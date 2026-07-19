/*
 * SenseFlow RTU-D4 — Modbus RTU Slave (RS485) + WiFi config UI
 *
 * Clean, single-purpose firmware:
 *   - Reads 4 DIP probes via OCSIL pulsed excitation (probe logic unchanged
 *     from the cloud build — same readDipRaw + debounce + percent table).
 *   - Exposes tank data as Modbus RTU holding registers (poll-only).
 *   - WiFi AP (+ optional STA via UI) hosts a web page to view tank %, volume,
 *     RSSI, fault, and to change Slave ID / tank capacity.
 *   - NO cloud, NO MQTT, NO Firebase, NO internet checks.
 *
 * Modbus register map (4xxxx = offset + 40001):
 *   40001  Tank Percentage   UINT16  (0..100)
 *   40002  Volume HIGH word  UINT32 hi   (litres)
 *   40003  Volume LOW  word  UINT32 lo
 *   40004  Fault Bitmap      UINT16  bit0=25% bit1=50% bit2=75% bit3=100%
 *   40005  Capacity HIGH     UINT32 hi   (litres)
 *   40006  Capacity LOW      UINT32 lo
 *
 * Library: "modbus-esp8266" (emelianov) — ModbusRTU class. Works on ESP32.
 */

#include <WiFi.h>
#include <Preferences.h>
#include <ModbusRTU.h>
#include <MvsConnect.h>
#include <mvsota_esp32.h>
#include <FastLED_min.h>

// ══════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════
#define SENSOR_COUNT      4          // DIP probes (1..4)

#define DEVICE_NAME_DEFAULT "SenseFlowRTU01"   // 15-char default (same for all units)
#define DEVICE_NAME_LEN   15                    // device name fixed length
#define FIRMWARE_VERSION  "25.0.0"
#define FIRMWARE_CODE     "SF-RTU-2026"         // MvsOTA firmware identifier
#define AP_PASSWORD       "mvstech9867"

// ── RS485 / Modbus (per unified PCB) ──
#define RS485_RX_PIN      5          // ESP IO5  → RS485 module RO
#define RS485_TX_PIN      17         // ESP IO17 → RS485 module DI
#define RS485_DIR_PIN     25         // ESP IO25 → RS485 module DE+RE
#define MODBUS_BAUD_DEFAULT 9600     // configurable via UI (applied on reboot)
#define MODBUS_ADDR_DEFAULT 1        // 1..247
// Holding-register offsets
#define MB_REG_PCT        0          // 40001
#define MB_REG_VOL_HI     1          // 40002
#define MB_REG_VOL_LO     2          // 40003
#define MB_REG_FAULT      3          // 40004
#define MB_REG_CAP_HI     4          // 40005
#define MB_REG_CAP_LO     5          // 40006
#define MB_REG_COUNT      6

// ── DIP probes (per unified PCB) ──
// Bottom→top: IO34=25%, IO35=50%, IO32=75%, IO33=100%. Ext 10k pulldowns.
const int DIP_PINS[] = {34, 35, 32, 33};
#define DIP_COMMON_PIN    12         // EXCITE on PCB (strapping, ext pulldown)

// Excitation: 0 = constant DC, 1 = OCSIL pulsed (anti-corrosion). Keep 1.
#define EXCITATION_MODE   1
#define DIP_SETTLE_US         300
#define DIP_SAMPLES_PER_READ   15
#define DIP_AGREE_THRESHOLD    15
#define DIP_READ_INTERVAL_MS 3000
#define DIP_WET_CONFIRM   3          // dry→wet needs 3 confirms (EMI reject)

// ── LED ──
#define LED_PIN           15

// ══════════════════════════════════════════════════
//  DIP PERCENT TABLE
// ══════════════════════════════════════════════════
const uint8_t DIP_PCT_1[] = {100};
const uint8_t DIP_PCT_2[] = {50, 100};
const uint8_t DIP_PCT_3[] = {33, 67, 100};
const uint8_t DIP_PCT_4[] = {25, 50, 75, 100};
const uint8_t* DIP_PCT_TABLE[] = { NULL, DIP_PCT_1, DIP_PCT_2, DIP_PCT_3, DIP_PCT_4 };

