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
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <MvsConnect.h>
#include <mvsota_esp32.h>
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
#define WIFI_BLINK_DURATION   2000     // WiFi status blink (2s per sticker spec)

// Ultrasonic
#define US_SAMPLES        15
#define US_MAD_MULTIPLIER 2.5
#define US_BLIND_ZONE     21.0    // cm
#define US_MAX_RANGE      450.0   // cm
#define US_HYSTERESIS     10.0    // cm
#define US_FAIL_LIMIT     10
#define US_OFFLINE_TIMEOUT 60000  // ms
#define US_MIN_CHANGE_CM  5       // Only push if distance changed by 5cm+
#define US_STEP_SIZE      5       // Ultrasonic: snap to steps (0,5,10,...95,100)

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
MvsOTA mvsota;

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

// Analytics — write history on data change
bool analyticsOn = false;

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
float usLastSentDistance = 0;  // For min change threshold
uint8_t usLastSentPct = 0xFF;
float usTankHeight = 100.0;   // cm, configurable from AP page
int   usFailCount = 0;
bool  usSensorOffline = false;
unsigned long lastUsRead = 0;

// Timing
unsigned long lastHeartbeat = 0;
unsigned long lastCommandCheck = 0;

// Manual WiFi flag — pauses auto-reconnect
bool manualWiFiInProgress = false;
unsigned long manualWiFiStart = 0;

// Push fail tracking
int consecutiveFailCount = 0;
bool pushFailFlash = false;
unsigned long pushFailFlashStart = 0;
unsigned long lastSuccessfulPush = 0;
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
  mvs.setDeviceName(String(DEVICE_NAME) + "-" + deviceCode.substring(3, 7));
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
bool internetAvailable = false;
unsigned long lastInternetCheck = 0;

// Force Google DNS — fixes broken router DNS
void setGoogleDNS() {
  IPAddress dns1(8, 8, 8, 8);
  IPAddress dns2(8, 8, 4, 4);
  WiFi.config(WiFi.localIP(), WiFi.gatewayIP(), WiFi.subnetMask(), dns1, dns2);
  Serial.println("DNS set to 8.8.8.8 / 8.8.4.4");
}

// Check internet by connecting to Google DNS
bool checkInternet() {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClient client;
  bool ok = client.connect("8.8.8.8", 53, 2000);
  client.stop();
  return ok;
}

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
  else                setLED(0, 200, 0);        // Green - Full
}

// ══════════════════════════════════════════════════
//  DIP SENSOR LOGIC
// ══════════════════════════════════════════════════

#if !USE_ULTRASONIC

void initDipSensors() {
  for (int i = 0; i < SENSOR_COUNT; i++) {
    pinMode(DIP_PINS[i], INPUT_PULLDOWN);
  }
}

