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

// Channel toggles must come before includes so the right libraries are pulled in.
#define ENABLE_CLOUD                 1
#define ENABLE_LOCAL_MQTT            0
// MQTT broker location: 0 = LAN Pi gateway, 1 = cloud broker (HiveMQ/EMQX/VPS).
// Detailed config block lives further down — these top-level defines exist
// here only so the WiFiClientSecure include can be conditionally pulled in.
#define USE_CLOUD_MQTT               0
#define CLOUD_MQTT_USE_TLS           0
#if ENABLE_CLOUD == 0 && ENABLE_LOCAL_MQTT == 0
  #warning "Both cloud and MQTT disabled — device will be local-AP-only"
#endif

#include <WiFi.h>
#include <WiFiUdp.h>
#include <Preferences.h>
#include "esp_task_wdt.h"
#include "esp_system.h"
#include <HTTPUpdate.h>
#include <WiFiClientSecure.h>
#include <time.h>
#if ENABLE_CLOUD
  #include <Firebase_ESP_Client.h>
  #include <addons/TokenHelper.h>
#endif
#include <MvsConnect.h>
#include <mvsota_esp32.h>
#include <FastLED_min.h>
#if ENABLE_LOCAL_MQTT
  #include <PubSubClient.h>
  #if USE_CLOUD_MQTT && CLOUD_MQTT_USE_TLS
    #include <WiFiClientSecure.h>
  #endif
  #include "mbedtls/sha256.h"
#endif

// ══════════════════════════════════════════════════
//  CONFIGURATION — CHANGE THESE PER DEPLOYMENT
// ══════════════════════════════════════════════════

// Sensor mode: 0 = DIP switches, 1 = Ultrasonic HC-SR04
#define USE_ULTRASONIC    0

// DIP sensor count (1–4), ignored if USE_ULTRASONIC=1
#define SENSOR_COUNT      4

// Firebase project config
#define FIREBASE_API_KEY      "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4"
#define FIREBASE_DB_URL       "https://senseflow-5a9bb-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_PROJECT_ID   "senseflow-5a9bb"

// Device info
#define DEVICE_NAME       "SenseFlow-Node-DIP"
#define FIRMWARE_VERSION  "17.0.5"
#define FIRMWARE_CODE     "SF-OSC-2026"
#define AP_PASSWORD       "mvstech9867"

// ── MQTT broker config (LAN or cloud — selected by USE_CLOUD_MQTT above) ──
#define MQTT_PUBLISH_INTERVAL_MS   2000    // push every 2s + on change

#if USE_CLOUD_MQTT == 0
  // LAN mode — Pi runs Mosquitto, ESP32 auto-discovers via UDP, derived password.
  #define MQTT_PORT                  1883
  #define MQTT_DISCOVERY_PORT        1900
  #define MQTT_DISCOVERY_MSG         "SENSEFLOW_DISCOVER"
  #define MQTT_DISCOVERY_REPLY       "SENSEFLOW_HERE"
  #define MQTT_DISCOVERY_INTERVAL_MS 60000
  // Rotate MQTT_SECRET by reflashing all devices + updating pi_gateway.py.
  #define MQTT_SECRET             "mvs_kalp_2026_xY9k_rotate_me"
#else
  // Cloud mode — direct connect to HiveMQ / EMQX / VPS Mosquitto via TLS.
  // Examples for CLOUD_MQTT_HOST:
  //   "abc123.s1.eu.hivemq.cloud"   (HiveMQ Cloud)
  //   "broker.emqx.io"              (public test, no auth)
  //   "mqtt.yourdomain.com"         (self-hosted Mosquitto on VPS)
  #define MQTT_PORT                  8883        // TLS port; 1883 for plain
  #define CLOUD_MQTT_HOST            "REPLACE_WITH_BROKER_HOST"
  #define CLOUD_MQTT_USER            "REPLACE_WITH_USERNAME"
  #define CLOUD_MQTT_PASS            "REPLACE_WITH_PASSWORD_OR_TOKEN"
  // CA root certificate (required when CLOUD_MQTT_USE_TLS=1).
  #if CLOUD_MQTT_USE_TLS
    static const char* CLOUD_MQTT_CA_CERT = R"PEM(
-----BEGIN CERTIFICATE-----
REPLACE_WITH_CA_CERT_PEM
-----END CERTIFICATE-----
)PEM";
  #endif
#endif

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
// Bottom→top: GPIO34=25%, GPIO35=50%, GPIO32=75%, GPIO33=100%
// All require external 10k pull-down resistors (34/35 have no internal pulls).
const int DIP_PINS[] = {34, 35, 32, 33};

// Common rod pin — driven by ESP32 GPIO regardless of mode.
#define DIP_COMMON_PIN       12   // EXCITE on PCB. Strapping pin — external pull-down ensures LOW at boot.

// Set to 1 when GPIO12 drives an NPN common-emitter transistor (BC547 or
// similar) that switches the probe-common rod. Schematic on the PCB:
//
//   EXCITE (GPIO12) ── EX_B (base resistor) ── Base
//                                              Collector ── EX_C (pull-up) ── 5V (or 3.3V via J2)
//                                                                          ── EX (probe common rod)
//                                              Emitter ── GND
//   EX_G keeps the base pulled down to GND during boot.
//
// Output is taken at the collector (common-emitter config), so the logic
// INVERTS:
//   GPIO12 LOW  → transistor OFF → collector pulled HIGH via EX_C → common HIGH (excite ON)
//   GPIO12 HIGH → transistor ON  → collector shorted to GND        → common LOW  (excite OFF)
//
// Boot is safe because EX_G holds the base LOW → transistor OFF → common
// sits at 5V via EX_C. No current is being driven from GPIO12 at boot.
//
// Set to 0 for direct GPIO drive (short cables only, ESP32 sources 3.3V).
#define DIP_COMMON_VIA_TRANSISTOR  1

#if DIP_COMMON_VIA_TRANSISTOR
  // NPN common-emitter inverts the GPIO sense (see schematic comment above).
  #define DIP_COMMON_DRIVE_ACTIVE   LOW    // GPIO LOW  → transistor OFF → common HIGH (excite)
  #define DIP_COMMON_DRIVE_IDLE     HIGH   // GPIO HIGH → transistor ON  → common LOW  (idle)
#else
  // Direct drive — GPIO IS the common rod.
  #define DIP_COMMON_DRIVE_ACTIVE   HIGH
  #define DIP_COMMON_DRIVE_IDLE     LOW
#endif

// Excitation mode for the common rod:
//   0 = CONSTANT DC — common held HIGH always; probes read with plain
//       digitalRead(). Simpler but causes electrolytic corrosion of probes
//       (months to a few months of life). Use only if probes are easily
//       replaceable or the system is short-lived.
//   1 = OCSIL PULSED — common pulsed only during read bursts, synchronous
//       sampling rejects leakage/stuck pins, probe life 2-10 yr.
#define EXCITATION_MODE      1

// How often the firmware re-reads the probes (applies to both modes).
#define DIP_READ_INTERVAL_MS_DEFAULT 2000

#if EXCITATION_MODE == 1
  // Probe life profile — only used in OCSIL mode.
  //   1 = ~2 years  (fastest UI)
  //   2 = ~4 years  (good balance, default)
  //   3 = ~8 years  (slower UI, lower duty)
  //   4 = MAX       (minimum duty cycle, slowest UI)
  #define PROBE_LIFE_PROFILE   2

  #if PROBE_LIFE_PROFILE == 1
    #define DIP_SETTLE_US         200
    #define DIP_SAMPLES_PER_READ   10
    #define DIP_AGREE_THRESHOLD     8
    #define DIP_READ_INTERVAL_MS 2000
  #elif PROBE_LIFE_PROFILE == 2
    // Tightened for EMI noise rejection on top-of-water probe:
    //   - 600 µs settle (was 300) — long probe cables (~100m) have higher
    //     capacitance; need ~2x time for the line to fully charge before sampling
    //   - 15 samples = more statistical confidence
    //   - 15/15 agreement (strict) — any noise-aligned glitch fails
    #define DIP_SETTLE_US         600
    #define DIP_SAMPLES_PER_READ   15
    #define DIP_AGREE_THRESHOLD    15
    #define DIP_READ_INTERVAL_MS 3000
  #elif PROBE_LIFE_PROFILE == 3
    #define DIP_SETTLE_US          50
    #define DIP_SAMPLES_PER_READ    5
    #define DIP_AGREE_THRESHOLD     4
    #define DIP_READ_INTERVAL_MS 5000
  #elif PROBE_LIFE_PROFILE == 4
    #define DIP_SETTLE_US          50
    #define DIP_SAMPLES_PER_READ    3
    #define DIP_AGREE_THRESHOLD     3
    #define DIP_READ_INTERVAL_MS 10000
  #else
    #error "PROBE_LIFE_PROFILE must be 1, 2, 3 or 4"
  #endif
#elif EXCITATION_MODE == 0
  // Constant DC — only DIP_READ_INTERVAL_MS is meaningful.
  #define DIP_READ_INTERVAL_MS DIP_READ_INTERVAL_MS_DEFAULT
#else
  #error "EXCITATION_MODE must be 0 (constant DC) or 1 (OCSIL pulsed)"
#endif

// Ultrasonic pins
#define US_TRIG_PIN  32   // Shared with DIP probe 2 — only used when USE_ULTRASONIC=1
#define US_ECHO_PIN  34

// Addressable LED
#define LED_PIN      15
#define LED_COUNT    1