// ══════════════════════════════════════════════════
//  GLOBALS
// ══════════════════════════════════════════════════
Preferences prefs;
MvsConnect  mvs(DEVICE_NAME_DEFAULT, FIRMWARE_VERSION);
MvsOTA      mvsota;
ModbusRTU   mb;
CRGB        rgbLeds[1];

String   deviceName = DEVICE_NAME_DEFAULT;   // user-editable, 15 chars, NVS
String   devSuffix  = "";                    // random 4-char, generated once, NVS
String   apName     = "";                    // deviceName_suffix_mvstech
uint32_t modbusBaud = MODBUS_BAUD_DEFAULT;   // configurable baud (NVS)

// Sensor state
uint8_t  sensorBits   = 0;
uint8_t  confirmedPct = 0;
bool     sensorError  = false;

// Modbus-exposed values
uint8_t  slaveID       = MODBUS_ADDR_DEFAULT;
uint16_t tankPercent   = 0;
uint32_t currentVolume = 0;
uint32_t totalCapacity = 0;   // litres (0 = not configured → litres hidden)
uint16_t faultBitmap   = 0;
uint32_t lastModbusPoll = 0;

// AP mode: 0 = always on, 1 = 10-min auto-off after boot (default)
uint8_t  apMode = 1;
unsigned long apTimerStart = 0, apTimerDeadline = 0;
bool     apTimerEnded = false;
const unsigned long AP_AUTO_OFF_MS = 10UL * 60UL * 1000UL;
const unsigned long AP_EXTEND_MS   =  5UL * 60UL * 1000UL;

// WiFi STA reconnect
bool     manualWiFiInProgress = false;
unsigned long manualWiFiStart = 0;

// LED cycle
unsigned long ledCycleStart = 0;

