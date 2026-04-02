/*
 * SenseFlow Valve Simulator v1.0.0
 *
 * Simulates a SenseFlow valve + sensor device WITHOUT real hardware.
 * Virtual DIP sensors + virtual valve controlled from AP web page.
 * Pushes real data to Firebase for end-to-end testing.
 *
 * Features:
 *   - Toggle DIP sensors on/off from web UI
 *   - Open/Close valve from web UI buttons
 *   - Switch sensor count (0-6) at runtime
 *   - Auto mode with configurable thresholds
 *   - Trigger sensor errors (non-consecutive DIP)
 *   - Trigger valve faults from web UI
 *   - All Firebase behavior identical to real valve firmware
 *   - Config sync from Firebase /config/ (web dashboard changes)
 *
 * Device Code: SF-XXXXXXXX-SN (generated once, stored in NVS)
 * Device Class: 0x01 (Valve)
 */

#include <WiFi.h>
#include <ESPmDNS.h>
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

#define DEVICE_NAME       "SenseFlow-ValveSim"
#define FIRMWARE_VERSION  "1.0.0"
#define FIRMWARE_CODE     "SF-VSM-2026-01"
#define AP_PASSWORD       "mvstech9867"

// Device classes
#define CLS_VALVE   0x01
#define CLS_SENSOR  0x02
#define CLS_MOTOR   0x03

// Sensor types
#define SNS_NONE  0x00
#define SNS_DIP   0x01

// LED
#define LED_PIN  15

// Timing
#define HEARTBEAT_INTERVAL     300000
#define COMMAND_CHECK_INTERVAL  5000
#define CONFIG_CHECK_INTERVAL   5000

// Simulated valve travel time (ms)
#define SIM_VALVE_TRAVEL_MS    3000

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

FirebaseData fbdo;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;
bool firebaseReady = false;

String deviceCode = "";
String apName = "";

// ── Valve state ─────────────────────────────────
enum ValveState {
  STATE_RECOVERY,   // 0
  STATE_OPENING,    // 1
  STATE_OPEN,       // 2
  STATE_CLOSING,    // 3
  STATE_CLOSED,     // 4
  STATE_FAULT,      // 5
  STATE_LS_ERROR    // 6
};

volatile ValveState valveState = STATE_CLOSED;
unsigned long valveTravelStart = 0;  // When opening/closing started

// ── Simulated controls (from web UI) ────────────
volatile uint8_t simSensorCount = 4;    // 0-6 (0 = valve only)
volatile uint8_t simSensorBits = 0;     // DIP bit pattern
volatile bool    simFault = false;      // Trigger fault from UI

// ── Auto mode config ────────────────────────────
bool    autoMode   = false;
uint8_t minPercent = 25;
uint8_t maxPercent = 75;

// ── Derived state ───────────────────────────────
uint8_t sensorBits = 0;
uint8_t confirmedPct = 0;
uint8_t flags = 0;
bool    sensorError = false;

// ── Last sent values ────────────────────────────
uint8_t lastSentValveState = 0xFF;
uint8_t lastSentBits = 0xFF;
uint8_t lastSentPct = 0xFF;
uint8_t lastSentFlags = 0xFF;

// ── Timing ──────────────────────────────────────
unsigned long lastHeartbeat = 0;
unsigned long lastCommandCheck = 0;
unsigned long lastConfigCheck = 0;

// Manual WiFi flag
bool manualWiFiInProgress = false;
unsigned long manualWiFiStart = 0;

// mDNS
bool mdnsStarted = false;
String mdnsName = "";

// Push fail tracking
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

  mdnsName = "senseflow-vsim-" + deviceCode.substring(3, 7);
  mdnsName.toLowerCase();
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
  Serial.println("  SENSEFLOW VALVE SIMULATOR");
  Serial.println("========================================");
  Serial.print("  Code:       "); Serial.println(deviceCode);
  Serial.println("  Class:      VALVE (0x01)");
  Serial.print("  Sensors:    "); Serial.println(simSensorCount);
  Serial.print("  Firmware:   "); Serial.println(FIRMWARE_VERSION);
  Serial.print("  MAC:        "); Serial.println(WiFi.macAddress());
  Serial.println("  Mode:       SIMULATOR");
  Serial.println("========================================\n");
}