// Timing
#define HEARTBEAT_INTERVAL    300000   // 5 minutes
#define COMMAND_CHECK_INTERVAL 5000    // 5 seconds
#define DIP_DEBOUNCE_MS          0     // disabled — sync sampling + 2s read gap = natural filter
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

#if ENABLE_LOCAL_MQTT
  #if USE_CLOUD_MQTT && CLOUD_MQTT_USE_TLS
    WiFiClientSecure mqttNetClient;
  #else
    WiFiClient       mqttNetClient;
  #endif
  PubSubClient   mqttClient(mqttNetClient);
  #if USE_CLOUD_MQTT == 0
    WiFiUDP      mqttUdp;
    IPAddress    mqttBrokerIp;             // resolved by discovery
  #endif
  bool          mqttBrokerKnown   = false; // also used in cloud mode to skip DNS retry
  unsigned long lastMqttDiscovery = 0;
  unsigned long lastMqttPublish   = 0;
  unsigned long lastMqttReconnect = 0;
#endif

// Firebase
#if ENABLE_CLOUD
FirebaseData fbdo;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;
#endif
bool firebaseReady = false;   // stays false forever when ENABLE_CLOUD==0

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

// Last value that passed the confirmation gate. Heartbeat + idle-history
// fallback use these so cloud never sees a transient glitch.
uint8_t lastConfirmedBits  = 0;
uint8_t lastConfirmedPct   = 0;
uint8_t lastConfirmedFlags = 0;
bool    haveConfirmedValue = false;
unsigned long lastHistoryWriteAt = 0;

// ── OTA + NTP state ────────────────────────────────────────────────
uint32_t firstBootAt    = 0;   // epoch seconds — set once, persisted in NVS
uint32_t lastUpdatedAt  = 0;   // epoch seconds — last successful OTA (or firstBootAt if never)
unsigned long lastNtpSyncAt = 0;  // millis()
bool          ntpSynced     = false;
unsigned long lastOtaCheckAt = 0;  // millis()
const unsigned long OTA_CHECK_INTERVAL_MS = 30000;   // poll trigger every 30 s
const unsigned long NTP_RESYNC_INTERVAL   = 24UL * 60UL * 60UL * 1000UL;  // 24 h
#define OTA_MAX_RETRIES 3
#define NTP_SERVER      "pool.ntp.org"
#define NTP_TZ_OFFSET_S (5 * 3600 + 30 * 60)   // IST = UTC+5:30

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
uint32_t tankCapacityLitres = 0;  // 0 = not configured, hides litres in UI
// AP mode: 0 = always on, 1 = on for 10 min after first successful STA connect (default)
uint8_t apMode = 1;
unsigned long apTimerStart = 0;          // millis() when 10-min countdown begins (0 = not started)
unsigned long apTimerDeadline = 0;       // millis() when AP will shut off (extends on activity)
bool apTimerEnded = false;               // true once AP has been shut down
const unsigned long AP_AUTO_OFF_MS = 10UL * 60UL * 1000UL;   // 10 min
const unsigned long AP_EXTEND_MS   =  5UL * 60UL * 1000UL;   //  +5 min on web activity
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

  // Load tank capacity in litres (0 = not configured → litres hidden in UI)
  tankCapacityLitres = prefs.getUInt("capL", 0);

  // Load AP-always-on flag (default true)
  // Load AP mode. New key apMode (0=always-on, 1=10-min).
  // Migrate from old apOn bool if present (true=always-on, false=10-min).
  if (prefs.isKey("apMode")) {
    apMode = prefs.getUChar("apMode", 1);
  } else if (prefs.isKey("apOn")) {
    apMode = prefs.getBool("apOn", true) ? 0 : 1;
    prefs.putUChar("apMode", apMode);
    prefs.remove("apOn");
  } else {
    apMode = 1;   // default: 10-min auto-off
  }

  // Load OTA timestamps (stored as epoch seconds)
  firstBootAt   = prefs.getUInt("firstBoot", 0);
  lastUpdatedAt = prefs.getUInt("lastUpd", 0);
  Serial.printf("[BOOT] NVS firstBootAt=%u  lastUpdatedAt=%u\n",
                firstBootAt, lastUpdatedAt);

  // Last-sent values from previous boot — used to skip a redundant push if
  // the new confirmed reading matches what cloud already has. Prevents
  // double-history entries on reboot when sensor state hasn't changed.
  // 0xFF sentinel = "nothing stored yet" → force first push.
  lastSentBits  = prefs.getUChar("lsBits",  0xFF);
  lastSentPct   = prefs.getUChar("lsPct",   0xFF);
  lastSentFlags = prefs.getUChar("lsFlags", 0xFF);
  Serial.printf("[BOOT] NVS lastSent bits=%u pct=%u flags=%u\n",
                lastSentBits, lastSentPct, lastSentFlags);
  // firstBootAt + lastUpdatedAt finalized later, after NTP sync

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
bool internetAvailable = false;          // result of DNS chain check
bool firebaseHealthy   = false;          // false after consecutive Firebase fails
unsigned long lastInternetCheck      = 0;
unsigned long lastFirebaseHealthRetry = 0;
unsigned long wifiLastConnectedAt    = 0;
unsigned long wifiLastDisconnectedAt = 0;
int   wifiReconnectAttempts = 0;

// Force Google DNS — fixes broken router DNS
void setGoogleDNS() {
  IPAddress dns1(8, 8, 8, 8);
  IPAddress dns2(8, 8, 4, 4);
  WiFi.config(WiFi.localIP(), WiFi.gatewayIP(), WiFi.subnetMask(), dns1, dns2);
  Serial.println("DNS set to 8.8.8.8 / 8.8.4.4");
}

// Check internet with DNS-server fallback chain.
// Tries Google → Cloudflare → Quad9 on port 53 with 1s timeout each.
// Returns true on first success, false only if all three fail.
// Works on virtually any consumer router (port 53 rarely blocked).
bool checkInternet() {
  if (WiFi.status() != WL_CONNECTED) return false;
  const char* dnsServers[] = { "8.8.8.8", "1.1.1.1", "9.9.9.9" };
  for (int i = 0; i < 3; i++) {
    WiFiClient client;
    if (client.connect(dnsServers[i], 53, 1000)) {
      client.stop();
      return true;
    }
    client.stop();
  }
  return false;
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
    pinMode(DIP_PINS[i], INPUT_PULLDOWN);  // External 10k pull-down required on 34/35
  }
  pinMode(DIP_COMMON_PIN, OUTPUT);
#if EXCITATION_MODE == 0
  // Constant DC mode — common held active permanently. Probes read with plain digitalRead.
  digitalWrite(DIP_COMMON_PIN, DIP_COMMON_DRIVE_ACTIVE);
#else
  // OCSIL pulsed — common parked idle between bursts (no current flow, no electrolysis).
  digitalWrite(DIP_COMMON_PIN, DIP_COMMON_DRIVE_IDLE);
#endif
}

#if EXCITATION_MODE == 0
// CONSTANT DC read — common is held HIGH all the time; just sample each probe.
uint8_t readDipRaw() {
  uint8_t bits = 0;
  for (int i = 0; i < SENSOR_COUNT; i++) {
    if (digitalRead(DIP_PINS[i]) == HIGH) bits |= (1 << i);
  }
  return bits;
}
#else
// Synchronous (unipolar square-wave) read on common pin.
// Drives common HIGH then LOW for DIP_SAMPLES_PER_READ cycles. A probe is
// counted as "wet" for a cycle only if it reads HIGH while common is HIGH
// AND LOW while common is LOW — i.e. it tracks the excitation. Stuck-HIGH
// pins (leakage, plating film, residual moisture) fail the LOW-phase check
// and get rejected. Returns a bitmask where bit i = 1 if probe i was wet
// for at least DIP_AGREE_THRESHOLD of DIP_SAMPLES_PER_READ cycles.
uint8_t readDipRaw() {
  uint8_t agreeCount[6] = {0, 0, 0, 0, 0, 0};

  for (int s = 0; s < DIP_SAMPLES_PER_READ; s++) {
    digitalWrite(DIP_COMMON_PIN, DIP_COMMON_DRIVE_ACTIVE);
    delayMicroseconds(DIP_SETTLE_US);
    uint8_t highSample = 0;
    for (int i = 0; i < SENSOR_COUNT; i++) {
      if (digitalRead(DIP_PINS[i]) == HIGH) highSample |= (1 << i);
    }

    digitalWrite(DIP_COMMON_PIN, DIP_COMMON_DRIVE_IDLE);
    delayMicroseconds(DIP_SETTLE_US);
    uint8_t lowSample = 0;
    for (int i = 0; i < SENSOR_COUNT; i++) {
      if (digitalRead(DIP_PINS[i]) == LOW) lowSample |= (1 << i);
    }

    uint8_t agree = highSample & lowSample;
    for (int i = 0; i < SENSOR_COUNT; i++) {
      if (agree & (1 << i)) agreeCount[i]++;
    }
  }

  // Park common idle between reads (minimises DC bias, slows electrolysis)
  digitalWrite(DIP_COMMON_PIN, DIP_COMMON_DRIVE_IDLE);

  uint8_t bits = 0;
  for (int i = 0; i < SENSOR_COUNT; i++) {
    if (agreeCount[i] >= DIP_AGREE_THRESHOLD) bits |= (1 << i);
  }
  return bits;
}
#endif  // EXCITATION_MODE

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

