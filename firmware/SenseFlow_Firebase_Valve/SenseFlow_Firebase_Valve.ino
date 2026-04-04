/*
 * SenseFlow Firebase Valve Controller v1.0.0
 *
 * ESP32 valve + sensor device that pushes data to Firebase RTDB.
 * Based on RS485 valve slave firmware, adapted for direct Firebase.
 *
 * Features:
 *   - Motorized ball valve control (230V or 24V via #define)
 *   - DIP water level sensors (1-6 configurable)
 *   - Auto mode: open/close based on thresholds (stored in NVS)
 *   - Firebase RTDB: live data push, config read, command check
 *   - Addressable LED (WS2812B): water level color + system status
 *   - Green/Red LEDs: valve state indication
 *   - Physical buttons: open/close, both-hold 3s = exit auto mode
 *   - MvsConnect AP for WiFi setup
 *   - MvsOTA for over-the-air updates
 *   - Fault detection, retry, limit switch validation
 *
 * Device Code: SF-XXXXXXXX-SN (generated once, stored in NVS)
 * Device Class: 0x01 (Valve)
 * Auth: Firebase anonymous authentication
 *
 * Firebase structure:
 *   /devices/{code}/live/    — valveState, sensorBits, confirmedPct, flags, rssi, timestamp
 *   /devices/{code}/info/    — online, firmwareVersion, deviceClass, sensorType, sensorCount
 *   /devices/{code}/config/  — autoMode, minPercent, maxPercent (written by web dashboard)
 *   /devices/{code}/commands/ — openRequested, closeRequested, refreshRequested, testRequested, restartRequested
 *
 * Valve types:
 *   230V: Limit switches readable anytime (FB_FORWARD/FB_REVERSE)
 *   24V:  Limit switches only readable when relay is ON (pulse-verify needed)
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
//  CONFIGURATION — CHANGE THESE PER DEPLOYMENT
// ══════════════════════════════════════════════════

// Valve type: 230 = 230V AC valve, 24 = 24V DC valve
#define VALVE_TYPE        230

// DIP sensor count (1–6)
#define SENSOR_COUNT      4

// Firebase project config
#define FIREBASE_API_KEY      "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4"
#define FIREBASE_DB_URL       "https://senseflow-5a9bb-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_PROJECT_ID   "senseflow-5a9bb"

// Device info
#define DEVICE_NAME       "SenseFlow-Valve"
#define FIRMWARE_VERSION  "1.0.0"
#define FIRMWARE_CODE     "SF-FBV-2026-01"
#define AP_PASSWORD       "mvstech9867"

// ══════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════

// Device classes
#define CLS_VALVE   0x01
#define CLS_SENSOR  0x02
#define CLS_MOTOR   0x03

// Sensor types
#define SNS_DIP         0x01

// ── Valve pins ──────────────────────────────────
#define BTN_FORWARD    21
#define BTN_REVERSE    22
#define RELAY_FORWARD   4
#define RELAY_REVERSE   5
#define FB_FORWARD     18    // Limit switch OPEN
#define FB_REVERSE     19    // Limit switch CLOSE
#define LED_OPEN       23    // Green LED
#define LED_CLOSE      13    // Red LED

// ── DIP sensor config ───────────────────────────
const int DIP_PINS[] = {32, 33, 14, 27, 34, 35};

// Addressable LED
#define LED_PIN      15

// Timing
#define HEARTBEAT_INTERVAL     300000   // 5 minutes
#define COMMAND_CHECK_INTERVAL 15000    // 15 seconds
#define CONFIG_CHECK_INTERVAL  30000    // 30 seconds
#define DIP_DEBOUNCE_MS         2000
#define FAULT_TIMEOUT_MS        (3UL * 60UL * 1000UL)
#define FAULT_RETRY_INTERVAL_MS (5UL * 60UL * 1000UL)
#define BLINK_INTERVAL_MS       500UL
#define BLINK_INTERVAL_SLOW_MS  1500UL
#define DEBOUNCE_MS             1000UL
#define DEBOUNCE_BTN_MS         50UL
#define BOTH_BTN_HOLD_MS        3000UL

// 24V pulse verify
#if VALVE_TYPE == 24
  #define PULSE_VERIFY_MS  100
#endif

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

// Firebase
FirebaseData fbdo;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;
bool firebaseReady = false;

// Device identity
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

ValveState valveState = STATE_RECOVERY;

// Auto mode config (stored in NVS + synced from Firebase /config/)
bool    autoMode    = false;
uint8_t minPercent  = 25;
uint8_t maxPercent  = 75;

// Relay state tracking
bool currentRelayFwd = false;
bool currentRelayRev = false;

// Fault timer
unsigned long faultTimerStart  = 0;
bool          faultTimerActive = false;

// Fault retry
unsigned long faultRetryTimerStart   = 0;
bool          faultRetrying          = false;
unsigned long faultRetryAttemptStart = 0;
int           faultRetryCount        = 0;
char          faultDirection         = 'O';  // 'O'=was opening, 'C'=was closing

// Both-button hold
unsigned long bothBtnHoldStart = 0;
bool          bothBtnHolding   = false;

// ── Debounce ────────────────────────────────────
struct Debounce {
  bool          lastRaw;
  bool          stableValue;
  unsigned long stableStart;
};

Debounce dbOpen   = {false, false, 0};
Debounce dbClose  = {false, false, 0};
Debounce dbBtnFwd = {true, true, 0};
Debounce dbBtnRev = {true, true, 0};
Debounce dbLevel[6] = {{false,false,0},{false,false,0},{false,false,0},
                        {false,false,0},{false,false,0},{false,false,0}};
bool lastBtnFwd = true;
bool lastBtnRev = true;

// ── Sensor state ────────────────────────────────
bool    levelActive[6] = {false};
bool    sensorError = false;
uint8_t sensorBits = 0;
uint8_t confirmedPct = 0;
uint8_t flags = 0;
// flags: bit0=sensorError, bit1=faultRetrying, bit2=relayFwd, bit3=relayRev, bit4=autoMode

// Last sent values
uint8_t lastSentValveState = 0xFF;
uint8_t lastSentBits = 0xFF;
uint8_t lastSentPct = 0xFF;
uint8_t lastSentFlags = 0xFF;

// Deferred actions
volatile bool pendingSave = false;

// Timing
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

// Addressable LED state
CRGB rgbLeds[1];
bool internetAvailable = false;
unsigned long lastInternetCheck = 0;
unsigned long ledCycleStart = 0;
bool ledShowingWifi = false;
unsigned long wifiBlinkStart = 0;
bool testBlinkActive = false;
unsigned long testBlinkStart = 0;

// ══════════════════════════════════════════════════
//  DEBOUNCE
// ══════════════════════════════════════════════════

bool updateDebounce(Debounce &db, bool rawReading, unsigned long debounceMs) {
  if (rawReading != db.lastRaw) {
    db.lastRaw     = rawReading;
    db.stableStart = millis();
  } else {
    if ((millis() - db.stableStart) >= debounceMs) {
      db.stableValue = rawReading;
    }
  }
  return db.stableValue;
}

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
    uint32_t seed = esp_random();
    randomSeed(seed);
    deviceCode = generateRandomCode();
    prefs.putString("devcode", deviceCode);
    Serial.println("Generated new device code: " + deviceCode);
  } else {
    Serial.println("Loaded device code from NVS: " + deviceCode);
  }

  // Load auto mode config from NVS
  autoMode   = prefs.getBool("automode", false);
  minPercent = prefs.getUChar("minpct", 25);
  maxPercent = prefs.getUChar("maxpct", 75);

  prefs.end();

  // Sanity check
  if (minPercent >= maxPercent) { minPercent = 25; maxPercent = 75; }

  apName = DEVICE_NAME;
  apName += "-";
  apName += deviceCode.substring(3, 7);
  apName += "_mvstech";

  mdnsName = "senseflow-valve-" + deviceCode.substring(3, 7);
  mdnsName.toLowerCase();
}

void saveConfig() {
  prefs.begin("senseflow", false);
  prefs.putBool("automode", autoMode);
  prefs.putUChar("minpct", minPercent);
  prefs.putUChar("maxpct", maxPercent);
  prefs.end();
  Serial.printf("[NVS] Saved: auto=%s min=%d%% max=%d%%\n",
    autoMode ? "ON" : "OFF", minPercent, maxPercent);
}

void printRegistrationInfo() {
  Serial.println("\n========================================");
  Serial.println("  SENSEFLOW VALVE REGISTRATION INFO");
  Serial.println("========================================");
  Serial.print("  Code:           "); Serial.println(deviceCode);
  Serial.println("  Class:          VALVE (0x01)");
  Serial.print("  Valve Type:     "); Serial.println(VALVE_TYPE == 24 ? "24V DC" : "230V AC");
  Serial.print("  Sensors:        "); Serial.println(SENSOR_COUNT > 0 ? String(SENSOR_COUNT) + " DIP" : "None");
  Serial.print("  Firmware:       "); Serial.println(FIRMWARE_VERSION);
  Serial.print("  MAC:            "); Serial.println(WiFi.macAddress());
  Serial.print("  Auto Mode:      "); Serial.println(autoMode ? "ON" : "OFF");
  Serial.printf("  Thresholds:     %d%% / %d%%\n", minPercent, maxPercent);
  Serial.println("========================================\n");
}

// ══════════════════════════════════════════════════
//  DNS + INTERNET CHECK
// ══════════════════════════════════════════════════

void setGoogleDNS() {
  IPAddress dns1(8, 8, 8, 8);
  IPAddress dns2(8, 8, 4, 4);
  WiFi.config(WiFi.localIP(), WiFi.gatewayIP(), WiFi.subnetMask(), dns1, dns2);
  Serial.println("DNS set to 8.8.8.8 / 8.8.4.4");
}

bool checkInternet() {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClient client;
  bool ok = client.connect("8.8.8.8", 53, 2000);
  client.stop();
  return ok;
}

// ══════════════════════════════════════════════════
//  ADDRESSABLE LED (WS2812B)
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
    #if SENSOR_COUNT > 0
    if (sensorError) {
      setLED(148, 51, 234);
    } else {
      setLevelColor(confirmedPct);
    }
    #else
    // No sensor — show valve state color
    if (valveState == STATE_OPEN) setLED(0, 200, 0);
    else if (valveState == STATE_CLOSED) setLED(255, 0, 0);
    else if (valveState == STATE_FAULT || valveState == STATE_LS_ERROR) setLED(148, 51, 234);
    else setLED(0, 0, 255);  // Opening/closing/recovery
    #endif
  }
}

// ══════════════════════════════════════════════════
//  VALVE STATUS LEDs (green/red)
// ══════════════════════════════════════════════════

void updateValveLEDs() {
  bool fastBlink = (millis() / BLINK_INTERVAL_MS) % 2;
  bool slowBlink = (millis() / BLINK_INTERVAL_SLOW_MS) % 2;

  switch (valveState) {
    case STATE_OPEN:
      digitalWrite(LED_OPEN, HIGH); digitalWrite(LED_CLOSE, LOW); break;
    case STATE_CLOSED:
      digitalWrite(LED_OPEN, LOW); digitalWrite(LED_CLOSE, HIGH); break;
    case STATE_OPENING:
    case STATE_RECOVERY:
      digitalWrite(LED_OPEN, fastBlink); digitalWrite(LED_CLOSE, LOW); break;
    case STATE_CLOSING:
      digitalWrite(LED_OPEN, LOW); digitalWrite(LED_CLOSE, fastBlink); break;
    case STATE_FAULT:
      if (faultRetrying) {
        digitalWrite(LED_OPEN, slowBlink); digitalWrite(LED_CLOSE, HIGH);
      } else {
        digitalWrite(LED_OPEN, fastBlink); digitalWrite(LED_CLOSE, fastBlink);
      }
      break;
    case STATE_LS_ERROR:
      digitalWrite(LED_OPEN, slowBlink); digitalWrite(LED_CLOSE, slowBlink); break;
  }
}

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
//  RELAY CONTROL (with safety interlock)
// ══════════════════════════════════════════════════

void setRelays(bool fwd, bool rev) {
  if (fwd && rev) {
    if (currentRelayFwd || currentRelayRev) {
      digitalWrite(RELAY_FORWARD, LOW);
      digitalWrite(RELAY_REVERSE, LOW);
      currentRelayFwd = false;
      currentRelayRev = false;
      Serial.println("[ERROR] Both relays requested - blocking");
    }
    return;
  }
  if (fwd != currentRelayFwd || rev != currentRelayRev) {
    if ((fwd && currentRelayRev) || (rev && currentRelayFwd)) {
      digitalWrite(RELAY_FORWARD, LOW);
      digitalWrite(RELAY_REVERSE, LOW);
      currentRelayFwd = false;
      currentRelayRev = false;
      delay(100);
    }
    digitalWrite(RELAY_FORWARD, fwd ? HIGH : LOW);
    digitalWrite(RELAY_REVERSE, rev ? HIGH : LOW);
    currentRelayFwd = fwd;
    currentRelayRev = rev;
  }
}

// ══════════════════════════════════════════════════
//  VALVE COMMAND (shared by buttons, serial, Firebase)
// ══════════════════════════════════════════════════

#define ACK_EXECUTED  0x00
#define ACK_ALREADY   0x01
#define ACK_FAULT     0x02
#define ACK_LS_ERROR  0x03
#define ACK_RECOVERY  0x04

uint8_t executeValveCommand(char cmd) {
  if (cmd == 'O' || cmd == 'o') {
    if      (valveState == STATE_FAULT)    return ACK_FAULT;
    else if (valveState == STATE_LS_ERROR) return ACK_LS_ERROR;
    else if (valveState == STATE_RECOVERY) return ACK_RECOVERY;
    else if (valveState == STATE_OPEN || valveState == STATE_OPENING)
                                           return ACK_ALREADY;
    else {
      #if VALVE_TYPE == 24
        // Pulse verify: briefly power relay to check if already open
        setRelays(true, false);
        delay(PULSE_VERIFY_MS);
        if (digitalRead(FB_FORWARD)) {
          setRelays(false, false);
          valveState = STATE_OPEN;
          return ACK_ALREADY;
        }
      #endif
      valveState = STATE_OPENING;
      setRelays(true, false);
      updateValveLEDs();
      return ACK_EXECUTED;
    }
  }
  if (cmd == 'C' || cmd == 'c') {
    if      (valveState == STATE_FAULT)    return ACK_FAULT;
    else if (valveState == STATE_LS_ERROR) return ACK_LS_ERROR;
    else if (valveState == STATE_RECOVERY) return ACK_RECOVERY;
    else if (valveState == STATE_CLOSED || valveState == STATE_CLOSING)
                                           return ACK_ALREADY;
    else {
      #if VALVE_TYPE == 24
        setRelays(false, true);
        delay(PULSE_VERIFY_MS);
        if (digitalRead(FB_REVERSE)) {
          setRelays(false, false);
          valveState = STATE_CLOSED;
          return ACK_ALREADY;
        }
      #endif
      valveState = STATE_CLOSING;
      setRelays(false, true);
      updateValveLEDs();
      return ACK_EXECUTED;
    }
  }
  return ACK_EXECUTED;
}

// ══════════════════════════════════════════════════
//  FAULT HANDLING
// ══════════════════════════════════════════════════

void updateFaultTimer(bool openLS, bool closeLS) {
  if (openLS || closeLS) {
    faultTimerActive = false;
    faultTimerStart  = 0;
  } else {
    if (!faultTimerActive) {
      faultTimerStart  = millis();
      faultTimerActive = true;
    }
  }
}

bool faultTimerExpired() {
  return faultTimerActive &&
         ((millis() - faultTimerStart) >= FAULT_TIMEOUT_MS);
}

void handleFaultState(bool openLS, bool closeLS) {
  // Only exit fault if the TARGET LS triggers (the direction we were trying to go)
  if (faultDirection == 'O' && openLS) {
    Serial.println("[FAULT] Open LS confirmed - exiting - STATE_OPEN");
    setRelays(false, false);
    faultRetrying = false; faultRetryCount = 0; faultTimerActive = false;
    valveState = STATE_OPEN;
    return;
  }
  if (faultDirection == 'C' && closeLS) {
    Serial.println("[FAULT] Close LS confirmed - exiting - STATE_CLOSED");
    setRelays(false, false);
    faultRetrying = false; faultRetryCount = 0; faultTimerActive = false;
    valveState = STATE_CLOSED;
    return;
  }
  if (!faultRetrying) {
    if ((millis() - faultRetryTimerStart) >= FAULT_RETRY_INTERVAL_MS) {
      faultRetryCount++;
      faultRetrying = true;
      faultRetryAttemptStart = millis();
      faultTimerActive = false;
      faultTimerStart  = 0;
      Serial.printf("[FAULT] Retry #%d direction=%c\n", faultRetryCount, faultDirection);
      // Retry in the SAME direction that failed
      if (faultDirection == 'C') setRelays(false, true);
      else setRelays(true, false);
    }
  } else {
    // Keep relay on during retry
    if (faultDirection == 'C') setRelays(false, true);
    else setRelays(true, false);
    if ((millis() - faultRetryAttemptStart) >= FAULT_TIMEOUT_MS) {
      Serial.printf("[FAULT] Retry #%d failed\n", faultRetryCount);
      setRelays(false, false);
      faultRetrying        = false;
      faultRetryTimerStart = millis();
    }
  }
}

// ══════════════════════════════════════════════════
//  DIP SENSOR LOGIC
// ══════════════════════════════════════════════════

#if SENSOR_COUNT > 0

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

void validateSensors() {
  sensorBits = 0;
  for (int i = 0; i < SENSOR_COUNT; i++) {
    if (levelActive[i]) sensorBits |= (1 << i);
  }

  sensorError = checkSensorError(sensorBits, SENSOR_COUNT);
  if (sensorError) flags |= 0x01; else flags &= ~0x01;

  confirmedPct = bitsToPercent(sensorBits, SENSOR_COUNT);
}

bool isValidPercent(uint8_t pct) {
  if (pct == 0) return true;
  for (int i = 0; i < SENSOR_COUNT; i++) {
    if (DIP_PCT_TABLE[SENSOR_COUNT][i] == pct) return true;
  }
  return false;
}

#else
// No sensors — stubs
void validateSensors() {}
bool isValidPercent(uint8_t) { return true; }
#endif

// ══════════════════════════════════════════════════
//  AUTO MODE EVALUATOR
// ══════════════════════════════════════════════════

#if SENSOR_COUNT > 0
void evaluateAutoMode() {
  if (!autoMode) return;
  if (sensorError) return;
  if (valveState != STATE_OPEN && valveState != STATE_CLOSED) return;

  if (valveState == STATE_CLOSED && confirmedPct <= minPercent) {
    Serial.printf("[AUTO] %d%% <= min %d%% - opening\n", confirmedPct, minPercent);
    executeValveCommand('O');
    return;
  }
  if (valveState == STATE_OPEN && confirmedPct >= maxPercent) {
    Serial.printf("[AUTO] %d%% >= max %d%% - closing\n", confirmedPct, maxPercent);
    executeValveCommand('C');
    return;
  }
}
#else
void evaluateAutoMode() {} // No sensors — auto mode handled externally
#endif

// ══════════════════════════════════════════════════
//  FIREBASE
// ══════════════════════════════════════════════════

void initFirebase() {
  Serial.println("[FB] initFirebase called");
  if (WiFi.status() == WL_CONNECTED) setGoogleDNS();

  fbConfig.api_key = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;
  fbConfig.token_status_callback = tokenStatusCallback;

  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectNetwork(true);

  Serial.println("[FB] Calling signUp for anonymous auth...");
  if (Firebase.signUp(&fbConfig, &fbAuth, "", "")) {
    Serial.println("[FB] Anonymous auth OK!");
  } else {
    Serial.println("[FB] Auth FAILED: " + String(fbConfig.signer.signupError.message.c_str()));
  }
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
      Serial.println("Initial heartbeat sent!");
    }
    return true;
  }
  return false;
}

void writePendingDevice() {
  String path = "pendingDevices/" + deviceCode;
  FirebaseJson json;
  json.set("deviceClass", CLS_VALVE);
  json.set("sensorType", SNS_DIP);
  json.set("sensorCount", SENSOR_COUNT);
  json.set("valveType", VALVE_TYPE);
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("macAddress", WiFi.macAddress());
  json.set("firstSeenAt/.sv", "timestamp");
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

void buildFlags() {
  // Rebuild flags byte from current state
  flags = 0;
  if (sensorError)     flags |= 0x01;  // bit0
  if (faultRetrying)   flags |= 0x02;  // bit1
  if (currentRelayFwd) flags |= 0x04;  // bit2
  if (currentRelayRev) flags |= 0x08;  // bit3
  if (autoMode)        flags |= 0x10;  // bit4
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
    Serial.printf("Pushed: valve=%s pct=%d%% bits=%d flags=0x%02X\n",
      stateName(valveState).c_str(), confirmedPct, sensorBits, flags);
    return true;
  }

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

void updateDeviceInfo(bool online) {
  String path = "devices/" + deviceCode + "/info";
  FirebaseJson json;
  json.set("online", online);
  json.set("lastSeen/.sv", "timestamp");
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("deviceClass", CLS_VALVE);
  json.set("sensorType", SNS_DIP);
  json.set("sensorCount", SENSOR_COUNT);
  json.set("valveType", VALVE_TYPE);
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

// Push current config to Firebase (so web dashboard shows current values)
void pushConfigToFirebase() {
  String path = "devices/" + deviceCode + "/config";
  FirebaseJson json;
  json.set("autoMode", autoMode);
  json.set("minPercent", minPercent);
  json.set("maxPercent", maxPercent);
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
}

// Read config from Firebase (user changes from web dashboard)
void checkConfig() {
  String basePath = "devices/" + deviceCode + "/config/";
  bool changed = false;

  if (Firebase.RTDB.getBool(&fbdo, (basePath + "autoMode").c_str())) {
    bool newAuto = fbdo.boolData();
    if (newAuto != autoMode) {
      autoMode = newAuto;
      changed = true;
      Serial.printf("[CONFIG] autoMode changed to %s\n", autoMode ? "ON" : "OFF");
    }
  }
  if (Firebase.RTDB.getInt(&fbdo, (basePath + "minPercent").c_str())) {
    uint8_t newMin = (uint8_t)fbdo.intData();
    if (newMin != minPercent && newMin < maxPercent) {
      minPercent = newMin;
      changed = true;
    }
  }
  if (Firebase.RTDB.getInt(&fbdo, (basePath + "maxPercent").c_str())) {
    uint8_t newMax = (uint8_t)fbdo.intData();
    if (newMax != maxPercent && newMax > minPercent) {
      maxPercent = newMax;
      changed = true;
    }
  }

  if (changed) saveConfig();
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
      Serial.println("[CMD] Firebase open requested");
      executeValveCommand('O');
      Firebase.RTDB.setBool(&fbdo, (basePath + "openRequested").c_str(), false);
      pushLiveData();
    }
  }
  handleLED();

  if (Firebase.RTDB.getBool(&fbdo, (basePath + "closeRequested").c_str())) {
    if (fbdo.boolData()) {
      Serial.println("[CMD] Firebase close requested");
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
//  BOTH-BUTTON AUTO EXIT FLASH
// ══════════════════════════════════════════════════

void flashAutoExitConfirm() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_OPEN, HIGH); digitalWrite(LED_CLOSE, LOW);  delay(120);
    digitalWrite(LED_OPEN, LOW);  digitalWrite(LED_CLOSE, HIGH); delay(120);
  }
  digitalWrite(LED_OPEN, LOW);
  digitalWrite(LED_CLOSE, LOW);
}

// ══════════════════════════════════════════════════
//  AP WEB PAGE
// ══════════════════════════════════════════════════

String buildCustomHTML() {
  String html = R"rawliteral(
<!DOCTYPE html><html><head>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>SenseFlow Valve</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#1a1a2e;color:#eee;padding:12px}
.card{background:#16213e;border-radius:12px;padding:14px;margin-bottom:10px}
h1{font-size:18px;color:#0ea5e9;margin-bottom:2px}
h2{font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:8px}
.code{font-family:monospace;font-size:16px;color:#38bdf8;letter-spacing:1px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600}
.row{display:flex;justify-content:space-between;padding:5px 0;font-size:12px;border-bottom:1px solid #1e3a5f}
.row:last-child{border:none}
.label{color:#64748b}
.val{color:#e2e8f0;font-weight:600}
.btn{display:inline-block;padding:8px 16px;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;margin:3px}
.btn-blue{background:#2563eb;color:#fff}
.btn-red{background:#dc2626;color:#fff}
.btn-green{background:#16a34a;color:#fff}
.btn-gray{background:#334155;color:#cbd5e1}
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
  html += "<h1>SenseFlow Valve</h1>";
  html += "<p class='code'>" + deviceCode + "</p>";
  html += "<span class='badge' style='background:" + String(VALVE_TYPE == 24 ? "#7c3aed" : "#0ea5e9") + ";color:#fff'>";
  html += String(VALVE_TYPE == 24 ? "24V DC" : "230V AC") + "</span> ";
  html += "<span class='badge' style='background:" + String(autoMode ? "#16a34a" : "#64748b") + ";color:#fff'>";
  html += String(autoMode ? "AUTO" : "MANUAL") + "</span>";
  html += "</div>";

  // Valve state
  String stColor = "#3498db";
  if (valveState == STATE_OPEN) stColor = "#27ae60";
  else if (valveState == STATE_CLOSED) stColor = "#e74c3c";
  else if (valveState == STATE_FAULT) stColor = "#e67e22";
  else if (valveState == STATE_LS_ERROR) stColor = "#8e44ad";

  html += "<div class='card' style='text-align:center'>";
  html += "<h2>VALVE STATE</h2>";
  html += "<div style='font-size:32px;font-weight:bold;color:" + stColor + "'>" + stateName(valveState) + "</div>";
  html += "<div style='margin-top:8px'>";
  html += "<a href='/api/valve?cmd=open'><button class='btn btn-green'>OPEN</button></a>";
  html += "<a href='/api/valve?cmd=close'><button class='btn btn-red'>CLOSE</button></a>";
  html += "</div></div>";

  // Water level (only if sensors present)
  #if SENSOR_COUNT > 0
  html += "<div class='card'>";
  html += "<h2>WATER LEVEL</h2>";
  html += "<div style='font-size:28px;font-weight:bold;text-align:center;margin:6px 0'>" + String(confirmedPct) + "%</div>";
  html += "<div style='display:flex;gap:6px;justify-content:center;margin:6px 0'>";
  for (int i = 0; i < SENSOR_COUNT; i++) {
    bool on = levelActive[i];
    html += "<div style='width:20px;height:20px;border-radius:50%;background:" + String(on ? "#3b82f6" : "#334155") + ";border:2px solid " + String(on ? "#60a5fa" : "#475569") + "'></div>";
  }
  html += "</div>";
  if (sensorError) html += "<div style='color:#a855f7;font-size:12px;text-align:center;font-weight:600'>SENSOR ERROR</div>";
  html += "</div>";
  #endif

  // Auto mode config
  html += "<div class='card'>";
  html += "<h2>AUTO CONTROL</h2>";
  html += "<div class='row'><span class='label'>Auto Mode</span><span class='val'>";
  html += "<a href='/api/setconfig?auto=" + String(autoMode ? "0" : "1") + "'><button class='btn " + String(autoMode ? "btn-green" : "btn-gray") + "' style='padding:4px 12px'>" + String(autoMode ? "ON" : "OFF") + "</button></a></span></div>";
  html += "<div class='row'><span class='label'>Open below</span><span class='val'>" + String(minPercent) + "%</span></div>";
  html += "<div class='row'><span class='label'>Close above</span><span class='val'>" + String(maxPercent) + "%</span></div>";
  html += "</div>";

  // Status
  html += "<div class='card'>";
  html += "<h2>STATUS</h2>";
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
  Serial.println("\n=== SenseFlow Firebase Valve v" FIRMWARE_VERSION " ===\n");

  // Valve pins
  pinMode(BTN_FORWARD,   INPUT_PULLUP);
  pinMode(BTN_REVERSE,   INPUT_PULLUP);
  pinMode(RELAY_FORWARD, OUTPUT);
  pinMode(RELAY_REVERSE, OUTPUT);
  pinMode(FB_FORWARD,    INPUT_PULLDOWN);
  pinMode(FB_REVERSE,    INPUT_PULLDOWN);
  pinMode(LED_OPEN,      OUTPUT);
  pinMode(LED_CLOSE,     OUTPUT);

  // Safe start
  digitalWrite(RELAY_FORWARD, LOW);
  digitalWrite(RELAY_REVERSE, LOW);
  digitalWrite(LED_OPEN,  LOW);
  digitalWrite(LED_CLOSE, LOW);

  // DIP sensor pins
  #if SENSOR_COUNT > 0
  for (int i = 0; i < SENSOR_COUNT; i++) {
    pinMode(DIP_PINS[i], INPUT_PULLDOWN);
  }
  #endif

  // Addressable LED
  FastLED_min<LED_PIN>.addLeds(rgbLeds, 1);
  FastLED_min<LED_PIN>.setBrightness(80);
  setLED(255, 100, 0);  // Orange on boot

  // Load device code + config from NVS
  loadOrCreateDeviceCode();
  printRegistrationInfo();

  // Seed debouncers
  bool openLS  = digitalRead(FB_FORWARD);
  bool closeLS = digitalRead(FB_REVERSE);
  dbOpen.lastRaw  = openLS;  dbOpen.stableValue  = openLS;  dbOpen.stableStart  = millis();
  dbClose.lastRaw = closeLS; dbClose.stableValue = closeLS; dbClose.stableStart = millis();
  for (int i = 0; i < 6; i++) {
    dbLevel[i].lastRaw = false; dbLevel[i].stableValue = false; dbLevel[i].stableStart = millis();
  }

  // Boot LS check — determine initial valve state
  #if VALVE_TYPE == 230
    if (openLS && closeLS) {
      Serial.println("[BOOT] Both LS HIGH - wiring fault");
      valveState = STATE_LS_ERROR;
    } else if (openLS) {
      valveState = STATE_OPEN;
      Serial.println("[BOOT] Open LS - STATE_OPEN");
    } else if (closeLS) {
      valveState = STATE_CLOSED;
      Serial.println("[BOOT] Close LS - STATE_CLOSED");
    } else {
      valveState = STATE_RECOVERY;
      Serial.println("[BOOT] No LS - driving OPEN");
      setRelays(true, false);
    }
    updateFaultTimer(openLS, closeLS);
  #else
    // 24V: LS not readable at idle, always start with recovery
    valveState = STATE_RECOVERY;
    Serial.println("[BOOT] 24V - driving OPEN for position");
    setRelays(true, false);
  #endif

  // WiFi AP
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), AP_PASSWORD);
  Serial.println("AP started: " + apName);

  // MvsConnect
  mvs.setCustomHTML([](){ return buildCustomHTML(); });
  mvs.onWiFiCredentialsReceived([](const String& ssid) {
    Serial.println("WiFi credentials received: " + ssid);
    WiFi.disconnect(false);
    delay(200);
  });
  mvs.begin();

  // Endpoints
  mvs.addEndpoint("/setwifi", []() {
    WebServer* srv = mvs.getServer();
    String ssid = srv->arg("ssid");
    String pass = srv->arg("pass");
    if (ssid.length() == 0) {
      srv->send(400, "text/html", "<html><body style='background:#1a1a2e;color:#fff;text-align:center;padding:40px'><h2>SSID required</h2></body></html>");
      return;
    }
    srv->send(200, "text/html", "<html><body style='background:#1a1a2e;color:#fff;text-align:center;padding:40px'><h2>Connecting to " + ssid + "...</h2><script>setTimeout(()=>location.href='/',15000)</script></body></html>");
    manualWiFiInProgress = true;
    manualWiFiStart = millis();
    WiFi.disconnect(true);
    delay(1000);
    Preferences wifiPrefs;
    wifiPrefs.begin("mvsconnect", false);
    wifiPrefs.putString("ssid", ssid);
    wifiPrefs.putString("password", pass);
    wifiPrefs.putBool("valid", true);
    wifiPrefs.end();
    WiFi.begin(ssid.c_str(), pass.c_str());
  });

  mvs.addEndpoint("/restart", []() {
    WebServer* srv = mvs.getServer();
    srv->send(200, "text/html", "<html><body style='background:#1a1a2e;color:#fff;text-align:center;padding:40px'><h2>Restarting...</h2></body></html>");
    delay(1000); ESP.restart();
  });

  mvs.addEndpoint("/api/valve", []() {
    WebServer* srv = mvs.getServer();
    String cmd = srv->arg("cmd");
    if (cmd == "open") executeValveCommand('O');
    else if (cmd == "close") executeValveCommand('C');
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/setconfig", []() {
    WebServer* srv = mvs.getServer();
    if (srv->hasArg("auto")) {
      autoMode = (srv->arg("auto").toInt() != 0);
      pendingSave = true;
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/force-push", []() {
    WebServer* srv = mvs.getServer();
    if (firebaseReady) { pushLiveData(); updateDeviceInfo(true); }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  mvs.addEndpoint("/api/status", []() {
    WebServer* srv = mvs.getServer();
    buildFlags();
    String json = "{";
    json += "\"code\":\"" + deviceCode + "\",";
    json += "\"valve\":\"" + stateName(valveState) + "\",";
    json += "\"pct\":" + String(confirmedPct) + ",";
    json += "\"bits\":" + String(sensorBits) + ",";
    json += "\"flags\":" + String(flags) + ",";
    json += "\"auto\":" + String(autoMode ? "true" : "false") + ",";
    json += "\"min\":" + String(minPercent) + ",";
    json += "\"max\":" + String(maxPercent) + ",";
    json += "\"firebase\":" + String(firebaseReady ? "true" : "false");
    json += "}";
    srv->send(200, "application/json", json);
  });

  // Try saved WiFi
  if (mvs.hasSavedWiFi()) {
    setLED(0, 0, 255);
    if (mvs.connectToSavedWiFi(30)) {
      Serial.println("WiFi connected! IP: " + WiFi.localIP().toString());
      setGoogleDNS();
      setLED(0, 255, 0);
      initFirebase();
    } else {
      setLED(255, 255, 255);
    }
  } else {
    setLED(255, 255, 255);
  }

  // MvsOTA
  mvsota.begin(DEVICE_NAME, FIRMWARE_VERSION, FIRMWARE_CODE);
  mvsota.onStart([]() {
    Serial.println("[OTA] Starting - relays OFF");
    setRelays(false, false);
  });

  ledCycleStart = millis();
}

// ══════════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════════

void loop() {
  unsigned long now = millis();

  mvs.handle();
  if (!mvsota.isUpdating()) mvsota.handle();

  // Deferred NVS save
  if (pendingSave) {
    pendingSave = false;
    saveConfig();
    if (firebaseReady) pushConfigToFirebase();
  }

  // Debounce limit switches
  bool rawOpen  = digitalRead(FB_FORWARD);
  bool rawClose = digitalRead(FB_REVERSE);
  bool rawBtnFwd = digitalRead(BTN_FORWARD);
  bool rawBtnRev = digitalRead(BTN_REVERSE);

  bool openLS  = updateDebounce(dbOpen,   rawOpen,   DEBOUNCE_MS);
  bool closeLS = updateDebounce(dbClose,  rawClose,  DEBOUNCE_MS);
  bool btnFwd  = updateDebounce(dbBtnFwd, rawBtnFwd, DEBOUNCE_BTN_MS);
  bool btnRev  = updateDebounce(dbBtnRev, rawBtnRev, DEBOUNCE_BTN_MS);

  // Debounce DIP sensors
  #if SENSOR_COUNT > 0
  for (int i = 0; i < SENSOR_COUNT; i++) {
    levelActive[i] = updateDebounce(dbLevel[i], digitalRead(DIP_PINS[i]), DIP_DEBOUNCE_MS);
  }
  #endif

  validateSensors();
  handleLED();
  evaluateAutoMode();

  // Button edge detection
  bool fwdJustPressed = (btnFwd == LOW && lastBtnFwd == HIGH);
  bool revJustPressed = (btnRev == LOW && lastBtnRev == HIGH);
  lastBtnFwd = btnFwd;
  lastBtnRev = btnRev;

  // Both-button hold: exit auto mode
  bool bothPressed = (btnFwd == LOW && btnRev == LOW);
  if (bothPressed) {
    if (!bothBtnHolding) { bothBtnHolding = true; bothBtnHoldStart = millis(); }
    bool fb = (millis() / BLINK_INTERVAL_MS) % 2;
    digitalWrite(LED_OPEN, fb); digitalWrite(LED_CLOSE, fb);
    if (autoMode && (millis() - bothBtnHoldStart) >= BOTH_BTN_HOLD_MS) {
      autoMode = false;
      pendingSave = true;
      bothBtnHolding = false;
      Serial.println("[BTN] Both held 3s - AUTO MODE OFF");
      flashAutoExitConfirm();
    }
    return;
  } else {
    bothBtnHolding = false;
  }

  // ── Valve state machine (230V) ────────────────
  #if VALVE_TYPE == 230
    // Both LS HIGH = wiring fault
    if (openLS && closeLS) {
      if (valveState != STATE_LS_ERROR) {
        Serial.println("[ERROR] Both LS HIGH - wiring fault");
        valveState = STATE_LS_ERROR;
        setRelays(false, false);
        if (firebaseReady) { pushLiveData(); handleLED(); }  // Report LS error
      }
      updateValveLEDs();
      return;
    }
    if (valveState == STATE_LS_ERROR) {
      Serial.println("[RECOVERY] LS error cleared");
      valveState = STATE_RECOVERY;
      setRelays(true, false);
    }
    if (valveState == STATE_FAULT) {
      handleFaultState(openLS, closeLS);
      updateValveLEDs();
      // Push fault state to Firebase (since return skips normal push)
      if (firebaseReady && hasDataChanged()) { pushLiveData(); handleLED(); }
      return;
    }
    // Fault timer — only watch the LS we're traveling toward
    if (valveState == STATE_OPENING || valveState == STATE_RECOVERY) {
      updateFaultTimer(openLS, false);   // only care about open LS
    } else if (valveState == STATE_CLOSING) {
      updateFaultTimer(false, closeLS);  // only care about close LS
    } else {
      updateFaultTimer(openLS, closeLS); // idle — either LS resets timer
    }
    if (faultTimerExpired()) {
      faultDirection = (valveState == STATE_CLOSING) ? 'C' : 'O';
      Serial.printf("[FAULT] No LS 3min - VALVE FAULTY (direction=%c)\n", faultDirection);
      valveState = STATE_FAULT;
      faultRetrying = false; faultRetryCount = 0;
      faultRetryTimerStart = millis();
      setRelays(false, false);
      updateValveLEDs();
      if (firebaseReady) { pushLiveData(); handleLED(); }  // Immediately report fault
      return;
    }
    if (valveState == STATE_RECOVERY) {
      if (openLS) { setRelays(false, false); valveState = STATE_OPEN; Serial.println("[RECOVERY] OPEN"); }
      else setRelays(true, false);
      updateValveLEDs();
      return;
    }
    if (valveState == STATE_OPENING) {
      if (openLS) { setRelays(false, false); valveState = STATE_OPEN; Serial.println("[OPENING] OPEN"); }
      else setRelays(true, false);
      updateValveLEDs();
      return;
    }
    if (valveState == STATE_CLOSING) {
      if (closeLS) { setRelays(false, false); valveState = STATE_CLOSED; Serial.println("[CLOSING] CLOSED"); }
      else setRelays(false, true);
      updateValveLEDs();
      return;
    }
  #else
    // ── 24V valve state machine ─────────────────
    // LS only readable when relay ON
    if (valveState == STATE_FAULT) {
      handleFaultState(openLS, closeLS);
      updateValveLEDs();
      if (firebaseReady && hasDataChanged()) { pushLiveData(); handleLED(); }
      return;
    }
    if (faultTimerExpired()) {
      faultDirection = (valveState == STATE_CLOSING) ? 'C' : 'O';
      Serial.printf("[FAULT] No LS confirm - VALVE FAULTY (direction=%c)\n", faultDirection);
      valveState = STATE_FAULT;
      faultRetrying = false; faultRetryCount = 0;
      faultRetryTimerStart = millis();
      setRelays(false, false);
      updateValveLEDs();
      if (firebaseReady) { pushLiveData(); handleLED(); }
      return;
    }
    if (valveState == STATE_RECOVERY || valveState == STATE_OPENING) {
      setRelays(true, false);
      updateFaultTimer(openLS, false);
      if (openLS) {
        setRelays(false, false);
        valveState = STATE_OPEN;
        faultTimerActive = false;
        Serial.println(valveState == STATE_RECOVERY ? "[RECOVERY] OPEN" : "[OPENING] OPEN");
      }
      updateValveLEDs();
      return;
    }
    if (valveState == STATE_CLOSING) {
      setRelays(false, true);
      updateFaultTimer(false, closeLS);
      if (closeLS) {
        setRelays(false, false);
        valveState = STATE_CLOSED;
        faultTimerActive = false;
        Serial.println("[CLOSING] CLOSED");
      }
      updateValveLEDs();
      return;
    }
  #endif

  // IDLE state
  updateValveLEDs();

  // Single button: ignored in auto mode
  if (!autoMode) {
    if (fwdJustPressed && valveState != STATE_OPEN) {
      Serial.println("[BTN] OPENING");
      valveState = STATE_OPENING;
      setRelays(true, false);
    }
    if (revJustPressed && valveState != STATE_CLOSED) {
      Serial.println("[BTN] CLOSING");
      valveState = STATE_CLOSING;
      setRelays(false, true);
    }
  }

  // mDNS
  if (WiFi.status() == WL_CONNECTED && !mdnsStarted) {
    if (MDNS.begin(mdnsName.c_str())) {
      MDNS.addService("http", "tcp", 7689);
      mdnsStarted = true;
      Serial.println("mDNS: http://" + mdnsName + ".local:7689");
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
    if (internetAvailable) {
      Serial.println("Internet OK, retrying Firebase...");
      initFirebase();
    }
  } else if (WiFi.status() != WL_CONNECTED) {
    internetAvailable = false;
  }

  // Firebase operations
  if (WiFi.status() == WL_CONNECTED) {
    checkFirebaseReady();
    if (firebaseReady) {
      if (hasDataChanged()) {
        if (pushLiveData()) updateDeviceInfo(true);
        handleLED();
      }
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        pushLiveData();
        handleLED();
        updateDeviceInfo(true);
        handleLED();
      }
      if (now - lastCommandCheck >= COMMAND_CHECK_INTERVAL) {
        lastCommandCheck = now;
        checkCommands();
        handleLED();
      }
      if (now - lastConfigCheck >= CONFIG_CHECK_INTERVAL) {
        lastConfigCheck = now;
        checkConfig();
        handleLED();
      }
    }
  } else {
    if (manualWiFiInProgress && (now - manualWiFiStart > 30000)) {
      manualWiFiInProgress = false;
    }
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

  // Serial commands
  if (Serial.available()) {
    char cmd = Serial.read();
    if (cmd == '\n' || cmd == '\r') return;
    switch (cmd) {
      case 'O': case 'o': executeValveCommand('O'); Serial.println("Opening..."); break;
      case 'C': case 'c': executeValveCommand('C'); Serial.println("Closing..."); break;
      case 'S': case 's':
        Serial.println("\n--- Valve Status ---");
        Serial.println("Code:       " + deviceCode);
        Serial.println("Valve:      " + stateName(valveState));
        Serial.printf("Level:      %d%% bits=%d error=%s\n", confirmedPct, sensorBits, sensorError ? "YES" : "No");
        Serial.printf("Auto:       %s  min=%d%% max=%d%%\n", autoMode ? "ON" : "OFF", minPercent, maxPercent);
        Serial.printf("Relays:     fwd=%s rev=%s\n", currentRelayFwd ? "ON" : "OFF", currentRelayRev ? "ON" : "OFF");
        Serial.println("Firebase:   " + String(firebaseReady ? "Ready" : "Not ready"));
        Serial.println("WiFi:       " + mvs.getWiFiStatus());
        Serial.println("IP:         " + WiFi.localIP().toString());
        Serial.println("Uptime:     " + String(millis() / 1000) + "s");
        Serial.println("--------------------\n");
        break;
      case 'R': case 'r':
        if (valveState == STATE_FAULT || valveState == STATE_LS_ERROR) {
          faultRetrying = false; faultRetryCount = 0; faultTimerActive = false;
          valveState = STATE_RECOVERY;
          setRelays(true, false);
          Serial.println("Manual reset - recovery");
        }
        break;
      default: Serial.println("O=open C=close S=status R=reset"); break;
    }
  }
}