// ══════════════════════════════════════════════════
//  DNS + INTERNET
// ══════════════════════════════════════════════════

void setGoogleDNS() {
  IPAddress dns1(8, 8, 8, 8), dns2(8, 8, 4, 4);
  WiFi.config(WiFi.localIP(), WiFi.gatewayIP(), WiFi.subnetMask(), dns1, dns2);
  Serial.println("DNS set to 8.8.8.8");
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
    int blinkPhase = ((now - wifiBlinkStart) / 250) % 2;
    if (WiFi.status() != WL_CONNECTED) {
      if (blinkPhase == 0) setLED(255, 255, 255); else setLEDOff();
    } else if (!internetAvailable) {
      if (blinkPhase == 0) setLED(255, 0, 100); else setLEDOff();
    } else {
      if (blinkPhase == 0) setLED(0, 0, 255); else setLEDOff();
    }
  } else {
    ledShowingWifi = false;
    if (simSensorCount > 0) {
      if (sensorError) setLED(148, 51, 234);
      else setLevelColor(confirmedPct);
    } else {
      // No sensor — show valve state color
      if (valveState == STATE_OPEN) setLED(0, 200, 0);
      else if (valveState == STATE_CLOSED) setLED(255, 0, 0);
      else if (valveState == STATE_FAULT || valveState == STATE_LS_ERROR) setLED(148, 51, 234);
      else setLED(0, 0, 255);
    }
  }
}

// ══════════════════════════════════════════════════
//  VALVE STATE NAME
// ══════════════════════════════════════════════════

String stateName(ValveState s) {
  switch (s) {
    case STATE_RECOVERY: return "RECOVERY";
    case STATE_OPENING:  return "OPENING";
    case STATE_OPEN:     return "OPEN";
    case STATE_CLOSING:  return "CLOSING";
    case STATE_CLOSED:   return "CLOSED";
    case STATE_FAULT:    return "FAULT";
    case STATE_LS_ERROR: return "LS_ERROR";
    default:             return "UNKNOWN";
  }
}

// ══════════════════════════════════════════════════
//  SIMULATED SENSOR PROCESSING
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
    sensorBits = 0;
    sensorError = false;
    confirmedPct = 0;
    flags &= ~0x01;
  }
}

// ══════════════════════════════════════════════════
//  SIMULATED VALVE STATE MACHINE
// ══════════════════════════════════════════════════

void executeValveCommand(char cmd) {
  if (valveState == STATE_FAULT || valveState == STATE_LS_ERROR) return;

  if ((cmd == 'O' || cmd == 'o') && valveState != STATE_OPEN && valveState != STATE_OPENING) {
    valveState = STATE_OPENING;
    valveTravelStart = millis();
    Serial.println("[SIM] Valve opening...");
  }
  if ((cmd == 'C' || cmd == 'c') && valveState != STATE_CLOSED && valveState != STATE_CLOSING) {
    valveState = STATE_CLOSING;
    valveTravelStart = millis();
    Serial.println("[SIM] Valve closing...");
  }
}

void processSimulatedValve() {
  // Handle fault trigger from UI
  if (simFault && valveState != STATE_FAULT) {
    valveState = STATE_FAULT;
    Serial.println("[SIM] Fault triggered");
    return;
  }

  // Simulate valve travel time
  if (valveState == STATE_OPENING) {
    if (millis() - valveTravelStart >= SIM_VALVE_TRAVEL_MS) {
      valveState = STATE_OPEN;
      Serial.println("[SIM] Valve OPEN");
    }
  }
  if (valveState == STATE_CLOSING) {
    if (millis() - valveTravelStart >= SIM_VALVE_TRAVEL_MS) {
      valveState = STATE_CLOSED;
      Serial.println("[SIM] Valve CLOSED");
    }
  }
}