// ── Asymmetric per-bit debounce ────────────────────────────────────
// Bit going dry→wet must be confirmed for DIP_WET_CONFIRM consecutive reads.
// Bit going wet→dry commits immediately. This kills EMI flicker on the
// top-of-water probe (false HIGH from antenna pickup), while still showing
// real drain events instantly.
#define DIP_WET_CONFIRM   3   // ~9 sec at 3-sec read interval

void processDipSensors() {
  static unsigned long lastDipRead = 0;
  static uint8_t wetConfirmCount[6] = {0, 0, 0, 0, 0, 0};

  if (millis() - lastDipRead < DIP_READ_INTERVAL_MS) return;
  lastDipRead = millis();

  uint8_t currentRaw = readDipRaw();

  // Asymmetric debounce per bit
  uint8_t newBits = sensorBits;
  for (int i = 0; i < SENSOR_COUNT; i++) {
    bool rawWet = (currentRaw >> i) & 1;
    bool committedWet = (sensorBits >> i) & 1;

    if (rawWet && !committedWet) {
      // Candidate dry→wet: require N consecutive confirms
      if (wetConfirmCount[i] < 255) wetConfirmCount[i]++;
      if (wetConfirmCount[i] >= DIP_WET_CONFIRM) {
        newBits |= (1 << i);
        wetConfirmCount[i] = 0;
      }
    } else if (!rawWet && committedWet) {
      // wet→dry: commit instantly
      newBits &= ~(1 << i);
      wetConfirmCount[i] = 0;
    } else {
      // Steady state — reset counter so noise needs N consecutive in a row
      wetConfirmCount[i] = 0;
    }
  }

  sensorBits = newBits;
  pendingBits = currentRaw;   // kept for legacy state but unused now
  sensorError = checkSensorError(sensorBits, SENSOR_COUNT);

  if (sensorError) {
    flags |= 0x01;
  } else {
    flags &= ~0x01;
  }

  confirmedPct = bitsToPercent(sensorBits, SENSOR_COUNT);
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

#if !ENABLE_CLOUD
// Stubs so call sites compile when cloud is disabled. All no-ops.
void  initFirebase() {}
bool  checkFirebaseReady() { return false; }
void  writePendingDevice() {}
bool  pushLiveData() { return false; }
void  updateDeviceInfo(bool) {}
void  checkCommands() {}
void  writeHistory() {}
void  checkConfig() {}
#else

void initFirebase() {
  Serial.println("[FB] initFirebase called");
  // Ensure Google DNS is set before any Firebase connection
  if (WiFi.status() == WL_CONNECTED) setGoogleDNS();
  Serial.println("[FB] DB URL: " + String(FIREBASE_DB_URL));

  fbConfig.api_key = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;
  fbConfig.token_status_callback = tokenStatusCallback;
  // Aggressive timeouts so a dead network doesn't block the main loop.
  // Default is 15000 ms which freezes AP page + mDNS + MQTT.
  fbConfig.timeout.serverResponse  = 2000;
  fbConfig.timeout.socketConnection = 2000;
  fbConfig.timeout.sslHandshake     = 3000;

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
      firebaseHealthy = true;
      consecutiveFailCount = 0;
      Serial.println("Firebase ready!");
      writePendingDevice();
      updateDeviceInfo(true);
      reportFirmwareInfoIfChanged();   // push firmwareVersion + firstBootAt + lastUpdatedAt (only if changed)
      // No initial pushLiveData() — wait for the 3-confirm gate to produce
      // first stable reading. Avoids polluting /history with boot-default 0%.
      Serial.println("Waiting for first confirmed sensor read");
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
// Gated by firebaseHealthy — if we know cloud is down, skip silently without
// hitting the 2-3s TLS timeout that would stall everything else.
// Internal: actually push supplied values. Used by both change-driven path
// (currents) and heartbeat (last-confirmed-stable values).
bool pushLiveDataValues(uint8_t bits, uint8_t pct, uint8_t flg) {
  // Layered gate: WiFi → internet → firebase
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!internetAvailable)             return false;
  if (!firebaseHealthy)               return false;

  String path = "devices/" + deviceCode + "/live";

  FirebaseJson json;
  json.set("sensorBits", bits);
  json.set("confirmedPct", pct);
  json.set("stateVal", 0);   // Sensor-only, no valve state
  json.set("flags", flg);
  json.set("rssi", WiFi.RSSI());
  json.set("timestamp/.sv", "timestamp");

  esp_task_wdt_reset();
  if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    lastSentBits  = bits;
    lastSentPct   = pct;
    lastSentFlags = flg;
    // Persist so a reboot with the same sensor state doesn't push again.
    Preferences lp;
    lp.begin("senseflow", false);
    lp.putUChar("lsBits",  bits);
    lp.putUChar("lsPct",   pct);
    lp.putUChar("lsFlags", flg);
    lp.end();
    lastDataPush = millis();
    consecutiveFailCount = 0;
    lastSuccessfulPush = millis();
    return true;
  } else {
    consecutiveFailCount++;
    Serial.printf("Push FAILED (%d): %s\n", consecutiveFailCount, fbdo.errorReason().c_str());
    // After 3 strikes mark cloud unhealthy. LED state machine will show this
    // via the existing 5-second blink slot (red). No solid-red spam.
    if (consecutiveFailCount >= 3) {
      Serial.println("[FB] 3 consecutive fails — marking cloud unhealthy");
      firebaseHealthy = false;
      consecutiveFailCount = 0;
    }
    return false;
  }
}

// Change-driven push — uses current (possibly mid-glitch) values; gated by
// hasDataChanged() at the call site so only confirmed-stable values reach here.
bool pushLiveData() {
  return pushLiveDataValues(sensorBits, confirmedPct, flags);
}

// Heartbeat push — always sends last-confirmed-stable value (or current
// if no confirmed value yet). Cloud sees device online without absorbing glitch.
bool pushLiveDataHeartbeat() {
  if (haveConfirmedValue) {
    return pushLiveDataValues(lastConfirmedBits, lastConfirmedPct, lastConfirmedFlags);
  }
  return pushLiveDataValues(sensorBits, confirmedPct, flags);
}

// Update device info node
void updateDeviceInfo(bool online) {
  if (!firebaseHealthy) return;
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

  // updateNode merges into /info instead of overwriting — preserves
  // firstBootAt, lastUpdatedAt, lastOtaStatus, otaRetryCount that other
  // code paths wrote there.
  esp_task_wdt_reset();
  Firebase.RTDB.updateNode(&fbdo, path.c_str(), &json);
}

// Check commands node
void checkCommands() {
  if (!firebaseHealthy) return;
  String basePath = "devices/" + deviceCode + "/commands/";

  esp_task_wdt_reset();
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "refreshRequested").c_str())) {
    if (fbdo.boolData()) {
      Serial.println("Refresh requested — force pushing data");
      pushLiveData();
      Firebase.RTDB.setBool(&fbdo, (basePath + "refreshRequested").c_str(), false);
    }
  }
  esp_task_wdt_reset();
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "testRequested").c_str())) {
    if (fbdo.boolData()) {
      Serial.println("Test requested — blinking LED");
      testBlinkActive = true;
      testBlinkStart = millis();
      Firebase.RTDB.setBool(&fbdo, (basePath + "testRequested").c_str(), false);
    }
  }
  esp_task_wdt_reset();
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

// Internal: write a history entry with explicit values + tag.
void writeHistoryValues(uint8_t bits, uint8_t pct, uint8_t flg, const char* tag) {
  if (!firebaseHealthy) return;
  FirebaseJson json;
  json.set("pct", pct);
  json.set("bits", bits);
  json.set("flags", flg);
  json.set("ts/.sv", "timestamp");
  esp_task_wdt_reset();
  if (Firebase.RTDB.pushJSON(&fbdo, ("devices/" + deviceCode + "/history").c_str(), &json)) {
    lastHistoryWriteAt = millis();
    Serial.printf("[HISTORY] Entry recorded (%s)\n", tag);
  }
}

// Minimum spacing between any history writes (change-driven or idle).
// Multiple confirmed changes within this window collapse to one entry.
#define HISTORY_MIN_INTERVAL (60UL * 60UL * 1000UL)   // 1 hour

// Change-driven write — current values; only when analyticsOn AND at least
// HISTORY_MIN_INTERVAL has passed since the last history entry.
void writeHistory() {
  if (!analyticsOn) return;
  if (lastHistoryWriteAt != 0 && millis() - lastHistoryWriteAt < HISTORY_MIN_INTERVAL) return;
  writeHistoryValues(sensorBits, confirmedPct, flags, "change");
}

// Idle fallback — if no history written for 1 hour, push last-confirmed
// values so chart isn't blank. Never the boot-default 0%.
void writeHistoryIdleIfDue() {
  if (!analyticsOn) return;
  if (!haveConfirmedValue) return;
  if (lastHistoryWriteAt != 0 && millis() - lastHistoryWriteAt < HISTORY_MIN_INTERVAL) return;
  writeHistoryValues(lastConfirmedBits, lastConfirmedPct, lastConfirmedFlags, "idle-1h");
}

// Check config — read analyticsOn flag
void checkConfig() {
  if (!firebaseHealthy) return;
  String path = "devices/" + deviceCode + "/config/analyticsOn";
  esp_task_wdt_reset();
  if (Firebase.RTDB.getBool(&fbdo, path.c_str())) {
    bool newVal = fbdo.boolData();
    if (newVal != analyticsOn) {
      analyticsOn = newVal;
      Serial.printf("[CONFIG] analyticsOn = %s\n", analyticsOn ? "ON" : "OFF");
    }
  }
}

