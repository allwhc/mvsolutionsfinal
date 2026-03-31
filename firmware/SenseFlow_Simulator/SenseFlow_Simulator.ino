/*
 * SenseFlow Firebase Simulator v1.0.0
 *
 * Simulates a SenseFlow sensor device WITHOUT real hardware.
 * DIP switches and ultrasonic sensor are virtual — controlled from AP web page.
 * Pushes real data to Firebase for end-to-end testing.
 *
 * Features:
 *   - Toggle DIP sensors on/off from web UI
 *   - Set ultrasonic distance via slider
 *   - Switch between DIP and Ultrasonic mode at runtime
 *   - Change sensor count (1-6) at runtime
 *   - Trigger physics errors (non-consecutive DIP)
 *   - Trigger sensor offline (ultrasonic fail)
 *   - All Firebase behavior identical to real firmware
 *   - LED behavior identical to real firmware
 */

#include <WiFi.h>
#include <Preferences.h>
// Only enable RTDB — saves ~300-400KB flash
#define ENABLE_RTDB
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <MvsConnect.h>
#include <FastLED_min.h>

// ══════════════════════════════════════════════════
//  FIREBASE CONFIG
// ══════════════════════════════════════════════════

#define FIREBASE_API_KEY      "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4"
#define FIREBASE_DB_URL       "https://senseflow-5a9bb-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_PROJECT_ID   "senseflow-5a9bb"

#define DEVICE_NAME       "SenseFlow-Sim"
#define FIRMWARE_VERSION  "16.0.0"
#define FIRMWARE_CODE     "SF-SIM-2026-16"
#define AP_PASSWORD       "mvstech9867"

// Device classes
#define CLS_VALVE   0x01
#define CLS_SENSOR  0x02
#define CLS_MOTOR   0x03

// Sensor types
#define SNS_NONE        0x00
#define SNS_DIP         0x01
#define SNS_ULTRASONIC  0x02

// LED
#define LED_PIN      15

// Timing
#define HEARTBEAT_INTERVAL    300000
#define COMMAND_CHECK_INTERVAL 5000

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

FirebaseData fbdo;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;
bool firebaseReady = false;

String deviceCode = "";
String apName = "";

// Simulated sensor state (controlled from web UI)
volatile uint8_t simSensorType = SNS_DIP;    // 1=DIP, 2=Ultrasonic
volatile uint8_t simSensorCount = 4;         // 1-6
volatile uint8_t simSensorBits = 0;          // DIP bit pattern
volatile uint8_t simUltrasonicPct = 50;      // Ultrasonic level %
volatile bool    simUltrasonicOffline = false;
volatile float   simTankHeight = 100.0;

// Derived state
uint8_t sensorBits = 0;
uint8_t confirmedPct = 0;
uint8_t flags = 0;
bool sensorError = false;

// Last sent values
uint8_t lastSentBits = 0xFF;
uint8_t lastSentPct = 0xFF;
uint8_t lastSentFlags = 0xFF;
uint8_t lastSentSensorType = 0xFF;
uint8_t lastSentSensorCount = 0xFF;

// Timing
unsigned long lastHeartbeat = 0;
unsigned long lastCommandCheck = 0;

// LED
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
  for (int i = 0; i < 8; i++) {
    code += charset[random(0, 36)];
  }
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
  prefs.end();

  apName = DEVICE_NAME;
  apName += "-";
  apName += deviceCode.substring(3, 7);
  apName += "_mvstech";
}

void printRegistrationInfo() {
  Serial.println("\n========================================");
  Serial.println("  SENSEFLOW SIMULATOR REGISTRATION");
  Serial.println("========================================");
  Serial.print("  Code:           "); Serial.println(deviceCode);
  Serial.println("  Class:          SENSOR (0x02)");
  Serial.print("  Sensor Type:    "); Serial.println(simSensorType == SNS_DIP ? "DIP (0x01)" : "ULTRASONIC (0x02)");
  Serial.print("  Sensor Count:   "); Serial.println(simSensorCount);
  Serial.print("  Firmware:       "); Serial.println(FIRMWARE_VERSION);
  Serial.print("  MAC:            "); Serial.println(WiFi.macAddress());
  Serial.println("  Mode:           SIMULATOR");
  Serial.println("========================================\n");
}