// ══════════════════════════════════════════════════
//  AUTO MODE EVALUATOR
// ══════════════════════════════════════════════════

void evaluateAutoMode() {
  if (!autoMode || simSensorCount == 0) return;
  if (sensorError) return;
  if (valveState != STATE_OPEN && valveState != STATE_CLOSED) return;

  if (valveState == STATE_CLOSED && confirmedPct <= minPercent) {
    Serial.printf("[AUTO] %d%% <= min %d%% - opening\n", confirmedPct, minPercent);
    executeValveCommand('O');
  }
  if (valveState == STATE_OPEN && confirmedPct >= maxPercent) {
    Serial.printf("[AUTO] %d%% >= max %d%% - closing\n", confirmedPct, maxPercent);
    executeValveCommand('C');
  }
}

// ══════════════════════════════════════════════════
//  FIREBASE
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
    Serial.println("[FB] Auth FAILED: " + String(fbConfig.signer.signupError.message.c_str()));
  }
}

void buildFlags() {
  flags = 0;
  if (sensorError)                                       flags |= 0x01;
  if (valveState == STATE_FAULT)                         flags |= 0x02;
  if (valveState == STATE_OPENING)                       flags |= 0x04;
  if (valveState == STATE_CLOSING)                       flags |= 0x08;
  if (autoMode)                                          flags |= 0x10;
}

bool checkFirebaseReady() {
  if (Firebase.ready()) {
    if (!firebaseReady) {
      firebaseReady = true;
      Serial.println("Firebase ready!");
      writePendingDevice();
      buildFlags();
      pushLiveData();
      updateDeviceInfo(true);
      pushConfigToFirebase();
    }
    return true;
  }
  return false;
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
    Serial.printf("Pushed: valve=%s pct=%d%% flags=0x%02X\n",
      stateName(valveState).c_str(), confirmedPct, flags);
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
  json.set("online", online);
  json.set("lastSeen/.sv", "timestamp");
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("deviceClass", CLS_VALVE);
  json.set("sensorType", simSensorCount > 0 ? SNS_DIP : SNS_NONE);
  json.set("sensorCount", (int)simSensorCount);
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

void checkConfig() {
  String path = "devices/" + deviceCode + "/config";
  if (Firebase.RTDB.getJSON(&fbdo, path.c_str())) {
    FirebaseJson &json = fbdo.jsonData();
    FirebaseJsonData result;
    bool changed = false;

    if (json.get(result, "autoMode") && result.type == "boolean") {
      bool v = result.boolValue;
      if (v != autoMode) { autoMode = v; changed = true; Serial.printf("[CONFIG] autoMode=%s\n", autoMode ? "ON" : "OFF"); }
    }
    if (json.get(result, "minPercent") && result.type == "int") {
      uint8_t v = (uint8_t)result.intValue;
      if (v != minPercent && v < maxPercent) { minPercent = v; changed = true; }
    }
    if (json.get(result, "maxPercent") && result.type == "int") {
      uint8_t v = (uint8_t)result.intValue;
      if (v != maxPercent && v > minPercent) { maxPercent = v; changed = true; }
    }
    if (changed) saveConfig();
  }
}

void checkCommands() {
  String basePath = "devices/" + deviceCode + "/commands/";

  if (Firebase.RTDB.getBool(&fbdo, (basePath + "refreshRequested").c_str())) {
    if (fbdo.boolData()) {
      pushLiveData();
      Firebase.RTDB.setBool(&fbdo, (basePath + "refreshRequested").c_str(), false);
    }
  }
  handleLED();

  if (Firebase.RTDB.getBool(&fbdo, (basePath + "openRequested").c_str())) {
    if (fbdo.boolData()) {
      executeValveCommand('O');
      Firebase.RTDB.setBool(&fbdo, (basePath + "openRequested").c_str(), false);
      pushLiveData();
    }
  }
  handleLED();

  if (Firebase.RTDB.getBool(&fbdo, (basePath + "closeRequested").c_str())) {
    if (fbdo.boolData()) {
      executeValveCommand('C');
      Firebase.RTDB.setBool(&fbdo, (basePath + "closeRequested").c_str(), false);
      pushLiveData();
    }
  }
  handleLED();

  if (Firebase.RTDB.getBool(&fbdo, (basePath + "testRequested").c_str())) {
    if (fbdo.boolData()) {
      testBlinkActive = true; testBlinkStart = millis();
      Firebase.RTDB.setBool(&fbdo, (basePath + "testRequested").c_str(), false);
    }
  }
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "restartRequested").c_str())) {
    if (fbdo.boolData()) {
      Firebase.RTDB.setBool(&fbdo, (basePath + "restartRequested").c_str(), false);
      updateDeviceInfo(false); delay(500); ESP.restart();
    }
  }
}

