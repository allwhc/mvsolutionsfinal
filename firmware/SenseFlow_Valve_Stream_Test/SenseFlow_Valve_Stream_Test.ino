/*
 * SenseFlow Valve Stream Test v1.0.0
 *
 * SAME as Valve Simulator but uses Firebase RTDB Streaming
 * instead of polling for commands and config.
 *
 * Purpose: Test streaming vs polling side-by-side.
 * Identify this device by:
 *   - Device name: SenseFlow-VStream
 *   - Firmware code: SF-VST-2026-01
 *   - Web card: has "streamTest: true" in info → purple border
 *
 * Two FirebaseData objects:
 *   fbdo       — for writing (pushLiveData, updateDeviceInfo, clear commands)
 *   fbdoStream — persistent stream listener on /commands/ and /config/
 */

#include <WiFi.h>
#include <Preferences.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <MvsConnect.h>
#include <mvsota_esp32.h>
#include <FastLED_min.h>

// ══════════════════════════════════════════════════
//  FIREBASE CONFIG
// ══════════════════════════════════════════════════

#define FIREBASE_API_KEY      "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4"
#define FIREBASE_DB_URL       "https://senseflow-5a9bb-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_PROJECT_ID   "senseflow-5a9bb"

#define DEVICE_NAME       "SenseFlow-VStream"
#define FIRMWARE_VERSION  "1.0.0"
#define FIRMWARE_CODE     "SF-VST-2026-01"
#define AP_PASSWORD       "mvstech9867"

#define CLS_VALVE   0x01
#define SNS_NONE    0x00
#define SNS_DIP     0x01

#define LED_PIN  15

// Timing — NO command/config polling intervals needed!
#define HEARTBEAT_INTERVAL     300000   // 5 min
#define SIM_VALVE_TRAVEL_MS    3000     // Simulated valve travel

// DIP percent table
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

// Two Firebase objects — one for writes, one for stream
FirebaseData fbdo;         // writes (push data, clear commands)
FirebaseData fbdoStream;   // persistent stream listener
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;
bool firebaseReady = false;
bool streamStarted = false;

String deviceCode = "";
String apName = "";

// ── Valve state ─────────────────────────────────
enum ValveState {
  STATE_RECOVERY, STATE_OPENING, STATE_OPEN,
  STATE_CLOSING, STATE_CLOSED, STATE_FAULT, STATE_LS_ERROR
};

volatile ValveState valveState = STATE_CLOSED;
unsigned long valveTravelStart = 0;

// ── Simulated controls ──────────────────────────
volatile uint8_t simSensorCount = 4;
volatile uint8_t simSensorBits = 0;
volatile bool    simFault = false;

// ── Auto mode ───────────────────────────────────
bool    autoMode   = false;
uint8_t minPercent = 25;
uint8_t maxPercent = 75;

// ── Sensor state ────────────────────────────────
uint8_t sensorBits = 0;
uint8_t confirmedPct = 0;
uint8_t flags = 0;
bool    sensorError = false;

// ── Last sent ───────────────────────────────────
uint8_t lastSentValveState = 0xFF;
uint8_t lastSentBits = 0xFF;
uint8_t lastSentPct = 0xFF;
uint8_t lastSentFlags = 0xFF;

// ── Timing ──────────────────────────────────────
unsigned long lastHeartbeat = 0;

// ── Stream stats ────────────────────────────────
unsigned long streamEventsReceived = 0;
unsigned long streamCommandsExecuted = 0;
unsigned long streamLastEventTime = 0;

// Manual WiFi
bool manualWiFiInProgress = false;
unsigned long manualWiFiStart = 0;

// Push fail
int consecutiveFailCount = 0;
bool pushFailFlash = false;
unsigned long pushFailFlashStart = 0;
unsigned long lastSuccessfulPush = 0;

// LED
CRGB rgbLeds[1];
bool internetAvailable = false;
unsigned long lastInternetCheck = 0;
unsigned long ledCycleStart = 0;
bool ledShowingWifi = false;
unsigned long wifiBlinkStart = 0;
bool testBlinkActive = false;
unsigned long testBlinkStart = 0;

// ══════════════════════════════════════════════════
//  DEVICE CODE
// ══════════════════════════════════════════════════