// ══════════════════════════════════════════════════
//  LED (same as real firmware)
// ══════════════════════════════════════════════════

CRGB rgbLeds[1];

void setLED(uint8_t r, uint8_t g, uint8_t b) {
  rgbLeds[0] = CRGB(r, g, b);
  FastLED_min<LED_PIN>.show();
}
void setLEDOff() { setLED(0, 0, 0); }

// Level colors matching LED sticker spec
void setLevelColor(uint8_t pct) {
  if (pct == 0)       setLED(255, 0, 0);       // Red - Empty
  else if (pct <= 25) setLED(255, 80, 0);       // Orange - Low
  else if (pct <= 50) setLED(255, 200, 0);      // Yellow - Half
  else if (pct <= 75) setLED(0, 229, 255);      // Cyan - Good
  else                setLED(0, 230, 118);      // Green - Full
}

void handleLED() {
  unsigned long now = millis();

  // Priority 1: Test blink (Firebase command)
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

  // LED cycle: 30s level color → 2s WiFi status blink → repeat
  unsigned long cycleElapsed = now - ledCycleStart;
  if (cycleElapsed >= 32000) { ledCycleStart = now; ledShowingWifi = false; }

  if (cycleElapsed >= 30000) {
    // Stage 2: WiFi status blink (2s) — HIGHEST PRIORITY, overrides sensor error
    if (!ledShowingWifi) { ledShowingWifi = true; wifiBlinkStart = now; }
    int blinkPhase = ((now - wifiBlinkStart) / 250) % 2;
    if (WiFi.status() == WL_CONNECTED) {
      if (blinkPhase == 0) setLED(0, 0, 255); else setLEDOff();  // Blue blink
    } else {
      if (blinkPhase == 0) setLED(255, 255, 255); else setLEDOff();  // White blink
    }
  } else {
    // Stage 1: Tank level color (30s)
    ledShowingWifi = false;
    if (sensorError || (simSensorType == SNS_ULTRASONIC && simUltrasonicOffline)) {
      setLED(148, 51, 234);  // Purple - sensor error
    } else {
      setLevelColor(confirmedPct);
    }
  }
}

// ══════════════════════════════════════════════════
//  SIMULATED SENSOR PROCESSING
// ══════════════════════════════════════════════════

int countConsecutive(uint8_t bits, int count) {
  int consecutive = 0;
  for (int i = 0; i < count; i++) {
    if (bits & (1 << i)) consecutive++;
    else break;
  }
  return consecutive;
}

bool checkSensorError(uint8_t bits, int count) {
  int totalOn = 0;
  for (int i = 0; i < count; i++) {
    if (bits & (1 << i)) totalOn++;
  }
  return (totalOn != countConsecutive(bits, count));
}

uint8_t bitsToPercent(uint8_t bits, int count) {
  int consecutive = countConsecutive(bits, count);
  if (consecutive == 0) return 0;
  if (count >= 1 && count <= 6) return DIP_PCT_TABLE[count][consecutive - 1];
  return 0;
}

void processSimulatedSensors() {
  if (simSensorType == SNS_DIP) {
    sensorBits = simSensorBits & ((1 << simSensorCount) - 1); // mask to count
    sensorError = checkSensorError(sensorBits, simSensorCount);
    if (sensorError) flags |= 0x01; else flags &= ~0x01;
    flags &= ~0x20; // clear ultrasonic offline
    confirmedPct = bitsToPercent(sensorBits, simSensorCount);
  } else {
    // Ultrasonic mode
    sensorBits = 0;
    sensorError = false;
    flags &= ~0x01;
    if (simUltrasonicOffline) {
      flags |= 0x20;
      confirmedPct = 0xFF;
    } else {
      flags &= ~0x20;
      confirmedPct = simUltrasonicPct;
    }
  }
}