bool hasDataChanged() {
  buildFlags();
  return ((uint8_t)valveState != lastSentValveState ||
          sensorBits != lastSentBits ||
          confirmedPct != lastSentPct ||
          flags != lastSentFlags);
}

// ══════════════════════════════════════════════════
//  WEB UI
// ══════════════════════════════════════════════════

String buildCustomHTML() {
  String html = R"rawliteral(
<!DOCTYPE html><html><head>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>SenseFlow Valve Simulator</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#1a1a2e;color:#eee;padding:12px}
.card{background:#16213e;border-radius:12px;padding:14px;margin-bottom:10px}
h1{font-size:18px;color:#0ea5e9;margin-bottom:2px}
h2{font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:8px}
.code{font-family:monospace;font-size:16px;color:#38bdf8;letter-spacing:1px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;color:#fff}
.row{display:flex;justify-content:space-between;padding:5px 0;font-size:12px;border-bottom:1px solid #1e3a5f}
.row:last-child{border:none}
.label{color:#64748b}
.val{color:#e2e8f0;font-weight:600}
.dip-row{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}
.dip-btn{width:44px;height:44px;border-radius:50%;border:3px solid #334155;font-size:12px;font-weight:bold;cursor:pointer;transition:all 0.2s}
.dip-on{background:#3b82f6;border-color:#60a5fa;color:#fff}
.dip-off{background:#1e293b;border-color:#334155;color:#64748b}
.dip-err{background:#a855f7;border-color:#c084fc;color:#fff}
.pct{font-size:28px;font-weight:bold;text-align:center;margin:8px 0}
.pct-bar{height:8px;background:#1e293b;border-radius:4px;overflow:hidden;margin:6px 0}
.pct-fill{height:100%;border-radius:4px;transition:width 0.3s}
select,input[type=number]{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 10px;border-radius:6px;font-size:12px}
.btn{display:inline-block;padding:8px 16px;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;margin:3px}
.btn-blue{background:#2563eb;color:#fff}
.btn-red{background:#dc2626;color:#fff}
.btn-green{background:#16a34a;color:#fff}
.btn-gray{background:#334155;color:#cbd5e1}
.btn-purple{background:#7c3aed;color:#fff}
.err-banner{background:#7c3aed;color:#fff;padding:8px;border-radius:8px;text-align:center;font-size:12px;font-weight:600;margin:8px 0}
</style></head><body>
)rawliteral";

  // WiFi status
  bool wifiOk = (WiFi.status() == WL_CONNECTED);
  if (wifiOk) {
    html += "<div style='background:#064e3b;border:1px solid #059669;border-radius:10px;padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px'>";
    html += "<div style='width:10px;height:10px;border-radius:50%;background:#34d399'></div>";
    html += "<div><div style='font-size:12px;font-weight:700;color:#ecfdf5'>WiFi Connected</div>";
    html += "<div style='font-size:10px;color:#6ee7b7'>" + WiFi.SSID() + " &bull; " + WiFi.localIP().toString() + "</div></div></div>";
  } else {
    html += "<div style='background:#451a03;border:1px solid #92400e;border-radius:10px;padding:10px 14px;margin-bottom:10px'>";
    html += "<div style='font-size:12px;font-weight:700;color:#fef2f2'>WiFi Not Connected</div></div>";
  }

  // Header
  html += "<div class='card'>";
  html += "<h1>Valve Simulator</h1>";
  html += "<p class='code'>" + deviceCode + "</p>";
  html += "<span class='badge' style='background:#e67e22'>SIMULATOR</span> ";
  html += "<span class='badge' style='background:" + String(autoMode ? "#16a34a" : "#64748b") + "'>" + String(autoMode ? "AUTO" : "MANUAL") + "</span>";
  html += "</div>";

  // Valve state + controls
  String stColor = "#3498db";
  if (valveState == STATE_OPEN) stColor = "#27ae60";
  else if (valveState == STATE_CLOSED) stColor = "#e74c3c";
  else if (valveState == STATE_FAULT) stColor = "#e67e22";

  html += "<div class='card' style='text-align:center'>";
  html += "<h2>VALVE</h2>";
  html += "<div style='font-size:32px;font-weight:bold;color:" + stColor + "'>" + stateName(valveState) + "</div>";
  html += "<div style='margin-top:8px'>";
  html += "<a href='/api/valve?cmd=open'><button class='btn btn-green'>OPEN</button></a>";
  html += "<a href='/api/valve?cmd=close'><button class='btn btn-red'>CLOSE</button></a>";
  html += "</div>";
  html += "<div style='margin-top:6px'>";
  html += "<a href='/api/set-error?type=fault'><button class='btn btn-purple'>Trigger Fault</button></a>";
  html += "<a href='/api/clear-error'><button class='btn btn-gray'>Clear Fault</button></a>";
  html += "</div></div>";

  // Sensor count selector
  html += "<div class='card'>";
  html += "<h2>Sensor Config</h2>";
  html += "<form action='/api/set-mode' method='GET' style='display:flex;gap:8px;align-items:center'>";
  html += "<select name='count'>";
  html += "<option value='0'" + String(simSensorCount == 0 ? " selected" : "") + ">No Sensors</option>";
  for (int i = 1; i <= 6; i++) {
    html += "<option value='" + String(i) + "'" + String(simSensorCount == i ? " selected" : "") + ">" + String(i) + " sensors</option>";
  }
  html += "</select>";
  html += "<button class='btn btn-blue' type='submit'>Apply</button>";
  html += "</form></div>";

  // DIP controls (only if sensors > 0)
  if (simSensorCount > 0) {
    html += "<div class='card'>";
    html += "<h2>DIP Sensors (tap to toggle)</h2>";
    html += "<div class='dip-row'>";
    for (int i = 0; i < simSensorCount; i++) {
      bool on = (simSensorBits >> i) & 1;
      String cls = sensorError ? "dip-err" : (on ? "dip-on" : "dip-off");
      html += "<a href='/api/toggle-dip?bit=" + String(i) + "'><div class='dip-btn " + cls + "'>" + String(i + 1) + "</div></a>";
    }
    html += "</div>";
    if (sensorError) html += "<div class='err-banner'>SENSOR ERROR: Non-consecutive</div>";
    html += "<div class='pct'>" + String(confirmedPct) + "%</div>";
    html += "<div class='pct-bar'><div class='pct-fill' style='width:" + String(confirmedPct) + "%;background:" +
      String(confirmedPct <= 10 ? "#ef4444" : confirmedPct <= 25 ? "#f97316" : confirmedPct <= 50 ? "#eab308" : "#22c55e") + "'></div></div>";
    html += "<a href='/api/set-error?type=dip'><button class='btn btn-purple'>Trigger Sensor Error</button></a>";
    html += "</div>";
  }

  // Auto mode
  html += "<div class='card'>";
  html += "<h2>AUTO CONTROL</h2>";
  html += "<div class='row'><span class='label'>Auto Mode</span><span class='val'>";
  html += "<a href='/api/setconfig?auto=" + String(autoMode ? "0" : "1") + "'><button class='btn " + String(autoMode ? "btn-green" : "btn-gray") + "' style='padding:4px 12px'>" + String(autoMode ? "ON" : "OFF") + "</button></a></span></div>";
  html += "<div class='row'><span class='label'>Open below</span><span class='val'>" + String(minPercent) + "%</span></div>";
  html += "<div class='row'><span class='label'>Close above</span><span class='val'>" + String(maxPercent) + "%</span></div>";
  html += "</div>";

  // Status
  html += "<div class='card'>";
  html += "<h2>Status</h2>";
  html += "<div class='row'><span class='label'>Firebase</span><span class='val'>" + String(firebaseReady ? "Ready" : "Not ready") + "</span></div>";
  html += "<div class='row'><span class='label'>Last Push</span><span class='val'>" +
    (lastSuccessfulPush > 0 ? String((millis() - lastSuccessfulPush) / 1000) + "s ago" : "Never") + "</span></div>";
  html += "<div class='row'><span class='label'>Push Fails</span><span class='val'>" + String(consecutiveFailCount) + "</span></div>";
  html += "<div class='row'><span class='label'>Uptime</span><span class='val'>" + String(millis() / 1000) + "s</span></div>";
  html += "</div>";

  // Actions
  html += "<div class='card'>";
  html += "<a href='/api/force-push'><button class='btn btn-blue'>Force Push</button></a>";
  html += "<a href='/restart'><button class='btn btn-red'>Restart</button></a>";
  html += "</div>";

  // WiFi setup
  html += "<div class='card'>";
  html += "<h2>WiFi Setup</h2>";
  html += "<form action='/setwifi' method='GET'>";
  html += "<input type='text' name='ssid' placeholder='WiFi SSID' style='width:100%;margin-bottom:6px;padding:8px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;font-size:12px' required>";
  html += "<input type='password' name='pass' placeholder='Password' style='width:100%;padding:8px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;font-size:12px'>";
  html += "<button class='btn btn-green' type='submit' style='width:100%;margin-top:8px'>Connect WiFi</button>";
  html += "</form></div>";

  // Device code
  html += "<div class='card' style='text-align:center'>";
  html += "<p class='code' style='font-size:20px;user-select:all'>" + deviceCode + "</p>";
  html += "<p style='font-size:10px;color:#64748b'>Register in admin panel</p>";
  html += "</div>";

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
  Serial.println("\n=== SenseFlow Valve Simulator v" FIRMWARE_VERSION " ===\n");

  FastLED_min<LED_PIN>.addLeds(rgbLeds, 1);
  FastLED_min<LED_PIN>.setBrightness(80);
  setLED(255, 100, 0);

  loadOrCreateDeviceCode();
  printRegistrationInfo();

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), AP_PASSWORD);
  Serial.println("AP started: " + apName);

  mvs.setCustomHTML([](){ return buildCustomHTML(); });
  mvs.onWiFiCredentialsReceived([](const String& ssid) {
    WiFi.disconnect(false); delay(200);
  });
  mvs.begin();

  // Endpoints
  mvs.addEndpoint("/setwifi", []() {
    WebServer* srv = mvs.getServer();
    String ssid = srv->arg("ssid"), pass = srv->arg("pass");
    if (ssid.length() == 0) { srv->send(400, "text/html", "<h2>SSID required</h2>"); return; }
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
    WebServer* srv = mvs.getServer();
    String cmd = srv->arg("cmd");
    if (cmd == "open") executeValveCommand('O');
    else if (cmd == "close") executeValveCommand('C');
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/toggle-dip", []() {
    WebServer* srv = mvs.getServer();
    int bit = srv->arg("bit").toInt();
    if (bit >= 0 && bit < 6) simSensorBits ^= (1 << bit);
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/set-mode", []() {
    WebServer* srv = mvs.getServer();
    simSensorCount = constrain(srv->arg("count").toInt(), 0, 6);
    simSensorBits = 0;
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/set-error", []() {
    WebServer* srv = mvs.getServer();
    String type = srv->arg("type");
    if (type == "dip") simSensorBits = 0b00000101;
    else if (type == "fault") simFault = true;
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/clear-error", []() {
    simFault = false;
    simSensorBits = 0;
    if (valveState == STATE_FAULT || valveState == STATE_LS_ERROR) {
      valveState = STATE_CLOSED;
    }
    mvs.getServer()->sendHeader("Location", "/"); mvs.getServer()->send(302);
  });

  mvs.addEndpoint("/api/setconfig", []() {
    WebServer* srv = mvs.getServer();
    if (srv->hasArg("auto")) {
      autoMode = (srv->arg("auto").toInt() != 0);
      saveConfig();
      if (firebaseReady) pushConfigToFirebase();
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/force-push", []() {
    if (firebaseReady) { pushLiveData(); updateDeviceInfo(true); }
    mvs.getServer()->sendHeader("Location", "/"); mvs.getServer()->send(302);
  });

  mvs.addEndpoint("/api/status", []() {
    buildFlags();
    String json = "{";
    json += "\"code\":\"" + deviceCode + "\",";
    json += "\"valve\":\"" + stateName(valveState) + "\",";
    json += "\"pct\":" + String(confirmedPct) + ",";
    json += "\"bits\":" + String(sensorBits) + ",";
    json += "\"flags\":" + String(flags) + ",";
    json += "\"auto\":" + String(autoMode ? "true" : "false") + ",";
    json += "\"firebase\":" + String(firebaseReady ? "true" : "false");
    json += "}";
    mvs.getServer()->send(200, "application/json", json);
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
//  LOOP
// ══════════════════════════════════════════════════

void loop() {
  unsigned long now = millis();
  mvs.handle();
  if (!mvsota.isUpdating()) mvsota.handle();

  processSimulatedSensors();
  processSimulatedValve();
  handleLED();
  evaluateAutoMode();

  // mDNS
  if (WiFi.status() == WL_CONNECTED && !mdnsStarted) {
    if (MDNS.begin(mdnsName.c_str())) {
      MDNS.addService("http", "tcp", 7689);
      mdnsStarted = true;
    }
  } else if (WiFi.status() != WL_CONNECTED && mdnsStarted) {
    mdnsStarted = false;
  }

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
    checkFirebaseReady();
    if (firebaseReady) {
      if (hasDataChanged()) {
        if (pushLiveData()) updateDeviceInfo(true);
        handleLED();
      }
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        pushLiveData(); handleLED();
        updateDeviceInfo(true); handleLED();
      }
      if (now - lastCommandCheck >= COMMAND_CHECK_INTERVAL) {
        lastCommandCheck = now;
        checkCommands(); handleLED();
      }
      if (now - lastConfigCheck >= CONFIG_CHECK_INTERVAL) {
        lastConfigCheck = now;
        checkConfig(); handleLED();
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
  }

  // Serial
  if (Serial.available()) {
    char cmd = Serial.read();
    if (cmd == '\n' || cmd == '\r') return;
    switch (cmd) {
      case 'O': case 'o': executeValveCommand('O'); break;
      case 'C': case 'c': executeValveCommand('C'); break;
      case 'S': case 's':
        Serial.println("\n--- Valve Sim Status ---");
        Serial.println("Code:   " + deviceCode);
        Serial.println("Valve:  " + stateName(valveState));
        Serial.printf("Level:  %d%% sensors=%d bits=%d\n", confirmedPct, simSensorCount, sensorBits);
        Serial.printf("Auto:   %s min=%d%% max=%d%%\n", autoMode ? "ON" : "OFF", minPercent, maxPercent);
        Serial.println("Firebase: " + String(firebaseReady ? "Ready" : "Not ready"));
        Serial.println("------------------------\n");
        break;
      default: Serial.println("O=open C=close S=status"); break;
    }
  }
}