uint8_t readDipRaw() {
  uint8_t bits = 0;
  for (int i = 0; i < SENSOR_COUNT; i++) {
    if (digitalRead(DIP_PINS[i]) == HIGH) {  // Active high — HIGH = water touching
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
  // Count consecutive ON sensors from bottom (bit 0 = GPIO 32 = bottom)
  // 0001 = 25%, 0011 = 50%, 0111 = 75%, 1111 = 100%
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
    // No significant change in raw reading
  } else {
    usFilteredDistance = filtered;
  }

  usRawDistance = filtered;

  // Distance to percent: tank full when distance is small
  float waterHeight = usTankHeight - usFilteredDistance;
  if (waterHeight < 0) waterHeight = 0;
  if (waterHeight > usTankHeight) waterHeight = usTankHeight;

  uint8_t rawPct = (uint8_t)((waterHeight / usTankHeight) * 100.0);

  // Snap to nearest step
  uint8_t snapped = ((rawPct + US_STEP_SIZE / 2) / US_STEP_SIZE) * US_STEP_SIZE;
  if (snapped > 100) snapped = 100;

  // Only push if step changed or distance moved significantly
  float distChange = abs(usFilteredDistance - usLastSentDistance);
  if (snapped != usLastSentPct || distChange >= US_MIN_CHANGE_CM || usLastSentPct == 0xFF) {
    confirmedPct = snapped;
    usLastSentDistance = usFilteredDistance;
    usLastSentPct = snapped;
  }
  // LED always shows latest reading even if not pushed
  // (confirmedPct stays at last pushed value, but LED can show newPct)

  sensorBits = 0;  // Not applicable for ultrasonic
}

#endif

// ══════════════════════════════════════════════════
//  FIREBASE
// ══════════════════════════════════════════════════

void initFirebase() {
  Serial.println("[FB] initFirebase called");
  // Ensure Google DNS is set before any Firebase connection
  if (WiFi.status() == WL_CONNECTED) setGoogleDNS();
  Serial.println("[FB] DB URL: " + String(FIREBASE_DB_URL));

  fbConfig.api_key = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;
  fbConfig.token_status_callback = tokenStatusCallback;

  Serial.println("[FB] Calling Firebase.begin...");
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectNetwork(true);
  Serial.println("[FB] Firebase.begin done");

  Serial.println("[FB] Calling signUp for anonymous auth...");
  if (Firebase.signUp(&fbConfig, &fbAuth, "", "")) {
    Serial.println("[FB] Anonymous auth OK!");
  } else {
    Serial.println("[FB] Auth FAILED: " + String(fbConfig.signer.signupError.message.c_str()));
  }

  Serial.println("[FB] Firebase.ready() = " + String(Firebase.ready() ? "true" : "false"));
}

bool checkFirebaseReady() {
  if (Firebase.ready()) {
    if (!firebaseReady) {
      firebaseReady = true;
      Serial.println("Firebase ready!");
      writePendingDevice();
      // Immediate heartbeat — device shows online right away
      pushLiveData();
      updateDeviceInfo(true);
      Serial.println("Initial heartbeat sent!");
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
    consecutiveFailCount = 0;
    lastSuccessfulPush = millis();
    return true;
  } else {
    consecutiveFailCount++;
    pushFailFlash = true;
    pushFailFlashStart = millis();
    Serial.printf("Push FAILED (%d): %s\n", consecutiveFailCount, fbdo.errorReason().c_str());
    if (consecutiveFailCount >= 5) {
      Serial.println("[FB] 5 consecutive fails — resetting Firebase auth");
      firebaseReady = false;
      internetAvailable = false;
      consecutiveFailCount = 0;
    }
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

// Write history entry — only called on data change when analyticsOn
void writeHistory() {
  if (!analyticsOn) return;
  String path = "devices/" + deviceCode + "/history/" + String(millis());
  // Use server timestamp as key would be ideal but RTDB push generates unique key
  // Instead, use push() which creates a unique chronological key
  FirebaseJson json;
  json.set("pct", confirmedPct);
  json.set("bits", sensorBits);
  json.set("flags", flags);
  json.set("ts/.sv", "timestamp");
  if (Firebase.RTDB.pushJSON(&fbdo, ("devices/" + deviceCode + "/history").c_str(), &json)) {
    Serial.println("[HISTORY] Entry recorded");
  }
}

// Check config — read analyticsOn flag
void checkConfig() {
  String path = "devices/" + deviceCode + "/config/analyticsOn";
  if (Firebase.RTDB.getBool(&fbdo, path.c_str())) {
    bool newVal = fbdo.boolData();
    if (newVal != analyticsOn) {
      analyticsOn = newVal;
      Serial.printf("[CONFIG] analyticsOn = %s\n", analyticsOn ? "ON" : "OFF");
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

  // Push fail red flash
  if (pushFailFlash) {
    if (now - pushFailFlashStart < 500) {
      setLED(255, 0, 0);
      return;
    } else { pushFailFlash = false; }
  }
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

  // LED cycle: 30s level color → 5s system status blink → repeat
  unsigned long cycleElapsed = now - ledCycleStart;
  if (cycleElapsed >= 35000) { ledCycleStart = now; ledShowingWifi = false; }

  if (cycleElapsed >= 30000) {
    // Stage 2: System status blink (5s) — HIGHEST PRIORITY, overrides sensor error
    if (!ledShowingWifi) { ledShowingWifi = true; wifiBlinkStart = now; }
    int blinkPhase = ((now - wifiBlinkStart) / 250) % 2;
    if (WiFi.status() != WL_CONNECTED) {
      if (blinkPhase == 0) setLED(255, 255, 255); else setLEDOff();  // White blink = no WiFi
    } else if (!internetAvailable) {
      if (blinkPhase == 0) setLED(255, 0, 100); else setLEDOff();    // Pink blink = WiFi but no internet
    } else {
      if (blinkPhase == 0) setLED(0, 0, 255); else setLEDOff();      // Blue blink = WiFi + internet OK
    }
  } else {
    // Stage 1: Tank level color (30s)
    ledShowingWifi = false;
    if (sensorError) {
      setLED(148, 51, 234);  // Purple - sensor error
    }
    #if USE_ULTRASONIC
    else if (usSensorOffline) {
      setLED(148, 51, 234);  // Purple - sensor offline
    }
    #endif
    else {
      setLevelColor(confirmedPct);
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

  // WiFi status banner
  bool wifiOk = (WiFi.status() == WL_CONNECTED);
  if (wifiOk) {
    html += "<div style='background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:8px'>";
    html += "<div style='width:10px;height:10px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px #22c55e'></div>";
    html += "<div><div style='font-size:12px;font-weight:700;color:#166534'>WiFi Connected</div>";
    html += "<div style='font-size:10px;color:#15803d'>" + WiFi.SSID() + " &bull; " + WiFi.localIP().toString() + " &bull; RSSI " + String(WiFi.RSSI()) + "dBm</div></div></div>";
  } else {
    html += "<div style='background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:8px'>";
    html += "<div style='width:10px;height:10px;border-radius:50%;background:#ef4444;box-shadow:0 0 6px #ef4444'></div>";
    html += "<div><div style='font-size:12px;font-weight:700;color:#991b1b'>WiFi Not Connected</div>";
    html += "<div style='font-size:10px;color:#dc2626'>Enter credentials below or use MvsConnect app</div></div></div>";
  }

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
  html += "<div class='row'><span class='label'>Firebase</span><span class='val'>" + String(firebaseReady ? "Ready" : "Not ready") + "</span></div>";
  html += "<div class='row'><span class='label'>Last Push</span><span class='val'>" +
    (lastSuccessfulPush > 0 ? String((millis() - lastSuccessfulPush) / 1000) + "s ago" : "Never") + "</span></div>";
  html += "<div class='row'><span class='label'>Push Fails</span><span class='val" +
    String(consecutiveFailCount > 0 ? "' style='color:#ef4444" : "") + "'>" + String(consecutiveFailCount) + "</span></div>";
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

  // Tank height config (ultrasonic only)
  #if USE_ULTRASONIC
    html += "<div class='card'>";
    html += "<h2>Tank Settings</h2>";
    html += "<form action='/settank' method='GET' style='display:flex;gap:6px;align-items:center'>";
    html += "<span style='font-size:12px;color:#666;white-space:nowrap'>Height (cm):</span>";
    html += "<input type='number' name='h' min='10' max='500' value='" + String((int)usTankHeight) + "' style='flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px' required>";
    html += "<button class='btn btn-blue' type='submit' style='margin:0;padding:8px 16px'>Save</button>";
    html += "</form>";
    html += "<div class='row' style='margin-top:6px'><span class='label'>Raw Distance</span><span class='val'>" + String(usRawDistance, 1) + " cm</span></div>";
    html += "<div class='row'><span class='label'>Min Change</span><span class='val'>" + String(US_MIN_CHANGE_CM) + " cm / " + String(US_STEP_SIZE) + "% step</span></div>";
    html += "</div>";
  #endif

  // Actions Card
  html += "<div class='card'>";
  html += "<h2>Actions</h2>";
  html += "<a href='/restart'><button class='btn btn-red'>Restart Device</button></a>";
  html += "</div>";

  // Manual WiFi entry
  html += "<div class='card'>";
  html += "<h2>WiFi Setup</h2>";
  html += "<form action='/setwifi' method='GET'>";
  html += "<input type='text' name='ssid' placeholder='WiFi SSID' style='width:100%;margin-bottom:6px;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px' required>";
  html += "<div style='position:relative'>";
  html += "<input type='password' id='wpass' name='pass' placeholder='Password' style='width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;padding-right:40px'>";
  html += "<button type='button' onclick=\"var p=document.getElementById('wpass');p.type=p.type==='password'?'text':'password'\" style='position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:#888;font-size:14px;cursor:pointer'>&#128065;</button>";
  html += "</div>";
  html += "<button class='btn btn-blue' type='submit' style='width:100%;margin-top:8px'>Connect WiFi</button>";
  html += "</form>";
  html += "</div>";

  html += "<script>var t=setInterval(()=>{if(!document.activeElement||document.activeElement.tagName==='BODY')location.reload()},5000)</script>";
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
      srv->send(400, "text/html", "<html><body><h2>SSID required</h2></body></html>");
      return;
    }
    srv->send(200, "text/html", "<html><body><h2>Connecting to " + ssid + "...</h2><p>Page will reload in 15s</p><script>setTimeout(()=>location.href='/',15000)</script></body></html>");
    Serial.println("Manual WiFi: " + ssid);
    // Pause auto-reconnect for 30s so it doesn't fight
    manualWiFiInProgress = true;
    manualWiFiStart = millis();
    // Full disconnect and wait
    WiFi.disconnect(true);
    delay(1000);
    // Save new credentials to NVS first
    Preferences wifiPrefs;
    wifiPrefs.begin("mvsconnect", false);
    wifiPrefs.putString("ssid", ssid);
    wifiPrefs.putString("password", pass);
    wifiPrefs.putBool("valid", true);
    wifiPrefs.end();
    // Now connect with new credentials
    WiFi.begin(ssid.c_str(), pass.c_str());
    Serial.println("WiFi.begin called for: " + ssid);
  });

  // API endpoints — use mvs.getServer() inside handlers
  // Tank height setting (ultrasonic)
  mvs.addEndpoint("/settank", []() {
    WebServer* srv = mvs.getServer();
    float h = srv->arg("h").toFloat();
    if (h >= 10 && h <= 500) {
      usTankHeight = h;
      Preferences tankPrefs;
      tankPrefs.begin("senseflow", false);
      tankPrefs.putFloat("tankh", h);
      tankPrefs.end();
      Serial.println("Tank height set to: " + String(h) + " cm");
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

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
      setGoogleDNS();
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

  // MvsOTA
  mvsota.begin(DEVICE_NAME, FIRMWARE_VERSION, FIRMWARE_CODE);

  ledCycleStart = millis();
}

// ══════════════════════════════════════════════════
//  MAIN LOOP
// ══════════════════════════════════════════════════

void loop() {
  unsigned long now = millis();

  // MvsConnect always runs (AP mode web server)
  mvs.handle();
  if (!mvsota.isUpdating()) mvsota.handle();

  // Read sensors continuously
  #if USE_ULTRASONIC
    processUltrasonic();
  #else
    processDipSensors();
  #endif

  // Handle LED state machine
  handleLED();

  // mDNS handled by MvsConnect library (<deviceName>-mvstech.local)

  // Internet check — only when Firebase not ready (saves bandwidth once connected)
  if (firebaseReady) {
    internetAvailable = true;
  } else if (WiFi.status() == WL_CONNECTED && (now - lastInternetCheck > 30000)) {
    lastInternetCheck = now;
    internetAvailable = checkInternet();
    if (internetAvailable) {
      Serial.println("Internet OK, retrying Firebase...");
      initFirebase();
    }
  } else if (WiFi.status() != WL_CONNECTED) {
    internetAvailable = false;
  }

  // Firebase operations only when WiFi connected
  if (WiFi.status() == WL_CONNECTED) {
    checkFirebaseReady();

    if (firebaseReady) {
      // Change-driven data push
      if (hasDataChanged()) {
        Serial.printf("Data changed: bits=%d pct=%d flags=%d → pushing\n", sensorBits, confirmedPct, flags);
        if (pushLiveData()) {
          updateDeviceInfo(true);
          writeHistory();  // Record to history if analytics enabled
        }
        handleLED();  // Prevent LED freeze during Firebase calls
      }

      // 5-minute heartbeat
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        Serial.println("Heartbeat — pushing data + checking commands");
        pushLiveData();
        handleLED();
        updateDeviceInfo(true);
        handleLED();
      }

      // Check commands every 5 seconds
      if (now - lastCommandCheck >= COMMAND_CHECK_INTERVAL) {
        lastCommandCheck = now;
        checkCommands();
        handleLED();
      }

      // Check config every 30 seconds (analyticsOn flag)
      static unsigned long lastConfigCheck = 0;
      if (now - lastConfigCheck >= 30000) {
        lastConfigCheck = now;
        checkConfig();
      }
    }
  } else {
    // Try reconnecting every 30 seconds
    // Clear manual WiFi flag after 30s
    if (manualWiFiInProgress && (now - manualWiFiStart > 30000)) {
      manualWiFiInProgress = false;
    }
    // Auto-reconnect only if manual WiFi is not in progress
    static unsigned long lastReconnect = 0;
    if (!manualWiFiInProgress && (now - lastReconnect > 30000)) {
      lastReconnect = now;
      if (mvs.hasSavedWiFi()) {
        Serial.println("Attempting WiFi reconnect...");
        if (mvs.connectToSavedWiFi(10)) {
          Serial.println("Reconnected!");
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
  else if (cmd == "FIREBASE" || cmd == "FB") {
    Serial.println("\n--- Firebase Debug ---");
    Serial.println("WiFi:       " + String(WiFi.status() == WL_CONNECTED ? "Connected" : "Not connected"));
    Serial.println("Ready:      " + String(Firebase.ready() ? "Yes" : "No"));
    Serial.println("firebaseReady var: " + String(firebaseReady ? "Yes" : "No"));
    Serial.println("Attempting initFirebase now...");
    initFirebase();
    Serial.println("After init, ready: " + String(Firebase.ready() ? "Yes" : "No"));
    Serial.println("----------------------\n");
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
  else if (cmd.startsWith("WIFI ")) {
    // Format: WIFI ssid password
    // Example: WIFI MyNetwork MyPassword123
    // Example: WIFI MyNetwork (no password for open networks)
    String params = cmd.substring(5);
    int spaceIdx = params.indexOf(' ');
    String ssid, pass;
    if (spaceIdx > 0) {
      ssid = params.substring(0, spaceIdx);
      pass = params.substring(spaceIdx + 1);
    } else {
      ssid = params;
      pass = "";
    }
    ssid.trim(); pass.trim();
    if (ssid.length() == 0) {
      Serial.println("Usage: WIFI <ssid> <password>");
      return;
    }
    Serial.println("Setting WiFi: " + ssid);
    Preferences wifiPrefs;
    wifiPrefs.begin("mvsconnect", false);
    wifiPrefs.putString("ssid", ssid);
    wifiPrefs.putString("password", pass);
    wifiPrefs.putBool("valid", true);
    wifiPrefs.end();
    Serial.println("Credentials saved. Restarting...");
    delay(500);
    ESP.restart();
  }
  else if (cmd == "HELP") {
    Serial.println("\nCommands: STATUS, ADMIN, FIREBASE, RESTART, RESET_WIFI, WIFI <ssid> <pass>, HELP\n");
  }
}
