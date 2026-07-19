/*
 * SenseFlow SENSOR SIMULATOR v1.0.0
 *
 * Pure simulator — no physical sensor GPIOs are read.
 * User selects mode (DIP or Ultrasonic) at runtime via web UI.
 *   - DIP:        pick count 1-6, toggle each bit on/off
 *   - Ultrasonic: slider for water level %, tank height configurable
 *
 * Pushes to Firebase RTDB exactly like the real sensor firmware:
 *   /devices/{code}/live, /info, /history (history respects admin analyticsOn)
 *
 * Registers as deviceClass=0x02 (Sensor). /info carries "simulator":true
 * so the dashboard can tag it as a simulated device.
 *
 * Device Code: SF-XXXXXXXX-SM (SM suffix marks simulator)
 */

#include <WiFi.h>
#include <Preferences.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <MvsConnect.h>
#include <mvsota_esp32.h>
#include <FastLED_min.h>

// ══════════════════════════════════════════════════
//  FIREBASE / DEVICE CONFIG
// ══════════════════════════════════════════════════
#define FIREBASE_API_KEY    "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4"
#define FIREBASE_DB_URL     "https://senseflow-5a9bb-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_PROJECT_ID "senseflow-5a9bb"

#define DEVICE_NAME         "SenseFlow-SimSensor"
#define FIRMWARE_VERSION    "1.0.0-sim"
#define FIRMWARE_CODE       "SF-SIM-SENSOR-2026-1"
#define AP_PASSWORD         "mvstech9867"

// Device classes / sensor types (match protocol)
#define CLS_SENSOR          0x02
#define SNS_NONE            0x00
#define SNS_DIP             0x01
#define SNS_ULTRASONIC      0x02

// LED
#define LED_PIN             15

// Timing
#define HEARTBEAT_INTERVAL      300000   // 5 min
#define COMMAND_CHECK_INTERVAL  5000     // 5 s
#define CONFIG_CHECK_INTERVAL   30000    // 30 s
#define LED_CYCLE_DURATION      30000
#define WIFI_BLINK_DURATION     5000

// DIP percent tables (same as real firmware)
const uint8_t DIP_PCT_1[] = {100};
const uint8_t DIP_PCT_2[] = {50, 100};
const uint8_t DIP_PCT_3[] = {33, 67, 100};
const uint8_t DIP_PCT_4[] = {25, 50, 75, 100};
const uint8_t DIP_PCT_5[] = {20, 40, 60, 80, 100};
const uint8_t DIP_PCT_6[] = {17, 33, 50, 67, 83, 100};
const uint8_t* DIP_PCT_TABLE[] = {
  NULL, DIP_PCT_1, DIP_PCT_2, DIP_PCT_3, DIP_PCT_4, DIP_PCT_5, DIP_PCT_6
};

// ══════════════════════════════════════════════════
//  GLOBALS
// ══════════════════════════════════════════════════
Preferences prefs;
MvsConnect mvs(DEVICE_NAME, FIRMWARE_VERSION);
MvsOTA mvsota;

FirebaseData   fbdo;
FirebaseAuth   fbAuth;
FirebaseConfig fbConfig;
bool firebaseReady = false;

String deviceCode = "";
String apName = "";

// Simulator state (persisted)
uint8_t simSensorType  = SNS_DIP;   // SNS_DIP | SNS_ULTRASONIC
uint8_t simDipCount    = 4;         // 1-6
uint8_t simDipBits     = 0;         // user-toggled bits
uint8_t simUsPct       = 0;         // user-set % for ultrasonic
float   simTankHeight  = 100.0;     // cm, ultrasonic only (display)

// Derived / published state
uint8_t sensorBits   = 0;
uint8_t confirmedPct = 0;
uint8_t flags        = 0;
bool    sensorError  = false;

// Change detection
uint8_t lastSentBits  = 0xFF;
uint8_t lastSentPct   = 0xFF;
uint8_t lastSentFlags = 0xFF;

// Analytics (history) flag from Firebase
bool analyticsOn = false;