String generateRandomCode() {
  const char charset[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  String code = "SF-";
  for (int i = 0; i < 8; i++) code += charset[random(0, 36)];
  code += "-SN";
  return code;
}

void loadOrCreateDeviceCode() {
  prefs.begin("senseflow", false);
  deviceCode = prefs.getString("devcode", "");
  if (deviceCode.length() == 0) {
    randomSeed(esp_random());
    deviceCode = generateRandomCode();
    prefs.putString("devcode", deviceCode);
  }
  autoMode   = prefs.getBool("automode", false);
  minPercent = prefs.getUChar("minpct", 25);
  maxPercent = prefs.getUChar("maxpct", 75);
  prefs.end();
  if (minPercent >= maxPercent) { minPercent = 25; maxPercent = 75; }

  apName = DEVICE_NAME;
  apName += "-";
  apName += deviceCode.substring(3, 7);
  apName += "_mvstech";
  mvs.setDeviceName(String(DEVICE_NAME) + "-" + deviceCode.substring(3, 7));
}

void saveConfig() {
  prefs.begin("senseflow", false);
  prefs.putBool("automode", autoMode);
  prefs.putUChar("minpct", minPercent);
  prefs.putUChar("maxpct", maxPercent);
  prefs.end();
}

void printRegistrationInfo() {
  Serial.println("\n========================================");
  Serial.println("  SENSEFLOW VALVE STREAM TEST");
  Serial.println("========================================");
  Serial.print("  Code:       "); Serial.println(deviceCode);
  Serial.println("  Class:      VALVE (0x01)");
  Serial.print("  Sensors:    "); Serial.println(simSensorCount);
  Serial.println("  Transport:  FIREBASE STREAM (not polling)");
  Serial.print("  Firmware:   "); Serial.println(FIRMWARE_VERSION);
  Serial.println("========================================\n");
}

// ══════════════════════════════════════════════════
//  DNS + INTERNET
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

// ══════════════════════════════════════════════════
//  LED
// ══════════════════════════════════════════════════

void setLED(uint8_t r, uint8_t g, uint8_t b) {
  rgbLeds[0] = CRGB(r, g, b); FastLED_min<LED_PIN>.show();
}
void setLEDOff() { setLED(0, 0, 0); }

void setLevelColor(uint8_t pct) {
  if (pct == 0)       setLED(255, 0, 0);
  else if (pct <= 25) setLED(255, 80, 0);
  else if (pct <= 50) setLED(255, 200, 0);
  else if (pct <= 75) setLED(0, 229, 255);
  else                setLED(0, 200, 0);
}

void handleLED() {
  unsigned long now = millis();
  if (pushFailFlash) {
    if (now - pushFailFlashStart < 500) { setLED(255, 0, 0); return; }
    else { pushFailFlash = false; }
  }
  if (testBlinkActive) {
    unsigned long elapsed = now - testBlinkStart;
    if (elapsed < 1800) {
      int phase = (elapsed / 200) % 3;
      if (phase == 0) setLED(255, 0, 0);
      else if (phase == 1) setLED(0, 255, 0);
      else setLED(0, 0, 255);
    } else { testBlinkActive = false; }
    return;
  }
  unsigned long cycleElapsed = now - ledCycleStart;
  if (cycleElapsed >= 35000) { ledCycleStart = now; ledShowingWifi = false; }
  if (cycleElapsed >= 30000) {
    if (!ledShowingWifi) { ledShowingWifi = true; wifiBlinkStart = now; }
    int bp = ((now - wifiBlinkStart) / 250) % 2;
    if (WiFi.status() != WL_CONNECTED) { if (bp == 0) setLED(255, 255, 255); else setLEDOff(); }
    else if (!internetAvailable) { if (bp == 0) setLED(255, 0, 100); else setLEDOff(); }
    else { if (bp == 0) setLED(0, 0, 255); else setLEDOff(); }
  } else {
    ledShowingWifi = false;
    if (simSensorCount > 0) {
      if (sensorError) setLED(148, 51, 234); else setLevelColor(confirmedPct);
    } else {
      if (valveState == STATE_OPEN) setLED(0, 200, 0);
      else if (valveState == STATE_CLOSED) setLED(255, 0, 0);
      else if (valveState == STATE_FAULT) setLED(148, 51, 234);
      else setLED(0, 0, 255);
    }
  }
}

// ══════════════════════════════════════════════════
//  VALVE + SENSOR SIMULATION
// ══════════════════════════════════════════════════

String stateName(ValveState s) {
  switch (s) {
    case STATE_RECOVERY: return "RECOVERY"; case STATE_OPENING: return "OPENING";
    case STATE_OPEN: return "OPEN"; case STATE_CLOSING: return "CLOSING";
    case STATE_CLOSED: return "CLOSED"; case STATE_FAULT: return "FAULT";
    case STATE_LS_ERROR: return "LS_ERROR"; default: return "UNKNOWN";
  }
}

int countConsecutive(uint8_t bits, int count) {
  int c = 0;
  for (int i = 0; i < count; i++) { if (bits & (1 << i)) c++; else break; }
  return c;
}

bool checkSensorError(uint8_t bits, int count) {
  int total = 0;
  for (int i = 0; i < count; i++) { if (bits & (1 << i)) total++; }
  return (total != countConsecutive(bits, count));
}

uint8_t bitsToPercent(uint8_t bits, int count) {
  int c = countConsecutive(bits, count);
  if (c == 0) return 0;
  if (count >= 1 && count <= 6) return DIP_PCT_TABLE[count][c - 1];
  return 0;
}

void processSimulatedSensors() {
  if (simSensorCount > 0) {
    sensorBits = simSensorBits & ((1 << simSensorCount) - 1);
    sensorError = checkSensorError(sensorBits, simSensorCount);
    if (sensorError) flags |= 0x01; else flags &= ~0x01;
    confirmedPct = bitsToPercent(sensorBits, simSensorCount);
  } else {
    sensorBits = 0; sensorError = false; confirmedPct = 0; flags &= ~0x01;
  }
}

void executeValveCommand(char cmd) {
  if (valveState == STATE_FAULT || valveState == STATE_LS_ERROR) return;
  if ((cmd == 'O' || cmd == 'o') && valveState != STATE_OPEN && valveState != STATE_OPENING) {
    valveState = STATE_OPENING; valveTravelStart = millis();
    Serial.println("[STREAM] Valve opening...");
  }
  if ((cmd == 'C' || cmd == 'c') && valveState != STATE_CLOSED && valveState != STATE_CLOSING) {
    valveState = STATE_CLOSING; valveTravelStart = millis();
    Serial.println("[STREAM] Valve closing...");
  }
}

void processSimulatedValve() {
  if (simFault && valveState != STATE_FAULT) { valveState = STATE_FAULT; return; }
  if (valveState == STATE_OPENING && millis() - valveTravelStart >= SIM_VALVE_TRAVEL_MS) {
    valveState = STATE_OPEN; Serial.println("[SIM] OPEN");
  }
  if (valveState == STATE_CLOSING && millis() - valveTravelStart >= SIM_VALVE_TRAVEL_MS) {
    valveState = STATE_CLOSED; Serial.println("[SIM] CLOSED");
  }
}

void evaluateAutoMode() {
  if (!autoMode || simSensorCount == 0 || sensorError) return;
  if (valveState != STATE_OPEN && valveState != STATE_CLOSED) return;
  if (valveState == STATE_CLOSED && confirmedPct <= minPercent) executeValveCommand('O');
  if (valveState == STATE_OPEN && confirmedPct >= maxPercent) executeValveCommand('C');
}

// ══════════════════════════════════════════════════
//  FIREBASE — WRITE OPERATIONS (using fbdo)
// ══════════════════════════════════════════════════

void initFirebase() {
  if (WiFi.status() == WL_CONNECTED) setGoogleDNS();
  fbConfig.api_key = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;
  fbConfig.token_status_callback = tokenStatusCallback;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectNetwork(true);
  if (Firebase.signUp(&fbConfig, &fbAuth, "", "")) {
    Serial.println("[FB] Anonymous auth OK!");
  } else {
    Serial.println("[FB] Auth FAILED");
  }
}

void buildFlags() {
  flags = 0;
  if (sensorError)                   flags |= 0x01;
  if (valveState == STATE_FAULT)     flags |= 0x02;
  if (valveState == STATE_OPENING)   flags |= 0x04;
  if (valveState == STATE_CLOSING)   flags |= 0x08;
  if (autoMode)                      flags |= 0x10;
}

void writePendingDevice() {
  String path = "pendingDevices/" + deviceCode;
  FirebaseJson json;
  json.set("deviceClass", CLS_VALVE);
  json.set("sensorType", simSensorCount > 0 ? SNS_DIP : SNS_NONE);
  json.set("sensorCount", (int)simSensorCount);
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("macAddress", WiFi.macAddress());
  json.set("simulator", true);
  json.set("streamTest", true);
  json.set("firstSeenAt/.sv", "timestamp");
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

bool pushLiveData() {
  buildFlags();
  String path = "devices/" + deviceCode + "/live";
  FirebaseJson json;
  json.set("valveState", (int)valveState);
  json.set("sensorBits", sensorBits);
  json.set("confirmedPct", confirmedPct);
  json.set("flags", flags);
  json.set("rssi", WiFi.RSSI());
  json.set("timestamp/.sv", "timestamp");

  if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    lastSentValveState = (uint8_t)valveState;
    lastSentBits = sensorBits;
    lastSentPct = confirmedPct;
    lastSentFlags = flags;
    consecutiveFailCount = 0;
    lastSuccessfulPush = millis();
    return true;
  }
  consecutiveFailCount++;
  pushFailFlash = true; pushFailFlashStart = millis();
  if (consecutiveFailCount >= 5) {
    firebaseReady = false; internetAvailable = false; consecutiveFailCount = 0;
  }
  return false;
}

void updateDeviceInfo(bool online) {
  String path = "devices/" + deviceCode + "/info";
  FirebaseJson json;
  json.set("online", online);
  json.set("lastSeen/.sv", "timestamp");
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("deviceClass", CLS_VALVE);
  json.set("sensorType", simSensorCount > 0 ? SNS_DIP : SNS_NONE);
  json.set("sensorCount", (int)simSensorCount);
  json.set("streamTest", true);  // Flag for web to show purple border
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

void pushConfigToFirebase() {
  String path = "devices/" + deviceCode + "/config";
  FirebaseJson json;
  json.set("autoMode", autoMode);
  json.set("minPercent", minPercent);
  json.set("maxPercent", maxPercent);
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

bool hasDataChanged() {
  buildFlags();
  return ((uint8_t)valveState != lastSentValveState ||
          sensorBits != lastSentBits ||
          confirmedPct != lastSentPct ||
          flags != lastSentFlags);
}

// ══════════════════════════════════════════════════
//  FIREBASE STREAM — THE KEY DIFFERENCE
//  Listens to BOTH /commands/ and /config/ under
//  the device path. Any change triggers instantly.
// ══════════════════════════════════════════════════

void startStream() {
  // Stream the entire device node — catches commands + config changes
  String path = "devices/" + deviceCode;
  if (Firebase.RTDB.beginStream(&fbdoStream, path.c_str())) {
    streamStarted = true;
    Serial.println("[STREAM] Started listening on: " + path);
  } else {
    Serial.println("[STREAM] Failed to start: " + fbdoStream.errorReason());
    streamStarted = false;
  }
}

void handleStream() {
  if (!streamStarted) return;

  if (!Firebase.RTDB.readStream(&fbdoStream)) {
    Serial.println("[STREAM] Read error: " + fbdoStream.errorReason());
    // Stream broken — restart it
    streamStarted = false;
    return;
  }

  if (!fbdoStream.streamAvailable()) return;

  // We got data!
  streamEventsReceived++;
  streamLastEventTime = millis();

  String path = fbdoStream.dataPath();   // e.g., "/commands/openRequested" or "/config/autoMode"
  String type = fbdoStream.dataType();

  Serial.printf("[STREAM] Event #%lu — path=%s type=%s\n",
    streamEventsReceived, path.c_str(), type.c_str());

  // ── Handle commands ──────────────────────────
  if (path == "/commands/openRequested" && type == "boolean" && fbdoStream.boolData()) {
    Serial.println("[STREAM] >> OPEN command received instantly!");
    executeValveCommand('O');
    Firebase.RTDB.setBool(&fbdo, ("devices/" + deviceCode + "/commands/openRequested").c_str(), false);
    pushLiveData();
    streamCommandsExecuted++;
  }
  else if (path == "/commands/closeRequested" && type == "boolean" && fbdoStream.boolData()) {
    Serial.println("[STREAM] >> CLOSE command received instantly!");
    executeValveCommand('C');
    Firebase.RTDB.setBool(&fbdo, ("devices/" + deviceCode + "/commands/closeRequested").c_str(), false);
    pushLiveData();
    streamCommandsExecuted++;
  }
  else if (path == "/commands/refreshRequested" && type == "boolean" && fbdoStream.boolData()) {
    pushLiveData();
    Firebase.RTDB.setBool(&fbdo, ("devices/" + deviceCode + "/commands/refreshRequested").c_str(), false);
    streamCommandsExecuted++;
  }
  else if (path == "/commands/testRequested" && type == "boolean" && fbdoStream.boolData()) {
    testBlinkActive = true; testBlinkStart = millis();
    Firebase.RTDB.setBool(&fbdo, ("devices/" + deviceCode + "/commands/testRequested").c_str(), false);
    streamCommandsExecuted++;
  }
  else if (path == "/commands/restartRequested" && type == "boolean" && fbdoStream.boolData()) {
    Firebase.RTDB.setBool(&fbdo, ("devices/" + deviceCode + "/commands/restartRequested").c_str(), false);
    updateDeviceInfo(false); delay(500); ESP.restart();
  }

  // ── Handle config changes ────────────────────
  else if (path == "/config/autoMode" && type == "boolean") {
    bool v = fbdoStream.boolData();
    if (v != autoMode) {
      autoMode = v;
      saveConfig();
      Serial.printf("[STREAM] >> autoMode changed to %s\n", autoMode ? "ON" : "OFF");
    }
  }
  else if (path == "/config/minPercent" && type == "int") {
    uint8_t v = (uint8_t)fbdoStream.intData();
    if (v != minPercent && v < maxPercent) {
      minPercent = v; saveConfig();
      Serial.printf("[STREAM] >> minPercent changed to %d%%\n", minPercent);
    }
  }
  else if (path == "/config/maxPercent" && type == "int") {
    uint8_t v = (uint8_t)fbdoStream.intData();
    if (v != maxPercent && v > minPercent) {
      maxPercent = v; saveConfig();
      Serial.printf("[STREAM] >> maxPercent changed to %d%%\n", maxPercent);
    }
  }

  // ── Handle bulk config write (when web sets entire /config/ at once) ──
  else if (path == "/config" && type == "json") {
    // Parse bulk config from stream JSON string
    FirebaseJson json;
    json.setJsonData(fbdoStream.to<String>());
    FirebaseJsonData r;
    bool changed = false;
    if (json.get(r, "autoMode") && r.type == "boolean" && r.boolValue != autoMode) {
      autoMode = r.boolValue; changed = true;
    }
    if (json.get(r, "minPercent") && r.type == "int" && (uint8_t)r.intValue != minPercent) {
      minPercent = (uint8_t)r.intValue; changed = true;
    }
    if (json.get(r, "maxPercent") && r.type == "int" && (uint8_t)r.intValue != maxPercent) {
      maxPercent = (uint8_t)r.intValue; changed = true;
    }
    if (changed) {
      saveConfig();
      Serial.printf("[STREAM] >> Config bulk update: auto=%s min=%d%% max=%d%%\n",
        autoMode ? "ON" : "OFF", minPercent, maxPercent);
    }
  }
}

// ══════════════════════════════════════════════════
//  WEB UI
// ══════════════════════════════════════════════════

String buildCustomHTML() {
  String html = R"rawliteral(
<!DOCTYPE html><html><head>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>Valve Stream Test</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#1a1a2e;color:#eee;padding:12px}
.card{background:#16213e;border-radius:12px;padding:14px;margin-bottom:10px}
h1{font-size:18px;color:#a855f7;margin-bottom:2px}
h2{font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:8px}
.code{font-family:monospace;font-size:16px;color:#c084fc;letter-spacing:1px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;color:#fff}
.row{display:flex;justify-content:space-between;padding:5px 0;font-size:12px;border-bottom:1px solid #1e3a5f}
.row:last-child{border:none}
.label{color:#64748b}
.val{color:#e2e8f0;font-weight:600}
.dip-row{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}
.dip-btn{width:44px;height:44px;border-radius:50%;border:3px solid #334155;font-size:12px;font-weight:bold;cursor:pointer}
.dip-on{background:#3b82f6;border-color:#60a5fa;color:#fff}
.dip-off{background:#1e293b;border-color:#334155;color:#64748b}
.dip-err{background:#a855f7;border-color:#c084fc;color:#fff}
.pct{font-size:28px;font-weight:bold;text-align:center;margin:8px 0}
.pct-bar{height:8px;background:#1e293b;border-radius:4px;overflow:hidden;margin:6px 0}
.pct-fill{height:100%;border-radius:4px;transition:width 0.3s}
select{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 10px;border-radius:6px;font-size:12px}
.btn{display:inline-block;padding:8px 16px;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;margin:3px}
.btn-blue{background:#2563eb;color:#fff}
.btn-red{background:#dc2626;color:#fff}
.btn-green{background:#16a34a;color:#fff}
.btn-gray{background:#334155;color:#cbd5e1}
.btn-purple{background:#7c3aed;color:#fff}
.stream-badge{background:#a855f7;color:#fff;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;display:inline-block;margin:4px 0}
</style></head><body>
)rawliteral";

  // WiFi status
  if (WiFi.status() == WL_CONNECTED) {
    html += "<div style='background:#064e3b;border:1px solid #059669;border-radius:10px;padding:10px 14px;margin-bottom:10px'>";
    html += "<div style='font-size:12px;font-weight:700;color:#ecfdf5'>WiFi Connected — " + WiFi.SSID() + "</div></div>";
  } else {
    html += "<div style='background:#451a03;border:1px solid #92400e;border-radius:10px;padding:10px 14px;margin-bottom:10px'>";
    html += "<div style='font-size:12px;font-weight:700;color:#fef2f2'>WiFi Not Connected</div></div>";
  }

  // Header — purple themed
  html += "<div class='card' style='border:2px solid #a855f7'>";
  html += "<h1>Valve Stream Test</h1>";
  html += "<p class='code'>" + deviceCode + "</p>";
  html += "<div class='stream-badge'>STREAM MODE — NOT POLLING</div>";
  html += "</div>";

  // Stream stats — unique to this firmware
  html += "<div class='card' style='border-left:3px solid #a855f7'>";
  html += "<h2>Stream Stats</h2>";
  html += "<div class='row'><span class='label'>Stream Active</span><span class='val'>" + String(streamStarted ? "YES" : "NO") + "</span></div>";
  html += "<div class='row'><span class='label'>Events Received</span><span class='val'>" + String(streamEventsReceived) + "</span></div>";
  html += "<div class='row'><span class='label'>Commands Executed</span><span class='val'>" + String(streamCommandsExecuted) + "</span></div>";
  html += "<div class='row'><span class='label'>Last Event</span><span class='val'>" +
    (streamLastEventTime > 0 ? String((millis() - streamLastEventTime) / 1000) + "s ago" : "Never") + "</span></div>";
  html += "<div class='row'><span class='label'>Polling Reads</span><span class='val' style='color:#22c55e'>ZERO</span></div>";
  html += "</div>";

  // Valve state
  String stColor = valveState == STATE_OPEN ? "#27ae60" : valveState == STATE_CLOSED ? "#e74c3c" : valveState == STATE_FAULT ? "#e67e22" : "#3498db";
  html += "<div class='card' style='text-align:center'>";
  html += "<h2>VALVE</h2>";
  html += "<div style='font-size:32px;font-weight:bold;color:" + stColor + "'>" + stateName(valveState) + "</div>";
  html += "<div style='margin-top:8px'>";
  html += "<a href='/api/valve?cmd=open'><button class='btn btn-green'>OPEN</button></a>";
  html += "<a href='/api/valve?cmd=close'><button class='btn btn-red'>CLOSE</button></a>";
  html += "</div>";
  html += "<div style='margin-top:6px'>";
  html += "<a href='/api/set-error?type=fault'><button class='btn btn-purple'>Fault</button></a>";
  html += "<a href='/api/clear-error'><button class='btn btn-gray'>Clear</button></a>";
  html += "</div></div>";

  // Sensor config
  html += "<div class='card'>";
  html += "<form action='/api/set-mode' method='GET' style='display:flex;gap:8px;align-items:center'>";
  html += "<select name='count'>";
  html += "<option value='0'" + String(simSensorCount == 0 ? " selected" : "") + ">No Sensors</option>";
  for (int i = 1; i <= 6; i++) {
    html += "<option value='" + String(i) + "'" + String(simSensorCount == i ? " selected" : "") + ">" + String(i) + " sensors</option>";
  }
  html += "</select><button class='btn btn-blue' type='submit'>Apply</button></form></div>";

  // DIP
  if (simSensorCount > 0) {
    html += "<div class='card'>";
    html += "<div class='dip-row'>";
    for (int i = 0; i < simSensorCount; i++) {
      bool on = (simSensorBits >> i) & 1;
      html += "<a href='/api/toggle-dip?bit=" + String(i) + "'><div class='dip-btn " + String(sensorError ? "dip-err" : (on ? "dip-on" : "dip-off")) + "'>" + String(i + 1) + "</div></a>";
    }
    html += "</div>";
    html += "<div class='pct'>" + String(confirmedPct) + "%</div>";
    html += "</div>";
  }

  // Status
  html += "<div class='card'>";
  html += "<div class='row'><span class='label'>Firebase</span><span class='val'>" + String(firebaseReady ? "Ready" : "Not ready") + "</span></div>";
  html += "<div class='row'><span class='label'>Auto</span><span class='val'>" + String(autoMode ? "ON" : "OFF") + " (" + String(minPercent) + "-" + String(maxPercent) + "%)</span></div>";
  html += "<div class='row'><span class='label'>Last Push</span><span class='val'>" +
    (lastSuccessfulPush > 0 ? String((millis() - lastSuccessfulPush) / 1000) + "s ago" : "Never") + "</span></div>";
  html += "</div>";

  // Actions
  html += "<div class='card'>";
  html += "<a href='/api/force-push'><button class='btn btn-blue'>Force Push</button></a>";
  html += "<a href='/restart'><button class='btn btn-red'>Restart</button></a>";
  html += "</div>";

  // WiFi
  html += "<div class='card'>";
  html += "<form action='/setwifi' method='GET'>";
  html += "<input type='text' name='ssid' placeholder='SSID' style='width:100%;margin-bottom:6px;padding:8px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;font-size:12px' required>";
  html += "<input type='password' name='pass' placeholder='Password' style='width:100%;padding:8px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;font-size:12px'>";
  html += "<button class='btn btn-green' type='submit' style='width:100%;margin-top:8px'>Connect</button></form></div>";

  html += "<script>setInterval(()=>{if(!document.activeElement||document.activeElement.tagName==='BODY')location.reload()},5000)</script>";
  html += "</body></html>";
  return html;
}

// ══════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== SenseFlow Valve STREAM TEST v" FIRMWARE_VERSION " ===\n");

  FastLED_min<LED_PIN>.addLeds(rgbLeds, 1);
  FastLED_min<LED_PIN>.setBrightness(80);
  setLED(255, 100, 0);

  loadOrCreateDeviceCode();
  printRegistrationInfo();

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), AP_PASSWORD);

  mvs.setCustomHTML([](){ return buildCustomHTML(); });
  mvs.onWiFiCredentialsReceived([](const String& ssid) { WiFi.disconnect(false); delay(200); });
  mvs.begin();

  mvs.addEndpoint("/setwifi", []() {
    WebServer* srv = mvs.getServer();
    String ssid = srv->arg("ssid"), pass = srv->arg("pass");
    if (ssid.length() == 0) { srv->send(400, "text/html", "SSID required"); return; }
    srv->send(200, "text/html", "<html><body style='background:#1a1a2e;color:#fff;text-align:center;padding:40px'><h2>Connecting...</h2><script>setTimeout(()=>location.href='/',15000)</script></body></html>");
    manualWiFiInProgress = true; manualWiFiStart = millis();
    WiFi.disconnect(true); delay(1000);
    Preferences wp; wp.begin("mvsconnect", false);
    wp.putString("ssid", ssid); wp.putString("password", pass); wp.putBool("valid", true); wp.end();
    WiFi.begin(ssid.c_str(), pass.c_str());
  });

  mvs.addEndpoint("/restart", []() {
    mvs.getServer()->send(200, "text/html", "<html><body style='background:#1a1a2e;color:#fff;text-align:center;padding:40px'><h2>Restarting...</h2></body></html>");
    delay(1000); ESP.restart();
  });

  mvs.addEndpoint("/api/valve", []() {
    String cmd = mvs.getServer()->arg("cmd");
    if (cmd == "open") executeValveCommand('O');
    else if (cmd == "close") executeValveCommand('C');
    mvs.getServer()->sendHeader("Location", "/"); mvs.getServer()->send(302);
  });

  mvs.addEndpoint("/api/toggle-dip", []() {
    int bit = mvs.getServer()->arg("bit").toInt();
    if (bit >= 0 && bit < 6) simSensorBits ^= (1 << bit);
    mvs.getServer()->sendHeader("Location", "/"); mvs.getServer()->send(302);
  });

  mvs.addEndpoint("/api/set-mode", []() {
    simSensorCount = constrain(mvs.getServer()->arg("count").toInt(), 0, 6);
    simSensorBits = 0;
    mvs.getServer()->sendHeader("Location", "/"); mvs.getServer()->send(302);
  });

  mvs.addEndpoint("/api/set-error", []() {
    String type = mvs.getServer()->arg("type");
    if (type == "dip") simSensorBits = 0b00000101;
    else if (type == "fault") simFault = true;
    mvs.getServer()->sendHeader("Location", "/"); mvs.getServer()->send(302);
  });

  mvs.addEndpoint("/api/clear-error", []() {
    simFault = false; simSensorBits = 0;
    if (valveState == STATE_FAULT || valveState == STATE_LS_ERROR) valveState = STATE_CLOSED;
    mvs.getServer()->sendHeader("Location", "/"); mvs.getServer()->send(302);
  });

  mvs.addEndpoint("/api/force-push", []() {
    if (firebaseReady) { pushLiveData(); updateDeviceInfo(true); }
    mvs.getServer()->sendHeader("Location", "/"); mvs.getServer()->send(302);
  });

  mvs.addEndpoint("/api/setconfig", []() {
    if (mvs.getServer()->hasArg("auto")) {
      autoMode = (mvs.getServer()->arg("auto").toInt() != 0);
      saveConfig();
      if (firebaseReady) pushConfigToFirebase();
    }
    mvs.getServer()->sendHeader("Location", "/"); mvs.getServer()->send(302);
  });

  // Connect WiFi
  if (mvs.hasSavedWiFi()) {
    setLED(0, 0, 255);
    if (mvs.connectToSavedWiFi(30)) {
      setGoogleDNS(); setLED(0, 255, 0); initFirebase();
    } else { setLED(255, 255, 255); }
  } else { setLED(255, 255, 255); }

  mvsota.begin(DEVICE_NAME, FIRMWARE_VERSION, FIRMWARE_CODE);
  ledCycleStart = millis();
}

// ══════════════════════════════════════════════════
//  LOOP — NO POLLING! Stream handles commands/config
// ══════════════════════════════════════════════════

void loop() {
  unsigned long now = millis();
  mvs.handle();
  if (!mvsota.isUpdating()) mvsota.handle();

  processSimulatedSensors();
  processSimulatedValve();
  handleLED();
  evaluateAutoMode();

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

  // Firebase
  if (WiFi.status() == WL_CONNECTED) {
    if (Firebase.ready()) {
      if (!firebaseReady) {
        firebaseReady = true;
        Serial.println("Firebase ready!");
        writePendingDevice();
        buildFlags();
        pushLiveData();
        updateDeviceInfo(true);
        pushConfigToFirebase();
        // START STREAM — this is where the magic happens
        startStream();
      }

      // Process stream events (non-blocking)
      handleStream();

      // Restart stream if it died
      if (!streamStarted && firebaseReady) {
        static unsigned long lastStreamRetry = 0;
        if (now - lastStreamRetry > 10000) {
          lastStreamRetry = now;
          Serial.println("[STREAM] Reconnecting...");
          startStream();
        }
      }

      // Change-driven data push (same as before)
      if (hasDataChanged()) {
        if (pushLiveData()) updateDeviceInfo(true);
        handleLED();
      }

      // Heartbeat only — NO command/config polling!
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        pushLiveData(); handleLED();
        updateDeviceInfo(true); handleLED();
      }
    }
  } else {
    if (manualWiFiInProgress && (now - manualWiFiStart > 30000)) manualWiFiInProgress = false;
    static unsigned long lastReconnect = 0;
    if (!manualWiFiInProgress && (now - lastReconnect > 30000)) {
      lastReconnect = now;
      if (mvs.hasSavedWiFi()) {
        if (mvs.connectToSavedWiFi(10)) {
          setGoogleDNS();
          if (!firebaseReady) initFirebase();
        }
      }
    }
    // Stream dies when WiFi drops
    streamStarted = false;
  }

  // Serial
  if (Serial.available()) {
    char cmd = Serial.read();
    if (cmd == '\n' || cmd == '\r') return;
    switch (cmd) {
      case 'O': case 'o': executeValveCommand('O'); break;
      case 'C': case 'c': executeValveCommand('C'); break;
      case 'S': case 's':
        Serial.println("\n--- Valve Stream Test ---");
        Serial.println("Code:       " + deviceCode);
        Serial.println("Valve:      " + stateName(valveState));
        Serial.printf("Level:      %d%% sensors=%d\n", confirmedPct, simSensorCount);
        Serial.printf("Auto:       %s min=%d%% max=%d%%\n", autoMode ? "ON" : "OFF", minPercent, maxPercent);
        Serial.println("Firebase:   " + String(firebaseReady ? "Ready" : "Not ready"));
        Serial.printf("Stream:     %s events=%lu cmds=%lu\n",
          streamStarted ? "ACTIVE" : "DOWN", streamEventsReceived, streamCommandsExecuted);
        Serial.println("-------------------------\n");
        break;
      default: Serial.println("O=open C=close S=status"); break;
    }
  }
}