#endif  // ENABLE_CLOUD

// ══════════════════════════════════════════════════
//  CHANGE DETECTION — only push when values change
// ══════════════════════════════════════════════════

// Cloud-push stability gate.
// A new (bits/pct/flags) value must repeat across DATA_CONFIRM consecutive
// calls before it's eligible for cloud/MQTT push. This protects against
// single-read glitches that would otherwise pollute Firebase history.
// Local UI / LED keep using sensorBits/confirmedPct instantly — only cloud waits.
// At 3-sec read interval × 5 confirms ≈ 15 sec lag before a real change reaches cloud.
// Bumped 3→5 to defeat noise on long (~100m) probe cables — same-value
// glitches that survive the 15-sample read still get caught here.
#define DATA_CONFIRM 5

bool hasDataChanged() {
  static uint8_t candidateBits  = 0xFF;
  static uint8_t candidatePct   = 0xFF;
  static uint8_t candidateFlags = 0xFF;
  static uint8_t confirmCount   = 0;

  // First call after boot — seed candidate without pushing yet
  if (confirmCount == 0 && candidateBits == 0xFF && candidatePct == 0xFF) {
    candidateBits  = sensorBits;
    candidatePct   = confirmedPct;
    candidateFlags = flags;
    confirmCount   = 1;
    return false;
  }

  if (sensorBits == candidateBits &&
      confirmedPct == candidatePct &&
      flags == candidateFlags) {
    if (confirmCount < 255) confirmCount++;
  } else {
    candidateBits  = sensorBits;
    candidatePct   = confirmedPct;
    candidateFlags = flags;
    confirmCount   = 1;
  }

  // Once confirmed N times, stamp last-known-good (heartbeat uses this)
  if (confirmCount >= DATA_CONFIRM) {
    lastConfirmedBits  = candidateBits;
    lastConfirmedPct   = candidatePct;
    lastConfirmedFlags = candidateFlags;
    haveConfirmedValue = true;

    if (candidateBits  != lastSentBits  ||
        candidatePct   != lastSentPct   ||
        candidateFlags != lastSentFlags) {
      return true;
    }
  }
  return false;
}

// ══════════════════════════════════════════════════
//  LED STATE MACHINE
// ══════════════════════════════════════════════════