// WiFi flags
bool manualWiFiInProgress = false;
unsigned long manualWiFiStart = 0;

// Timers
unsigned long lastHeartbeat = 0;
unsigned long lastCommandCheck = 0;
unsigned long lastConfigCheck = 0;
unsigned long lastSuccessfulPush = 0;
unsigned long lastDataPush = 0;

// Push fail tracking
int  consecutiveFailCount = 0;
bool pushFailFlash = false;
unsigned long pushFailFlashStart = 0;

// LED
CRGB rgbLeds[1];
unsigned long ledCycleStart = 0;
bool ledShowingWifi = false;
unsigned long wifiBlinkStart = 0;
bool testBlinkActive = false;
unsigned long testBlinkStart = 0;

// Internet
bool internetAvailable = false;
unsigned long lastInternetCheck = 0;

// ══════════════════════════════════════════════════
//  LED HELPERS
// ══════════════════════════════════════════════════
void setLED(uint8_t r, uint8_t g, uint8_t b) {
  rgbLeds[0] = CRGB(r, g, b);
  FastLED_min<LED_PIN>.show();
}
void setLEDOff() { setLED(0, 0, 0); }

void setLevelColor(uint8_t pct) {
  if (pct == 0)       setLED(255, 0, 0);
  else if (pct <= 25) setLED(255, 80, 0);
  else if (pct <= 50) setLED(255, 200, 0);
  else if (pct <= 75) setLED(0, 229, 255);
  else                setLED(0, 200, 0);
}