// ══════════════════════════════════════════════════
//  DEVICE CODE
// ══════════════════════════════════════════════════
// Random 4-char suffix (A-Z0-9) so identically-named devices are distinguishable
// over mDNS / AP. Generated once at first boot, kept forever.
String generateSuffix() {
  const char charset[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  String s = "";
  for (int i = 0; i < 4; i++) s += charset[random(0, 36)];
  return s;
}

// Rebuild AP SSID / mDNS name from deviceName + suffix.
void rebuildApName() {
  apName = deviceName + "_" + devSuffix + "_mvstech";
  mvs.setDeviceName(deviceName + "_" + devSuffix);
}

void loadConfig() {
  prefs.begin("senseflow", false);

  // Device name (15 chars, default same for all units)
  deviceName = prefs.getString("devname", DEVICE_NAME_DEFAULT);
  if (deviceName.length() == 0) deviceName = DEVICE_NAME_DEFAULT;
  if (deviceName.length() > DEVICE_NAME_LEN) deviceName = deviceName.substring(0, DEVICE_NAME_LEN);

  // Random 4-char suffix — generate once, keep
  devSuffix = prefs.getString("devsfx", "");
  if (devSuffix.length() != 4) {
    randomSeed(esp_random());
    devSuffix = generateSuffix();
    prefs.putString("devsfx", devSuffix);
  }

  uint8_t a = prefs.getUChar("mbAddr", MODBUS_ADDR_DEFAULT);
  slaveID = (a >= 1 && a <= 247) ? a : MODBUS_ADDR_DEFAULT;
  totalCapacity = prefs.getULong("capacity", 0);
  apMode = prefs.getUChar("apMode", 1);
  modbusBaud = prefs.getULong("baud", MODBUS_BAUD_DEFAULT);
  prefs.end();

  rebuildApName();
}

// ══════════════════════════════════════════════════
//  LED
// ══════════════════════════════════════════════════
void setLED(uint8_t r, uint8_t g, uint8_t b) { rgbLeds[0] = CRGB(r, g, b); FastLED_min<LED_PIN>.show(); }
void setLEDOff() { setLED(0, 0, 0); }

void setLevelColor(uint8_t pct) {
  if (pct == 0)       setLED(255, 0, 0);     // Red - empty
  else if (pct <= 25) setLED(255, 80, 0);    // Orange
  else if (pct <= 50) setLED(255, 200, 0);   // Yellow
  else if (pct <= 75) setLED(0, 229, 255);   // Cyan
  else                setLED(0, 200, 0);     // Green - full
}

// 30s level color → 5s status blink (cyan=bus polled, white=no master).
void handleLED() {
  unsigned long now = millis();
  unsigned long e = now - ledCycleStart;
  if (e >= 35000) { ledCycleStart = now; e = 0; }

  if (e >= 30000) {
    int ph = ((now) / 250) % 2;
    bool busAlive = (lastModbusPoll != 0) && (now - lastModbusPoll < 10000);
    if (busAlive)      { if (ph == 0) setLED(0, 180, 255); else setLEDOff(); }  // Cyan = polled
    else               { if (ph == 0) setLED(255, 255, 255); else setLEDOff(); } // White = no master
  } else {
    if (sensorError) setLED(148, 51, 234);   // Purple - fault
    else             setLevelColor(confirmedPct);
  }
}

// ══════════════════════════════════════════════════
//  DIP PROBE LOGIC  (unchanged — OCSIL pulsed)
// ══════════════════════════════════════════════════
void initDipSensors() {
  for (int i = 0; i < SENSOR_COUNT; i++) pinMode(DIP_PINS[i], INPUT_PULLDOWN);
  pinMode(DIP_COMMON_PIN, OUTPUT);
  digitalWrite(DIP_COMMON_PIN, LOW);
}

// Synchronous unipolar square-wave read. Probe counted wet only if it tracks
// the excitation (HIGH when common HIGH, LOW when common LOW). Rejects stuck pins.
uint8_t readDipRaw() {
  uint8_t agreeCount[6] = {0};
  for (int s = 0; s < DIP_SAMPLES_PER_READ; s++) {
    digitalWrite(DIP_COMMON_PIN, HIGH);
    delayMicroseconds(DIP_SETTLE_US);
    uint8_t hi = 0;
    for (int i = 0; i < SENSOR_COUNT; i++) if (digitalRead(DIP_PINS[i]) == HIGH) hi |= (1 << i);
    digitalWrite(DIP_COMMON_PIN, LOW);
    delayMicroseconds(DIP_SETTLE_US);
    uint8_t lo = 0;
    for (int i = 0; i < SENSOR_COUNT; i++) if (digitalRead(DIP_PINS[i]) == LOW) lo |= (1 << i);
    uint8_t agree = hi & lo;
    for (int i = 0; i < SENSOR_COUNT; i++) if (agree & (1 << i)) agreeCount[i]++;
  }
  digitalWrite(DIP_COMMON_PIN, LOW);   // park LOW between reads
  uint8_t bits = 0;
  for (int i = 0; i < SENSOR_COUNT; i++) if (agreeCount[i] >= DIP_AGREE_THRESHOLD) bits |= (1 << i);
  return bits;
}

int countConsecutive(uint8_t bits, int count) {
  int c = 0;
  for (int i = 0; i < count; i++) { if (bits & (1 << i)) c++; else break; }
  return c;
}

bool checkSensorError(uint8_t bits, int count) {
  int total = 0;
  for (int i = 0; i < count; i++) if (bits & (1 << i)) total++;
  return (total != countConsecutive(bits, count));   // non-consecutive = error
}

uint8_t bitsToPercent(uint8_t bits, int count) {
  int c = countConsecutive(bits, count);
  if (c == 0) return 0;
  if (count >= 1 && count <= 4) return DIP_PCT_TABLE[count][c - 1];
  return 0;
}

// Fault bitmap: dry probe below the highest wet probe = gap fault.
uint16_t buildFaultBitmap() {
  uint16_t fb = 0;
  int highestWet = -1;
  for (int i = 0; i < SENSOR_COUNT; i++) if ((sensorBits >> i) & 1) highestWet = i;
  for (int i = 0; i < highestWet; i++) if (!((sensorBits >> i) & 1)) fb |= (1 << i);
  return fb;
}

void processDipSensors() {
  static unsigned long lastRead = 0;
  static uint8_t wetConfirm[6] = {0};
  if (millis() - lastRead < DIP_READ_INTERVAL_MS) return;
  lastRead = millis();

  uint8_t raw = readDipRaw();
  uint8_t newBits = sensorBits;
  for (int i = 0; i < SENSOR_COUNT; i++) {
    bool rawWet = (raw >> i) & 1;
    bool isWet  = (sensorBits >> i) & 1;
    if (rawWet && !isWet) {
      if (wetConfirm[i] < 255) wetConfirm[i]++;
      if (wetConfirm[i] >= DIP_WET_CONFIRM) { newBits |= (1 << i); wetConfirm[i] = 0; }
    } else if (!rawWet && isWet) {
      newBits &= ~(1 << i); wetConfirm[i] = 0;       // wet→dry instant
    } else {
      wetConfirm[i] = 0;
    }
  }
  sensorBits   = newBits;
  sensorError  = checkSensorError(sensorBits, SENSOR_COUNT);
  confirmedPct = bitsToPercent(sensorBits, SENSOR_COUNT);
}

// ══════════════════════════════════════════════════
//  MODBUS
// ══════════════════════════════════════════════════
void updateRegisters() {
  tankPercent   = confirmedPct;
  currentVolume = (totalCapacity > 0)
    ? (uint32_t)(((uint64_t)tankPercent * totalCapacity) / 100ULL) : 0;
  faultBitmap   = buildFaultBitmap();

  mb.Hreg(MB_REG_PCT,    tankPercent);
  mb.Hreg(MB_REG_VOL_HI, (uint16_t)(currentVolume >> 16));
  mb.Hreg(MB_REG_VOL_LO, (uint16_t)(currentVolume & 0xFFFF));
  mb.Hreg(MB_REG_FAULT,  faultBitmap);
  mb.Hreg(MB_REG_CAP_HI, (uint16_t)(totalCapacity >> 16));
  mb.Hreg(MB_REG_CAP_LO, (uint16_t)(totalCapacity & 0xFFFF));
}

void modbusInit() {
  Serial2.begin(modbusBaud, SERIAL_8N1, RS485_RX_PIN, RS485_TX_PIN);
  mb.begin(&Serial2, RS485_DIR_PIN);
  mb.slave(slaveID);
  for (int i = 0; i < MB_REG_COUNT; i++) mb.addHreg(i);
  // Stamp poll time when master reads 40001 (LED bus-alive indicator).
  mb.onGetHreg(MB_REG_PCT, [](TRegister* r, uint16_t v) -> uint16_t {
    lastModbusPoll = millis();
    return v;
  });
  updateRegisters();
  Serial.printf("[MB] RTU slave ready addr=%u %lu 8N1 RX=%d TX=%d DIR=%d\n",
                slaveID, (unsigned long)modbusBaud, RS485_RX_PIN, RS485_TX_PIN, RS485_DIR_PIN);
}

// ══════════════════════════════════════════════════
//  WEB UI
// ══════════════════════════════════════════════════
String fmtLitres(uint32_t v) {
  if (v >= 1000000UL) return String(v / 1000000.0, 2) + " ML";
  if (v >= 1000UL)    return String(v / 1000.0, 1) + " KL";
  return String(v) + " L";
}

String buildCustomHTML() {
  String html = R"rawliteral(
<!DOCTYPE html><html><head>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>SenseFlow RTU-D4</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#f5f5f5;color:#333;padding:16px}
.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h1{font-size:20px;color:#2563eb;margin-bottom:4px}
h2{font-size:14px;font-weight:600;color:#666;margin-bottom:8px}
.code{font-family:monospace;font-size:16px;font-weight:bold;color:#111}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px}
.row:last-child{border:none}.label{color:#888}.val{font-weight:600}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px}
.btn-blue{background:#2563eb;color:#fff}.btn-red{background:#ef4444;color:#fff}
.tank-wrap{display:flex;gap:20px;align-items:center}
.tank{width:110px;height:220px;flex-shrink:0}
.big-pct{font-size:40px;font-weight:800;color:#2563eb;line-height:1}
.litres{font-size:15px;color:#475569;font-weight:600}
.err{background:#faf5ff;border:1px solid #d8b4fe;color:#7e22ce;padding:6px 10px;border-radius:8px;font-size:11px;font-weight:600;margin-top:6px}
input{padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px}
</style></head><body>
)rawliteral";

  bool wifiOk = (WiFi.status() == WL_CONNECTED);
  html += "<div class='card' style='display:flex;align-items:center;gap:8px;background:" + String(wifiOk ? "#f0fdf4" : "#fef2f2") + "'>";
  html += "<div style='width:10px;height:10px;border-radius:50%;background:" + String(wifiOk ? "#22c55e" : "#ef4444") + "'></div>";
  if (wifiOk) html += "<div style='font-size:11px'><b>WiFi: " + WiFi.SSID() + "</b> &bull; " + WiFi.localIP().toString() + " &bull; RSSI " + String(WiFi.RSSI()) + "dBm</div>";
  else        html += "<div style='font-size:11px'><b>WiFi not connected</b> &bull; AP config below</div>";
  html += "</div>";

  // Tank card — header shows the user device name + suffix
  html += "<div class='card'><h1>" + deviceName + "</h1><p class='code'>" + deviceName + "_" + devSuffix + "</p>";
  html += "<div class='tank-wrap' style='margin-top:12px'>";
  int innerTop = 50, innerBottom = 240, innerH = innerBottom - innerTop;
  int yStart = innerBottom - (innerH * confirmedPct / 100);
  html += "<svg class='tank' viewBox='0 0 150 260'>";
  html += "<defs><clipPath id='c'><path d='M 15 60 Q 15 50 25 50 L 125 50 Q 135 50 135 60 L 135 220 Q 135 240 115 240 L 35 240 Q 15 240 15 220 Z'/></clipPath></defs>";
  html += "<path d='M 15 60 Q 15 50 25 50 L 125 50 Q 135 50 135 60 L 135 220 Q 135 240 115 240 L 35 240 Q 15 240 15 220 Z' fill='#f8fafc' stroke='#475569' stroke-width='3'/>";
  html += "<rect x='10' y='30' width='130' height='14' rx='4' fill='#475569'/>";
  html += "<g clip-path='url(#c)'><rect id='tw' x='0' y='" + String(yStart) + "' width='150' height='" + String(innerBottom - yStart) + "' fill='#2563eb'/></g>";
  const uint8_t* PCT = DIP_PCT_TABLE[SENSOR_COUNT];
  for (int i = 0; i < SENSOR_COUNT; i++) {
    bool on = (sensorBits >> i) & 1;
    int pct = PCT ? PCT[i] : 0;
    int py = innerBottom - (innerH * pct / 100);
    html += "<line x1='15' y1='" + String(py) + "' x2='135' y2='" + String(py) + "' stroke='" + String(on ? "#2563eb" : "#cbd5e1") + "' stroke-width='1.5' stroke-dasharray='3,2'/>";
  }
  html += "</svg>";
  html += "<div><div class='big-pct' id='pct'>" + String(confirmedPct) + "%</div>";
  if (totalCapacity > 0) html += "<div class='litres' id='lit'>" + fmtLitres(currentVolume) + " / " + fmtLitres(totalCapacity) + "</div>";
  if (sensorError) html += "<div class='err'>Sensor pattern fault &mdash; check wiring</div>";
  html += "</div></div></div>";

  // Modbus card — live register values + meaning
  html += "<div class='card'><h2>Modbus RTU (RS485)</h2>";
  html += "<div class='row'><span class='label'>Mode</span><span class='val'>Slave &bull; " + String(modbusBaud) + " 8N1 &bull; Big-Endian</span></div>";
  html += "<div class='row'><span class='label'>Slave ID</span><span class='val'>" + String(slaveID) + "</span></div>";
  html += "<div style='margin-top:8px;font-size:12px'>";
  html += "<div class='row'><span class='label'>40001 &mdash; Tank %</span><span class='val'>" + String(tankPercent) + "</span></div>";
  html += "<div class='row'><span class='label'>40002 &mdash; Volume HI</span><span class='val'>" + String((uint16_t)(currentVolume >> 16)) + "</span></div>";
  html += "<div class='row'><span class='label'>40003 &mdash; Volume LO</span><span class='val'>" + String((uint16_t)(currentVolume & 0xFFFF)) + "</span></div>";
  html += "<div class='row'><span class='label'>40004 &mdash; Fault bitmap</span><span class='val'>" + String(faultBitmap) + "</span></div>";
  html += "<div class='row'><span class='label'>40005 &mdash; Capacity HI</span><span class='val'>" + String((uint16_t)(totalCapacity >> 16)) + "</span></div>";
  html += "<div class='row'><span class='label'>40006 &mdash; Capacity LO</span><span class='val'>" + String((uint16_t)(totalCapacity & 0xFFFF)) + "</span></div>";
  html += "</div>";
  html += "<p style='font-size:10px;color:#888;margin-top:4px'>32-bit values are Big-Endian: HIGH word in lower register (40002/40005).</p>";

  // Slave ID
  html += "<form action='/setmbaddr' method='GET' style='margin-top:10px;display:flex;gap:6px;align-items:center'>";
  html += "<span style='font-size:12px;color:#666'>Slave ID (1-247):</span>";
  html += "<input type='number' name='a' min='1' max='247' value='" + String(slaveID) + "' style='flex:1' required>";
  html += "<button class='btn btn-blue' type='submit' style='margin:0;padding:8px 16px'>Save</button></form>";
  // Baud rate dropdown
  html += "<form action='/setbaud' method='GET' style='margin-top:8px;display:flex;gap:6px;align-items:center'>";
  html += "<span style='font-size:12px;color:#666'>Baud:</span>";
  html += "<select name='b' style='flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px'>";
  const uint32_t bauds[] = {9600, 19200, 38400, 57600, 115200};
  for (int i = 0; i < 5; i++)
    html += "<option value='" + String(bauds[i]) + "'" + String(bauds[i] == modbusBaud ? " selected" : "") + ">" + String(bauds[i]) + "</option>";
  html += "</select>";
  html += "<button class='btn btn-blue' type='submit' style='margin:0;padding:8px 16px'>Save</button></form>";
  html += "<p style='font-size:10px;color:#888;margin-top:2px'>Baud change applies after restart.</p>";
  // Capacity
  html += "<form action='/setcapacity' method='GET' style='margin-top:8px;display:flex;gap:6px;align-items:center'>";
  html += "<span style='font-size:12px;color:#666'>Capacity (L):</span>";
  html += "<input type='number' name='c' min='0' max='100000000' value='" + String(totalCapacity) + "' style='flex:1'>";
  html += "<button class='btn btn-blue' type='submit' style='margin:0;padding:8px 16px'>Save</button></form>";
  html += "</div>";

  // Device name card
  html += "<div class='card'><h2>Device Name</h2>";
  html += "<form action='/setname' method='GET' style='display:flex;gap:6px;align-items:center'>";
  html += "<input type='text' name='n' maxlength='15' value='" + deviceName + "' style='flex:1' required>";
  html += "<button class='btn btn-blue' type='submit' style='margin:0;padding:8px 16px'>Save</button></form>";
  html += "<p style='font-size:10px;color:#888;margin-top:4px'>Max 15 chars. AP/mDNS = name_" + devSuffix + "_mvstech (applies after restart).</p>";
  html += "</div>";

  // Details card
  int rssi = WiFi.RSSI();
  String sig = (WiFi.status() != WL_CONNECTED) ? "N/A" : (rssi >= -55 ? "Excellent" : rssi >= -65 ? "Good" : rssi >= -75 ? "Fair" : "Weak");
  html += "<div class='card'><h2>Details</h2>";
  html += "<div class='row'><span class='label'>Sensor</span><span class='val'>" + String(SENSOR_COUNT) + "-Probe DIP</span></div>";
  html += "<div class='row'><span class='label'>WiFi Signal</span><span class='val'>" + sig + " (" + String(rssi) + "dBm)</span></div>";
  html += "<div class='row'><span class='label'>Firmware</span><span class='val'>v" + String(FIRMWARE_VERSION) + "</span></div>";
  html += "</div>";

  // AP mode card
  html += "<div class='card'><h2>AP WiFi</h2>";
  html += "<label style='display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px'><input type='radio' name='ap' " + String(apMode == 0 ? "checked" : "") + " onchange=\"location.href='/setapmode?mode=0'\"> Always on</label>";
  html += "<label style='display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px'><input type='radio' name='ap' " + String(apMode == 1 ? "checked" : "") + " onchange=\"location.href='/setapmode?mode=1'\"> 10 min after boot</label>";
  html += "<a href='/restart'><button class='btn btn-red'>Restart Device</button></a></div>";

  // WiFi STA setup card
  html += "<div class='card'><h2>WiFi Setup (join router)</h2>";
  html += "<form action='/setwifi' method='GET'>";
  html += "<input type='text' name='ssid' placeholder='WiFi SSID' style='width:100%;margin-bottom:6px' required>";
  html += "<input type='password' name='pass' placeholder='Password' style='width:100%'>";
  html += "<button class='btn btn-blue' type='submit' style='width:100%;margin-top:8px'>Connect WiFi</button></form></div>";

  // Live poll
  html += "<script>setInterval(async()=>{try{const d=await(await fetch('/sstatus')).json();";
  html += "const y=240-(190*d.level/100);const w=document.getElementById('tw');if(w){w.setAttribute('y',y);w.setAttribute('height',240-y)}";
  html += "const p=document.getElementById('pct');if(p)p.textContent=d.level+'%';";
  html += "}catch(e){}},2000);";
  html += "setInterval(()=>{if(!document.activeElement||document.activeElement.tagName==='BODY')location.reload()},30000);</script>";
  html += "</body></html>";
  return html;
}

// ══════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== SenseFlow RTU-D4 v" FIRMWARE_VERSION " ===");

  FastLED_min<LED_PIN>.addLeds(rgbLeds, 1);
  FastLED_min<LED_PIN>.setBrightness(80);
  setLED(255, 100, 0);   // orange boot

  loadConfig();
  initDipSensors();

  // WiFi AP (+ STA if saved)
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), AP_PASSWORD);
  Serial.println("AP: " + apName);

  mvs.setCustomHTML([](){ return buildCustomHTML(); });
  mvs.onWiFiCredentialsReceived([](const String& ssid) {
    WiFi.disconnect(false); delay(200);
  });
  mvs.begin();

  // Endpoints
  mvs.addEndpoint("/setwifi", []() {
    WebServer* srv = mvs.getServer();
    String ssid = srv->arg("ssid"), pass = srv->arg("pass");
    if (ssid.length() == 0) { srv->send(400, "text/html", "SSID required"); return; }
    srv->send(200, "text/html", "<h2>Connecting to " + ssid + "...</h2><script>setTimeout(()=>location.href='/',15000)</script>");
    manualWiFiInProgress = true; manualWiFiStart = millis();
    WiFi.disconnect(true); delay(1000);
    Preferences wp; wp.begin("mvswifi", false);
    wp.putString("ssid", ssid); wp.putString("password", pass); wp.putBool("valid", true); wp.end();
    WiFi.begin(ssid.c_str(), pass.c_str());
  });

  mvs.addEndpoint("/setmbaddr", []() {
    WebServer* srv = mvs.getServer();
    int a = srv->arg("a").toInt();
    if (a >= 1 && a <= 247) {
      slaveID = (uint8_t)a;
      Preferences p; p.begin("senseflow", false); p.putUChar("mbAddr", slaveID); p.end();
      mb.slave(slaveID);
      Serial.printf("[MB] Slave ID = %u\n", slaveID);
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/setcapacity", []() {
    WebServer* srv = mvs.getServer();
    uint32_t c = (uint32_t)strtoul(srv->arg("c").c_str(), NULL, 10);
    totalCapacity = c;
    Preferences p; p.begin("senseflow", false); p.putULong("capacity", c); p.end();
    updateRegisters();
    Serial.printf("[CFG] Capacity = %lu L\n", (unsigned long)c);
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  // Baud rate — save to NVS, takes effect after restart
  mvs.addEndpoint("/setbaud", []() {
    WebServer* srv = mvs.getServer();
    uint32_t b = (uint32_t)strtoul(srv->arg("b").c_str(), NULL, 10);
    if (b == 9600 || b == 19200 || b == 38400 || b == 57600 || b == 115200) {
      modbusBaud = b;
      Preferences p; p.begin("senseflow", false); p.putULong("baud", b); p.end();
      Serial.printf("[MB] Baud = %lu (restart to apply)\n", (unsigned long)b);
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  // Device name (max 15 chars) — save to NVS, AP/mDNS update after restart
  mvs.addEndpoint("/setname", []() {
    WebServer* srv = mvs.getServer();
    String n = srv->arg("n");
    n.trim();
    if (n.length() > DEVICE_NAME_LEN) n = n.substring(0, DEVICE_NAME_LEN);
    if (n.length() > 0) {
      deviceName = n;
      Preferences p; p.begin("senseflow", false); p.putString("devname", deviceName); p.end();
      Serial.println("[CFG] Device name = " + deviceName);
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/setapmode", []() {
    WebServer* srv = mvs.getServer();
    uint8_t m = (uint8_t)srv->arg("mode").toInt(); if (m > 1) m = 1;
    apMode = m;
    Preferences p; p.begin("senseflow", false); p.putUChar("apMode", apMode); p.end();
    if (apMode == 0) {
      WiFi.mode(WIFI_AP_STA); WiFi.softAP(apName.c_str(), AP_PASSWORD);
      apTimerStart = 0; apTimerEnded = false;
    } else if (WiFi.status() == WL_CONNECTED && apTimerStart == 0) {
      apTimerStart = millis(); apTimerDeadline = apTimerStart + AP_AUTO_OFF_MS; apTimerEnded = false;
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/restart", []() {
    WebServer* srv = mvs.getServer();
    srv->send(200, "text/html", "<h2>Restarting...</h2>");
    delay(800); ESP.restart();
  });

  mvs.addEndpoint("/sstatus", []() {
    WebServer* srv = mvs.getServer();
    String j = "{";
    j += "\"level\":" + String(confirmedPct) + ",";
    j += "\"bits\":" + String(sensorBits) + ",";
    j += "\"fault\":" + String(faultBitmap) + ",";
    j += "\"capL\":" + String(totalCapacity) + ",";
    j += "\"rssi\":" + String(WiFi.RSSI()) + ",";
    j += "\"id\":" + String(slaveID);
    j += "}";
    srv->send(200, "application/json", j);
  });

  // Try saved WiFi (STA)
  if (mvs.hasSavedWiFi()) {
    setLED(0, 0, 255);
    if (mvs.connectToSavedWiFi(20)) {
      Serial.println("WiFi STA: " + WiFi.localIP().toString());
      if (apMode == 1) { apTimerStart = millis(); apTimerDeadline = apTimerStart + AP_AUTO_OFF_MS; apTimerEnded = false; }
    }
  }

  // MvsOTA — over-the-air firmware update support
  mvsota.begin(deviceName.c_str(), FIRMWARE_VERSION, FIRMWARE_CODE);

  modbusInit();
  ledCycleStart = millis();
}

// ══════════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════════
void loop() {
  unsigned long now = millis();

  mvs.handle();
  if (!mvsota.isUpdating()) mvsota.handle();

  // AP 10-min auto-off
  if (apMode == 1 && apTimerStart != 0 && !apTimerEnded && now >= apTimerDeadline) {
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    apTimerEnded = true;
    Serial.println("[AP] auto-off");
  }

  // Sensors
  processDipSensors();

  // Modbus (poll-only) + register refresh
  updateRegisters();
  mb.task();

  handleLED();

  // STA reconnect every 30s if dropped
  if (WiFi.status() != WL_CONNECTED) {
    if (manualWiFiInProgress && (now - manualWiFiStart > 30000)) manualWiFiInProgress = false;
    static unsigned long lastRC = 0;
    if (!manualWiFiInProgress && (now - lastRC > 30000)) {
      lastRC = now;
      if (mvs.hasSavedWiFi()) mvs.connectToSavedWiFi(8);
    }
  }

  // Serial commands (bench)
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n'); cmd.trim();
    if (cmd.equalsIgnoreCase("SHOW")) {
      Serial.printf("ID=%u  pct=%u  vol=%lu  cap=%lu  fault=%u  RSSI=%d\n",
        slaveID, tankPercent, (unsigned long)currentVolume,
        (unsigned long)totalCapacity, faultBitmap, WiFi.RSSI());
    } else if (cmd.startsWith("ID=")) {
      int a = cmd.substring(3).toInt();
      if (a >= 1 && a <= 247) { slaveID = a; prefs.begin("senseflow", false); prefs.putUChar("mbAddr", slaveID); prefs.end(); mb.slave(slaveID); Serial.printf("ID=%u\n", slaveID); }
    } else if (cmd.startsWith("C=")) {
      totalCapacity = strtoul(cmd.substring(2).c_str(), NULL, 10);
      prefs.begin("senseflow", false); prefs.putULong("capacity", totalCapacity); prefs.end();
      updateRegisters(); Serial.printf("cap=%lu\n", (unsigned long)totalCapacity);
    } else if (cmd.equalsIgnoreCase("RESTART")) {
      ESP.restart();
    }
  }
}