void handleLED() {
  unsigned long now = millis();

  // pushFailFlash deliberately removed — was causing constant-red misleading
  // signal when internet drops. Cloud-fail state now shown via the 5s blink
  // slot (red blink) so user sees it as one of the proper status colors.

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
    bool wifiUp = (WiFi.status() == WL_CONNECTED);
    if (!wifiUp) {
      // White blink = WiFi disconnected
      if (blinkPhase == 0) setLED(255, 255, 255); else setLEDOff();
    } else if (!internetAvailable) {
      // Pink blink = WiFi OK, no internet (DNS chain failed)
      if (blinkPhase == 0) setLED(255, 0, 100); else setLEDOff();
    } else if (ENABLE_CLOUD && !firebaseHealthy) {
      // Red blink = internet OK but cloud unreachable (Firebase failing)
      if (blinkPhase == 0) setLED(255, 0, 0); else setLEDOff();
    } else {
      // Blue blink = all good
      if (blinkPhase == 0) setLED(0, 0, 255); else setLEDOff();
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

// Auto-format litres: <1000 = "L", 1000-999,999 = "KL" (1 decimal),
// >=1,000,000 = "ML" (2 decimal). Returns e.g. "12.0 KL" or "750 L".
String fmtLitres(uint32_t v) {
  if (v >= 1000000UL) {
    return String(v / 1000000.0, 2) + " ML";
  }
  if (v >= 1000UL) {
    return String(v / 1000.0, 1) + " KL";
  }
  return String(v) + " L";
}

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
/* Tank visualization */
.tank-wrap{display:flex;gap:24px;align-items:stretch}
/* Tapered tank silhouette (top is narrower, like a real water tank with a lid) */
.tank{position:relative;width:120px;height:240px;flex-shrink:0;overflow:visible}
.tank-svg{width:100%;height:100%;display:block;overflow:visible}
.tank-water{transition:height .6s ease-out}
.tank-info{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:6px;overflow:hidden}
.big-pct{font-size:40px;font-weight:800;color:#2563eb;line-height:1;word-break:break-word}
.litres{font-size:15px;color:#475569;font-weight:600;word-break:break-word}
.tank-sub{font-size:11px;color:#64748b;word-break:break-word}
.err-banner{background:#faf5ff;border:1px solid #d8b4fe;color:#7e22ce;padding:6px 10px;border-radius:8px;font-size:11px;font-weight:600;margin-top:6px}
@media (max-width:380px){.big-pct{font-size:32px}.litres{font-size:13px}}
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

  // Tank visualization card (DIP only — ultrasonic has its own raw-distance card lower down)
  #if !USE_ULTRASONIC
  {
    html += "<div class='card'>";
    html += "<h1>SenseFlow Device</h1>";
    html += "<p class='code'>" + deviceCode + "</p>";

    html += "<div class='tank-wrap' style='margin-top:14px'>";
    // Tank graphic — SVG with tapered shoulders + lid, water clipped inside body
    // viewBox 0 0 150 260. Body inner area: x 15-135, y 50-240 (190 tall)
    static const uint8_t PCT_1[] = {100};
    static const uint8_t PCT_2[] = {50, 100};
    static const uint8_t PCT_3[] = {33, 67, 100};
    static const uint8_t PCT_4[] = {25, 50, 75, 100};
    static const uint8_t PCT_5[] = {20, 40, 60, 80, 100};
    static const uint8_t PCT_6[] = {17, 33, 50, 67, 83, 100};
    const uint8_t* PCT = NULL;
    switch (SENSOR_COUNT) {
      case 1: PCT = PCT_1; break; case 2: PCT = PCT_2; break;
      case 3: PCT = PCT_3; break; case 4: PCT = PCT_4; break;
      case 5: PCT = PCT_5; break; case 6: PCT = PCT_6; break;
    }
    int innerTop = 50, innerBottom = 240;       // y range of water fill inside SVG
    int innerHeight = innerBottom - innerTop;   // 190
    int waterYStart = innerBottom - (innerHeight * confirmedPct / 100);
    int waterH = innerBottom - waterYStart;

    html += "<div class='tank' id='tank'>";
    html += "<svg class='tank-svg' viewBox='0 0 150 260' preserveAspectRatio='xMidYMid meet'>";
    // Clip path matching inner body shape (tapered shoulders, rounded bottom)
    html += "<defs><clipPath id='bodyClip'>";
    html += "<path d='M 15 60 Q 15 50 25 50 L 125 50 Q 135 50 135 60 L 135 220 Q 135 240 115 240 L 35 240 Q 15 240 15 220 Z'/>";
    html += "</clipPath>";
    html += "<linearGradient id='waterGrad' x1='0' y1='0' x2='0' y2='1'>";
    html += "<stop offset='0%' stop-color='#60a5fa'/><stop offset='100%' stop-color='#2563eb'/>";
    html += "</linearGradient></defs>";
    // Tank body outline
    html += "<path d='M 15 60 Q 15 50 25 50 L 125 50 Q 135 50 135 60 L 135 220 Q 135 240 115 240 L 35 240 Q 15 240 15 220 Z' fill='#f8fafc' stroke='#475569' stroke-width='3'/>";
    // Lid (sits on top, slightly wider)
    html += "<rect x='10' y='30' width='130' height='14' rx='4' fill='#475569'/>";
    html += "<rect x='35' y='20' width='80' height='12' rx='3' fill='#64748b'/>";
    // Water (clipped to body shape)
    html += "<g clip-path='url(#bodyClip)'>";
    html += "<rect class='tank-water' id='tankWater' x='0' y='" + String(waterYStart) + "' width='150' height='" + String(waterH) + "' fill='url(#waterGrad)'/>";
    // Water surface highlight
    html += "<ellipse id='tankSurface' cx='75' cy='" + String(waterYStart) + "' rx='65' ry='3' fill='#93c5fd' opacity='0.7'/>";
    html += "</g>";
    // Probe markers (drawn outside clip so they show even above water)
    for (int i = 0; i < SENSOR_COUNT; i++) {
      bool on = (sensorBits >> i) & 1;
      int pct = PCT ? PCT[i] : 0;
      int probeY = innerBottom - (innerHeight * pct / 100);
      String color = on ? "#2563eb" : "#cbd5e1";
      String tabFill = on ? "#2563eb" : "#e5e7eb";
      String tabText = on ? "#ffffff" : "#64748b";
      // Dashed line across tank
      html += "<line class='probe' data-bit='" + String(i) + "' x1='15' y1='" + String(probeY) + "' x2='135' y2='" + String(probeY) + "' stroke='" + color + "' stroke-width='1.5' stroke-dasharray='3,2'/>";
      // % tab on the right outside the tank
      html += "<rect class='probe-tab-bg' data-bit='" + String(i) + "' x='138' y='" + String(probeY - 7) + "' width='28' height='14' rx='3' fill='" + tabFill + "'/>";
      html += "<text class='probe-tab-tx' data-bit='" + String(i) + "' x='152' y='" + String(probeY + 4) + "' text-anchor='middle' font-size='10' font-weight='700' fill='" + tabText + "'>" + String(pct) + "%</text>";
    }
    html += "</svg>";
    html += "</div>";  // .tank

    // Right-side readout
    html += "<div class='tank-info'>";
    html += "<div class='big-pct' id='bigPct'>" + String(confirmedPct) + "%</div>";
    if (tankCapacityLitres > 0) {
      uint32_t litres = (uint32_t)(((uint64_t)confirmedPct * tankCapacityLitres) / 100ULL);
      html += "<div class='litres' id='litres'>" + fmtLitres(litres) + " / " + fmtLitres(tankCapacityLitres) + "</div>";
    } else {
      html += "<div class='litres' id='litres' style='display:none'></div>";
    }
    if (sensorError) {
      html += "<div class='err-banner' id='errBanner'>Sensor pattern fault &mdash; check wiring</div>";
    } else {
      html += "<div class='err-banner' id='errBanner' style='display:none'></div>";
    }
    html += "</div>";  // .tank-info
    html += "</div>";  // .tank-wrap

    // Tank capacity config
    html += "<form action='/setcapacity' method='GET' style='margin-top:14px;display:flex;gap:6px;align-items:center'>";
    html += "<span style='font-size:12px;color:#666;white-space:nowrap'>Capacity (L):</span>";
    html += "<input type='number' name='c' min='0' max='1000000' value='" + String(tankCapacityLitres) + "' style='flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px'>";
    html += "<button class='btn btn-blue' type='submit' style='margin:0;padding:8px 16px'>Save</button>";
    html += "</form>";
    html += "</div>";  // card
  }
  #else
  // Device Info Card (ultrasonic)
  html += "<div class='card'>";
  html += "<h1>SenseFlow Device</h1>";
  html += "<p class='code'>" + deviceCode + "</p>";
  html += "</div>";
  #endif

  // Device code for admin reference
  html += "<div class='card' style='text-align:center'>";
  html += "<h2>Device Code</h2>";
  html += "<p class='code' style='font-size:20px;margin:10px 0;user-select:all'>" + deviceCode + "</p>";
  html += "<p style='font-size:10px;color:#888'>Register this code in admin panel to generate QR</p>";
  html += "</div>";

  // Device Details Card — collapsed by default, click header to expand
  {
    int rssi = WiFi.RSSI();
    String sig;
    if (WiFi.status() != WL_CONNECTED) sig = "Not connected";
    else if (rssi >= -65) sig = "Excellent";
    else if (rssi >= -70) sig = "Good";
    else if (rssi >= -98) sig = "Fair";
    else                  sig = "Weak";

    String lastUpd;
    if (lastSuccessfulPush == 0) lastUpd = "Never";
    else {
      unsigned long secs = (millis() - lastSuccessfulPush) / 1000;
      if (secs < 60)      lastUpd = String(secs) + "s ago";
      else if (secs < 3600) lastUpd = String(secs / 60) + "m ago";
      else                 lastUpd = String(secs / 3600) + "h ago";
    }

    html += "<div class='card'>";
    html += "<h2 onclick=\"var d=document.getElementById('devDet');d.style.display=d.style.display==='none'?'block':'none';this.querySelector('span').textContent=d.style.display==='none'?'\\u25BC':'\\u25B2'\" style='cursor:pointer;display:flex;justify-content:space-between;align-items:center;margin:0'>Device Details <span style='font-size:11px;color:#888'>&#9660;</span></h2>";
    html += "<div id='devDet' style='display:none;margin-top:10px'>";
    #if USE_ULTRASONIC
      html += "<div class='row'><span class='label'>Sensor</span><span class='val'>Ultrasonic</span></div>";
      html += "<div class='row'><span class='label'>Tank Height</span><span class='val'>" + String(usTankHeight, 0) + " cm</span></div>";
    #else
      html += "<div class='row'><span class='label'>Sensor</span><span class='val'>" + String(SENSOR_COUNT) + "-Probe DIP</span></div>";
    #endif
    html += "<div class='row'><span class='label'>WiFi Signal</span><span class='val'>" + sig + "</span></div>";
    html += "<div class='row'><span class='label'>Cloud Status</span><span class='val' style='color:" + String(firebaseReady ? "#16a34a" : "#dc2626") + "'>" + String(firebaseReady ? "Connected" : "Not connected") + "</span></div>";
    html += "<div class='row'><span class='label'>Last Update</span><span class='val'>" + lastUpd + "</span></div>";
    html += "<div class='row'><span class='label'>Firmware</span><span class='val'>v" + String(FIRMWARE_VERSION) + "</span></div>";
    html += "</div></div>";
  }

  // (DIP live dots card removed — tank visualisation already shows probe state)

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

  // AP mode countdown banner (only when 10-min mode + timer running)
  if (apMode == 1 && apTimerStart != 0 && !apTimerEnded && millis() < apTimerDeadline) {
    unsigned long left = (apTimerDeadline - millis()) / 1000;
    html += "<div id='apBanner' style='background:#fef3c7;border:1px solid #fcd34d;color:#92400e;padding:8px 10px;border-radius:8px;font-size:12px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:8px'>";
    html += "<span>AP turns off in <b id='apLeftTxt'>" + String(left / 60) + "m " + String(left % 60) + "s</b></span>";
    html += "<a href='/extendap' style='background:#fbbf24;color:#fff;padding:4px 10px;border-radius:6px;text-decoration:none;font-weight:600;font-size:11px'>+5 min</a>";
    html += "</div>";
  }

  html += "<p style='font-size:11px;color:#666;margin-bottom:4px;font-weight:600'>AP WiFi visibility</p>";
  html += "<label style='display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 0;font-size:13px'>";
  html += "<input type='radio' name='apModeRdo' value='0' " + String(apMode == 0 ? "checked" : "") + " onchange=\"location.href='/setapmode?mode=0'\">";
  html += "<span>Keep AP always on</span></label>";
  html += "<label style='display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 0;font-size:13px'>";
  html += "<input type='radio' name='apModeRdo' value='1' " + String(apMode == 1 ? "checked" : "") + " onchange=\"location.href='/setapmode?mode=1'\">";
  html += "<span>AP active for 10 min after each boot</span></label>";
  html += "<p style='font-size:11px;color:#888;margin:6px 0 10px'>10-min mode auto-extends while you're on this page.</p>";

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

  // Live polling — updates tank viz without page reload so user can fill / drain and watch
  html += "<script>";
  html += "const INNER_TOP=50, INNER_BOTTOM=240, INNER_H=190;";
  html += "function fmtOne(v){if(v>=1000000)return (v/1000000).toFixed(2)+' ML';if(v>=1000)return (v/1000).toFixed(1)+' KL';return v+' L'}";
  html += "function fmtL(p,c){return c>0?fmtOne(Math.round(p*c/100))+' / '+fmtOne(c):''}";
  html += "async function pollStatus(){";
  html += "try{const r=await fetch('/sstatus');if(!r.ok)return;const d=await r.json();";
  // Water rect: recompute y + height in SVG units
  html += "const yStart=INNER_BOTTOM-(INNER_H*d.level/100);";
  html += "const w=document.getElementById('tankWater');if(w){w.setAttribute('y',yStart);w.setAttribute('height',INNER_BOTTOM-yStart)}";
  html += "const sf=document.getElementById('tankSurface');if(sf)sf.setAttribute('cy',yStart);";
  html += "const bp=document.getElementById('bigPct');if(bp)bp.textContent=d.level+'%';";
  html += "const lt=document.getElementById('litres');if(lt){const s=fmtL(d.level,d.capL);if(s){lt.textContent=s;lt.style.display='block'}else{lt.style.display='none'}}";
  html += "const eb=document.getElementById('errBanner');if(eb){if(d.error){eb.textContent='Sensor pattern fault \\u2014 check wiring';eb.style.display='block'}else{eb.style.display='none'}}";
  // Probe colors (line + tab bg + tab text)
  html += "document.querySelectorAll('.probe').forEach(el=>{const b=parseInt(el.dataset.bit);const on=!!(d.bits&(1<<b));el.setAttribute('stroke',on?'#2563eb':'#cbd5e1')});";
  html += "document.querySelectorAll('.probe-tab-bg').forEach(el=>{const b=parseInt(el.dataset.bit);const on=!!(d.bits&(1<<b));el.setAttribute('fill',on?'#2563eb':'#e5e7eb')});";
  html += "document.querySelectorAll('.probe-tab-tx').forEach(el=>{const b=parseInt(el.dataset.bit);const on=!!(d.bits&(1<<b));el.setAttribute('fill',on?'#ffffff':'#64748b')});";
  // AP-countdown live update
  html += "const ab=document.getElementById('apBanner');const alt=document.getElementById('apLeftTxt');";
  html += "if(ab&&alt&&d.apMode===1){if(d.apLeft>0){alt.textContent=Math.floor(d.apLeft/60)+'m '+(d.apLeft%60)+'s';ab.style.display='flex'}else{ab.style.display='none'}}";
  html += "}catch(e){}}";
  html += "setInterval(pollStatus,2000);";
  // Periodic page reload (every 30 s) to refresh non-tank cards (Last Push, RSSI, etc.) — only when not typing
  html += "setInterval(()=>{if(!document.activeElement||document.activeElement.tagName==='BODY')location.reload()},30000);";
  html += "</script>";
  html += "</body></html>";

  return html;
}

// ══════════════════════════════════════════════════
//  LOCAL MQTT (Phase 1: publish only)
// ══════════════════════════════════════════════════

#if ENABLE_LOCAL_MQTT

#if USE_CLOUD_MQTT == 0
// ── LAN-only helpers ──
void mqttBroadcastDiscovery() {
  if (WiFi.status() != WL_CONNECTED) return;
  IPAddress bcast = WiFi.localIP();
  bcast[3] = 255;
  mqttUdp.beginPacket(bcast, MQTT_DISCOVERY_PORT);
  mqttUdp.print(MQTT_DISCOVERY_MSG);
  mqttUdp.endPacket();
  Serial.println("[MQTT] Broadcast discovery sent");
}

void mqttHandleDiscoveryReply() {
  int pktSize = mqttUdp.parsePacket();
  if (pktSize <= 0) return;
  char buf[64] = {0};
  int len = mqttUdp.read(buf, sizeof(buf) - 1);
  if (len <= 0) return;
  if (strncmp(buf, MQTT_DISCOVERY_REPLY, strlen(MQTT_DISCOVERY_REPLY)) == 0) {
    mqttBrokerIp = mqttUdp.remoteIP();
    mqttBrokerKnown = true;
    mqttClient.setServer(mqttBrokerIp, MQTT_PORT);
    Serial.print("[MQTT] Gateway discovered at "); Serial.println(mqttBrokerIp);
  }
}

String mqttDerivePassword() {
  String input = deviceCode + MQTT_SECRET;
  uint8_t hash[32];
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  mbedtls_sha256_update(&ctx, (const uint8_t*)input.c_str(), input.length());
  mbedtls_sha256_finish(&ctx, hash);
  mbedtls_sha256_free(&ctx);
  char hex[17];
  for (int i = 0; i < 8; i++) sprintf(hex + i * 2, "%02x", hash[i]);
  hex[16] = 0;
  return String(hex);
}
#else
// ── Cloud-only setup ──
void mqttCloudInit() {
  if (mqttBrokerKnown) return;
  #if CLOUD_MQTT_USE_TLS
    mqttNetClient.setCACert(CLOUD_MQTT_CA_CERT);
  #endif
  mqttClient.setServer(CLOUD_MQTT_HOST, MQTT_PORT);
  mqttBrokerKnown = true;
  Serial.printf("[MQTT] Cloud broker set: %s:%d (TLS=%d)\n",
                CLOUD_MQTT_HOST, MQTT_PORT, CLOUD_MQTT_USE_TLS);
}
#endif

void mqttPublishLive();   // forward decl

// Command handler: dispatches messages on senseflow/<deviceCode>/cmd/+
void mqttCommandCallback(char* topic, byte* payload, unsigned int len) {
  String t = String(topic);
  String p;
  for (unsigned int i = 0; i < len; i++) p += (char)payload[i];
  Serial.printf("[MQTT] cmd %s = %s\n", t.c_str(), p.c_str());

  String base = "senseflow/" + deviceCode + "/cmd/";
  if (t == base + "refresh") {
    mqttPublishLive();
  }
  else if (t == base + "restart") {
    delay(500);
    ESP.restart();
  }
  else if (t == base + "analytics") {
    bool on = (p == "1" || p == "true" || p == "ON");
    analyticsOn = on;
    Serial.printf("[MQTT] analyticsOn -> %s\n", on ? "ON" : "OFF");
  }
}

bool mqttEnsureConnected() {
  if (!mqttBrokerKnown) return false;
  if (mqttClient.connected()) return true;
  if (millis() - lastMqttReconnect < 5000) return false;
  lastMqttReconnect = millis();
  String clientId = "sf-" + deviceCode;
  #if USE_CLOUD_MQTT
    String username = CLOUD_MQTT_USER;
    String password = CLOUD_MQTT_PASS;
  #else
    String username = deviceCode;
    String password = mqttDerivePassword();
  #endif
  // LWT: when device disconnects, broker tells subscribers it went offline
  String willTopic = "senseflow/" + deviceCode + "/info/online";
  if (mqttClient.connect(clientId.c_str(), username.c_str(), password.c_str(),
                         willTopic.c_str(), 0, true, "false")) {
    Serial.println("[MQTT] Connected to gateway (authenticated)");
    // Announce online (retained)
    mqttClient.publish(willTopic.c_str(), "true", true);
    // Subscribe to all command topics for this device
    String cmdSub = "senseflow/" + deviceCode + "/cmd/+";
    mqttClient.subscribe(cmdSub.c_str());
    return true;
  }
  Serial.printf("[MQTT] connect failed rc=%d (5=bad credentials)\n", mqttClient.state());
  return false;
}

void mqttPublishLive() {
  if (!mqttClient.connected()) return;
  String topic = "senseflow/" + deviceCode + "/live";
  String payload = "{";
  payload += "\"pct\":" + String(confirmedPct) + ",";
  payload += "\"bits\":" + String(sensorBits) + ",";
  payload += "\"flags\":" + String(flags) + ",";
  payload += "\"error\":" + String(sensorError ? "true" : "false") + ",";
  payload += "\"rssi\":" + String(WiFi.RSSI());
  payload += "}";
  mqttClient.publish(topic.c_str(), payload.c_str(), true);   // retained
}

void mqttLoop() {
  if (WiFi.status() != WL_CONNECTED) return;

#if USE_CLOUD_MQTT
  // Cloud mode: no discovery, just set server once
  if (!mqttBrokerKnown) mqttCloudInit();
#else
  // LAN mode: broadcast UDP discovery until gateway replies
  if (!mqttBrokerKnown) {
    if (millis() - lastMqttDiscovery >= MQTT_DISCOVERY_INTERVAL_MS || lastMqttDiscovery == 0) {
      lastMqttDiscovery = millis();
      mqttUdp.begin(MQTT_DISCOVERY_PORT);
      mqttBroadcastDiscovery();
    }
    mqttHandleDiscoveryReply();
    return;
  }
#endif

  if (mqttEnsureConnected()) {
    mqttClient.loop();
    if (millis() - lastMqttPublish >= MQTT_PUBLISH_INTERVAL_MS) {
      lastMqttPublish = millis();
      mqttPublishLive();
    }
  } else {
#if !USE_CLOUD_MQTT
    // LAN: if broker stays unreachable >2 min, maybe Pi changed IP.
    // Force re-discovery so we pick up the new one.
    static unsigned long firstDisconnectAt = 0;
    if (firstDisconnectAt == 0) firstDisconnectAt = millis();
    if (millis() - firstDisconnectAt > 120000) {
      Serial.println("[MQTT] >2 min disconnect — forcing re-discovery");
      mqttBrokerKnown = false;
      lastMqttDiscovery = 0;
      firstDisconnectAt = 0;
    }
#endif
  }
}

#endif  // ENABLE_LOCAL_MQTT

// ══════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════

// Boot-reason flag — if last shutdown was unclean, blink purple briefly so
// installer/user notices something happened. Set during setup, used by LED.
bool crashedLastBoot = false;
unsigned long crashIndicatorStart = 0;

// ══════════════════════════════════════════════════
//  NTP TIME SYNC
// ══════════════════════════════════════════════════

uint32_t nowEpoch() {
  time_t now = time(nullptr);
  return (now > 1700000000) ? (uint32_t)now : 0;   // sanity: post-2023
}

void syncNTPIfDue() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (ntpSynced && (millis() - lastNtpSyncAt < NTP_RESYNC_INTERVAL)) return;

  configTime(NTP_TZ_OFFSET_S, 0, NTP_SERVER);
  // Wait up to 3 sec for first sync (boot path) or just kick off (resync)
  for (int i = 0; i < 30 && nowEpoch() == 0; i++) delay(100);
  uint32_t e = nowEpoch();
  if (e > 0) {
    ntpSynced = true;
    lastNtpSyncAt = millis();
    Serial.printf("[NTP] Sync OK, epoch=%u\n", e);

    // On the first successful sync after boot, stamp firstBootAt if unset
    Preferences p;
    p.begin("senseflow", false);
    if (firstBootAt == 0) {
      firstBootAt = e;
      p.putUInt("firstBoot", firstBootAt);
      Serial.printf("[BOOT] firstBootAt = %u\n", firstBootAt);
    }
    // If never OTA'd, lastUpdatedAt mirrors firstBootAt
    if (lastUpdatedAt == 0) {
      lastUpdatedAt = firstBootAt;
      p.putUInt("lastUpd", lastUpdatedAt);
    }
    p.end();

    // Now that timestamps are real (not 0), push to Firebase if changed.
    // Write-once cache ensures this is a no-op on subsequent reboots.
    reportFirmwareInfoIfChanged();
  }
}

// ══════════════════════════════════════════════════
//  OTA — admin-triggered firmware update
// ══════════════════════════════════════════════════

#if ENABLE_CLOUD

// Report firmware info to Firebase /devices/<code>/info/
void reportFirmwareInfo() {
  if (!firebaseHealthy) return;
  FirebaseJson json;
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("firstBootAt",     firstBootAt);
  json.set("lastUpdatedAt",   lastUpdatedAt);
  String path = "devices/" + deviceCode + "/info";
  Firebase.RTDB.updateNode(&fbdo, path.c_str(), &json);
}

// Write-once optimisation — only push to Firebase if firmware version OR
// lastUpdatedAt has changed since the last reported snapshot (stored in NVS).
// Saves a Firebase write per boot/NTP sync on devices that haven't changed.
void reportFirmwareInfoIfChanged() {
  if (!firebaseHealthy) return;

  // Build a stable hash of {firmwareVersion, lastUpdatedAt}. djb2 on the
  // version string XOR lastUpdatedAt is enough — collisions are harmless
  // (worst case: one extra write).
  uint32_t verHash = 5381;
  const char* s = FIRMWARE_VERSION;
  while (*s) { verHash = ((verHash << 5) + verHash) + (uint8_t)(*s++); }
  uint32_t key = verHash ^ lastUpdatedAt;

  Preferences p;
  p.begin("senseflow", false);
  uint32_t lastKey = p.getUInt("rptKey", 0);
  if (key == lastKey) {
    p.end();
    return;   // nothing changed — skip the Firebase write
  }
  reportFirmwareInfo();
  p.putUInt("rptKey", key);
  p.end();
  Serial.printf("[FB] reportFirmwareInfo pushed (key=%u)\n", key);
}

// Set OTA status fields on Firebase
void setOtaStatus(const String& status, uint8_t retries) {
  if (!firebaseHealthy) return;
  FirebaseJson json;
  json.set("lastOtaStatus", status);
  json.set("otaRetryCount", retries);
  String path = "devices/" + deviceCode + "/info";
  Firebase.RTDB.updateNode(&fbdo, path.c_str(), &json);
}

// Clear the trigger so we don't re-fire on next poll
void clearOtaTrigger() {
  if (!firebaseHealthy) return;
  FirebaseJson json;
  json.set("otaTrigger", false);
  String path = "devices/" + deviceCode + "/config";
  Firebase.RTDB.updateNode(&fbdo, path.c_str(), &json);
}

// Execute the actual HTTP(S) firmware download + flash. Blocks for the
// duration of the download — watchdog is fed via progress callback.
// Returns reason string on failure, empty string on success (won't return
// at all on success because device reboots).
String runHttpUpdate(const String& url, const String& md5) {
  // Disable watchdog during long download
  esp_task_wdt_delete(NULL);

  // Pick client based on URL scheme
  WiFiClient        plainClient;
  WiFiClientSecure  tlsClient;
  WiFiClient*       chosen = nullptr;
  if (url.startsWith("https://")) {
    tlsClient.setInsecure();   // accept self-signed / unknown CA; admin owns the URL
    chosen = &tlsClient;
  } else {
    chosen = &plainClient;
  }

  httpUpdate.setLedPin(LED_PIN, LOW);
  httpUpdate.rebootOnUpdate(false);   // we'll reboot ourselves after Firebase write
  if (md5.length() == 32) {
    httpUpdate.setMD5sum(md5);
  }
  // Feed watchdog during download via progress callback
  httpUpdate.onProgress([](int progress, int total){
    static uint32_t lastFeed = 0;
    if (millis() - lastFeed > 2000) {
      lastFeed = millis();
      Serial.printf("[OTA] %d / %d bytes\n", progress, total);
    }
  });

  t_httpUpdate_return ret = httpUpdate.update(*chosen, url);

  // Re-arm watchdog
  esp_task_wdt_add(NULL);

  switch (ret) {
    case HTTP_UPDATE_FAILED:
      return "fail:" + String(httpUpdate.getLastError()) + ":" + httpUpdate.getLastErrorString();
    case HTTP_UPDATE_NO_UPDATES:
      return "fail:no_update";
    case HTTP_UPDATE_OK:
      return "";   // success, but execution won't reach here if we rebooted
    default:
      return "fail:unknown";
  }
}

// Check Firebase for an OTA trigger and execute if due. Runs from main
// loop on a 30-sec timer.
void checkOtaTrigger() {
  if (!firebaseHealthy) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!ntpSynced) return;   // need real time to honor schedules

  String basePath = "devices/" + deviceCode + "/config/";

  // Each Firebase call can stall up to ~2s on a flaky network. Feed the
  // watchdog between calls so a chain of slow reads doesn't add up to >60s.
  esp_task_wdt_reset();
  if (!Firebase.RTDB.getBool(&fbdo, (basePath + "otaTrigger").c_str())) return;
  if (!fbdo.boolData()) return;   // not triggered

  // Read scheduled time
  uint32_t scheduledAt = 0;
  esp_task_wdt_reset();
  if (Firebase.RTDB.getInt(&fbdo, (basePath + "otaScheduledAt").c_str())) {
    scheduledAt = (uint32_t)fbdo.intData();
  }
  uint32_t epoch = nowEpoch();
  if (scheduledAt > 0 && epoch < scheduledAt) {
    // Not yet time
    return;
  }
  // Stale trigger guard — if scheduled time is more than 7 days in the past,
  // assume the admin meant a different update window and don't auto-flash.
  const uint32_t SEVEN_DAYS = 7UL * 24UL * 3600UL;
  if (scheduledAt > 0 && epoch > scheduledAt + SEVEN_DAYS) {
    Serial.println("[OTA] Trigger expired (>7 days past scheduled time) — clearing");
    setOtaStatus("fail:expired", 0);
    clearOtaTrigger();
    return;
  }

  // Read retry count + URL + MD5
  uint8_t retries = 0;
  String infoPath = "devices/" + deviceCode + "/info/";
  esp_task_wdt_reset();
  if (Firebase.RTDB.getInt(&fbdo, (infoPath + "otaRetryCount").c_str())) {
    retries = (uint8_t)fbdo.intData();
  }
  if (retries >= OTA_MAX_RETRIES) {
    setOtaStatus("fail:max_retries", retries);
    clearOtaTrigger();
    Serial.println("[OTA] Max retries reached — giving up");
    return;
  }

  String url, md5;
  esp_task_wdt_reset();
  if (Firebase.RTDB.getString(&fbdo, (basePath + "otaTargetUrl").c_str())) url = fbdo.stringData();
  if (url.length() == 0) {
    setOtaStatus("fail:no_url", retries);
    clearOtaTrigger();
    return;
  }
  esp_task_wdt_reset();
  if (Firebase.RTDB.getString(&fbdo, (basePath + "otaTargetMd5").c_str())) md5 = fbdo.stringData();

  Serial.printf("[OTA] Starting download: %s\n", url.c_str());
  setOtaStatus("in_progress", retries);

  String result = runHttpUpdate(url, md5);

  if (result.length() == 0) {
    // Success — record then reboot. Clear the report-cache key so the
    // freshly-booted new firmware re-pushes timestamps to Firebase.
    Preferences p;
    p.begin("senseflow", false);
    lastUpdatedAt = nowEpoch();
    p.putUInt("lastUpd", lastUpdatedAt);
    p.remove("rptKey");   // force re-push on next boot
    p.end();

    setOtaStatus("success", 0);
    clearOtaTrigger();
    Serial.println("[OTA] Success — rebooting into new firmware");
    delay(1000);
    ESP.restart();
  } else {
    // Fail — increment retry, set next scheduled time with random backoff
    retries++;
    setOtaStatus(result, retries);
    if (retries < OTA_MAX_RETRIES) {
      uint32_t backoffSec = 60 + (esp_random() % 540);   // 1-10 min
      FirebaseJson json;
      json.set("otaScheduledAt", epoch + backoffSec);
      Firebase.RTDB.updateNode(&fbdo, ("devices/" + deviceCode + "/config").c_str(), &json);
      Serial.printf("[OTA] Failed (%s), retry %u/%u in %u sec\n",
                    result.c_str(), retries, OTA_MAX_RETRIES, backoffSec);
    } else {
      clearOtaTrigger();
      Serial.println("[OTA] Final fail — trigger cleared");
    }
  }
}

#else
void reportFirmwareInfo() {}
void checkOtaTrigger() {}
#endif  // ENABLE_CLOUD

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n=== SenseFlow Firebase Sensor v" FIRMWARE_VERSION " ===\n");

  // Log reset reason so installer/log can see if device crashed
  esp_reset_reason_t reason = esp_reset_reason();
  Serial.printf("[BOOT] Reset reason: %d\n", (int)reason);
  if (reason == ESP_RST_PANIC || reason == ESP_RST_INT_WDT ||
      reason == ESP_RST_TASK_WDT || reason == ESP_RST_WDT ||
      reason == ESP_RST_BROWNOUT) {
    Serial.println("[BOOT] Previous run ended abnormally");
    crashedLastBoot = true;
    crashIndicatorStart = millis();
  }

  // Hardware watchdog — reboot if main loop ever blocks > 30 s.
  // (Firebase TLS at worst case ~3s now thanks to timeout tightening.)
  // ESP32 core 3.x uses a config struct; older cores use (timeout, panic).
  #if ESP_IDF_VERSION_MAJOR >= 5
    esp_task_wdt_config_t wdt_cfg = {
      .timeout_ms = 60000,
      .idle_core_mask = 0,
      .trigger_panic = true
    };
    esp_task_wdt_init(&wdt_cfg);
  #else
    esp_task_wdt_init(60, true);
  #endif
  esp_task_wdt_add(NULL);

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
    wifiPrefs.begin("mvswifi", false);
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
    // Auto-extend AP timer: any active poll proves a user is on the page
    if (apMode == 1 && apTimerStart != 0 && !apTimerEnded) {
      unsigned long remaining = (millis() < apTimerDeadline) ? (apTimerDeadline - millis()) : 0;
      if (remaining < 60000) {   // < 1 min left → extend
        apTimerDeadline = millis() + AP_EXTEND_MS;
      }
    }
    unsigned long apLeft = 0;
    if (apMode == 1 && apTimerStart != 0 && !apTimerEnded && millis() < apTimerDeadline) {
      apLeft = (apTimerDeadline - millis()) / 1000;
    }
    String json = "{";
    json += "\"code\":\"" + deviceCode + "\",";
    json += "\"level\":" + String(confirmedPct) + ",";
    json += "\"bits\":" + String(sensorBits) + ",";
    json += "\"count\":" + String(SENSOR_COUNT) + ",";
    json += "\"flags\":" + String(flags) + ",";
    json += "\"error\":" + String(sensorError ? "true" : "false") + ",";
    json += "\"capL\":" + String(tankCapacityLitres) + ",";
    json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
    json += "\"wifi\":\"" + mvs.getWiFiStatus() + "\",";
    json += "\"firebase\":" + String(firebaseReady ? "true" : "false") + ",";
    json += "\"apMode\":" + String(apMode) + ",";
    json += "\"apLeft\":" + String(apLeft);
    json += "}";
    srv->send(200, "application/json", json);
  });

  // Tank capacity (litres) — saved to NVS so litres can be shown locally
  mvs.addEndpoint("/setcapacity", []() {
    WebServer* srv = mvs.getServer();
    uint32_t c = srv->arg("c").toInt();
    if (c <= 1000000) {  // sanity cap at 1,000,000 L
      tankCapacityLitres = c;
      Preferences capPrefs;
      capPrefs.begin("senseflow", false);
      capPrefs.putUInt("capL", c);
      capPrefs.end();
      Serial.println("Tank capacity set to: " + String(c) + " L");
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  // AP mode selector: 0 = always on, 1 = 10-min auto-off
  mvs.addEndpoint("/setapmode", []() {
    WebServer* srv = mvs.getServer();
    uint8_t mode = (uint8_t)srv->arg("mode").toInt();
    if (mode > 1) mode = 1;
    apMode = mode;
    Preferences apPrefs;
    apPrefs.begin("senseflow", false);
    apPrefs.putUChar("apMode", apMode);
    apPrefs.end();
    Serial.printf("AP mode set to: %u (0=always, 1=10min)\n", apMode);

    if (apMode == 0) {
      // Always-on: bring AP back if it was off
      WiFi.mode(WIFI_AP_STA);
      WiFi.softAP(apName.c_str(), AP_PASSWORD);
      apTimerStart = 0;
      apTimerDeadline = 0;
      apTimerEnded = false;
      Serial.println("AP forced ON (always mode)");
    } else {
      // 10-min mode: start countdown only if STA already connected
      if (WiFi.status() == WL_CONNECTED && apTimerStart == 0) {
        apTimerStart = millis();
        apTimerDeadline = apTimerStart + AP_AUTO_OFF_MS;
        apTimerEnded = false;
        Serial.println("AP 10-min timer started");
      }
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  // Manual extend AP timer by 5 min (button on UI)
  mvs.addEndpoint("/extendap", []() {
    WebServer* srv = mvs.getServer();
    if (apMode == 1 && apTimerStart != 0 && !apTimerEnded) {
      apTimerDeadline += AP_EXTEND_MS;
      Serial.println("AP timer extended +5 min");
    }
    srv->sendHeader("Location", "/"); srv->send(302);
  });

  // Try connecting to saved WiFi
  if (mvs.hasSavedWiFi()) {
    Serial.println("Connecting to saved WiFi...");
    setLED(0, 0, 255);  // Blue while connecting
    if (mvs.connectToSavedWiFi(30)) {
      Serial.println("WiFi connected! IP: " + WiFi.localIP().toString());
      setGoogleDNS();
      // (boot "green on connect" removed — green is reserved for tank-full)
      if (apMode == 1) {
        // 10-min mode: start countdown now that STA is up
        apTimerStart = millis();
        apTimerDeadline = apTimerStart + AP_AUTO_OFF_MS;
        apTimerEnded = false;
        Serial.println("AP 10-min countdown started");
      }
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

#if ENABLE_LOCAL_MQTT
  mqttClient.setBufferSize(512);
  mqttClient.setCallback(mqttCommandCallback);
#endif

  ledCycleStart = millis();
}

// ══════════════════════════════════════════════════
//  MAIN LOOP
// ══════════════════════════════════════════════════

void loop() {
  unsigned long now = millis();

  // Feed watchdog — proves main loop is alive
  esp_task_wdt_reset();

  // Heap monitor — if we ever drop below 30 KB, restart cleanly before crash
  static unsigned long lastHeapCheck = 0;
  if (now - lastHeapCheck >= 300000) {   // 5 min
    lastHeapCheck = now;
    uint32_t freeHeap = ESP.getFreeHeap();
    Serial.printf("[HEAP] free=%u bytes\n", freeHeap);
    if (freeHeap < 30000) {
      Serial.println("[HEAP] Below 30 KB — restarting cleanly");
      delay(500);
      ESP.restart();
    }
  }

  // Scheduled auto-restart (industrial practice): reboot after 7 days uptime
  // to clear any TLS/heap fragmentation. Skip if OTA in progress or a push
  // happened in the last 2 minutes (avoid interrupting active transfer).
  const unsigned long REBOOT_AFTER_MS = 7UL * 24UL * 60UL * 60UL * 1000UL;  // 7 days
  if (now >= REBOOT_AFTER_MS && !mvsota.isUpdating() &&
      (lastSuccessfulPush == 0 || (now - lastSuccessfulPush) > 120000)) {
    Serial.println("[REBOOT] Scheduled 7-day restart");
    if (firebaseReady) updateDeviceInfo(false);
    delay(500);
    ESP.restart();
  }

  // MvsConnect always runs (AP mode web server)
  mvs.handle();
  if (!mvsota.isUpdating()) mvsota.handle();

  // ── AP 10-min auto-off (only when apMode==1 and STA up) ──
  if (apMode == 1 && apTimerStart != 0 && !apTimerEnded) {
    if (millis() >= apTimerDeadline) {
      Serial.println("[AP] 10-min timer expired — shutting down AP");
      WiFi.softAPdisconnect(true);
      WiFi.mode(WIFI_STA);
      apTimerEnded = true;
    }
  }

  // Local MQTT — discovery, connect, publish (Phase 1)
#if ENABLE_LOCAL_MQTT
  mqttLoop();
#endif

  // Read sensors continuously
  #if USE_ULTRASONIC
    processUltrasonic();
  #else
    processDipSensors();
  #endif

  // Handle LED state machine
  handleLED();

  // mDNS handled by MvsConnect library (<deviceName>-mvstech.local)

  // Layered network state: WiFi → internet (DNS chain) → firebase
  // Each layer is checked every 30s. Failure in one stops the next from
  // wasting time (especially the slow TLS handshake on dead internet).
  bool wifiUp = (WiFi.status() == WL_CONNECTED);

  if (!wifiUp) {
    internetAvailable = false;
    firebaseHealthy   = false;
  } else if (now - lastInternetCheck > 30000) {
    lastInternetCheck = now;
    bool prevInternet = internetAvailable;
    internetAvailable = checkInternet();    // DNS chain, ~1-3s worst case
    if (internetAvailable && !prevInternet) {
      Serial.println("[NET] Internet restored");
      // Recover Firebase only if it was previously unhealthy
      if (!firebaseHealthy) {
        Serial.println("[FB] Internet back — attempting recovery");
        if (!firebaseReady) {
          initFirebase();
        } else {
          firebaseHealthy = true;           // give it another chance
          consecutiveFailCount = 0;
        }
      }
    } else if (!internetAvailable && prevInternet) {
      Serial.println("[NET] Internet lost — gating Firebase");
      firebaseHealthy = false;
    }
  }

  // Firebase operations — only when WiFi + internet are confirmed up
  if (wifiUp && internetAvailable) {
    checkFirebaseReady();

    if (firebaseReady && firebaseHealthy) {
      // Change-driven data push (only fires after 3-confirm gate)
      if (hasDataChanged()) {
        Serial.printf("Data changed: bits=%d pct=%d flags=%d → pushing\n", sensorBits, confirmedPct, flags);
        if (pushLiveData()) {
          updateDeviceInfo(true);
          writeHistory();
        }
        handleLED();
      }

      // Idle 1-hour fallback — if no /history entry for 1 hour, push the
      // last-confirmed value so analytics chart isn't blank.
      writeHistoryIdleIfDue();
      handleLED();

      // NTP sync (first boot + every 24h)
      syncNTPIfDue();

      // OTA trigger poll (every 30 s, NTP-time-gated)
      if (now - lastOtaCheckAt >= OTA_CHECK_INTERVAL_MS) {
        lastOtaCheckAt = now;
        checkOtaTrigger();
        handleLED();
      }

      // 5-minute heartbeat — pushes last-confirmed-stable value, never the
      // possibly-glitchy current reading.
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        Serial.println("Heartbeat — pushing last-confirmed value");
        pushLiveDataHeartbeat();
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
  }

  if (!wifiUp) {
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
    Serial.println("Firmware:   " + String(FIRMWARE_VERSION));
    Serial.printf ("NTP synced: %s (epoch=%u)\n", ntpSynced ? "yes" : "no", nowEpoch());
    Serial.printf ("firstBootAt:   %u\n", firstBootAt);
    Serial.printf ("lastUpdatedAt: %u\n", lastUpdatedAt);
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
  else if (cmd == "AP_ON") {
    Serial.println("Re-enabling AP (clears 10-min timer)");
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(apName.c_str(), AP_PASSWORD);
    if (apMode == 1) {
      apTimerStart = millis();
      apTimerDeadline = apTimerStart + AP_AUTO_OFF_MS;
    }
    apTimerEnded = false;
    Serial.println("AP re-enabled");
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
    wifiPrefs.begin("mvswifi", false);
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
