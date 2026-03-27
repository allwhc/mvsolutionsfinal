/*
 * SenseFlow Firebase Sensor Firmware v1.0.0
 *
 * ESP32 sensor-only device that pushes data directly to Firebase RTDB.
 * Supports DIP (1-6 switches) and Ultrasonic (HC-SR04) sensors.
 * Uses MvsConnect for WiFi setup via Android app.
 *
 * Device Code: SF-XXXXXXXX-SN (generated once, stored in NVS)
 * Auth: Firebase anonymous authentication
 * Data Push: Change-driven + 5 minute heartbeat
 * Commands: refreshRequested, testRequested, restartRequested
 *
 * Device Class: 0x02 (Sensor only)
 * LED: Addressable WS2812B on GPIO15
 *   - Level color for 30s → WiFi status blink → repeat
 *   - Purple solid on sensor error
 *   - Rainbow on Firebase test command
 *   - Blue blink = WiFi connected, White blink = WiFi disconnected
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
//  CONFIGURATION — CHANGE THESE PER DEPLOYMENT
// ══════════════════════════════════════════════════

// Sensor mode: 0 = DIP switches, 1 = Ultrasonic HC-SR04
#define USE_ULTRASONIC    0

// DIP sensor count (1–6), ignored if USE_ULTRASONIC=1
#define SENSOR_COUNT      4

// Firebase project config
#define FIREBASE_API_KEY      "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4"
#define FIREBASE_DB_URL       "https://senseflow-5a9bb-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_PROJECT_ID   "senseflow-5a9bb"

// Device info
#define DEVICE_NAME       "SenseFlow-Sensor"
#define FIRMWARE_VERSION  "14.0.0"
#define FIRMWARE_CODE     "SF-FBS-2026-14"
#define AP_PASSWORD       "mvstech9867"

// ══════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════

// Device classes (match RS485 protocol)
#define CLS_VALVE   0x01
#define CLS_SENSOR  0x02
#define CLS_MOTOR   0x03

// Sensor types
#define SNS_NONE        0x00
#define SNS_DIP         0x01
#define SNS_ULTRASONIC  0x02

// DIP sensor GPIOs (fixed order, same as RS485 version)
const int DIP_PINS[] = {32, 33, 14, 27, 34, 35};

// Ultrasonic pins
#define US_TRIG_PIN  25
#define US_ECHO_PIN  34

// Addressable LED
#define LED_PIN      15
#define LED_COUNT    1

// Timing
#define HEARTBEAT_INTERVAL    300000   // 5 minutes
#define COMMAND_CHECK_INTERVAL 5000    // 5 seconds
#define DIP_DEBOUNCE_MS       2000     // DIP debounce
#define US_READ_INTERVAL      5000     // Ultrasonic read interval
#define LED_CYCLE_DURATION    30000    // 30 seconds level display
#define WIFI_BLINK_DURATION   1500     // WiFi status blink duration

// Ultrasonic
#define US_SAMPLES        15
#define US_MAD_MULTIPLIER 2.5
#define US_BLIND_ZONE     21.0    // cm
#define US_MAX_RANGE      450.0   // cm
#define US_HYSTERESIS     10.0    // cm
#define US_FAIL_LIMIT     10
#define US_OFFLINE_TIMEOUT 60000  // ms

// ══════════════════════════════════════════════════
//  DIP PERCENT TABLE (same as RS485 version)
// ══════════════════════════════════════════════════

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

// Firebase
FirebaseData fbdo;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;
bool firebaseReady = false;

// Device identity
String deviceCode = "";
String apName = "";

// Sensor state
uint8_t sensorBits = 0;
uint8_t confirmedPct = 0;
uint8_t flags = 0;        // bit0=sensorError, bit5=sensorOffline
bool    sensorError = false;

// Last sent values (for change detection)
uint8_t lastSentBits = 0xFF;
uint8_t lastSentPct = 0xFF;
uint8_t lastSentFlags = 0xFF;

// DIP debounce
uint8_t rawBits = 0;
uint8_t pendingBits = 0;
unsigned long debounceStart = 0;
bool debouncing = false;

// Ultrasonic
float usRawDistance = 0;
float usFilteredDistance = 0;
float usTankHeight = 100.0;  // cm, configurable
int   usFailCount = 0;
bool  usSensorOffline = false;
unsigned long lastUsRead = 0;

// Timing
unsigned long lastHeartbeat = 0;
unsigned long lastCommandCheck = 0;
unsigned long lastDataPush = 0;

// LED state
unsigned long ledCycleStart = 0;
bool ledShowingWifi = false;
unsigned long wifiBlinkStart = 0;
bool testBlinkActive = false;
unsigned long testBlinkStart = 0;

// ══════════════════════════════════════════════════
//  DEVICE CODE GENERATION
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
    // Seed random from analog noise + MAC
    uint8_t mac[6];
    WiFi.macAddress(mac);
    uint32_t seed = esp_random();
    randomSeed(seed);

    deviceCode = generateRandomCode();
    prefs.putString("devcode", deviceCode);
    Serial.println("Generated new device code: " + deviceCode);
  } else {
    Serial.println("Loaded device code from NVS: " + deviceCode);
  }

  // Load ultrasonic tank height
  usTankHeight = prefs.getFloat("tankh", 100.0);

  prefs.end();

  apName = DEVICE_NAME;
  apName += "-";
  apName += deviceCode.substring(3, 7);  // First 4 chars of random part
  apName += "_mvstech";
}

// ══════════════════════════════════════════════════
//  SERIAL REGISTRATION OUTPUT (FACTORY)
// ══════════════════════════════════════════════════

void printRegistrationInfo() {
  Serial.println();
  Serial.println("========================================");
  Serial.println("  SENSEFLOW DEVICE REGISTRATION INFO");
  Serial.println("========================================");
  Serial.print("  Code:           "); Serial.println(deviceCode);
  Serial.print("  Class:          SENSOR (0x02)");
  Serial.println();
  Serial.print("  Sensor Type:    ");
  #if USE_ULTRASONIC
    Serial.println("ULTRASONIC (0x02)");
  #else
    Serial.println("DIP (0x01)");
  #endif
  Serial.print("  Sensor Count:   "); Serial.println(SENSOR_COUNT);
  Serial.print("  Firmware:       "); Serial.println(FIRMWARE_VERSION);
  Serial.print("  MAC:            "); Serial.println(WiFi.macAddress());
  Serial.print("  AP Name:        "); Serial.println(apName);
  Serial.println("========================================");
  Serial.println();
}

// ══════════════════════════════════════════════════
//  ADDRESSABLE LED (WS2812B via FastLED_min)
// ══════════════════════════════════════════════════

CRGB rgbLeds[1];

void setLED(uint8_t r, uint8_t g, uint8_t b) {
  rgbLeds[0] = CRGB(r, g, b);
  FastLED_min<LED_PIN>.show();
}

void setLEDOff() { setLED(0, 0, 0); }

// Level-based color (matches RS485 version)
void setLevelColor(uint8_t pct) {
  if (pct == 0)       setLED(255, 0, 0);      // Red
  else if (pct <= 25) setLED(255, 100, 0);     // Orange
  else if (pct <= 50) setLED(255, 255, 0);     // Yellow
  else if (pct <= 75) setLED(100, 255, 0);     // Light green
  else                setLED(0, 255, 0);       // Green
}

// ══════════════════════════════════════════════════
//  DIP SENSOR LOGIC
// ══════════════════════════════════════════════════

#if !USE_ULTRASONIC

void initDipSensors() {
  for (int i = 0; i < SENSOR_COUNT; i++) {
    pinMode(DIP_PINS[i], INPUT_PULLUP);
  }
}

uint8_t readDipRaw() {
  uint8_t bits = 0;
  for (int i = 0; i < SENSOR_COUNT; i++) {
    if (digitalRead(DIP_PINS[i]) == LOW) {  // Active low
      bits |= (1 << i);
    }
  }
  return bits;
}

// Count consecutive ON sensors from bottom (bit 0)
int countConsecutive(uint8_t bits, int count) {
  int consecutive = 0;
  for (int i = 0; i < count; i++) {
    if (bits & (1 << i)) {
      consecutive++;
    } else {
      break;
    }
  }
  return consecutive;
}

// Check for physics violation (non-consecutive sensors)
bool checkSensorError(uint8_t bits, int count) {
  int totalOn = 0;
  for (int i = 0; i < count; i++) {
    if (bits & (1 << i)) totalOn++;
  }
  int consecutive = countConsecutive(bits, count);
  return (totalOn != consecutive);  // Error if non-consecutive
}

uint8_t bitsToPercent(uint8_t bits, int count) {
  int consecutive = countConsecutive(bits, count);
  if (consecutive == 0) return 0;
  if (count >= 1 && count <= 6) {
    return DIP_PCT_TABLE[count][consecutive - 1];
  }
  return 0;
}

void processDipSensors() {
  uint8_t currentRaw = readDipRaw();

  if (currentRaw != rawBits) {
    rawBits = currentRaw;
    if (!debouncing || currentRaw != pendingBits) {
      pendingBits = currentRaw;
      debounceStart = millis();
      debouncing = true;
    }
  }

  if (debouncing && (millis() - debounceStart >= DIP_DEBOUNCE_MS)) {
    debouncing = false;
    sensorBits = pendingBits;
    sensorError = checkSensorError(sensorBits, SENSOR_COUNT);

    if (sensorError) {
      flags |= 0x01;   // bit0 = sensorError
    } else {
      flags &= ~0x01;
    }

    confirmedPct = bitsToPercent(sensorBits, SENSOR_COUNT);
  }
}

#endif

// ══════════════════════════════════════════════════
//  ULTRASONIC SENSOR LOGIC
// ══════════════════════════════════════════════════

#if USE_ULTRASONIC

void initUltrasonic() {
  pinMode(US_TRIG_PIN, OUTPUT);
  pinMode(US_ECHO_PIN, INPUT);
  digitalWrite(US_TRIG_PIN, LOW);
}

float readUltrasonicRaw() {
  digitalWrite(US_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(US_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(US_TRIG_PIN, LOW);

  long duration = pulseIn(US_ECHO_PIN, HIGH, 30000);  // 30ms timeout
  if (duration == 0) return -1;

  float distance = duration * 0.0343 / 2.0;

  // Calibration (same as RS485 version)
  distance = -0.456079 + (1.0165 * distance);

  if (distance < US_BLIND_ZONE || distance > US_MAX_RANGE) return -1;
  return distance;
}

// Median Absolute Deviation filter
float madFilter(float* samples, int count) {
  // Sort for median
  float sorted[US_SAMPLES];
  memcpy(sorted, samples, count * sizeof(float));
  for (int i = 0; i < count - 1; i++) {
    for (int j = i + 1; j < count; j++) {
      if (sorted[j] < sorted[i]) {
        float tmp = sorted[i];
        sorted[i] = sorted[j];
        sorted[j] = tmp;
      }
    }
  }

  float median = sorted[count / 2];

  // Calculate MAD
  float deviations[US_SAMPLES];
  for (int i = 0; i < count; i++) {
    deviations[i] = abs(samples[i] - median);
  }
  // Sort deviations
  for (int i = 0; i < count - 1; i++) {
    for (int j = i + 1; j < count; j++) {
      if (deviations[j] < deviations[i]) {
        float tmp = deviations[i];
        deviations[i] = deviations[j];
        deviations[j] = tmp;
      }
    }
  }
  float mad = deviations[count / 2];

  // Filter outliers, average inliers
  float sum = 0;
  int inliers = 0;
  for (int i = 0; i < count; i++) {
    if (abs(samples[i] - median) <= US_MAD_MULTIPLIER * mad + 0.001) {
      sum += samples[i];
      inliers++;
    }
  }

  return (inliers > 0) ? (sum / inliers) : median;
}

void processUltrasonic() {
  if (millis() - lastUsRead < US_READ_INTERVAL) return;
  lastUsRead = millis();

  float samples[US_SAMPLES];
  int validCount = 0;

  for (int i = 0; i < US_SAMPLES; i++) {
    float d = readUltrasonicRaw();
    if (d > 0) {
      samples[validCount++] = d;
    }
    delay(10);
  }

  if (validCount < 3) {
    usFailCount++;
    if (usFailCount >= US_FAIL_LIMIT) {
      usSensorOffline = true;
      flags |= 0x20;     // bit5 = sensorOffline
      confirmedPct = 0xFF;
    }
    return;
  }

  usFailCount = 0;
  usSensorOffline = false;
  flags &= ~0x20;

  float filtered = madFilter(samples, validCount);

  // Apply hysteresis
  if (abs(filtered - usFilteredDistance) < US_HYSTERESIS) {
    // No significant change
  } else {
    usFilteredDistance = filtered;
  }

  usRawDistance = filtered;

  // Distance to percent: tank full when distance is small
  float waterHeight = usTankHeight - usFilteredDistance;
  if (waterHeight < 0) waterHeight = 0;
  if (waterHeight > usTankHeight) waterHeight = usTankHeight;

  confirmedPct = (uint8_t)((waterHeight / usTankHeight) * 100.0);
  sensorBits = 0;  // Not applicable for ultrasonic
}

#endif

// ══════════════════════════════════════════════════
//  FIREBASE
// ══════════════════════════════════════════════════

void initFirebase() {
  fbConfig.api_key = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;

  // Anonymous auth
  fbAuth.user.email = "";
  fbAuth.user.password = "";

  fbConfig.token_status_callback = tokenStatusCallback;

  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectNetwork(true);

  Serial.println("Firebase initialized, signing in anonymously...");
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

// Write to /pendingDevices/{deviceCode} — capability info only
void writePendingDevice() {
  String path = "pendingDevices/" + deviceCode;

  FirebaseJson json;
  json.set("deviceClass", CLS_SENSOR);
  #if USE_ULTRASONIC
    json.set("sensorType", SNS_ULTRASONIC);
  #else
    json.set("sensorType", SNS_DIP);
  #endif
  json.set("sensorCount", SENSOR_COUNT);
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("macAddress", WiFi.macAddress());
  json.set("firstSeenAt/.sv", "timestamp");

  if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    Serial.println("Pending device info written to Firebase");
  } else {
    Serial.println("Failed to write pending device: " + fbdo.errorReason());
  }
}

// Push live sensor data to /devices/{deviceCode}/live/
bool pushLiveData() {
  String path = "devices/" + deviceCode + "/live";

  FirebaseJson json;
  json.set("sensorBits", sensorBits);
  json.set("confirmedPct", confirmedPct);
  json.set("stateVal", 0);   // Sensor-only, no valve state
  json.set("flags", flags);
  json.set("rssi", WiFi.RSSI());
  json.set("timestamp/.sv", "timestamp");

  if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    lastSentBits = sensorBits;
    lastSentPct = confirmedPct;
    lastSentFlags = flags;
    lastDataPush = millis();
    return true;
  } else {
    Serial.println("Data push failed: " + fbdo.errorReason());
    return false;
  }
}

// Update device info node
void updateDeviceInfo(bool online) {
  String path = "devices/" + deviceCode + "/info";

  FirebaseJson json;
  json.set("online", online);
  json.set("lastSeen/.sv", "timestamp");
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("deviceClass", CLS_SENSOR);
  #if USE_ULTRASONIC
    json.set("sensorType", SNS_ULTRASONIC);
  #else
    json.set("sensorType", SNS_DIP);
  #endif
  json.set("sensorCount", SENSOR_COUNT);

  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

// Check commands node
void checkCommands() {
  String basePath = "devices/" + deviceCode + "/commands/";

  if (Firebase.RTDB.getBool(&fbdo, (basePath + "refreshRequested").c_str())) {
    if (fbdo.boolData()) {
      Serial.println("Refresh requested — force pushing data");
      pushLiveData();
      Firebase.RTDB.setBool(&fbdo, (basePath + "refreshRequested").c_str(), false);
    }
  }
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "testRequested").c_str())) {
    if (fbdo.boolData()) {
      Serial.println("Test requested — blinking LED");
      testBlinkActive = true;
      testBlinkStart = millis();
      Firebase.RTDB.setBool(&fbdo, (basePath + "testRequested").c_str(), false);
    }
  }
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "restartRequested").c_str())) {
    if (fbdo.boolData()) {
      Serial.println("Restart requested — rebooting...");
      Firebase.RTDB.setBool(&fbdo, (basePath + "restartRequested").c_str(), false);
      updateDeviceInfo(false);
      delay(500);
      ESP.restart();
    }
  }
}

// ══════════════════════════════════════════════════
//  CHANGE DETECTION — only push when values change
// ══════════════════════════════════════════════════

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

  // Priority 1: Test blink (rainbow cycle 3 times)
  if (testBlinkActive) {
    unsigned long elapsed = now - testBlinkStart;
    if (elapsed < 1800) {
      // 3 cycles of rainbow, each 600ms
      int phase = (elapsed / 200) % 3;
      if (phase == 0) setLED(255, 0, 0);
      else if (phase == 1) setLED(0, 255, 0);
      else setLED(0, 0, 255);
    } else {
      testBlinkActive = false;
    }
    return;
  }

  // Priority 2: Sensor error — solid purple
  if (sensorError) {
    setLED(128, 0, 128);
    return;
  }

  #if USE_ULTRASONIC
  if (usSensorOffline) {
    setLED(128, 0, 128);  // Purple for offline too
    return;
  }
  #endif

  // Priority 3 & 4: Level color (30s) → WiFi blink → repeat
  unsigned long cycleElapsed = now - ledCycleStart;

  if (cycleElapsed >= (LED_CYCLE_DURATION + WIFI_BLINK_DURATION)) {
    // Restart cycle
    ledCycleStart = now;
    ledShowingWifi = false;
  }

  if (cycleElapsed < LED_CYCLE_DURATION) {
    // Show level color
    setLevelColor(confirmedPct);
    ledShowingWifi = false;
  } else {
    // WiFi status blink period
    if (!ledShowingWifi) {
      ledShowingWifi = true;
      wifiBlinkStart = now;
    }

    unsigned long blinkElapsed = now - wifiBlinkStart;
    int blinkPhase = (blinkElapsed / 250) % 2;  // 250ms on/off

    if (WiFi.status() == WL_CONNECTED) {
      // Blue blink
      if (blinkPhase == 0) setLED(0, 0, 255);
      else setLEDOff();
    } else {
      // White blink
      if (blinkPhase == 0) setLED(255, 255, 255);
      else setLEDOff();
    }
  }
}

// ══════════════════════════════════════════════════
//  MVSCONNECT CUSTOM PAGE (AP MODE)
// ══════════════════════════════════════════════════

String buildCustomHTML() {
  String html = R"rawliteral(
<!DOCTYPE html><html><head>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>SenseFlow Device</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#f5f5f5;color:#333;padding:16px}
.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
h1{font-size:20px;color:#2563eb;margin-bottom:4px}
h2{font-size:14px;font-weight:600;color:#666;margin-bottom:8px}
.code{font-family:monospace;font-size:18px;font-weight:bold;color:#111;letter-spacing:1px}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px}
.row:last-child{border:none}
.label{color:#888}
.val{font-weight:600;color:#333}
.qr{text-align:center;padding:16px}
.qr img{border:8px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.15);border-radius:4px}
.link{word-break:break-all;font-size:11px;color:#2563eb;margin-top:8px;display:block}
.dip-row{display:flex;gap:6px;margin:8px 0}
.dip-dot{width:28px;height:28px;border-radius:50%;border:2px solid #ccc;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold}
.dip-on{background:#3b82f6;border-color:#2563eb;color:#fff}
.dip-off{background:#e5e7eb;border-color:#d1d5db;color:#999}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px}
.btn-blue{background:#2563eb;color:#fff}
.btn-red{background:#ef4444;color:#fff}
.btn-gray{background:#e5e7eb;color:#333}
</style>
</head><body>
)rawliteral";

  // Device Info Card
  html += "<div class='card'>";
  html += "<h1>SenseFlow Device</h1>";
  html += "<p class='code'>" + deviceCode + "</p>";
  html += "</div>";

  // Device code for admin reference
  html += "<div class='card' style='text-align:center'>";
  html += "<h2>Device Code</h2>";
  html += "<p class='code' style='font-size:20px;margin:10px 0;user-select:all'>" + deviceCode + "</p>";
  html += "<p style='font-size:10px;color:#888'>Register this code in admin panel to generate QR</p>";
  html += "</div>";

  // Details Card
  html += "<div class='card'>";
  html += "<h2>Device Details</h2>";
  html += "<div class='row'><span class='label'>Class</span><span class='val'>Sensor (0x02)</span></div>";

  #if USE_ULTRASONIC
    html += "<div class='row'><span class='label'>Sensor Type</span><span class='val'>Ultrasonic</span></div>";
    html += "<div class='row'><span class='label'>Tank Height</span><span class='val'>" + String(usTankHeight, 0) + " cm</span></div>";
  #else
    html += "<div class='row'><span class='label'>Sensor Type</span><span class='val'>DIP</span></div>";
    html += "<div class='row'><span class='label'>Sensor Count</span><span class='val'>" + String(SENSOR_COUNT) + "</span></div>";
  #endif

  html += "<div class='row'><span class='label'>Firmware</span><span class='val'>" + String(FIRMWARE_VERSION) + "</span></div>";
  html += "<div class='row'><span class='label'>MAC</span><span class='val'>" + WiFi.macAddress() + "</span></div>";
  html += "<div class='row'><span class='label'>WiFi</span><span class='val'>" + mvs.getWiFiStatus() + "</span></div>";
  html += "<div class='row'><span class='label'>RSSI</span><span class='val'>" + String(WiFi.RSSI()) + " dBm</span></div>";
  html += "<div class='row'><span class='label'>Level</span><span class='val'>" + String(confirmedPct) + "%</span></div>";
  html += "</div>";

  // DIP Sensor Live Check
  #if !USE_ULTRASONIC
    html += "<div class='card'>";
    html += "<h2>DIP Sensors (Live)</h2>";
    html += "<div class='dip-row'>";
    for (int i = 0; i < SENSOR_COUNT; i++) {
      bool on = (sensorBits >> i) & 1;
      html += "<div class='dip-dot " + String(on ? "dip-on" : "dip-off") + "'>" + String(i + 1) + "</div>";
    }
    html += "</div>";
    if (sensorError) {
      html += "<p style='color:#a855f7;font-size:12px;font-weight:600'>Sensor Error: Non-consecutive</p>";
    }
    html += "</div>";
  #endif

  // Actions Card
  html += "<div class='card'>";
  html += "<h2>Actions</h2>";
  html += "<a href='/restart'><button class='btn btn-red'>Restart Device</button></a>";
  html += "</div>";

  html += "<script>setTimeout(()=>location.reload(),5000)</script>";
  html += "</body></html>";

  return html;
}

// ══════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n=== SenseFlow Firebase Sensor v" FIRMWARE_VERSION " ===\n");

  // LED
  FastLED_min<LED_PIN>.addLeds(rgbLeds, 1);
  FastLED_min<LED_PIN>.setBrightness(80);
  setLED(255, 100, 0);  // Orange on boot

  // Load or generate device code
  loadOrCreateDeviceCode();

  // Print registration info (factory serial output)
  printRegistrationInfo();

  // Initialize sensors
  #if USE_ULTRASONIC
    initUltrasonic();
    Serial.println("Ultrasonic sensor initialized");
  #else
    initDipSensors();
    Serial.println("DIP sensors initialized (" + String(SENSOR_COUNT) + " switches)");
  #endif

  // Start MvsConnect AP
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), AP_PASSWORD);
  Serial.println("AP started: " + apName);

  // MvsConnect setup
  mvs.setCustomHTML([](){ return buildCustomHTML(); });

  mvs.onWiFiCredentialsReceived([](const String& ssid) {
    Serial.println("WiFi credentials received: " + ssid);
  });

  // begin() MUST be called before addEndpoint()
  mvs.begin();

  // API endpoints — use mvs.getServer() inside handlers
  mvs.addEndpoint("/restart", []() {
    WebServer* srv = mvs.getServer();
    srv->send(200, "text/html", "<html><body><h2>Restarting...</h2><script>setTimeout(()=>history.back(),3000)</script></body></html>");
    delay(1000);
    ESP.restart();
  });

  mvs.addEndpoint("/sstatus", []() {
    WebServer* srv = mvs.getServer();
    String json = "{";
    json += "\"code\":\"" + deviceCode + "\",";
    json += "\"level\":" + String(confirmedPct) + ",";
    json += "\"bits\":" + String(sensorBits) + ",";
    json += "\"flags\":" + String(flags) + ",";
    json += "\"error\":" + String(sensorError ? "true" : "false") + ",";
    json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
    json += "\"wifi\":\"" + mvs.getWiFiStatus() + "\",";
    json += "\"firebase\":" + String(firebaseReady ? "true" : "false");
    json += "}";
    srv->send(200, "application/json", json);
  });

  // Try connecting to saved WiFi
  if (mvs.hasSavedWiFi()) {
    Serial.println("Connecting to saved WiFi...");
    setLED(0, 0, 255);  // Blue while connecting
    if (mvs.connectToSavedWiFi(30)) {
      Serial.println("WiFi connected! IP: " + WiFi.localIP().toString());
      setLED(0, 255, 0);  // Green on connect
      initFirebase();
    } else {
      Serial.println("WiFi connection failed, AP mode active");
      setLED(255, 255, 255);  // White = no WiFi
    }
  } else {
    Serial.println("No saved WiFi, AP mode active for setup");
    setLED(255, 255, 255);
  }

  ledCycleStart = millis();
}

// ══════════════════════════════════════════════════
//  MAIN LOOP
// ══════════════════════════════════════════════════

void loop() {
  unsigned long now = millis();

  // MvsConnect always runs (AP mode web server)
  mvs.handle();

  // Read sensors continuously
  #if USE_ULTRASONIC
    processUltrasonic();
  #else
    processDipSensors();
  #endif

  // Handle LED state machine
  handleLED();

  // Firebase operations only when WiFi connected
  if (WiFi.status() == WL_CONNECTED) {

    // Initialize Firebase if not done
    if (!firebaseReady && !Firebase.ready()) {
      // Still waiting for auth
    }
    checkFirebaseReady();

    if (firebaseReady) {

      // Change-driven data push
      if (hasDataChanged()) {
        Serial.printf("Data changed: bits=%d pct=%d flags=%d → pushing\n", sensorBits, confirmedPct, flags);
        if (pushLiveData()) {
          updateDeviceInfo(true);
        }
      }

      // 5-minute heartbeat
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        Serial.println("Heartbeat — pushing data + checking commands");
        pushLiveData();
        updateDeviceInfo(true);
      }

      // Check commands every 5 seconds
      if (now - lastCommandCheck >= COMMAND_CHECK_INTERVAL) {
        lastCommandCheck = now;
        checkCommands();
      }
    }
  } else {
    // Try reconnecting every 30 seconds
    static unsigned long lastReconnect = 0;
    if (now - lastReconnect > 30000) {
      lastReconnect = now;
      if (mvs.hasSavedWiFi()) {
        Serial.println("Attempting WiFi reconnect...");
        if (mvs.connectToSavedWiFi(10)) {
          Serial.println("Reconnected!");
          if (!firebaseReady) initFirebase();
        }
      }
    }
  }

  // Serial commands
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    handleSerialCommand(cmd);
  }
}

// ══════════════════════════════════════════════════
//  SERIAL COMMANDS
// ══════════════════════════════════════════════════

void handleSerialCommand(String cmd) {
  cmd.toUpperCase();

  if (cmd == "STATUS" || cmd == "S") {
    Serial.println("\n--- Device Status ---");
    Serial.println("Code:       " + deviceCode);
    Serial.println("WiFi:       " + mvs.getWiFiStatus());
    Serial.println("IP:         " + WiFi.localIP().toString());
    Serial.println("RSSI:       " + String(WiFi.RSSI()) + " dBm");
    Serial.println("Firebase:   " + String(firebaseReady ? "Ready" : "Not ready"));
    Serial.println("Level:      " + String(confirmedPct) + "%");
    Serial.println("SensorBits: " + String(sensorBits, BIN));
    Serial.println("Flags:      0x" + String(flags, HEX));
    Serial.println("Error:      " + String(sensorError ? "YES" : "No"));
    Serial.println("Uptime:     " + String(millis() / 1000) + "s");
    Serial.println("Free Heap:  " + String(ESP.getFreeHeap()));
    Serial.println("--------------------\n");
  }
  else if (cmd == "ADMIN") {
    printRegistrationInfo();
  }
  else if (cmd == "RESTART" || cmd == "RESET") {
    Serial.println("Restarting...");
    delay(500);
    ESP.restart();
  }
  else if (cmd == "RESET_WIFI") {
    Serial.println("Clearing WiFi credentials...");
    mvs.clearSavedWiFi();
    delay(500);
    ESP.restart();
  }
  else if (cmd == "HELP") {
    Serial.println("\nCommands: STATUS, ADMIN, RESTART, RESET_WIFI, HELP\n");
  }
}