// ══════════════════════════════════════════════════
//  FIREBASE
// ══════════════════════════════════════════════════

void initFirebase() {
  fbConfig.api_key = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;
  fbConfig.token_status_callback = tokenStatusCallback;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectNetwork(true);

  // Anonymous sign-up (empty email + password = anonymous)
  if (Firebase.signUp(&fbConfig, &fbAuth, "", "")) {
    Serial.println("Firebase anonymous auth OK");
  } else {
    Serial.println("Firebase auth failed: " + String(fbConfig.signer.signupError.message.c_str()));
  }
}

bool checkFirebaseReady() {
  if (Firebase.ready()) {
    if (!firebaseReady) {
      firebaseReady = true;
      Serial.println("Firebase ready!");
      writePendingDevice();
    }
    return true;
  }
  return false;
}

void writePendingDevice() {
  String path = "pendingDevices/" + deviceCode;
  FirebaseJson json;
  json.set("deviceClass", CLS_SENSOR);
  json.set("sensorType", (int)simSensorType);
  json.set("sensorCount", (int)simSensorCount);
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("macAddress", WiFi.macAddress());
  json.set("simulator", true);
  json.set("firstSeenAt/.sv", "timestamp");
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

bool pushLiveData() {
  String path = "devices/" + deviceCode + "/live";
  FirebaseJson json;
  json.set("sensorBits", sensorBits);
  json.set("confirmedPct", confirmedPct);
  json.set("stateVal", 0);
  json.set("flags", flags);
  json.set("rssi", WiFi.RSSI());
  json.set("timestamp/.sv", "timestamp");
  if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    lastSentBits = sensorBits;
    lastSentPct = confirmedPct;
    lastSentFlags = flags;
    lastSentSensorType = simSensorType;
    lastSentSensorCount = simSensorCount;
    Serial.printf("Pushed: bits=%d pct=%d flags=0x%02X type=%d count=%d\n",
      sensorBits, confirmedPct, flags, simSensorType, simSensorCount);
    return true;
  }
  Serial.println("Push failed: " + fbdo.errorReason());
  return false;
}