// ══════════════════════════════════════════════════
//  DEVICE CODE + STATE PERSISTENCE
// ══════════════════════════════════════════════════
String generateRandomCode() {
  const char charset[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  String code = "SF-";
  for (int i = 0; i < 8; i++) code += charset[random(0, 36)];
  code += "-SM";   // SM = simulator marker
  return code;
}

void loadState() {
  prefs.begin("sfsim", false);
  deviceCode = prefs.getString("devcode", "");
  if (deviceCode.length() == 0) {
    randomSeed(esp_random());
    deviceCode = generateRandomCode();
    prefs.putString("devcode", deviceCode);
    Serial.println("Generated sim device code: " + deviceCode);
  } else {
    Serial.println("Loaded sim device code: " + deviceCode);
  }
  simSensorType = prefs.getUChar("stype", SNS_DIP);
  simDipCount   = prefs.getUChar("dcount", 4);
  simDipBits    = prefs.getUChar("dbits", 0);
  simUsPct      = prefs.getUChar("uspct", 0);
  simTankHeight = prefs.getFloat("tankh", 100.0);
  prefs.end();

  if (simDipCount < 1 || simDipCount > 6) simDipCount = 4;

  apName = DEVICE_NAME;
  apName += "-";
  apName += deviceCode.substring(3, 7);
  apName += "_mvstech";
  mvs.setDeviceName(String(DEVICE_NAME) + "-" + deviceCode.substring(3, 7));
}

void saveSimState() {
  prefs.begin("sfsim", false);
  prefs.putUChar("stype",  simSensorType);
  prefs.putUChar("dcount", simDipCount);
  prefs.putUChar("dbits",  simDipBits);
  prefs.putUChar("uspct",  simUsPct);
  prefs.putFloat("tankh",  simTankHeight);
  prefs.end();
}

// ══════════════════════════════════════════════════
//  SIMULATOR LOGIC (no GPIO reads)
// ══════════════════════════════════════════════════
int countConsecutive(uint8_t bits, int count) {
  int c = 0;
  for (int i = 0; i < count; i++) {
    if (bits & (1 << i)) c++; else break;
  }
  return c;
}
bool checkSensorError(uint8_t bits, int count) {
  int total = 0;
  for (int i = 0; i < count; i++) if (bits & (1 << i)) total++;
  return (total != countConsecutive(bits, count));
}
uint8_t bitsToPercent(uint8_t bits, int count) {
  int c = countConsecutive(bits, count);
  if (c == 0) return 0;
  if (count >= 1 && count <= 6) return DIP_PCT_TABLE[count][c - 1];
  return 0;
}

void recomputeSimState() {
  if (simSensorType == SNS_DIP) {
    uint8_t mask = (simDipCount >= 8) ? 0xFF : ((1 << simDipCount) - 1);
    sensorBits   = simDipBits & mask;
    sensorError  = checkSensorError(sensorBits, simDipCount);
    confirmedPct = bitsToPercent(sensorBits, simDipCount);
    if (sensorError) flags |= 0x01; else flags &= ~0x01;
    flags &= ~0x20;  // not offline
  } else {
    sensorBits   = 0;
    sensorError  = false;
    confirmedPct = simUsPct;
    flags &= ~0x01;
    flags &= ~0x20;
  }
}

// ══════════════════════════════════════════════════
//  FIREBASE
// ══════════════════════════════════════════════════
void setGoogleDNS() {
  IPAddress dns1(8, 8, 8, 8), dns2(8, 8, 4, 4);
  WiFi.config(WiFi.localIP(), WiFi.gatewayIP(), WiFi.subnetMask(), dns1, dns2);
}
bool checkInternet() {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClient client;
  bool ok = client.connect("8.8.8.8", 53, 2000);
  client.stop();
  return ok;
}

void initFirebase() {
  if (WiFi.status() == WL_CONNECTED) setGoogleDNS();
  fbConfig.api_key = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;
  fbConfig.token_status_callback = tokenStatusCallback;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectNetwork(true);
  if (Firebase.signUp(&fbConfig, &fbAuth, "", "")) {
    Serial.println("[FB] anon auth OK");
  } else {
    Serial.println("[FB] auth FAILED: " + String(fbConfig.signer.signupError.message.c_str()));
  }
}

void writePendingDevice() {
  String path = "pendingDevices/" + deviceCode;
  FirebaseJson json;
  json.set("deviceClass",     CLS_SENSOR);
  json.set("sensorType",      simSensorType);
  json.set("sensorCount",     simSensorType == SNS_DIP ? simDipCount : 0);
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("macAddress",      WiFi.macAddress());
  json.set("simulator",       true);
  json.set("firstSeenAt/.sv", "timestamp");
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

bool pushLiveData() {
  String path = "devices/" + deviceCode + "/live";
  FirebaseJson json;
  json.set("sensorBits",   sensorBits);
  json.set("confirmedPct", confirmedPct);
  json.set("stateVal",     0);
  json.set("flags",        flags);
  json.set("rssi",         WiFi.RSSI());
  json.set("timestamp/.sv","timestamp");

  if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    lastSentBits  = sensorBits;
    lastSentPct   = confirmedPct;
    lastSentFlags = flags;
    lastDataPush  = millis();
    lastSuccessfulPush = millis();
    consecutiveFailCount = 0;
    return true;
  }
  consecutiveFailCount++;
  pushFailFlash = true;
  pushFailFlashStart = millis();
  Serial.printf("Push FAILED (%d): %s\n", consecutiveFailCount, fbdo.errorReason().c_str());
  if (consecutiveFailCount >= 5) {
    firebaseReady = false;
    internetAvailable = false;
    consecutiveFailCount = 0;
  }
  return false;
}

void updateDeviceInfo(bool online) {
  String path = "devices/" + deviceCode + "/info";
  FirebaseJson json;
  json.set("online",          online);
  json.set("lastSeen/.sv",    "timestamp");
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("deviceClass",     CLS_SENSOR);
  json.set("sensorType",      simSensorType);
  json.set("sensorCount",     simSensorType == SNS_DIP ? simDipCount : 0);
  json.set("simulator",       true);
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

void writeHistory() {
  if (!analyticsOn) return;
  FirebaseJson json;
  json.set("pct",      confirmedPct);
  json.set("bits",     sensorBits);
  json.set("flags",    flags);
  json.set("ts/.sv",   "timestamp");
  if (Firebase.RTDB.pushJSON(&fbdo, ("devices/" + deviceCode + "/history").c_str(), &json)) {
    Serial.println("[HISTORY] entry recorded");
  }
}

void checkConfig() {
  String path = "devices/" + deviceCode + "/config/analyticsOn";
  if (Firebase.RTDB.getBool(&fbdo, path.c_str())) {
    bool v = fbdo.boolData();
    if (v != analyticsOn) {
      analyticsOn = v;
      Serial.printf("[CONFIG] analyticsOn = %s\n", analyticsOn ? "ON" : "OFF");
    }
  }
}

void checkCommands() {
  String base = "devices/" + deviceCode + "/commands/";
  if (Firebase.RTDB.getBool(&fbdo, (base + "refreshRequested").c_str()) && fbdo.boolData()) {
    pushLiveData();
    Firebase.RTDB.setBool(&fbdo, (base + "refreshRequested").c_str(), false);
  }
  if (Firebase.RTDB.getBool(&fbdo, (base + "testRequested").c_str()) && fbdo.boolData()) {
    testBlinkActive = true; testBlinkStart = millis();
    Firebase.RTDB.setBool(&fbdo, (base + "testRequested").c_str(), false);
  }
  if (Firebase.RTDB.getBool(&fbdo, (base + "restartRequested").c_str()) && fbdo.boolData()) {
    Firebase.RTDB.setBool(&fbdo, (base + "restartRequested").c_str(), false);
    updateDeviceInfo(false);
    delay(500); ESP.restart();
  }
}

bool checkFirebaseReady() {
  if (Firebase.ready()) {
    if (!firebaseReady) {
      firebaseReady = true;
      Serial.println("[FB] ready");
      writePendingDevice();
      pushLiveData();
      updateDeviceInfo(true);
    }
    return true;
  }
  return false;
}

bool hasDataChanged() {
  return (sensorBits != lastSentBits ||
          confirmedPct != lastSentPct ||
          flags != lastSentFlags);
}

// ══════════════════════════════════════════════════
//  LED STATE MACHINE
// ══════════════════════════════════════════════════
void handleLED() {
  unsigned long now = millis();

  if (pushFailFlash) {
    if (now - pushFailFlashStart < 500) { setLED(255, 0, 0); return; }
    pushFailFlash = false;
  }
  if (testBlinkActive) {
    unsigned long e = now - testBlinkStart;
    if (e < 1800) {
      int p = (e / 200) % 3;
      if      (p == 0) setLED(255, 0, 0);
      else if (p == 1) setLED(0, 255, 0);
      else             setLED(0, 0, 255);
    } else testBlinkActive = false;
    return;
  }

  unsigned long ce = now - ledCycleStart;
  if (ce >= 35000) { ledCycleStart = now; ledShowingWifi = false; }

  if (ce >= 30000) {
    if (!ledShowingWifi) { ledShowingWifi = true; wifiBlinkStart = now; }
    int phase = ((now - wifiBlinkStart) / 250) % 2;
    if (WiFi.status() != WL_CONNECTED) {
      if (phase == 0) setLED(255, 255, 255); else setLEDOff();
    } else if (!internetAvailable) {
      if (phase == 0) setLED(255, 0, 100); else setLEDOff();
    } else {
      if (phase == 0) setLED(0, 0, 255); else setLEDOff();
    }
  } else {
    ledShowingWifi = false;
    if (sensorError) setLED(148, 51, 234);
    else setLevelColor(confirmedPct);
  }
}

// ══════════════════════════════════════════════════
//  CUSTOM WEB UI
// ══════════════════════════════════════════════════
String buildCustomHTML() {
  String h = R"raw(<!DOCTYPE html><html><head>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>SenseFlow Sensor Simulator</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#f5f5f5;color:#333;padding:16px}
.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
h1{font-size:20px;color:#2563eb;margin-bottom:4px}
h2{font-size:14px;font-weight:600;color:#666;margin-bottom:8px}
.code{font-family:monospace;font-size:18px;font-weight:bold;color:#111;letter-spacing:1px}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px}
.row:last-child{border:none}
.label{color:#888}.val{font-weight:600;color:#333}
.btn{display:inline-block;padding:10px 14px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin:4px 4px 4px 0;text-decoration:none;text-align:center}
.btn-blue{background:#2563eb;color:#fff}.btn-red{background:#ef4444;color:#fff}
.btn-gray{background:#e5e7eb;color:#333}.btn-green{background:#16a34a;color:#fff}
.pill{display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700}
.pill-sim{background:#fef3c7;color:#92400e}
.dip-row{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap}
.dip-dot{width:44px;height:44px;border-radius:50%;border:3px solid #ccc;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;text-decoration:none}
.dip-on{background:#3b82f6;border-color:#2563eb;color:#fff}
.dip-off{background:#e5e7eb;border-color:#d1d5db;color:#777}
input[type=range]{width:100%}
input[type=number],input[type=text],input[type=password],select{width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px}
</style></head><body>
)raw";

  // WiFi banner
  bool wifiOk = (WiFi.status() == WL_CONNECTED);
  if (wifiOk) {
    h += "<div style='background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:10px 14px;margin-bottom:12px'>";
    h += "<b style='color:#166534;font-size:12px'>WiFi Connected</b> ";
    h += "<span style='font-size:10px;color:#15803d'>" + WiFi.SSID() + " &bull; " + WiFi.localIP().toString() + " &bull; RSSI " + String(WiFi.RSSI()) + "dBm</span>";
    h += "</div>";
  } else {
    h += "<div style='background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:10px 14px;margin-bottom:12px'>";
    h += "<b style='color:#991b1b;font-size:12px'>WiFi Not Connected</b></div>";
  }

  // Header card
  h += "<div class='card'>";
  h += "<h1>Sensor Simulator <span class='pill pill-sim'>SIMULATOR</span></h1>";
  h += "<p class='code'>" + deviceCode + "</p>";
  h += "<p style='font-size:11px;color:#888;margin-top:6px'>Register this code in admin panel to link device</p>";
  h += "</div>";

  // Mode selector
  h += "<div class='card'><h2>Simulated Sensor Type</h2>";
  h += "<form action='/setmode' method='GET' style='display:flex;gap:8px'>";
  h += "<select name='m' onchange='this.form.submit()' style='flex:1'>";
  h += "<option value='1'" + String(simSensorType == SNS_DIP ? " selected" : "") + ">DIP Switches</option>";
  h += "<option value='2'" + String(simSensorType == SNS_ULTRASONIC ? " selected" : "") + ">Ultrasonic (HC-SR04)</option>";
  h += "</select>";
  h += "<noscript><button class='btn btn-blue' type='submit'>Set</button></noscript>";
  h += "</form></div>";

  // DIP controls
  if (simSensorType == SNS_DIP) {
    h += "<div class='card'><h2>DIP Sensor Count</h2>";
    h += "<form action='/setcount' method='GET' style='display:flex;gap:8px'>";
    h += "<select name='n' onchange='this.form.submit()' style='flex:1'>";
    for (int i = 1; i <= 6; i++) {
      h += "<option value='" + String(i) + "'" + (simDipCount == i ? " selected" : "") + ">" + String(i) + " sensors</option>";
    }
    h += "</select></form>";

    h += "<h2 style='margin-top:12px'>Toggle Bits (bit0 = bottom)</h2>";
    h += "<div class='dip-row'>";
    for (int i = 0; i < simDipCount; i++) {
      bool on = (simDipBits >> i) & 1;
      h += "<a class='dip-dot " + String(on ? "dip-on" : "dip-off") + "' href='/togglebit?b=" + String(i) + "'>" + String(i + 1) + "</a>";
    }
    h += "</div>";
    h += "<a class='btn btn-gray' href='/setbits?b=0'>All OFF</a>";
    h += "<a class='btn btn-gray' href='/setbits?b=" + String((1 << simDipCount) - 1) + "'>All ON (100%)</a>";

    if (sensorError) {
      h += "<p style='color:#a855f7;font-size:12px;font-weight:600;margin-top:8px'>Simulated Error: non-consecutive bits</p>";
    }
    h += "</div>";
  } else {
    // Ultrasonic controls
    h += "<div class='card'><h2>Ultrasonic Water Level</h2>";
    h += "<form action='/setpct' method='GET'>";
    h += "<input type='range' name='p' min='0' max='100' step='5' value='" + String(simUsPct) + "' oninput='v.textContent=this.value+\"%\"' onchange='this.form.submit()'>";
    h += "<p style='text-align:center;font-size:24px;font-weight:700;color:#2563eb'><span id='v'>" + String(simUsPct) + "%</span></p>";
    h += "<noscript><button class='btn btn-blue' type='submit'>Set</button></noscript>";
    h += "</form>";
    h += "<div style='display:flex;gap:4px;flex-wrap:wrap;margin-top:8px'>";
    int presets[] = {0, 25, 50, 75, 100};
    for (int p : presets) {
      h += "<a class='btn btn-gray' href='/setpct?p=" + String(p) + "'>" + String(p) + "%</a>";
    }
    h += "</div>";

    h += "<h2 style='margin-top:12px'>Tank Height (display only)</h2>";
    h += "<form action='/settank' method='GET' style='display:flex;gap:6px'>";
    h += "<input type='number' name='h' min='10' max='500' value='" + String((int)simTankHeight) + "' style='flex:1'>";
    h += "<button class='btn btn-blue' type='submit'>Save</button></form>";
    h += "</div>";
  }

  // Status card
  h += "<div class='card'><h2>Published State</h2>";
  h += "<div class='row'><span class='label'>Level</span><span class='val'>" + String(confirmedPct) + "%</span></div>";
  h += "<div class='row'><span class='label'>Bits</span><span class='val'>0b" + String(sensorBits, BIN) + "</span></div>";
  h += "<div class='row'><span class='label'>Flags</span><span class='val'>0x" + String(flags, HEX) + "</span></div>";
  h += "<div class='row'><span class='label'>Firebase</span><span class='val'>" + String(firebaseReady ? "Ready" : "Not ready") + "</span></div>";
  h += "<div class='row'><span class='label'>History (admin)</span><span class='val'>" + String(analyticsOn ? "ENABLED" : "disabled") + "</span></div>";
  h += "<div class='row'><span class='label'>Last Push</span><span class='val'>" +
    (lastSuccessfulPush > 0 ? String((millis() - lastSuccessfulPush) / 1000) + "s ago" : "Never") + "</span></div>";
  h += "<div class='row'><span class='label'>Push Fails</span><span class='val'>" + String(consecutiveFailCount) + "</span></div>";
  h += "<div class='row'><span class='label'>MAC</span><span class='val'>" + WiFi.macAddress() + "</span></div>";
  h += "<div class='row'><span class='label'>Firmware</span><span class='val'>" + String(FIRMWARE_VERSION) + "</span></div>";
  h += "</div>";

  // Actions
  h += "<div class='card'><h2>Actions</h2>";
  h += "<a class='btn btn-blue' href='/forcepush'>Force Push</a>";
  h += "<a class='btn btn-red' href='/restart'>Restart</a>";
  h += "</div>";

  // Manual WiFi
  h += "<div class='card'><h2>WiFi Setup</h2>";
  h += "<form action='/setwifi' method='GET'>";
  h += "<input type='text' name='ssid' placeholder='WiFi SSID' required style='margin-bottom:6px'>";
  h += "<input type='password' name='pass' placeholder='Password' style='margin-bottom:6px'>";
  h += "<button class='btn btn-blue' type='submit' style='width:100%'>Connect WiFi</button>";
  h += "</form></div>";

  h += "</body></html>";
  return h;
}

// ══════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n=== SenseFlow SENSOR SIMULATOR v" FIRMWARE_VERSION " ===\n");

  FastLED_min<LED_PIN>.addLeds(rgbLeds, 1);
  FastLED_min<LED_PIN>.setBrightness(80);
  setLED(255, 100, 0);

  loadState();
  recomputeSimState();

  Serial.println("Device code: " + deviceCode);
  Serial.println("Mode: " + String(simSensorType == SNS_DIP ? "DIP" : "ULTRASONIC"));

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), AP_PASSWORD);
  Serial.println("AP: " + apName);

  mvs.setCustomHTML([]() { return buildCustomHTML(); });

  mvs.onWiFiCredentialsReceived([](const String& ssid) {
    Serial.println("WiFi creds received: " + ssid);
    WiFi.disconnect(false);
    delay(200);
  });

  mvs.begin();

  // Simulator control endpoints
  mvs.addEndpoint("/setmode", []() {
    WebServer* s = mvs.getServer();
    uint8_t m = s->arg("m").toInt();
    if (m == SNS_DIP || m == SNS_ULTRASONIC) {
      simSensorType = m;
      saveSimState();
      recomputeSimState();
    }
    s->sendHeader("Location", "/"); s->send(302);
  });

  mvs.addEndpoint("/setcount", []() {
    WebServer* s = mvs.getServer();
    int n = s->arg("n").toInt();
    if (n >= 1 && n <= 6) {
      simDipCount = n;
      uint8_t mask = (1 << simDipCount) - 1;
      simDipBits &= mask;
      saveSimState();
      recomputeSimState();
    }
    s->sendHeader("Location", "/"); s->send(302);
  });

  mvs.addEndpoint("/togglebit", []() {
    WebServer* s = mvs.getServer();
    int b = s->arg("b").toInt();
    if (b >= 0 && b < simDipCount) {
      simDipBits ^= (1 << b);
      saveSimState();
      recomputeSimState();
    }
    s->sendHeader("Location", "/"); s->send(302);
  });

  mvs.addEndpoint("/setbits", []() {
    WebServer* s = mvs.getServer();
    simDipBits = (uint8_t) s->arg("b").toInt();
    uint8_t mask = (1 << simDipCount) - 1;
    simDipBits &= mask;
    saveSimState();
    recomputeSimState();
    s->sendHeader("Location", "/"); s->send(302);
  });

  mvs.addEndpoint("/setpct", []() {
    WebServer* s = mvs.getServer();
    int p = s->arg("p").toInt();
    if (p < 0) p = 0; if (p > 100) p = 100;
    simUsPct = (uint8_t) p;
    saveSimState();
    recomputeSimState();
    s->sendHeader("Location", "/"); s->send(302);
  });

  mvs.addEndpoint("/settank", []() {
    WebServer* s = mvs.getServer();
    float h = s->arg("h").toFloat();
    if (h >= 10 && h <= 500) {
      simTankHeight = h;
      saveSimState();
    }
    s->sendHeader("Location", "/"); s->send(302);
  });

  mvs.addEndpoint("/forcepush", []() {
    WebServer* s = mvs.getServer();
    if (firebaseReady) {
      pushLiveData();
      updateDeviceInfo(true);
      writeHistory();
    }
    s->sendHeader("Location", "/"); s->send(302);
  });

  mvs.addEndpoint("/restart", []() {
    WebServer* s = mvs.getServer();
    s->send(200, "text/html", "<h2>Restarting...</h2>");
    delay(800); ESP.restart();
  });

  mvs.addEndpoint("/setwifi", []() {
    WebServer* s = mvs.getServer();
    String ssid = s->arg("ssid"), pass = s->arg("pass");
    if (ssid.length() == 0) { s->send(400, "text/html", "SSID required"); return; }
    s->send(200, "text/html", "<h2>Connecting to " + ssid + "...</h2><script>setTimeout(()=>location.href='/',15000)</script>");
    manualWiFiInProgress = true; manualWiFiStart = millis();
    WiFi.disconnect(true); delay(1000);
    Preferences w; w.begin("mvsconnect", false);
    w.putString("ssid", ssid); w.putString("password", pass); w.putBool("valid", true); w.end();
    WiFi.begin(ssid.c_str(), pass.c_str());
  });

  mvs.addEndpoint("/sstatus", []() {
    WebServer* s = mvs.getServer();
    String j = "{";
    j += "\"code\":\"" + deviceCode + "\",";
    j += "\"mode\":" + String(simSensorType) + ",";
    j += "\"level\":" + String(confirmedPct) + ",";
    j += "\"bits\":" + String(sensorBits) + ",";
    j += "\"flags\":" + String(flags) + ",";
    j += "\"firebase\":" + String(firebaseReady ? "true" : "false") + ",";
    j += "\"history\":" + String(analyticsOn ? "true" : "false");
    j += "}";
    s->send(200, "application/json", j);
  });

  // Try saved WiFi
  if (mvs.hasSavedWiFi()) {
    Serial.println("Connecting saved WiFi...");
    setLED(0, 0, 255);
    if (mvs.connectToSavedWiFi(30)) {
      Serial.println("WiFi OK IP: " + WiFi.localIP().toString());
      setGoogleDNS();
      setLED(0, 255, 0);
      initFirebase();
    } else {
      setLED(255, 255, 255);
    }
  } else {
    setLED(255, 255, 255);
  }

  mvsota.begin(DEVICE_NAME, FIRMWARE_VERSION, FIRMWARE_CODE);
  ledCycleStart = millis();
}

// ══════════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════════
void loop() {
  unsigned long now = millis();

  mvs.handle();
  if (!mvsota.isUpdating()) mvsota.handle();

  // No sensor GPIO reads — state changes only via web UI → recomputeSimState()
  handleLED();

  // mDNS handled by MvsConnect library (<deviceName>-mvstech.local)

  // Internet check
  if (firebaseReady) {
    internetAvailable = true;
  } else if (WiFi.status() == WL_CONNECTED && (now - lastInternetCheck > 30000)) {
    lastInternetCheck = now;
    internetAvailable = checkInternet();
    if (internetAvailable) initFirebase();
  } else if (WiFi.status() != WL_CONNECTED) {
    internetAvailable = false;
  }

  // Firebase loop
  if (WiFi.status() == WL_CONNECTED) {
    checkFirebaseReady();
    if (firebaseReady) {
      if (hasDataChanged()) {
        Serial.printf("Data changed: bits=%d pct=%d flags=%d\n", sensorBits, confirmedPct, flags);
        if (pushLiveData()) {
          updateDeviceInfo(true);
          writeHistory();
        }
        handleLED();
      }
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        pushLiveData();
        updateDeviceInfo(true);
      }
      if (now - lastCommandCheck >= COMMAND_CHECK_INTERVAL) {
        lastCommandCheck = now;
        checkCommands();
      }
      if (now - lastConfigCheck >= CONFIG_CHECK_INTERVAL) {
        lastConfigCheck = now;
        checkConfig();
      }
    }
  } else {
    if (manualWiFiInProgress && (now - manualWiFiStart > 30000)) manualWiFiInProgress = false;
    static unsigned long lastRc = 0;
    if (!manualWiFiInProgress && (now - lastRc > 30000)) {
      lastRc = now;
      if (mvs.hasSavedWiFi()) {
        if (mvs.connectToSavedWiFi(10)) {
          setGoogleDNS();
          if (!firebaseReady) initFirebase();
        }
      }
    }
  }

  // Serial commands
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    String up = cmd; up.toUpperCase();
    if (up == "S" || up == "STATUS") {
      Serial.println("code=" + deviceCode + " mode=" + String(simSensorType) +
                     " pct=" + String(confirmedPct) + " bits=" + String(sensorBits, BIN) +
                     " history=" + String(analyticsOn ? "ON" : "off"));
    } else if (up.startsWith("WIFI ")) {
      String p = cmd.substring(5);
      int sp = p.indexOf(' ');
      String ssid = sp > 0 ? p.substring(0, sp) : p;
      String pass = sp > 0 ? p.substring(sp + 1) : "";
      ssid.trim(); pass.trim();
      if (ssid.length()) {
        Preferences w; w.begin("mvsconnect", false);
        w.putString("ssid", ssid); w.putString("password", pass); w.putBool("valid", true); w.end();
        Serial.println("Saved. Restarting.");
        delay(400); ESP.restart();
      }
    }
  }
}