void updateDeviceInfo(bool online) {
  String path = "devices/" + deviceCode + "/info";
  FirebaseJson json;
  json.set("online", online);
  json.set("lastSeen/.sv", "timestamp");
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("deviceClass", CLS_SENSOR);
  json.set("sensorType", (int)simSensorType);
  json.set("sensorCount", (int)simSensorCount);
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

void checkCommands() {
  String basePath = "devices/" + deviceCode + "/commands/";

  if (Firebase.RTDB.getBool(&fbdo, (basePath + "refreshRequested").c_str())) {
    if (fbdo.boolData()) {
      pushLiveData();
      Firebase.RTDB.setBool(&fbdo, (basePath + "refreshRequested").c_str(), false);
    }
  }
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
  return (sensorBits != lastSentBits || confirmedPct != lastSentPct ||
          flags != lastSentFlags || simSensorType != lastSentSensorType ||
          simSensorCount != lastSentSensorCount);
}

// ══════════════════════════════════════════════════
//  WEB UI — SIMULATOR CONTROLS
// ══════════════════════════════════════════════════

String buildCustomHTML() {
  String html = R"rawliteral(
<!DOCTYPE html><html><head>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>SenseFlow Simulator</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#1a1a2e;color:#eee;padding:12px}
.card{background:#16213e;border-radius:12px;padding:14px;margin-bottom:10px}
h1{font-size:18px;color:#0ea5e9;margin-bottom:2px}
h2{font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:8px}
.code{font-family:monospace;font-size:16px;color:#38bdf8;letter-spacing:1px}
.badge{display:inline-block;background:#0ea5e9;color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600}
.row{display:flex;justify-content:space-between;padding:5px 0;font-size:12px;border-bottom:1px solid #1e3a5f}
.row:last-child{border:none}
.label{color:#64748b}
.val{color:#e2e8f0;font-weight:600}
.dip-row{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}
.dip-btn{width:44px;height:44px;border-radius:50%;border:3px solid #334155;font-size:12px;font-weight:bold;cursor:pointer;transition:all 0.2s}
.dip-on{background:#3b82f6;border-color:#60a5fa;color:#fff}
.dip-off{background:#1e293b;border-color:#334155;color:#64748b}
.dip-err{background:#a855f7;border-color:#c084fc;color:#fff}
.slider{width:100%;margin:8px 0;accent-color:#0ea5e9}
select,input[type=number]{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 10px;border-radius:6px;font-size:12px}
.btn{display:inline-block;padding:8px 16px;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;margin:3px}
.btn-blue{background:#2563eb;color:#fff}
.btn-red{background:#dc2626;color:#fff}
.btn-green{background:#16a34a;color:#fff}
.btn-gray{background:#334155;color:#cbd5e1}
.btn-purple{background:#7c3aed;color:#fff}
.pct{font-size:28px;font-weight:bold;text-align:center;margin:8px 0}
.pct-bar{height:8px;background:#1e293b;border-radius:4px;overflow:hidden;margin:6px 0}
.pct-fill{height:100%;border-radius:4px;transition:width 0.3s}
.qr{text-align:center;padding:12px}
.link{word-break:break-all;font-size:10px;color:#38bdf8;display:block;margin-top:6px}
.err-banner{background:#7c3aed;color:#fff;padding:8px;border-radius:8px;text-align:center;font-size:12px;font-weight:600;margin:8px 0}
</style></head><body>
)rawliteral";

  // WiFi status banner
  bool wifiOk = (WiFi.status() == WL_CONNECTED);
  if (wifiOk) {
    html += "<div style='background:#064e3b;border:1px solid #059669;border-radius:10px;padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px'>";
    html += "<div style='width:10px;height:10px;border-radius:50%;background:#34d399;box-shadow:0 0 6px #34d399'></div>";
    html += "<div><div style='font-size:12px;font-weight:700;color:#ecfdf5'>WiFi Connected</div>";
    html += "<div style='font-size:10px;color:#6ee7b7'>" + WiFi.SSID() + " &bull; " + WiFi.localIP().toString() + " &bull; RSSI " + String(WiFi.RSSI()) + "dBm</div></div></div>";
  } else {
    html += "<div style='background:#451a03;border:1px solid #92400e;border-radius:10px;padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px'>";
    html += "<div style='width:10px;height:10px;border-radius:50%;background:#f87171;box-shadow:0 0 6px #f87171'></div>";
    html += "<div><div style='font-size:12px;font-weight:700;color:#fef2f2'>WiFi Not Connected</div>";
    html += "<div style='font-size:10px;color:#fca5a5'>Enter credentials below or use MvsConnect app</div></div></div>";
  }

  // Header
  html += "<div class='card'>";
  html += "<h1>SenseFlow Simulator</h1>";
  html += "<p class='code'>" + deviceCode + "</p>";
  html += "<span class='badge'>SIMULATOR</span>";
  html += "</div>";

  // Sensor mode selector
  html += "<div class='card'>";
  html += "<h2>Sensor Mode</h2>";
  html += "<form action='/api/set-mode' method='GET' style='display:flex;gap:8px;align-items:center'>";
  html += "<select name='type'>";
  html += "<option value='1'" + String(simSensorType == SNS_DIP ? " selected" : "") + ">DIP Switches</option>";
  html += "<option value='2'" + String(simSensorType == SNS_ULTRASONIC ? " selected" : "") + ">Ultrasonic</option>";
  html += "</select>";
  html += "<select name='count'>";
  for (int i = 1; i <= 6; i++) {
    html += "<option value='" + String(i) + "'" + String(simSensorCount == i ? " selected" : "") + ">" + String(i) + " sensors</option>";
  }
  html += "</select>";
  html += "<button class='btn btn-blue' type='submit'>Apply</button>";
  html += "</form>";
  html += "</div>";

  // DIP controls
  if (simSensorType == SNS_DIP) {
    html += "<div class='card'>";
    html += "<h2>DIP Sensors (tap to toggle)</h2>";
    html += "<div class='dip-row'>";
    for (int i = 0; i < simSensorCount; i++) {
      bool on = (simSensorBits >> i) & 1;
      String cls = sensorError ? "dip-err" : (on ? "dip-on" : "dip-off");
      html += "<a href='/api/toggle-dip?bit=" + String(i) + "'><div class='dip-btn " + cls + "'>" + String(i + 1) + "</div></a>";
    }
    html += "</div>";

    if (sensorError) {
      html += "<div class='err-banner'>SENSOR ERROR: Non-consecutive sensors</div>";
    }

    html += "<div class='pct'>" + String(confirmedPct) + "%</div>";
    html += "<div class='pct-bar'><div class='pct-fill' style='width:" + String(confirmedPct) + "%;background:" +
      String(confirmedPct <= 10 ? "#ef4444" : confirmedPct <= 25 ? "#f97316" : confirmedPct <= 50 ? "#eab308" : "#22c55e") + "'></div></div>";

    html += "<div style='margin-top:10px'>";
    html += "<a href='/api/set-error?type=dip'><button class='btn btn-purple'>Trigger Physics Error</button></a>";
    html += "<a href='/api/clear-error'><button class='btn btn-gray'>Clear Error</button></a>";
    html += "</div>";
    html += "</div>";
  }

  // Ultrasonic controls
  if (simSensorType == SNS_ULTRASONIC) {
    html += "<div class='card'>";
    html += "<h2>Ultrasonic Sensor</h2>";

    if (simUltrasonicOffline) {
      html += "<div class='err-banner'>SENSOR OFFLINE</div>";
      html += "<div class='pct' style='color:#64748b'>--</div>";
    } else {
      html += "<div class='pct'>" + String(simUltrasonicPct) + "%</div>";
      html += "<div class='pct-bar'><div class='pct-fill' style='width:" + String(simUltrasonicPct) + "%;background:" +
        String(simUltrasonicPct <= 10 ? "#ef4444" : simUltrasonicPct <= 25 ? "#f97316" : simUltrasonicPct <= 50 ? "#eab308" : "#22c55e") + "'></div></div>";
    }

    html += "<form action='/api/set-level' method='GET'>";
    html += "<input type='range' class='slider' name='pct' min='0' max='100' value='" + String(simUltrasonicPct) + "'" +
      String(simUltrasonicOffline ? " disabled" : "") + " oninput='this.form.submit()'>";
    html += "</form>";

    html += "<div style='margin-top:10px'>";
    html += "<a href='/api/set-error?type=offline'><button class='btn btn-purple'>Set Offline</button></a>";
    html += "<a href='/api/clear-error'><button class='btn btn-gray'>Clear</button></a>";
    html += "</div>";
    html += "</div>";
  }

  // Status
  html += "<div class='card'>";
  html += "<h2>Status</h2>";
  html += "<div class='row'><span class='label'>WiFi</span><span class='val'>" + mvs.getWiFiStatus() + "</span></div>";
  html += "<div class='row'><span class='label'>RSSI</span><span class='val'>" + String(WiFi.RSSI()) + " dBm</span></div>";
  html += "<div class='row'><span class='label'>Firebase</span><span class='val'>" + String(firebaseReady ? "Ready" : "Not ready") + "</span></div>";
  html += "<div class='row'><span class='label'>Flags</span><span class='val'>0x" + String(flags, HEX) + "</span></div>";
  html += "<div class='row'><span class='label'>Uptime</span><span class='val'>" + String(millis() / 1000) + "s</span></div>";
  html += "</div>";

  // Actions
  html += "<div class='card'>";
  html += "<a href='/api/force-push'><button class='btn btn-blue'>Force Push</button></a>";
  html += "<a href='/restart'><button class='btn btn-red'>Restart</button></a>";
  html += "</div>";

  // Manual WiFi entry
  html += "<div class='card'>";
  html += "<h2>WiFi Setup</h2>";
  html += "<form action='/setwifi' method='GET'>";
  html += "<input type='text' name='ssid' placeholder='WiFi SSID' style='width:100%;margin-bottom:6px;padding:8px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;font-size:12px' required>";
  html += "<div style='position:relative'>";
  html += "<input type='password' id='wpass' name='pass' placeholder='Password' style='width:100%;padding:8px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;font-size:12px;padding-right:40px'>";
  html += "<button type='button' onclick=\"var p=document.getElementById('wpass');p.type=p.type==='password'?'text':'password'\" style='position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:#64748b;font-size:14px;cursor:pointer'>&#128065;</button>";
  html += "</div>";
  html += "<button class='btn btn-green' type='submit' style='width:100%;margin-top:8px'>Connect WiFi</button>";
  html += "</form>";
  html += "</div>";

  // Device code for admin reference
  html += "<div class='card' style='text-align:center'>";
  html += "<h2>Device Code</h2>";
  html += "<p class='code' style='font-size:20px;margin:10px 0;user-select:all'>" + deviceCode + "</p>";
  html += "<p style='font-size:10px;color:#64748b'>Register this code in admin panel to generate QR</p>";
  html += "</div>";

  html += "<script>setTimeout(()=>location.reload(),3000)</script>";
  html += "</body></html>";
  return html;
}

// ══════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== SenseFlow Simulator v" FIRMWARE_VERSION " ===\n");

  FastLED_min<LED_PIN>.addLeds(rgbLeds, 1);
  FastLED_min<LED_PIN>.setBrightness(80);
  setLED(255, 100, 0);

  loadOrCreateDeviceCode();
  printRegistrationInfo();

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), AP_PASSWORD);
  Serial.println("AP started: " + apName);

  // MvsConnect
  mvs.setCustomHTML([](){ return buildCustomHTML(); });

  mvs.onWiFiCredentialsReceived([](const String& ssid) {
    Serial.println("WiFi credentials received: " + ssid);
    // Fix: disconnect first to avoid "sta is connecting, cannot set config"
    WiFi.disconnect(false);
    delay(200);
  });

  // begin() MUST be called before addEndpoint()
  mvs.begin();

  // Manual WiFi entry endpoint
  mvs.addEndpoint("/setwifi", []() {
    WebServer* srv = mvs.getServer();
    String ssid = srv->arg("ssid");
    String pass = srv->arg("pass");
    if (ssid.length() == 0) {
      srv->send(400, "text/html", "<html><body style='background:#1a1a2e;color:#fff;text-align:center;padding:40px'><h2>SSID required</h2></body></html>");
      return;
    }
    srv->send(200, "text/html", "<html><body style='background:#1a1a2e;color:#fff;text-align:center;padding:40px'><h2>Connecting to " + ssid + "...</h2><p style='color:#94a3b8;margin-top:8px'>Page will reload in 10s</p><script>setTimeout(()=>location.href='/',10000)</script></body></html>");
    Serial.println("Manual WiFi: " + ssid);
    WiFi.disconnect(false);
    delay(200);
    WiFi.begin(ssid.c_str(), pass.c_str());
    // Save to NVS so it persists
    Preferences wifiPrefs;
    wifiPrefs.begin("mvsconnect", false);
    wifiPrefs.putString("ssid", ssid);
    wifiPrefs.putString("password", pass);
    wifiPrefs.putBool("valid", true);
    wifiPrefs.end();
  });

  // API endpoints — use mvs.getServer() inside handlers
  mvs.addEndpoint("/restart", []() {
    WebServer* srv = mvs.getServer();
    srv->send(200, "text/html", "<html><body style='background:#1a1a2e;color:#fff;text-align:center;padding:40px'><h2>Restarting...</h2></body></html>");
    delay(1000); ESP.restart();
  });

  mvs.addEndpoint("/api/toggle-dip", []() {
    WebServer* srv = mvs.getServer();
    int bit = srv->arg("bit").toInt();
    if (bit >= 0 && bit < 6) simSensorBits ^= (1 << bit);
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/set-level", []() {
    WebServer* srv = mvs.getServer();
    simUltrasonicPct = constrain(srv->arg("pct").toInt(), 0, 100);
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/set-mode", []() {
    WebServer* srv = mvs.getServer();
    simSensorType = constrain(srv->arg("type").toInt(), 1, 2);
    simSensorCount = constrain(srv->arg("count").toInt(), 1, 6);
    simSensorBits = 0;
    simUltrasonicPct = 50;
    simUltrasonicOffline = false;
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/set-error", []() {
    WebServer* srv = mvs.getServer();
    String type = srv->arg("type");
    if (type == "dip") {
      simSensorBits = 0b00000101;
    } else if (type == "offline") {
      simUltrasonicOffline = true;
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/clear-error", []() {
    WebServer* srv = mvs.getServer();
    simSensorBits = 0;
    simUltrasonicOffline = false;
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/force-push", []() {
    WebServer* srv = mvs.getServer();
    processSimulatedSensors();
    if (firebaseReady) { pushLiveData(); updateDeviceInfo(true); }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/status", []() {
    WebServer* srv = mvs.getServer();
    String json = "{";
    json += "\"code\":\"" + deviceCode + "\",";
    json += "\"sensorType\":" + String(simSensorType) + ",";
    json += "\"sensorCount\":" + String(simSensorCount) + ",";
    json += "\"bits\":" + String(sensorBits) + ",";
    json += "\"pct\":" + String(confirmedPct) + ",";
    json += "\"flags\":" + String(flags) + ",";
    json += "\"error\":" + String(sensorError ? "true" : "false") + ",";
    json += "\"firebase\":" + String(firebaseReady ? "true" : "false");
    json += "}";
    srv->send(200, "application/json", json);
  });

  if (mvs.hasSavedWiFi()) {
    setLED(0, 0, 255);
    if (mvs.connectToSavedWiFi(30)) {
      Serial.println("WiFi connected! IP: " + WiFi.localIP().toString());
      setLED(0, 255, 0);
      initFirebase();
    } else {
      setLED(255, 255, 255);
    }
  } else {
    setLED(255, 255, 255);
  }

  ledCycleStart = millis();
}

// ══════════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════════

void loop() {
  unsigned long now = millis();
  mvs.handle();
  processSimulatedSensors();
  handleLED();

  if (WiFi.status() == WL_CONNECTED) {
    checkFirebaseReady();
    if (firebaseReady) {
      if (hasDataChanged()) {
        if (pushLiveData()) updateDeviceInfo(true);
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
    }
  } else {
    static unsigned long lastReconnect = 0;
    if (now - lastReconnect > 30000) {
      lastReconnect = now;
      if (mvs.hasSavedWiFi()) {
        if (mvs.connectToSavedWiFi(10)) {
          if (!firebaseReady) initFirebase();
        }
      }
    }
  }

  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim(); cmd.toUpperCase();
    if (cmd == "STATUS" || cmd == "S") {
      Serial.println("\n--- Simulator Status ---");
      Serial.println("Code:       " + deviceCode);
      Serial.println("WiFi:       " + mvs.getWiFiStatus());
      Serial.println("IP:         " + WiFi.localIP().toString());
      Serial.println("RSSI:       " + String(WiFi.RSSI()) + " dBm");
      Serial.println("Firebase:   " + String(firebaseReady ? "Ready" : "Not ready"));
      Serial.printf("Sensor:     type=%s count=%d\n", simSensorType == SNS_DIP ? "DIP" : "US", simSensorCount);
      Serial.printf("Level:      %d%% bits=%d flags=0x%02X error=%s\n", confirmedPct, sensorBits, flags, sensorError ? "YES" : "No");
      Serial.println("Uptime:     " + String(millis() / 1000) + "s");
      Serial.println("Free Heap:  " + String(ESP.getFreeHeap()));
      Serial.println("------------------------\n");
    } else if (cmd == "ADMIN") {
      printRegistrationInfo();
    } else if (cmd == "RESTART") {
      ESP.restart();
    } else if (cmd == "RESET_WIFI") {
      mvs.clearSavedWiFi(); delay(500); ESP.restart();
    }
  }
}
