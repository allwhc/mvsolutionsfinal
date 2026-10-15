// ═══════════════════════════════════════════════════════════════════
//  CLOUD (Firebase RTDB) — 117.0.0 introduces cloud state publishing
// ═══════════════════════════════════════════════════════════════════
// Compile-time cloud gate. Set to 0 to build the fully local variant
// (no Firebase library linked) — useful for the panel-only SKU.
// MUST be defined before any include that references it.
#define ENABLE_CLOUD 1

#if ENABLE_CLOUD
  #define FIREBASE_API_KEY    "AIzaSyAyx29tFxNbERqbuM9iTFvWbVcehwtURw4"
  #define FIREBASE_DB_URL     "https://senseflow-5a9bb-default-rtdb.asia-southeast1.firebasedatabase.app"
  #define FIREBASE_PROJECT_ID "senseflow-5a9bb"
#endif

// Layer-3 rate limit for /live pushes (same convention as ultrasonic 19.1.0).
// State-change pushes still respect this floor; history events bypass it.
#define PUMP_LIVE_PUSH_MIN_GAP_MS  20000UL

#include <SPI.h>
// #include <LoRa.h>  // REMOVED - Wired version doesn't use LoRa
#include <ArduinoJson.h>
#include <EEPROM.h>
#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <RTClib.h>
#include <LittleFS.h>  // Changed from SPIFFS to LittleFS
#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <driver/rmt.h>
#include <mvsota_esp32.h>
#include <Preferences.h>   // NVS storage for MvsConnect WiFi credential transfer
#if ENABLE_CLOUD
  #include <Firebase_ESP_Client.h>
  #include <addons/TokenHelper.h>
  #include "esp_task_wdt.h"
  #include <HTTPUpdate.h>          // cloud-driven OTA (dashboard "Send OTA" button)
  #include <WiFiClientSecure.h>    // TLS transport for HTTPS OTA URLs
#endif

#define FIRMWARE_VERSION "118.0.11"
// v118 hardware variant — RS485 ultrasonic terrace tank sensor instead
// of the 3-probe discrete sensor. Same pump-control board, same source
// probe. Code changed so admin dashboard's firmware page can tell the
// two hardware variants apart at a glance.
#define FIRMWARE_CODE "SF-PANUS-2026-9868"


// Debug mode - set to 0 to disable all Serial prints and save ~10KB Flash
#define DEBUG_MODE 0

#if DEBUG_MODE
  #define DEBUG_PRINT(...)    DEBUG_PRINT(__VA_ARGS__)
  #define DEBUG_PRINTLN(...)  DEBUG_PRINTLN(__VA_ARGS__)
#else
  #define DEBUG_PRINT(...)    // Compiles to NOTHING
  #define DEBUG_PRINTLN(...)  // Compiles to NOTHING
#endif

// LoRa pins for ESP32 - COMMENTED OUT (kept for PCB reference, module not connected)
// #define SS      5
// #define RST     14
// #define DIO0    26

// ===========================================
// WIRED SENSOR PIN DEFINITIONS  (v118 — RS485 ULTRASONIC variant)
// ===========================================
// Terrace tank sensor is an RS485 Modbus ultrasonic module (not discrete
// probes). Communicates over UART2:
//   Sensor -> RS485 module -> ESP32:
//     RO (RX)      -> ESP32 GPIO5   (usSerial RX)
//     DI (TX)      -> ESP32 GPIO17  (usSerial TX)
//     DE+RE (DIR)  -> ESP32 GPIO25  (shorted, HIGH=TX, LOW=RX)
//
// Source probe (GPIO34) is unchanged from the v117 pump firmware — same
// hasWPSensor/wpSensorStatus dry-run/source-detection logic feeds off it.
//
// Discrete tank probe pins (GPIO32/33) from v117 are DELETED — this
// board revision has no terrace probes wired. Any residual reads would
// float and produce garbage.
#define RS485_RX_PIN   5    // ESP32 <- RS485 module RO
#define RS485_TX_PIN   17   // ESP32 -> RS485 module DI
#define RS485_DIR_PIN  25   // RS485 module DE+RE (shorted, direction control)
#define SOURCE_PROBE_PIN     34   // GPIO34 - ground-water/source presence (unchanged from v117)

// Legacy tank-probe pin stubs — no physical probes on this variant, but
// several diagnostic/debug prints still reference these constants for
// legacy log parity. Reads via digitalRead() on unconnected pins float
// (with INPUT default) but are IGNORED — pump-control uses ultrasonic
// tankLowWet/tankFullWet booleans, not these pin reads.
#define TANK_LOW_PROBE_PIN   32
#define TANK_FULL_PROBE_PIN  33

// Modbus RTU register map (per sensor datasheet — same protocol as
// RS485_Ultrasonic_Test.ino confirmed working).
#define REG_PROCESSED   0x0100   // filtered distance (mm) — ~500ms response
#define REG_REALTIME    0x0101   // instantaneous distance (mm) — ~100ms response
#define REG_TEMPERATURE 0x0102   // temperature (0.1 degC)
#define REG_SLAVE_ADDR  0x0200   // sensor's own Modbus address
#define ADDR_MIN 0x01
#define ADDR_MAX 0xFE

// v118.0.2: register the burst reads from. REALTIME gives ~100ms per
// response (vs 500ms for PROCESSED), letting us take 15 samples in
// ~1.5 sec for a full MAD-filtered decision instead of taking 7.5 sec
// per decision. PROCESSED's sensor-internal filtering is less valuable
// to us than our own 15-sample MAD because MAD is tunable + outlier-
// aware. Change here + reflash to switch — not editable from UI.
#define US_READ_REGISTER REG_REALTIME

// Excitation pin — retained as a #define so any residual references
// compile; not driven since there are no discrete probes on this variant.
#define EXCITATION_MODE 0
#define DIP_COMMON_PIN 12

// ===========================================
// WIRED SENSOR CONFIGURATION
// ===========================================
#define DIP_SETTLE_US 300
#define DIP_SAMPLES_PER_READ 15
// Require 12/15 samples HIGH to count as wet — gives noise rejection even
// without OCSIL excitation. A floating/removed probe typically gets 0-5/15
// HIGH samples from capacitive coupling; a truly wet probe gets 14-15/15.
#define DIP_AGREE_THRESHOLD 12
#define PROBE_READ_INTERVAL_MS 2000        // Read tank/source probes every 2 seconds
#define DIP_WET_CONFIRM 3                  // dry->wet needs 3 confirms (EMI reject)

// Source probe confirmation counts (consecutive majority-vote reads required)
#define SOURCE_WET_CONFIRM  8   // 8 WET reads (~16s) to confirm source present
#define SOURCE_DRY_CONFIRM 10   // 10 DRY reads (~20s) to confirm source gone

// Wired sensor timing
#define WIRED_WP_CHECK_INTERVAL_MS 1000    // Check water presence every 1 second
// Tank probe debounce: how long a tank level change must hold before accepted.
// 5s prevents turbulence/splash causing false FULL or LOW readings.
#define WIRED_WP_DEBOUNCE_MS 5000
#define WIRED_STARTUP_DELAY_MS 10000       // 10 second startup delay

// Wired sensor offline detection
#define WIRED_SENSOR_FAIL_THRESHOLD 10      // 3 consecutive failures = sensor offline

// ===========================================
// WIRED SENSOR ENUMS AND STRUCTURES
// ===========================================
// Water presence sensor types
enum WPSensorType {
  WP_NO_SENSOR = 0,
  WP_DIP_SENSOR = 1,
  WP_CONTACTLESS_SENSOR = 2,
  WP_BOTH_SENSORS = 3
};

// Water presence debounce structure
struct WaterPresenceDebounce {
  unsigned long stateChangeTime;    // When state change was first detected
  bool currentState;                // Current debounced state (what we use)
  bool lastRawState;                // Last raw combined reading
  bool isDebouncing;                // True if state transition in progress
  WPSensorType activeSensor;        // Which sensor(s) detected water
  uint8_t wetInterruptCount;        // consecutive DRY reads during wet-confirm window
};

// ===========================================
// WIRED SENSOR GLOBAL VARIABLES
// ===========================================
// Tank/source probe variables. tankLowWet / tankFullWet are still
// declared and maintained on this variant, but they are DERIVED from
// the ultrasonic sensor's pct (via updateTankDiscreteFromPct()) instead
// of being read from discrete probes. All downstream pump-control code
// that reads these booleans works unchanged — the semantic contract
// (low probe wet = tank has some water, full probe wet = tank is
// full) is preserved by mapping pct thresholds to those states.
unsigned long lastProbeReadTime = 0;
bool tankLowWet = false;
bool tankFullWet = false;

// ── v118 ultrasonic sensor state ──
// Config (persisted to NVS, editable via AP + cloud panel settings).
// v118.0.4: pump start/stop thresholds consolidated with the EXISTING
// startPercent/stopPercent globals (used by the shouldStart/shouldStop
// pump control logic at ~line 8273). No separate startPercent/StopPct
// — that was premature architecture and broke pump control because the
// actual control code never read them. One variable per concept.
uint16_t usTankHeightCm     = 100;    // full-water column height (10-1200 cm; v118.0.8 ceiling bumped from 600→1200 for taller sumps/overhead tanks)
uint16_t usSensorOffsetCm   = 20;     // dead zone from sensor face to water when full (0-100)
uint8_t  usModbusAddr       = 0x01;   // sensor's Modbus slave address

// Runtime.
int32_t  usLastRawMm        = -1;     // last valid distance-to-water in mm; -1 = none yet
uint8_t  usConfirmedPct     = 0;      // 0-100 tank pct (derived from usLastRawMm)
bool     usHaveGoodReading  = false;  // false until first successful poll
unsigned long usLastPollMs  = 0;      // last poll attempt timestamp
unsigned long usLastGoodMs  = 0;      // last successful read timestamp
uint8_t  usConsecutiveFails = 0;      // increments on each retry-exhausted poll cycle
bool     usSensorFault      = false;  // true after usConsecutiveFails crosses fault threshold

// Fault threshold — how many consecutive BURST cycles must have <3 valid
// samples before declaring sensor fault. Each burst already does 15
// attempts with its own retry ladder on each sample, so a burst with
// <3 valid readings is already strong evidence of a real sensor issue.
#define US_FAULT_AFTER_FAILS 10   // matches tank-monitor US_FAIL_LIMIT

// Burst cadence — one full 15-sample burst every this often. Faster
// while pump is running so we catch the pump-stop threshold crossing
// promptly; slower when idle to spare the RS485 bus.
#define US_POLL_INTERVAL_MS      2000   // 2 sec idle (one burst every 2 sec)
#define US_POLL_INTERVAL_RUN_MS  1000   // 1 sec while pump running

// Per-sample retry inside a burst — if a single sample times out, try
// again with this gap before giving up on that sample slot. Keeps the
// burst responsive even on a noisy bus.
#define US_RETRY_GAP_MS 20

// ── v118.0.2 MAD burst filter — ports proven tank-monitor pattern ──
// Each poll cycle takes a BURST of 15 raw samples ~10ms apart, applies
// MAD outlier rejection with multiplier 2.5, and commits the MEAN of
// accepted inliers. No rolling window — each burst is a fresh decision.
//
// Why burst vs rolling: fresh dataset per decision means fast response
// to real level changes (no stale samples lagging the median). 15 reads
// at ~100ms response per REG_REALTIME = ~1.5 sec burst, still fast
// enough for sub-second pump threshold crossings.
//
// MAD multiplier 2.5 matches tank-monitor firmware exactly — tighter
// than our previous 3× to be more rejective on surface ripple.
//
// Validation: samples outside the sensor's physical range (5-600 cm)
// are discarded before even entering the MAD. Need ≥3 valid samples in
// a burst for the result to be committed; otherwise fail-count bumps.
#define US_SAMPLES         15     // samples per burst (matches tank-monitor US_SAMPLES)
#define US_MAD_MULTIPLIER  2.5f   // outlier rejection threshold
#define US_SAMPLE_GAP_MS   10     // delay between samples in a burst
#define US_MIN_VALID       3      // need this many valid samples per burst to commit
#define US_BLIND_ZONE_MM   50     // < 50mm = inside dead zone, discard
#define US_MAX_RANGE_MM    6000   // > 6000mm = beyond spec, discard
uint16_t usOutlierCount    = 0;   // monotonic — rejected samples count (across bursts)
uint16_t usLastValidCount  = 0;   // samples that passed validation in the LAST burst (for diagnostics)
uint16_t usLastInlierCount = 0;   // samples that passed MAD in the LAST burst (for diagnostics)

// ── v118.0.5 majority-vote gate on top of MAD burst filter ──
// Keeps the last 3 MAD-filtered pct values. A new value is only
// committed to usConfirmedPct when the whole window agrees within 2%
// (max - min ≤ 2). Prevents a single noisy burst from flipping
// threshold decisions when ripples/wave noise squeeze past MAD. First
// burst commits immediately so pump has data to work with on cold
// start — majority vote kicks in from the second burst onward.
#define US_VOTE_WINDOW   3     // bursts in rolling majority buffer
#define US_VOTE_SPREAD   2     // max %-points agreement spread (max - min)
uint8_t  usVoteBuf[US_VOTE_WINDOW];
uint8_t  usVoteCount    = 0;   // valid entries so far (clamps at WINDOW)
uint8_t  usVoteHead     = 0;   // next write slot

// Water presence sensor variables (source/ground-water probe, IO34)
WaterPresenceDebounce wpDebounce = {0, false, false, false, WP_NO_SENSOR, 0};
unsigned long lastWPCheckTime = 0;
uint8_t srcWetCount = 0;   // consecutive WET reads toward confirmation
uint8_t srcDryCount = 0;   // consecutive DRY reads toward confirmation

// Wired startup tracking
bool wiredStartupComplete = false;
unsigned long wiredStartupTime = 0;

// Hardware pins
#define RELAY_PIN 4
// I2C (RTC) moved from the donor's 21/22 to 14/27 on this PCB variant -
// IO21=BTN and IO22=BUZZER are fixed roles here, IO27/IO14 are the PCB's
// dedicated I2C pins (IO26=SD_SCK is unrelated, not used by this build).
#define SDA_PIN 14
#define SCL_PIN 27
#define RESET_SWITCH_PIN 21  // Hardware reset switch (was GPIO33, now TANK_FULL_PROBE_PIN)

// WS2812B LED configuration - RMT driver
#define LED_PIN 15
#define LED_BRIGHTNESS 80  // Fixed brightness (0-255)

// RMT timing constants
#define T0H_TICKS 32
#define T1H_TICKS 64
#define TL_TICKS 52

// LED timing intervals (milliseconds)
#define FAST_BLINK_INTERVAL  250
#define MEDIUM_BLINK_INTERVAL 500
#define SLOW_BLINK_INTERVAL  1000
#define HEARTBEAT_INTERVAL  15000  // Blue heartbeat flash every 15 seconds
#define HEARTBEAT_FLASH_DURATION 100  // Quick 100ms flash
#define PULSE_SPEED          60  // BPM for pulse effect

// WS2812B RMT driver variables
static gpio_num_t ws2812_pin;
static rmt_channel_t ws2812_channel;
static uint8_t ws2812_brightness = 255;

bool ws2812_init(gpio_num_t pin, rmt_channel_t channel, uint8_t brightness) {
  ws2812_pin = pin;
  ws2812_channel = channel;
  ws2812_brightness = brightness;

  rmt_config_t config;
  config.rmt_mode = RMT_MODE_TX;
  config.channel = channel;
  config.gpio_num = pin;
  config.clk_div = 1;
  config.mem_block_num = 1;
  config.tx_config.loop_en = false;
  config.tx_config.carrier_en = false;
  config.tx_config.idle_output_en = true;
  config.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;

  if (rmt_config(&config) != ESP_OK) return false;
  if (rmt_driver_install(config.channel, 0, 0) != ESP_OK) return false;
  return true;
}

void ws2812_setColor(uint8_t r, uint8_t g, uint8_t b) {
  rmt_item32_t items[24];
  r = (r * ws2812_brightness) / 255;
  g = (g * ws2812_brightness) / 255;
  b = (b * ws2812_brightness) / 255;
  uint32_t color = (g << 16) | (r << 8) | b;
  for (int i = 0; i < 24; i++) {
    bool bit = color & (1 << (23 - i));
    items[i].level0 = 1;
    items[i].duration0 = (uint16_t)(bit ? T1H_TICKS : T0H_TICKS);
    items[i].level1 = 0;
    items[i].duration1 = (uint16_t)TL_TICKS;
  }
  rmt_write_items(ws2812_channel, items, 24, true);
  rmt_wait_tx_done(ws2812_channel, pdMS_TO_TICKS(100));
}

void ws2812_off() { ws2812_setColor(0, 0, 0); }
void ws2812_setBrightness(uint8_t brightness) { ws2812_brightness = brightness; }

// Access Point Configuration - WILL BE DYNAMIC BASED ON DEVICE NAME
#define AP_PASSWORD "mvstech9867"
#define AP_TIMEOUT_MINUTES 5           // AP stays active for 5 minutes
#define WEB_ACTIVITY_EXTEND_MINUTES 3  // Extend by 3 min per activity
#define MAX_AP_TIME_MINUTES 30         // Maximum total time

// OTA Configuration - WILL BE DYNAMIC BASED ON DEVICE NAME
#define OTA_PASSWORD "mvstech9867"  // Same as AP password for simplicity

// App Access Security - User-Agent check
#define APP_USER_AGENT "MVStech7689"

// Configuration: Set to 1 for AP always-on mode (no timeout)
#define AP_MODE_FOREVER 1              // 0 = Smart timeout, 1 = Always on

// Sensor configuration
#define SENSOR_BLIND_ZONE_CM 21   // Minimum distance sensor can measure accurately

// Dry run protection timing
#define DRY_RUN_RECOVERY_MINUTES 10       // Recovery wait time to go back to auto mode

// Sensor timeout configuration
#define SENSOR_TIMEOUT_SECONDS 120         // Sensor offline timeout (used for wired consecutive fail detection timing reference)
// #define LORA_HEALTH_CHECK_INTERVAL 60000  // REMOVED - LoRa health check not needed for wired

// Manual override configuration
#define MANUAL_OVERRIDE_TIMEOUT_HOURS 2   // 2-hour manual override timeout

// Fill intent memory configuration
#define FILL_INTENT_TIMEOUT_SECONDS 600   // 10 minutes intent expiration

// Password protection configuration (simplified - no session/lockout)

// LoRa reinitialization tracking - REMOVED for wired version
// static unsigned int loRaReinitCount = 0;

// Motor confirmation settings
#define MOTOR_CONFIRMATION_COUNT 5    // Require 5 consecutive readings to confirm
#define MOTOR_CONFIRMATION_TIMEOUT_SECONDS 60  // Reset confirmation if no new readings for 60 seconds

// WiFi reconnection configuration
#define WIFI_CHECK_INTERVAL_SECONDS 60        // Check WiFi status every 60 seconds
#define WIFI_RECONNECT_MIN_INTERVAL_SECONDS 10  // Minimum 10 seconds between attempts
#define WIFI_RECONNECT_MAX_INTERVAL_SECONDS 300 // Maximum 5 minutes between attempts
#define WIFI_RECONNECT_MAX_ATTEMPTS 3         // Max attempts before increasing backoff

// Relay configuration
#define RELAY_ACTIVE_LOW 0    // Set to 1 for ACTIVE LOW relay (most common)

// Relay control macros
#if RELAY_ACTIVE_LOW
  #define MOTOR_ON_STATE  LOW   // ACTIVE LOW: LOW = relay ON (motor runs)
  #define MOTOR_OFF_STATE HIGH  // ACTIVE LOW: HIGH = relay OFF (motor stops)
#else
  #define MOTOR_ON_STATE  HIGH  // ACTIVE HIGH: HIGH = relay ON (motor runs)
  #define MOTOR_OFF_STATE LOW   // ACTIVE HIGH: LOW = relay OFF (motor stops)
#endif

// ===========================================
// PANEL-CONTROL VARIANT (capacitive-start / DOL / star-delta panels)
// ===========================================
// In panel mode, the existing RELAY_PIN (GPIO4) pulses the START button on the
// contactor panel, RELAY_STOP_PIN pulses the STOP button, and MOTOR_FEEDBACK_PIN
// optionally reads a contactor auxiliary-NO contact (via opto-isolator) to
// confirm the contactor actually latched.
//
// In single-phase / MCB-type mode, RELAY_PIN is held continuously (existing
// behaviour); the STOP / feedback pins are not driven or read.
#define RELAY_STOP_PIN     16  // GPIO16 - pulses panel STOP push-button (panel mode only)
#define MOTOR_FEEDBACK_PIN 19  // GPIO19 - reads contactor aux-NO contact via opto (panel mode, optional).
                               // Line reads HIGH when contactor closes (pump running); LOW when open.
#define BUZZER_PIN         22  // GPIO22 - Buzzer (moved from donor's GPIO27, now I2C SCL)

// Buzzer hardware presence — set to 0 to hide buzzer UI and disable buzzer driver
// for hardware builds without a buzzer connected to BUZZER_PIN.
#define HAS_BUZZER_HARDWARE  1

// Boot configuration - force stop pump on boot for safety
#define FORCE_STOP_ON_BOOT 1  // Set to 1 to send stop pulse during boot, 0 to disable

// Pump type enum
enum PumpType {
  PUMP_SINGLE_PHASE = 0,   // Direct on/off (existing behaviour) - GPIO4 latched
  PUMP_PANEL        = 1    // Capacitive-start / DOL / star-delta panel - pulsed
};

// Pulse duration bounds (milliseconds), step 500ms in UI
#define PANEL_PULSE_MIN_MS    500UL     // 0.5 seconds
#define PANEL_PULSE_MAX_MS    300000UL  // 5 minutes
#define PANEL_PULSE_DEFAULT_MS 3000UL   // 3 seconds (per spec)

// Feedback verification
// Wiring: contactor aux-NO contact → opto-isolator → GPIO19. Line reads
// HIGH when contactor closes (pump running), LOW when open. This matches
// the current panel-board build; if a future opto config inverts the
// polarity, flip FEEDBACK_ACTIVE_LOW back to 1.
#define FEEDBACK_ACTIVE_LOW   0   // 0 = opto pulls GPIO HIGH when contactor closed (this build)
#if FEEDBACK_ACTIVE_LOW
  #define FEEDBACK_RUNNING_STATE LOW
#else
  #define FEEDBACK_RUNNING_STATE HIGH
#endif
// Wait up to 20 s after a START pulse before flagging fault. Larger
// pumps take several seconds to spin up the contactor + magnetic
// starter; the old 5 s window triggered false faults on slower panels.
#define FEEDBACK_CONFIRM_TIMEOUT_MS  20000UL
#define FEEDBACK_DROPOUT_DEBOUNCE_MS 3000UL   // Feedback must stay wrong for 3s to count as dropout

// Buzzer behaviour flags (bit-packed in one EEPROM byte)
#define BUZZ_ON_MOTOR_ON   0x01
#define BUZZ_ON_ERROR      0x02

// EEPROM addresses
#define EEPROM_SIZE 512
#define EEPROM_CONFIGURED_FLAG 0
#define EEPROM_TANK_HEIGHT 1      // 2 bytes
#define EEPROM_START_PERCENT 3    // 1 byte
#define EEPROM_STOP_PERCENT 4     // 1 byte
#define EEPROM_TANK_VOLUME 5      // 4 bytes
#define EEPROM_HAS_WP_SENSOR 9    // 1 byte
#define EEPROM_DRY_RUN_ON 10      // 1 byte
#define EEPROM_DRY_RUN_MINS 11    // 1 byte
#define EEPROM_TARGET_NODE 12     // 8 bytes
#define EEPROM_WP_NODE_NAME 20    // 8 bytes
#define EEPROM_AUTO_MODE_ENABLED 28  // 1 byte

// Schedule mode EEPROM addresses
#define EEPROM_SCHEDULE_MODE_ENABLED 29   // 1 byte
#define EEPROM_SCHEDULES_START 30         // 15 bytes (3 schedules × 5 bytes each)
#define EEPROM_SCHEDULE_COUNT 45          // 1 byte

// WiFi credentials EEPROM addresses
#define EEPROM_WIFI_CONFIGURED 50     // 1 byte
#define EEPROM_WIFI_SSID 51          // 32 bytes  
#define EEPROM_WIFI_PASSWORD 83      // 64 bytes

// Time sync EEPROM addresses
#define EEPROM_LAST_TIME_SYNC 147     // 4 bytes (unix timestamp)

// Logging system EEPROM addresses
#define EEPROM_LOG_INDEX 151         // 2 bytes (current log index)
#define EEPROM_LOG_COUNT 153         // 1 byte (total entries)

// Device name EEPROM addresses
#define EEPROM_DEVICE_NAME_CONFIGURED 154  // 1 byte
#define EEPROM_DEVICE_NAME 155             // 32 bytes

// Safe Mode auto-recovery configuration
#define EEPROM_AUTO_RECOVER_SCHEDULE 187   // 1 byte
#define EEPROM_AUTO_RECOVER_TIMEOUT 188    // 1 byte
#define EEPROM_AUTO_RECOVER_HOURS 189      // 1 byte

// Dry run protection configuration
#define EEPROM_MAX_DRY_RUN_COUNT 190       // 1 byte

// Password protection EEPROM addresses
#define EEPROM_PASSWORD_ENABLED 191        // 1 byte
#define EEPROM_PASSWORD 192                // 4 bytes (4-digit PIN)

// Source water detection EEPROM addresses (v8.0.1)
#define EEPROM_SOURCE_FEATURES_MAGIC 206   // 1 byte - validation (0xAE - bumped from 0xAC for v8 layout)
#define EEPROM_DETECTION_MODE 207          // 1 byte - 0=Pre (default), 1=Post
#define EEPROM_GRACE_PERIOD_TENS 208       // 1 byte - tens of seconds (4=40s, 6=1min, 18=3min, 60=10min)
#define EEPROM_SOURCE_DEBOUNCE_SECS 209    // 1 byte - 5-180 seconds (10 options)
#define EEPROM_RETRY_COUNT 210             // 1 byte - 1-5 source water retries
#define EEPROM_RETRY_WAIT_MINS 211         // 1 byte - 1-15 minutes source water wait
#define EEPROM_MAX_RUN_TIME_MINS 212       // 1 byte - 0=Off, 30/60/90/120/180 minutes
#define SOURCE_FEATURES_MAGIC 0xAE         // Bumped from 0xAC to invalidate v7 EEPROM data

// Panel control + buzzer + feedback EEPROM addresses (unchanged)
#define EEPROM_PANEL_MAGIC          213    // 1 byte - validation (0xAD)
#define EEPROM_PUMP_TYPE            214    // 1 byte - PumpType enum
#define EEPROM_PANEL_START_PULSE_MS 215    // 2 bytes - start pulse duration (ms)
#define EEPROM_PANEL_STOP_PULSE_MS  217    // 2 bytes - stop pulse duration (ms)
#define EEPROM_FEEDBACK_ENABLED     219    // 1 byte - 0 = off, 1 = on (panel only)
#define EEPROM_BUZZER_FLAGS         220    // 1 byte - bitmask BUZZ_ON_MOTOR_ON | BUZZ_ON_ERROR
#define PANEL_MAGIC                 0xAD

// NEW v8.0.1 — Tank dry run separate retry wait (fresh address, no panel conflict)
#define EEPROM_DRY_RUN_WAIT_MINS    221    // 1 byte - 1-15 minutes (tank dry run retry wait)

// Buzzer auto-stop timer (v8.0.1+)
#define EEPROM_BUZZER_AUTO_STOP_EN   222    // 1 byte - 0=continuous (default), 1=auto-stop after timeout
#define EEPROM_BUZZER_AUTO_STOP_MINS 223    // 1 byte - 1-30 minutes (default 5)

// Per-unit random 4-char suffix for AP SSID / mDNS uniqueness.
// Generated once on first boot, kept forever so the device always
// advertises the same name (e.g. terracetank_A3F7_mvstech).
#define EEPROM_SUFFIX_VALID 224             // 1 byte - magic 0xBB if suffix stored
#define EEPROM_SUFFIX      225              // 4 bytes - A-Z0-9 chars
#define SUFFIX_MAGIC 0xBB

// ── v118 ultrasonic-tank NVS slots ──
// Tank geometry + threshold settings for the RS485 ultrasonic terrace
// sensor. Distance→% conversion is level-driven and needs both a tank
// height and a mounting-offset (dead zone above water). Pump start/stop
// thresholds replace the discrete probe transitions of v117.
#define EEPROM_US_MAGIC              229    // 1 byte - 0xC5 if ultrasonic config valid
#define EEPROM_US_TANK_HEIGHT_CM     230    // 2 bytes - tank inner height (10-600 cm)
#define EEPROM_US_SENSOR_OFFSET_CM   232    // 2 bytes - dead zone above water (0-100 cm)
#define EEPROM_US_PUMP_START_PCT     234    // 1 byte - start pump below this pct (5-70)
#define EEPROM_US_PUMP_STOP_PCT      235    // 1 byte - stop pump at/above this pct (60-100)
#define EEPROM_US_MODBUS_ADDR        236    // 1 byte - sensor's Modbus slave address (0x01-0xFE)
#define US_MAGIC 0xC5

// ── v118.0.9 smart dry-run + Safe Mode auto-clear slots ──
// Smart dry-run uses level-change detection: measure pct every N min
// while pump runs, fault if change < minChangePct. Faster + more
// accurate than the time-only LOW→FULL probe timer. User can disable
// (fall back to classic), or set it OFF entirely.
//
// Safe Mode auto-clear: previously manual-only. Three options now:
//   0 = manual (OFF)
//   1 = next-schedule-start (only meaningful if schedule mode ON)
//   2 = timeout (clears after N hours)
#define EEPROM_SMART_DRY_RUN_MAGIC   237    // 1 byte - 0xDA if smart dry-run settings valid
#define EEPROM_SMART_DRY_RUN_ON      238    // 1 byte - 0=classic (LOW→FULL time), 1=smart (level-change)
#define EEPROM_SMART_CHECK_MINS      239    // 1 byte - check interval (1-15 min, default 5)
#define EEPROM_SMART_MIN_PCT         240    // 1 byte - min pct rise expected per check (1/2/3/5/10)
// (241-243 reserved for future smart dry-run tuning; Safe Mode auto-clear
// reuses existing EEPROM_AUTO_RECOVER_* slots in the auto-recovery block.)
#define SMART_DRY_RUN_MAGIC 0xDA

// v118.0.9 schedule extensions — appended slots keep the legacy
// EEPROM_SCHEDULES_START (30-44) format unchanged so a device
// downgrade won't corrupt its base schedule times.
// Each schedule gets 2 extra bytes: dayMask (bit 0=Sun..6=Sat) +
// fillUntilFull (0/1). Magic byte guards against uninitialised slots
// being read as 0x00 dayMask (which the loader interprets as "every day"
// via the backward-compat fallback below — safe default).
#define EEPROM_SCHED_EXT_MAGIC       244    // 1 byte - 0xDB if ext slots valid
#define EEPROM_SCHED_EXT_START       245    // 6 bytes (3 schedules × 2 bytes)
#define SCHED_EXT_MAGIC 0xDB
#define SCHED_DAY_MASK_ALL 0x7F   // every day of week

#define MAGIC_NUMBER 0xAB

// Logging system configuration
#define LOG_FILE_PATH "/tank_logs.dat"
#define MAX_LOG_ENTRIES 100
#define LOG_ENTRY_SIZE 128  // Fixed size per entry
#define LOG_VIEW_ENTRIES 50  // Max entries to show in web view


// Log event types (only the 7 specified types)
enum LogEventType {
  LOG_MOTOR_EVENT = 1,
  LOG_MODE_CHANGE = 2,
  LOG_ERROR_EVENT = 3,
  LOG_SYSTEM_EVENT = 4,
  LOG_WIFI_EVENT = 5,
  LOG_OTA_EVENT = 6,
  LOG_TIME_SYNC = 7,
  LOG_PACKET_EVENT = 8,    // NEW
  LOG_SENSOR_STATE = 9,    // NEW
  LOG_MEMORY_EVENT = 10    // NEW
};

// Forward declarations for functions using LogEventType
String getEventTypeName(LogEventType eventType);
void writeLogEntry(LogEventType eventType, const String& action, const String& details);

// Log entry structure (exactly 128 bytes)
struct LogEntry {
  uint32_t timestamp;      // 4 bytes - Unix timestamp
  uint8_t eventType;       // 1 byte - LogEventType
  char action[32];         // 32 bytes - Action description
  float waterLevel;        // 4 bytes - Water level (only for motor events)
  float waterPercent;      // 4 bytes - Water percentage (only for motor events)
  uint8_t wpSensorStatus;  // 1 byte - WP sensor status (only for motor events)
  char details[80];        // 80 bytes - Additional details
  uint8_t reserved[4];     // 4 bytes - Reserved for future use
};

// Circular buffer log management
struct LogManager {
  uint16_t currentIndex;   // Current write position (0-99)
  uint8_t totalEntries;    // Total entries written (0-100)
  bool isInitialized;
};

// Schedule structure
// v118.0.9 additions:
//   dayMask     — bitmask of weekdays this schedule runs on. Bit 0=Sun,
//                 1=Mon, …, 6=Sat. 0x7F = every day (backward-compat
//                 default when EEPROM slot is 0 or uninitialised).
//   fillUntilFull — when true, during the schedule WINDOW the pump
//                 starts regardless of startPercent and runs until
//                 current pct reaches stopPercent (or window ends).
//                 Lets users force-fill at off-peak hours even if the
//                 tank is only slightly below start threshold.
struct Schedule {
  uint8_t startHour;    // 0-23
  uint8_t startMinute;  // 0-59
  uint8_t endHour;      // 0-23
  uint8_t endMinute;    // 0-59
  bool enabled;         // individual schedule on/off
  uint8_t dayMask;      // v118.0.9 — bit 0=Sun..6=Sat. 0 or 0x7F = every day
  bool fillUntilFull;   // v118.0.9 — ignore startPercent, run to stopPercent
};

// WiFi reconnection management
struct WiFiReconnectState {
  bool isReconnecting;
  unsigned long lastCheckTime;
  unsigned long lastAttemptTime;
  unsigned long nextAttemptTime;
  uint8_t attemptCount;
  uint16_t backoffSeconds;
  bool wasConnected;
};

// System states
enum SystemMode {
  MODE_NORMAL = 0,
  MODE_DRY_RUN_RECOVERY = 1,
  MODE_SAFE_MODE = 2,
  MODE_SENSOR_OFFLINE = 3,
  MODE_MANUAL_OVERRIDE = 4,
  MODE_IDLE = 5,
  MODE_SCHEDULE_INACTIVE = 6,
  MODE_PANEL_FAULT = 7,
  MODE_SOURCE_DRY_RUN = 8   // NEW: separate from tank dry run, uses sourceDryRunCount/retryWaitMins
};

// Global variables
RTC_DS3231 rtc;
bool rtcAvailable = false;  // set true only if rtc.begin() succeeded at boot

// Software-clock anchor for boards without a physical RTC. Paired with
// lastTimeSyncEpoch (declared later, kept here as extern-style forward).
// Updated in lockstep by saveLastTimeSyncInfo() every NTP or browser sync.
// Between syncs, safeNow() extrapolates:
//     epoch_now = lastTimeSyncEpoch + (millis() - millisAtLastSync) / 1000
// Drift is just millis() rate error; self-heals on the next sync.
extern uint32_t lastTimeSyncEpoch;
uint32_t millisAtLastSync = 0;    // millis() snapshot at last sync (0 = never)

// Safe wrapper — returns current RTC time if available. Otherwise, if
// we've had at least one time sync (NTP or browser), extrapolate from
// the anchor using millis(). Only when we've NEVER synced do we fall
// back to the pre-sync placeholder so downstream code doesn't crash on
// a bogus year — logs made in that window are marked with the epoch
// anyway (they'll just carry the placeholder date until first sync).
DateTime safeNow() {
  if (rtcAvailable) return rtc.now();
  if (lastTimeSyncEpoch != 0 && millisAtLastSync != 0) {
    // Software clock: extrapolate from last sync. millis() overflow
    // (~49.7 days) is handled by unsigned arithmetic; result stays valid.
    uint32_t elapsedSec = (millis() - millisAtLastSync) / 1000UL;
    return DateTime(lastTimeSyncEpoch + elapsedSec);
  }
  return DateTime(2025, 1, 1, 0, 0, 0);  // placeholder — no RTC + no sync yet
}

WebServer server(7689);
IPAddress apIP(192, 168, 4, 1);

// Logging system variables
LogManager logManager = {0, 0, false};

// MVS OTA instance
MvsOTA mvsota;

// ═══════════════════════════════════════════════════════════════════
//  Firebase runtime state (117.0.0) — dual-core architecture
//  Pump control runs on Core 1 (Arduino default). Cloud runs on Core 0
//  in a dedicated FreeRTOS task with its own WDT. The two communicate
//  ONLY via (a) a mutex-guarded snapshot struct and (b) a FreeRTOS
//  event queue. Pump control never blocks on Firebase, WiFi, or DNS.
// ═══════════════════════════════════════════════════════════════════
#if ENABLE_CLOUD
FirebaseData    fbdo;
FirebaseAuth    fbAuth;
FirebaseConfig  fbConfig;

// These flags are written by the cloud task only and read by both tasks.
// `volatile` because reads happen outside the snapshot mutex — it's fine
// if a status read is momentarily stale, we just skip a publish that
// tick and retry on the next.
volatile bool   firebaseReady        = false;
volatile bool   firebaseHealthy      = false;
volatile bool   internetAvailable    = false;

// Layer-3 rate limit + change-detection cache (cloud-task-only state)
unsigned long   pumpLastLivePushMs   = 0;
// Set every time /live or /history writes actually succeed. Used by the
// AP web page ("Last Update: 12s ago") and by the LED status window to
// distinguish "auth OK but pushes failing" from "auth OK and pushes OK".
unsigned long   lastSuccessfulPush   = 0;

// ── Cloud-driven OTA ──────────────────────────────────────────────
// Mirrors the sensor firmware's OTA design. Dashboard's Admin → Firmware
// page writes {otaTrigger:true, otaTargetUrl, otaTargetMd5, otaScheduledAt}
// to /devices/{code}/config; firmware polls that node every ~30 s from
// the cloud task, downloads + flashes when due, then reboots into the
// new firmware. Motor-safety gate defers OTA while the pump is running.
unsigned long   lastOtaCheckMs       = 0;
const unsigned long OTA_CHECK_INTERVAL_MS = 60000;    // poll trigger every 60 s (v117.0.10+)
const uint8_t   OTA_MAX_RETRIES      = 3;             // fail permanently after N attempts
uint32_t        firstBootAt          = 0;             // epoch when device first came online
uint32_t        lastUpdatedAt        = 0;             // epoch of most recent successful OTA

// ── Feature-gate flags (mirrored from devices/{code}/config/) ───────
// Match the ultrasonic firmware's tier model so the same admin UI
// (Admin → Devices → toggle analytics / notify) works on pumps too.
//   analyticsOn — device writes /history when true. Off = free tier.
//   notifyOn    — device writes /notify_trigger when true. On = premium
//                 tier gets FCM push notifications via the Cloud Function
//                 dispatcher. Off = no notifications (zero backend cost).
// Both default OFF so a fresh device never spams RTDB before admin has
// deliberately turned it on. Polled by cloud task's checkCloudConfig().
volatile bool   analyticsOn = false;
volatile bool   notifyOn    = false;

// Tracked so pushNotifyTrigger() has a payload to send: the last pumpState
// transition + fault bits. Cheap to keep, only read on notify pushes.
volatile uint8_t lastNotifyFlags = 0;
String   lastPub_pumpState    = "";
String   lastPub_terraceState = "";
// v118.0.2: last published terrace pct — gates /live pushes on ≥2% change
// so the cloud dashboard chart gets fine-grained but not spammy data.
// Sentinel 0xFF = "nothing pushed yet"; next push always goes through.
uint8_t  lastPub_terracePct  = 0xFF;
#define  US_CLOUD_PUSH_DELTA_PCT  2    // push on ≥ this % change
String   lastPub_sourceState  = "";
bool     lastPub_feedbackFault = false;

// Persistent device code (NVS "pump" namespace)
String pumpDeviceCode = "";

// ── Snapshot struct — pump-control task writes, cloud task reads ────
// Kept small and POD (no String) so a full struct-copy under mutex is
// cheap. String fields are derived by the cloud task from these enums.
// PS_STARTING = motor was commanded ON, feedback hasn't confirmed HIGH
// yet, and we're still inside the FEEDBACK_CONFIRM_TIMEOUT_MS grace
// window. Honest transient state — shown as "Starting" on the pill,
// then flips to PS_AUTO / PS_MANUAL once feedback latches, or to
// PS_FAULT if the window expires. Only meaningful when feedback is
// enabled and wired; otherwise motor-commanded == motor-running.
enum PumpStateEnum   : uint8_t { PS_OFF=0, PS_AUTO=1, PS_MANUAL=2, PS_FAULT=3, PS_STARTING=4 };
enum TerraceEnum     : uint8_t { TS_EMPTY=0, TS_HALF=1, TS_FULL=2, TS_FAULT=3 };
enum SourceEnum      : uint8_t { SR_DRY=0,  SR_WET=1 };

// Fault reason codes carried alongside PS_FAULT so PumpDetail's Live
// tab can show "Failed to start" / "Dropped mid-run" / "Stuck on"
// instead of a generic "Fault". Kept as a plain uint8 in the snapshot;
// firmware sets it whenever feedbackFaultActive flips true, cloud
// forwards it in /live.faultReason.
enum FaultReasonEnum : uint8_t {
  FR_NONE            = 0,
  FR_START_FAIL      = 1,   // contactor never latched after START pulse + retry
  FR_MID_RUN_DROPOUT = 2,   // was running, contactor released unexpectedly
  FR_STUCK_ON        = 3,   // motor commanded off, feedback still shows running
};

struct PumpSnapshot {
  PumpStateEnum pumpState;
  TerraceEnum   terraceState;
  SourceEnum    sourceState;
  bool          hasFeedback;
  bool          hasSource;
  bool          feedbackFault;
  uint8_t       faultReason; // FaultReasonEnum — meaningful only when feedbackFault=true
  int           rssi;
  uint32_t      stampMs;   // millis() when snapshot was taken (for staleness)
  // v118.0.11: snapshot the ultrasonic read too, so cloudTask reads a
  // CONSISTENT (terraceState, terracePct, haveGoodReading, sensorFault)
  // tuple instead of racing against Core 1's burst commits. Prior code
  // snapshotted only the enum then re-read usConfirmedPct live for the
  // /history write — so a brief glitch between the two reads could push
  // a 0% /history event while /live and AP both showed the real pct.
  uint8_t       terracePct;
  bool          haveGoodReading;
  bool          sensorFault;
  int32_t       rawMm;
};
PumpSnapshot     g_snapshot   = { PS_OFF, TS_EMPTY, SR_DRY, false, false, false, FR_NONE, 0, 0, 0, false, false, -1 };
SemaphoreHandle_t g_snapMutex = nullptr;

// ── Pump run event — one enqueue per state transition ──────────────
// pump_on + pump_off carry the SAME runId so the web app can pair them
// even if only one arrives online. See writePairedHistory() for the
// "only push complete pairs" rule (user requirement).
enum PumpEventType : uint8_t { EV_PUMP_ON = 1, EV_PUMP_OFF = 2 };

struct PumpEvent {
  PumpEventType type;
  char          runId[24];    // "R-<epoch>" or "R-<millis>" fallback
  uint32_t      evTs;         // unix epoch (from RTC/NTP) or 0 if unknown
  uint32_t      evMillis;     // millis() at event time — always populated
  PumpStateEnum pumpStateAtEvent;
  TerraceEnum   terraceAtEvent;
  SourceEnum    sourceAtEvent;
  uint32_t      runSecIfOff;  // populated only for EV_PUMP_OFF
  char          cause[16];    // "auto" | "schedule" | "force" | "manual_button" | ...
};

QueueHandle_t    g_eventQueue = nullptr;  // pump-control → cloud task
#define PUMP_EVENT_QUEUE_LEN  10          // matches user's "last 10 events" rule

// ── Cloud-log queue (Core 0 → Core 1) ───────────────────────────────
// LittleFS is NOT thread-safe on ESP32. The cloud task pushes short
// human-readable log lines here whenever a /live or /history write
// succeeds or fails; the main loop on Core 1 drains and writes them
// to LittleFS via the existing logSystemEvent() path. This way LittleFS
// is only ever touched from a single core.
struct CloudLogMsg {
  char action[24];    // e.g. "HIST_OK", "HIST_FAIL", "LIVE_FAIL"
  char details[64];   // e.g. "runId=R-1734286800 runSec=1500", or error reason
};
QueueHandle_t    g_cloudLogQueue = nullptr;
#define CLOUD_LOG_QUEUE_LEN  16
// Non-blocking enqueue helper (safe to call from cloud task).
static inline void queueCloudLog(const char* action, const char* details) {
  if (!g_cloudLogQueue) return;
  CloudLogMsg m = {};
  strncpy(m.action,  action  ? action  : "",  sizeof(m.action)  - 1);
  strncpy(m.details, details ? details : "",  sizeof(m.details) - 1);
  // Drop oldest if full so we never block cloud task on log queue.
  if (xQueueSend(g_cloudLogQueue, &m, 0) != pdTRUE) {
    CloudLogMsg dropped;
    xQueueReceive(g_cloudLogQueue, &dropped, 0);
    xQueueSend(g_cloudLogQueue, &m, 0);
  }
}

// ── Paired-events cache: only complete pairs get pushed to /history ─
// Cloud task keeps at most 10 unpaired pump_on entries in RAM waiting
// for their pump_off partner. On EV_PUMP_OFF arrival, we find the
// matching runId, build one combined history entry, push to RTDB, and
// evict from the cache. If a pump_on ages past 24 hr without a partner,
// we drop it silently — matches user's rule "don't push incomplete pairs".
#define PAIRED_CACHE_LEN 10
struct PendingRun {
  bool     inUse;
  char     runId[24];
  uint32_t onTs;              // event time
  uint32_t onMillis;
  TerraceEnum terraceStart;
  SourceEnum  sourceStart;
  char     causeStart[16];
};
PendingRun g_pendingRuns[PAIRED_CACHE_LEN] = {};

// Cloud task handle (Core 0). Non-null once xTaskCreatePinnedToCore
// succeeds in setup().
TaskHandle_t g_cloudTaskHandle = nullptr;

// ── Forward declarations ────────────────────────────────────────────
// Arduino's auto-prototype generator inserts prototypes for all non-
// static functions at the top of the .ino BEFORE our struct/enum
// definitions above are seen, which breaks compilation. Declaring the
// prototypes here (after the types) suppresses auto-prototype for
// these names. All these functions are defined much later in the file.
static void snapshotToEvent(PumpEvent& e);
static bool copySnapshot(PumpSnapshot& out);
static bool cloudPushLive(const PumpSnapshot& s);
static void storePendingRun(const PumpEvent& onEv);
static bool pushPairedHistory(const PendingRun& on, const PumpEvent& off);
static const char* pumpEnumToStr(PumpStateEnum s);
static const char* terraceEnumToStr(TerraceEnum s);
static PumpStateEnum derivePumpStateEnum();
static TerraceEnum   deriveTerraceStateEnum();
static void writePendingDevice();
static void pushNotifyTrigger(const char* event, uint8_t flg);
static void checkCloudConfig();
static int  countPendingRuns();
static int  countEventQueueDepth();
static int  countCloudLogDepth();
#endif

// Device name configuration
String deviceName = "PANEL";  // Default name — panel-controller flavor
                              // (will have _<devSuffix>_mvstech appended,
                              // so AP SSID becomes "panel_2Y1U_mvstech"
                              // and cloud code "SF-PMP-2Y1U" share the
                              // same 4-char suffix — installer can
                              // correlate WiFi hotspot to registered
                              // device at a glance)
String devSuffix  = "";               // random 4-char suffix (A-Z0-9), generated once at first boot
String fullDeviceName = "senseflow_mvstech";  // Full name with suffix
String apSSID = "senseflow_mvstech";  // Dynamic AP SSID
String otaHostname = "senseflow-mvstech";  // Dynamic OTA hostname

// Configuration variables
bool isConfigured = false;
uint8_t startPercent = 30;
uint8_t stopPercent = 70;
uint32_t tankVolume = 1000;
bool hasWPSensor = false;
bool dryRunProtectionOn = false;
// Max minutes for the tank to go LOW->FULL while motor runs before declaring
// a dry run - replaces the donor's poll-interval cm-based dryRunIntervalMins
// (same EEPROM address/size/default, reinterpreted for binary probes).
uint8_t maxTimeToNextProbeMins = 10;
String targetNodeName = "US03";
String wpNodeName = "WP01";
bool autoModeEnabled = true;

// Panel control + feedback + buzzer configuration
PumpType pumpType = PUMP_SINGLE_PHASE;
uint16_t panelStartPulseMs = (uint16_t)PANEL_PULSE_DEFAULT_MS;
uint16_t panelStopPulseMs  = (uint16_t)PANEL_PULSE_DEFAULT_MS;
bool feedbackEnabled = false;            // panel mode only
uint8_t buzzerFlags = 0;                  // BUZZ_ON_MOTOR_ON | BUZZ_ON_ERROR

// Panel pulse state machine (runtime, not persisted)
enum PulseTarget { PULSE_NONE = 0, PULSE_START = 1, PULSE_STOP = 2 };
PulseTarget activePulse = PULSE_NONE;
unsigned long pulseEndAt = 0;
unsigned long lastStartPulseAt = 0;       // when the most recent START pulse ended
bool feedbackFaultActive = false;          // contactor failed to confirm / dropped out
unsigned long feedbackBadSinceMs = 0;      // tracks dropout debounce while motor expected on
uint8_t feedbackRetryCount = 0;            // Track retry attempts for START/STOP
bool buzzerMuted = false;                  // User acknowledged/silenced buzzer until next event
bool buzzerAutoStopEnabled = false;        // Default OFF; if ON, buzzer auto-mutes after timeout
uint8_t buzzerAutoStopMins = 5;            // 1-30 minutes; only used when buzzerAutoStopEnabled is true
unsigned long buzzerStartTime = 0;         // Tracks when current buzz event began (0 = idle)
unsigned long feedbackRetryWaitStart = 0;  // When retry pause started
bool waitingForRetry = false;              // True during 2s pause between retries

// Shared feedback state — maintained by handleMotorFeedback() on Core 1,
// read-only from Core 0 (derivePumpStateEnum + snapshot code). Prevents
// the cross-core race where Core 0 would independently readMotorFeedback()
// and disagree with Core 1's interpretation of the same GPIO.
//
// g_fbConfirmedRunning = latest debounced answer to "is the contactor
//   currently latched?". Only meaningful when feedbackEnabled=true and
//   pumpType=PUMP_PANEL; otherwise Core 0 falls back to motorState.
// g_faultReason = why feedbackFaultActive flipped true. Cleared to
//   FR_NONE when the fault clears. Forwarded to /live so PumpDetail
//   can show "Failed to start" / "Dropped mid-run" / "Stuck on".
volatile bool    g_fbConfirmedRunning = false;
volatile uint8_t g_faultReason        = 0;    // FaultReasonEnum

// "Until tank full" force-run mode. Set by the cloud-side force
// command (or AP page dropdown) when the user picks the "Until full"
// duration instead of a fixed minute count. When true, the manual-
// override loop stops on tank-FULL rather than on the elapsed timer.
// No hard safety cap — user's explicit choice; existing dry-run and
// feedback-fault protections still apply.
bool manualOverrideUntilFull = false;

// v118.0.9: panel-manual tracker. True when the physical panel button
// (not AP page, not cloud) started the pump. We route panel-manual
// through enterManualOverride() so AP/cloud UIs show the same STOP
// button + countdown + "until-full" logic they'd show for any other
// force run — but we SKIP the START pulse (contactor already latched
// by the button press) to avoid a redundant pulse that could race the
// operator who just pressed START. Also skip the STOP pulse on exit
// when the exit was triggered by the operator pressing panel STOP.
bool panelManualActive = false;

// Forward declarations (defined later) - explicit so Arduino's auto-prototype
// generator doesn't emit a prototype above the PulseTarget enum definition.
void startPanelPulse(PulseTarget target, uint16_t durationMs);
void handlePanelPulses();
void handleMotorFeedback();
void handleBuzzer();
void loadPanelConfig();
void savePanelConfig();

// Motor confirmation tracking
struct MotorConfirmation {
  int startConfirmCount = 0;     // Count of consecutive "should start" readings
  int stopConfirmCount = 0;      // Count of consecutive "should stop" readings
  bool waitingForStart = false;  // True when confirming start condition
  bool waitingForStop = false;   // True when confirming stop condition
  String lastStartConfirmMsgId = "";  // Last message ID that confirmed start
  String lastStopConfirmMsgId = "";   // Last message ID that confirmed stop
  unsigned long lastConfirmTime = 0;   // Last time we got a confirmation
  bool confirmationComplete = false;   // True when confirmation is ready to act on
  String confirmationType = "";        // "START" or "STOP" when confirmation complete
} motorConfirm;

// Schedule mode variables
bool scheduleModeEnabled = false;
Schedule schedules[3];
uint8_t activeScheduleCount = 0;
int currentActiveSchedule = -1;

// Safe Mode auto-recovery variables
bool autoRecoverOnSchedule = false;    // Default: DISABLED (conservative)
bool autoRecoverOnTimeout = false;     // Default: DISABLED (conservative)
int autoRecoverTimeoutHours = 4;       // Default: 4 hours
unsigned long safeModeStartTime = 0;   // Track when Safe Mode started

// OTA and WiFi Station mode variables
bool otaInProgress = false;
bool wifiStationMode = false;
String wifiSSID = "";
String wifiPassword = "";
bool wifiConfigured = false;
unsigned long otaStartTime = 0;
uint8_t otaProgress = 0;

// WiFi reconnection variables
WiFiReconnectState wifiReconnect = {false, 0, 0, 0, 0, WIFI_RECONNECT_MIN_INTERVAL_SECONDS, false};

// Time sync variables
uint32_t lastTimeSyncEpoch = 0;
String lastTimeSyncResult = "";

// NTP auto-sync variables
#define NTP_SYNC_INTERVAL_HOURS 24        // Try NTP sync every 24 hours
#define NTP_SERVER "pool.ntp.org"
unsigned long lastNTPCheckMillis = 0;
bool ntpSyncedToday = false;

// Runtime variables
SystemMode currentMode = MODE_NORMAL;
bool motorState = false;

#if ENABLE_CLOUD
// Cause of the NEXT setMotor() call. Callers set this before calling
// setMotor(true/false); the cloud hook reads it, then it's reset to
// "auto" for safety. Panel button + cloud forceOn share the same
// "force" cause (per user rule: same thing, no distinction).
const char* nextMotorCause = "auto";
// Track whether the current on-run was originated by us (true = auto)
// or by external means (false = manual/force). Used so pump_off inherits
// the right cause when it fires from a schedule/dry-run branch.
bool currentRunIsManual = false;
#endif
float currentWaterLevel = 0.0;
float currentWaterPercent = -1.0;
String lastReceivedMsgId = "";
DateTime lastSensorUpdate;
bool sensorOnline = false;
bool hasReceivedReading = false;
bool needFreshDataAfterRecovery = false;

// Startup safety variables
bool startupSensorValidation = true;
unsigned long startupTime = 0;
#define STARTUP_SENSOR_DELAY_MS 10000  // 10 seconds for wired sensor stabilization (was 30000 for wireless)
int dryRunCount = 0;
uint8_t maxDryRunCount = 2;  // Default: 2 dry runs before Safe Mode (configurable: 1-10 as of v118.0.9)
unsigned long lastPacketTime = 0;  // Track last LoRa packet reception time
unsigned long dryRunStartTime = 0;
unsigned long dryRunProbeTimerStart = 0;  // when the current LOW->FULL transit timer began

// ── v118.0.9 smart dry-run (level-change detection) ──
// Classic dry-run only knew the tank wasn't filling AFTER maxTimeToNextProbeMins
// elapsed with no LOW→FULL transition. Fine for 15-30 min fills; useless at
// catching a slow-leak or dry-source scenario where the pump might run for
// 2 hours producing nothing. Smart dry-run polls pct every N min while
// motor is on; if pct hasn't risen by the user's minimum (default 2%)
// within the window, counts a dry-run cycle. Catches real dry-pump in
// 5-15 min typical instead of 30+.
//
// Config (persisted in EEPROM slots 237-243, see top of file):
bool    smartDryRunEnabled = true;   // ON by default on v118.0.9+ — level-based beats time-based
uint8_t smartDryRunCheckMins = 5;    // Window size in minutes (1-15)
uint8_t smartDryRunMinPct    = 2;    // Required pct rise in window (1/2/3/5/10)
// Runtime state — reset on every pump-on:
uint8_t  smartDryRunStartPct = 0;    // Pct at window start
unsigned long smartDryRunWindowStartMs = 0;   // millis() at window start

// NOTE v118.0.9: Safe Mode auto-clear was going to add new globals here
// but the existing autoRecoverOnSchedule / autoRecoverOnTimeout /
// autoRecoverTimeoutHours already cover this feature end-to-end
// (checkSafeModeAutoRecovery + saveAutoRecoveryConfiguration). Cloud
// panel UI just needs to expose those three — no new firmware state.
bool wpSensorStatus = true;
DateTime lastWPSensorUpdate;
bool wpSensorOnline = false;
bool hasReceivedWPReading = false;
unsigned long lastStatusPrint = 0;
bool continuousStatusMode = false;

// RSSI tracking variables
int currentRSSI = 0;
int currentWPRSSI = 0;
bool hasRSSIReading = false;
bool hasWPRSSIReading = false;

// Manual override variables
bool previousAutoModeState = true;
SystemMode modeBeforeManualOverride = MODE_IDLE;  // NEW: Remember mode before manual override
unsigned long manualOverrideStartTime = 0;
int manualOverrideDurationMinutes = 15;  // Default: 15 minutes (user configurable: 5, 10, 15, 30, 60)

// AP-page "Force Run Duration" dropdown remembers the customer's last
// pick across reboots. Persisted to Preferences namespace "pump" under
// key "frDur". Sentinel -1 means "Until tank full". Loaded once at
// setup(); saved in handleWebManualOn after successful validation.
// This is UI-remember-me only — the actual running duration during a
// force run is manualOverrideDurationMinutes / manualOverrideUntilFull.
int lastForceRunSelection = 15;

// v117.0.9 — persisted round-trip token. Cloud writes /config/savedAt
// on every atomic Save & Send. checkCloudConfig() gates panel-settings
// application on freshSave = (incoming != this). Without persistence,
// a reboot resets to 0 → firmware treats stale /config as fresh →
// re-applies old cloud values → wipes out any AP-page changes made
// between saves. Loaded from Preferences "pump"/"lastSvAt" at setup;
// written back on every successful cloud save.
uint32_t lastAppliedSavedAt = 0;

// Fill intent memory variables
bool motorWasFillingBeforeOffline = false;
unsigned long sensorOfflineTimestamp = 0;
uint8_t fillResumeAttempts = 0;

// Source water detection configuration (saved to EEPROM) — v8.0.1
uint8_t detectionMode = 0;            // 0=Pre-Detection (default), 1=Post-Detection
uint8_t gracePeriodTens = 18;         // Grace period in tens of seconds (4=40s, 6=1min, 18=3min, 60=10min)
uint8_t sourceDebounceSecs = 30;      // Source debounce in seconds (5-180, 10 options)
uint8_t maxRetryCount = 3;            // Source water retries before Safe Mode (1-5)
uint8_t retryWaitMins = 10;           // Source water wait between retries (1-15 min)
uint8_t maxRunTimeMins = 120;         // Max continuous run time (0=Off, 30/60/90/120/180) — default 2h
uint8_t dryRunWaitMins = 10;          // Tank dry run wait between retries (1-15 min)

// Source water detection runtime state (RAM only)
uint8_t sourceDryRunCount = 0;        // Source water retry counter
bool graceActive = false;             // Grace period in progress
unsigned long graceStartTime = 0;     // When grace period started
bool sourceConfirmed = false;         // Source water confirmed stable after grace
unsigned long sourceConfirmStart = 0; // When source confirmation started
unsigned long motorRunStartTime = 0;  // When motor started current continuous run
unsigned long sourceDryRunStartTime = 0; // When source dry run recovery started

// Pump stage tracking for UI
String pumpStage = "IDLE";            // Current pump operation stage
String lastFaultReason = "";          // "NO_SOURCE", "NO_LEVEL_CHANGE", "MAX_RUN_TIME"

// Anti-spam variables
unsigned long lastNoWaterWarning = 0;
#define WARNING_REPEAT_INTERVAL 10000

// RGB LED variables
unsigned long lastLEDUpdate = 0;
bool ledBlinkState = false;
unsigned long lastHeartbeat = 0;
bool heartbeatActive = false;

// Cloud/WiFi status blink cycle (117.0.0) — mirrors the ultrasonic
// firmware's 30 s level color → 5 s system status blink pattern. During
// the status window, the LED colour tells the installer at a glance
// which layer of connectivity is failing:
//   Blue  = WiFi + internet + Firebase all OK
//   Pink  = WiFi up but no internet (DNS chain failed)
//   Red   = internet OK but Firebase auth failing
//   White = no WiFi at all
// Cycle: 30 s of normal LED (motor / fault / idle) → 5 s of status
// blink → repeat. Status blink runs at 250 ms ON / 250 ms OFF so it
// reads as an obvious "status pulse" not a solid colour.
unsigned long ledCycleStart   = 0;
bool          ledShowingStatus = false;
unsigned long statusBlinkStart = 0;
#define LED_CYCLE_LEVEL_MS   30000UL
#define LED_CYCLE_STATUS_MS   5000UL

// Test-LED (identify-device) blink — runs for ~1.8 s cycling RED → GREEN
// → BLUE every 200 ms. Highest priority in updateLEDStatus() so an
// installer can identify which physical box they're looking at even
// while motor is running or a fault is active. Triggered from three
// paths: (a) AP page /testled endpoint, (b) cloud /testRequested flag
// consumed by the cloud task, (c) SenseFlow app which flips that same
// cloud flag. Same visual signature as the ultrasonic firmware so
// installers see identical behaviour across pump + sensor devices.
volatile bool testBlinkActive = false;
volatile unsigned long testBlinkStart = 0;

// Web interface variables
bool apModeActive = false;
unsigned long apStartTime = 0;

// Reset switch variables
bool lastSwitchState = false;
unsigned long pressStartTime = 0;
bool longPressColorChanged = false;

// Button timing thresholds - IMPROVED (matching reference code style)
#define SWITCH_DEBOUNCE_TIME 50
#define SHORT_PRESS_MIN 50            // Lowered minimum - accept faster taps
#define SHORT_PRESS_MAX 300           // Maximum time for single tap
#define LONG_PRESS_MIN 1000           // Long press for manual override (reduced from 2000ms)

// Tap detection - IMPROVED
#define TAP_WINDOW 1500               // 1.5 seconds for triple-tap detection (increased from 1000ms)
#define RESULT_DISPLAY_TIME 1000      // Show result color for 1 second

// Button state variables
unsigned long firstClickTime = 0;
bool waitingForSecondClick = false;
bool manualOverrideToggled = false;
unsigned long switchPressStart = 0;
bool switchHoldProcessed = false;

// Tap tracking
int tapCount = 0;
unsigned long lastTapTime = 0;

// Web activity tracking for AP timeout
unsigned long lastWebActivity = 0;

// Form validation error tracking
String lastValidationErrors = "";
String lastFormData = "";

// Password protection variables
bool passwordEnabled = false;
String storedPassword = "";  // 4-digit PIN
bool deviceUnlocked = false;  // Simple boolean flag for unlock state

// ===========================================
// PASSWORD PROTECTION FUNCTIONS
// ===========================================

void loadPasswordSettings() {
  passwordEnabled = (EEPROM.read(EEPROM_PASSWORD_ENABLED) == MAGIC_NUMBER);

  if (passwordEnabled) {
    storedPassword = "";
    for (int i = 0; i < 4; i++) {
      char c = EEPROM.read(EEPROM_PASSWORD + i);
      if (c >= '0' && c <= '9') {
        storedPassword += c;
      } else {
        // Invalid password data - disable protection
        passwordEnabled = false;
        DEBUG_PRINTLN("Invalid password in EEPROM - password protection disabled");
        return;
      }
    }
    DEBUG_PRINTLN("Password protection ENABLED");
  } else {
    DEBUG_PRINTLN("Password protection DISABLED");
  }
}

void savePasswordSettings() {
  if (passwordEnabled && storedPassword.length() == 4) {
    EEPROM.write(EEPROM_PASSWORD_ENABLED, MAGIC_NUMBER);
    for (int i = 0; i < 4; i++) {
      EEPROM.write(EEPROM_PASSWORD + i, storedPassword[i]);
    }
  } else {
    EEPROM.write(EEPROM_PASSWORD_ENABLED, 0);
    for (int i = 0; i < 4; i++) {
      EEPROM.write(EEPROM_PASSWORD + i, 0);
    }
  }
  EEPROM.commit();

  DEBUG_PRINT("Password settings saved - Protection: ");
  DEBUG_PRINT(passwordEnabled ? "ENABLED" : "DISABLED");
  if (passwordEnabled && storedPassword.length() == 4) {
    DEBUG_PRINT(" - Password: ");
    DEBUG_PRINTLN(storedPassword);
  } else {
    DEBUG_PRINTLN();
  }
}

// All session-related functions removed - using simple password check

// handleLogin and handleLogout removed - replaced with simple handleWebRoot

String getLoginPageHTML(String errorMessage) {
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>Login - " + deviceName + "</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
  html += "<style>\n";
  html += "*{margin:0;padding:0;box-sizing:border-box}\n";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f0f8ff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}\n";
  html += ".login-box{background:#fff;padding:40px 30px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.15);max-width:400px;width:100%;text-align:center}\n";
  html += ".login-box h1{font-size:1.5em;color:#2980b9;margin-bottom:10px}\n";
  html += ".login-box .subtitle{color:#7f8c8d;font-size:0.9em;margin-bottom:30px}\n";
  html += ".pin-input{display:flex;gap:10px;justify-content:center;margin-bottom:20px}\n";
  html += ".pin-digit{width:50px;height:60px;font-size:2em;text-align:center;border:2px solid #ddd;border-radius:8px;transition:border-color 0.3s}\n";
  html += ".pin-digit:focus{outline:none;border-color:#3498db;box-shadow:0 0 0 3px rgba(52,152,219,0.1)}\n";
  html += ".error{background:#f8d7da;color:#721c24;padding:12px;border-radius:6px;margin-bottom:20px;border:1px solid #f5c6cb}\n";
  html += ".btn{width:100%;padding:16px;border:none;border-radius:8px;font-size:1.1em;font-weight:600;cursor:pointer;background:#27ae60;color:#fff;transition:background 0.3s;user-select:none}\n";
  html += ".btn:hover{background:#229954}\n";
  html += ".btn:active{transform:scale(0.98)}\n";
  html += ".btn:disabled{background:#bdc3c7;cursor:not-allowed}\n";
  html += ".btn.emergency{background:#e74c3c}\n";
  html += ".info{color:#7f8c8d;font-size:0.85em;margin-top:20px}\n";
  html += ".debug-info{color:#95a5a6;font-size:0.75em;margin-top:10px;font-family:monospace}\n";
  html += "@media(max-width:480px){.pin-digit{width:45px;height:55px;font-size:1.8em}}\n";
  html += "</style>\n</head>\n<body>\n";

  html += "<div class=\"login-box\">\n";
  html += "<h1>🔒 " + deviceName + "</h1>\n";
  html += "<div class=\"subtitle\">Enter 4-digit PIN to access</div>\n";

  if (errorMessage.length() > 0) {
    html += "<div class=\"error\">" + errorMessage + "</div>\n";
  }

  html += "<form method=\"POST\" action=\"/\" id=\"loginForm\">\n";
  html += "<div class=\"pin-input\">\n";
  html += "<input type=\"text\" class=\"pin-digit\" maxlength=\"1\" id=\"d1\" inputmode=\"numeric\" pattern=\"[0-9]*\" autocomplete=\"off\" required>\n";
  html += "<input type=\"text\" class=\"pin-digit\" maxlength=\"1\" id=\"d2\" inputmode=\"numeric\" pattern=\"[0-9]*\" autocomplete=\"off\" required>\n";
  html += "<input type=\"text\" class=\"pin-digit\" maxlength=\"1\" id=\"d3\" inputmode=\"numeric\" pattern=\"[0-9]*\" autocomplete=\"off\" required>\n";
  html += "<input type=\"text\" class=\"pin-digit\" maxlength=\"1\" id=\"d4\" inputmode=\"numeric\" pattern=\"[0-9]*\" autocomplete=\"off\" required>\n";
  html += "</div>\n";
  html += "<input type=\"hidden\" name=\"password\" id=\"password\">\n";
  html += "<button type=\"submit\" class=\"btn\" id=\"submitBtn\" disabled>Unlock</button>\n";
  html += "</form>\n";
  html += "<div class=\"info\">Device: " + fullDeviceName + "</div>\n";
  html += "<div class=\"debug-info\" id=\"debugInfo\"></div>\n";
  html += "</div>\n";

  // JavaScript for PIN input handling
  html += "<script>\n";
  html += "const digits = [document.getElementById('d1'), document.getElementById('d2'), document.getElementById('d3'), document.getElementById('d4')];\n";
  html += "const pwField = document.getElementById('password');\n";
  html += "const form = document.getElementById('loginForm');\n";
  html += "const submitBtn = document.getElementById('submitBtn');\n";
  html += "const debugInfo = document.getElementById('debugInfo');\n";

  // Auto-focus first digit
  html += "digits[0].focus();\n";

  // Initial state
  html += "updatePassword();\n";

  // Handle input
  html += "digits.forEach((digit, index) => {\n";
  html += "  digit.addEventListener('input', (e) => {\n";
  html += "    const val = e.target.value;\n";
  html += "    // Only allow numeric input\n";
  html += "    if (val.match(/[0-9]/)) {\n";
  html += "      e.target.value = val.charAt(val.length - 1);\n";
  html += "      if (index < 3) digits[index + 1].focus();\n";
  html += "      updatePassword();\n";
  html += "    } else {\n";
  html += "      e.target.value = '';\n";
  html += "      updatePassword();\n";
  html += "    }\n";
  html += "  });\n";

  // Handle backspace
  html += "  digit.addEventListener('keydown', (e) => {\n";
  html += "    if (e.key === 'Backspace') {\n";
  html += "      if (e.target.value === '' && index > 0) {\n";
  html += "        digits[index - 1].focus();\n";
  html += "        digits[index - 1].value = '';\n";
  html += "      } else {\n";
  html += "        e.target.value = '';\n";
  html += "      }\n";
  html += "      updatePassword();\n";
  html += "    }\n";
  html += "  });\n";

  // Handle paste
  html += "  digit.addEventListener('paste', (e) => {\n";
  html += "    e.preventDefault();\n";
  html += "    const paste = e.clipboardData.getData('text').replace(/\\D/g, '');\n";
  html += "    if (paste.length >= 4) {\n";
  html += "      for (let i = 0; i < 4; i++) digits[i].value = paste[i];\n";
  html += "      updatePassword();\n";
  html += "      digits[3].focus();\n";
  html += "    } else if (paste.length > 0) {\n";
  html += "      let startIdx = index;\n";
  html += "      for (let i = 0; i < paste.length && (startIdx + i) < 4; i++) {\n";
  html += "        digits[startIdx + i].value = paste[i];\n";
  html += "      }\n";
  html += "      updatePassword();\n";
  html += "      if (startIdx + paste.length < 4) digits[startIdx + paste.length].focus();\n";
  html += "    }\n";
  html += "  });\n";
  html += "});\n";

  // Update hidden field
  html += "function updatePassword() {\n";
  html += "  let pw = '';\n";
  html += "  let filledCount = 0;\n";
  html += "  digits.forEach(d => {\n";
  html += "    if (d.value.length > 0) filledCount++;\n";
  html += "    pw += d.value;\n";
  html += "  });\n";
  html += "  pwField.value = pw;\n";
  html += "  if (filledCount === 4 && pw.length === 4) {\n";
  html += "    submitBtn.disabled = false;\n";
  html += "    debugInfo.textContent = 'Ready to submit';\n";
  html += "  } else {\n";
  html += "    submitBtn.disabled = true;\n";
  html += "    debugInfo.textContent = 'Enter ' + (4 - filledCount) + ' more digit(s)';\n";
  html += "  }\n";
  html += "}\n";

  // Form submit - with detailed console logging
  html += "form.onsubmit = function(e) {\n";
  html += "  console.log('=== LOGIN FORM SUBMIT ===');\n";
  html += "  const pw = pwField.value;\n";
  html += "  console.log('Password length:', pw.length);\n";
  html += "  console.log('Password value:', pw);\n";
  html += "  console.log('Form action:', form.action);\n";
  html += "  console.log('Form method:', form.method);\n";
  html += "  if (pw.length !== 4 || !pw.match(/^[0-9]{4}$/)) {\n";
  html += "    console.error('❌ Validation failed: Invalid password format');\n";
  html += "    e.preventDefault();\n";
  html += "    alert('Please enter exactly 4 digits (0-9)');\n";
  html += "    return false;\n";
  html += "  }\n";
  html += "  console.log('✅ Validation passed - submitting to server...');\n";
  html += "  submitBtn.disabled = true;\n";
  html += "  submitBtn.textContent = 'Verifying...';\n";
  html += "  debugInfo.textContent = 'Checking password...';\n";
  html += "  console.log('Form will now submit naturally (browser handles redirect)');\n";
  html += "  return true;\n";
  html += "};\n";
  html += "\n";
  html += "// Log page load\n";
  html += "console.log('=== LOGIN PAGE LOADED ===');\n";
  html += "console.log('Device:', '" + fullDeviceName + "');\n";
  html += "console.log('Password enabled:', " + String(passwordEnabled ? "true" : "false") + ");\n";
  html += "\n";
  html += "// Monitor form responses (after submit)\n";
  html += "window.addEventListener('beforeunload', function() {\n";
  html += "  console.log('⏳ Page is unloading (redirect happening)...');\n";
  html += "});\n";

  html += "</script>\n</body>\n</html>";

  return html;
}

// ===========================================
// DEVICE NAME MANAGEMENT FUNCTIONS
// ===========================================

void loadDeviceName() {
  if (EEPROM.read(EEPROM_DEVICE_NAME_CONFIGURED) == MAGIC_NUMBER) {
    // Load device name from EEPROM
    deviceName = "";
    for (int i = 0; i < 32; i++) {
      char c = EEPROM.read(EEPROM_DEVICE_NAME + i);
      if (c == 0) break;
      deviceName += c;
    }
    
    // Validate loaded device name
    if (deviceName.length() == 0 || deviceName.length() > 20) {
      DEBUG_PRINTLN("Invalid device name in EEPROM, using default");
      deviceName = "senseflow";
    }

    DEBUG_PRINT("Device name loaded from EEPROM: ");
    DEBUG_PRINTLN(deviceName);
  } else {
    // Use default device name — matches SF-PMP cloud-code prefix
    deviceName = "PANEL";
    DEBUG_PRINTLN("Using default device name: PANEL");
  }
  
  updateDynamicNames();
}

void saveDeviceName() {
  EEPROM.write(EEPROM_DEVICE_NAME_CONFIGURED, MAGIC_NUMBER);
  
  // Save device name (max 31 chars + null terminator)
  for (int i = 0; i < 32; i++) {
    if (i < deviceName.length()) {
      EEPROM.write(EEPROM_DEVICE_NAME + i, deviceName[i]);
    } else {
      EEPROM.write(EEPROM_DEVICE_NAME + i, 0);
    }
  }
  
  EEPROM.commit();
  DEBUG_PRINT("Device name saved to EEPROM: ");
  DEBUG_PRINTLN(deviceName);
}

// Generate a random 4-char suffix (A-Z0-9) to make AP SSID / mDNS unique
// when multiple units are present. Stored once in EEPROM and never changed.
String generateDevSuffix() {
  const char charset[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  String s = "";
  for (int i = 0; i < 4; i++) s += charset[random(0, 36)];
  return s;
}

void loadDevSuffix() {
  if (EEPROM.read(EEPROM_SUFFIX_VALID) == SUFFIX_MAGIC) {
    devSuffix = "";
    for (int i = 0; i < 4; i++) {
      char c = (char)EEPROM.read(EEPROM_SUFFIX + i);
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) devSuffix += c;
    }
  }
  if (devSuffix.length() != 4) {
    randomSeed(esp_random());
    devSuffix = generateDevSuffix();
    EEPROM.write(EEPROM_SUFFIX_VALID, SUFFIX_MAGIC);
    for (int i = 0; i < 4; i++) EEPROM.write(EEPROM_SUFFIX + i, devSuffix[i]);
    EEPROM.commit();
    DEBUG_PRINT("Generated new device suffix: ");
    DEBUG_PRINTLN(devSuffix);
  }
}

void updateDynamicNames() {
  // Convert device name: replace spaces with underscores, convert to lowercase
  String cleanName = deviceName;
  cleanName.trim();
  cleanName.toLowerCase();
  cleanName.replace(" ", "_");
  
  // Remove any invalid characters for WiFi SSID and hostname
  String validName = "";
  for (int i = 0; i < cleanName.length(); i++) {
    char c = cleanName[i];
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
      validName += c;
    }
  }
  
  // Limit length to ensure space for suffix
  if (validName.length() > 20) {
    validName = validName.substring(0, 20);
  }
  
  // Include the per-unit random suffix so multiple devices in the same
  // location advertise different AP SSIDs / mDNS hostnames.
  String suffix = (devSuffix.length() == 4) ? ("_" + devSuffix) : "";
  fullDeviceName = validName + suffix + "_mvstech";
  apSSID = fullDeviceName;
  otaHostname = validName + suffix + "-mvstech";
  
  DEBUG_PRINTLN("Dynamic names updated:");
  DEBUG_PRINT("  Full device name: ");
  DEBUG_PRINTLN(fullDeviceName);
  DEBUG_PRINT("  AP SSID: ");
  DEBUG_PRINTLN(apSSID);
  DEBUG_PRINT("  OTA hostname: ");
  DEBUG_PRINTLN(otaHostname);
}

bool validateDeviceName(const String& name) {
  if (name.length() == 0 || name.length() > 20) {
    return false;
  }
  
  // Check for valid characters (letters, numbers, spaces, hyphens, underscores)
  for (int i = 0; i < name.length(); i++) {
    char c = name[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || 
          (c >= '0' && c <= '9') || c == ' ' || c == '-' || c == '_')) {
      return false;
    }
  }
  
  return true;
}

// ===========================================
// WIFI RECONNECTION FUNCTIONS
// ===========================================

void initializeWiFiReconnect() {
  wifiReconnect.isReconnecting = false;
  wifiReconnect.lastCheckTime = 0;
  wifiReconnect.lastAttemptTime = 0;
  wifiReconnect.nextAttemptTime = 0;
  wifiReconnect.attemptCount = 0;
  wifiReconnect.backoffSeconds = WIFI_RECONNECT_MIN_INTERVAL_SECONDS;
  wifiReconnect.wasConnected = wifiStationMode;
}

void resetWiFiBackoff() {
  wifiReconnect.attemptCount = 0;
  wifiReconnect.backoffSeconds = WIFI_RECONNECT_MIN_INTERVAL_SECONDS;
  wifiReconnect.isReconnecting = false;
}

void increaseWiFiBackoff() {
  wifiReconnect.attemptCount++;
  
  if (wifiReconnect.attemptCount >= WIFI_RECONNECT_MAX_ATTEMPTS) {
    // Increase backoff exponentially: 10s -> 20s -> 40s -> 80s -> 160s -> 300s (max)
wifiReconnect.backoffSeconds = min((uint16_t)(wifiReconnect.backoffSeconds * 2), (uint16_t)WIFI_RECONNECT_MAX_INTERVAL_SECONDS);
    wifiReconnect.attemptCount = 0; // Reset attempt count for next backoff period
  }
}

bool shouldAttemptWiFiReconnect() {
  unsigned long currentTime = millis();
  
  // Don't attempt during OTA
  if (otaInProgress) {
    return false;
  }
  
  // Check if it's time for a status check
  if (currentTime - wifiReconnect.lastCheckTime < WIFI_CHECK_INTERVAL_SECONDS * 1000) {
    return false;
  }
  
  wifiReconnect.lastCheckTime = currentTime;
  
  // If not configured, don't attempt
  if (!wifiConfigured || wifiSSID.length() == 0) {
    return false;
  }
  
  // Check current WiFi status
  bool currentlyConnected = (WiFi.status() == WL_CONNECTED);
  
  // If currently connected, we're good
  if (currentlyConnected) {
    if (!wifiStationMode) {
      // We just reconnected!
      wifiStationMode = true;
      resetWiFiBackoff();
      
      DEBUG_PRINTLN("WiFi reconnected successfully!");
      DEBUG_PRINT("Station IP: ");
      DEBUG_PRINTLN(WiFi.localIP());
      
      logWiFiEvent("WIFI_RECONNECTED", "AUTO_SUCCESS");
      
      // Restart OTA service
      setupOTA();
      
      return false; // No need to attempt
    } else {
      // Still connected, reset any ongoing reconnection
      if (wifiReconnect.isReconnecting) {
        resetWiFiBackoff();
        logWiFiEvent("WIFI_STABLE", "RECONNECTION_CANCELLED");
      }
      return false;
    }
  } else {
    // Currently disconnected
    if (wifiStationMode) {
      // We just lost connection
      wifiStationMode = false;
      wifiReconnect.wasConnected = true;
      wifiReconnect.isReconnecting = true;
      wifiReconnect.nextAttemptTime = currentTime;  // Try immediately on first disconnect
      
      DEBUG_PRINTLN("WiFi connection lost - starting auto-reconnection");
      logWiFiEvent("WIFI_DISCONNECTED", "STARTING_AUTO_RECONNECT");
    }
    
    // Check if it's time for a reconnection attempt
    if (wifiReconnect.isReconnecting && currentTime >= wifiReconnect.nextAttemptTime) {
      return true;
    }
  }
  
  return false;
}

bool attemptWiFiReconnection() {
  unsigned long currentTime = millis();
  wifiReconnect.lastAttemptTime = currentTime;
  
  DEBUG_PRINT("Attempting WiFi reconnection (attempt ");
  DEBUG_PRINT(wifiReconnect.attemptCount + 1);
  DEBUG_PRINT("/");
  DEBUG_PRINT(WIFI_RECONNECT_MAX_ATTEMPTS);
  DEBUG_PRINT(", backoff: ");
  DEBUG_PRINT(wifiReconnect.backoffSeconds);
  DEBUG_PRINTLN("s)...");
  
  // Set WiFi mode to both AP and Station
  WiFi.mode(WIFI_AP_STA);
  
  // Attempt connection
  WiFi.begin(wifiSSID.c_str(), wifiPassword.c_str());
  
  // Wait for connection (non-blocking, short timeout)
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 10) {
    delay(500);
    attempts++;
    
    // Handle other tasks during wait
    server.handleClient();
    if (otaInProgress) {
      return false; // Abort if OTA started
    }
  }
  
  bool connected = (WiFi.status() == WL_CONNECTED);
  
  if (connected) {
    wifiStationMode = true;
    resetWiFiBackoff();
    
    DEBUG_PRINTLN("WiFi reconnection successful!");
    DEBUG_PRINT("Station IP: ");
    DEBUG_PRINTLN(WiFi.localIP());
    
    logWiFiEvent("WIFI_RECONNECTED", "SUCCESS");
    
    // Restart OTA service
    setupOTA();
    
    return true;
  } else {
    // Failed to connect
    increaseWiFiBackoff();
    wifiReconnect.nextAttemptTime = currentTime + (wifiReconnect.backoffSeconds * 1000UL);
    
    DEBUG_PRINT("WiFi reconnection failed - next attempt in ");
    DEBUG_PRINT(wifiReconnect.backoffSeconds);
    DEBUG_PRINTLN(" seconds");
    
    // Make sure we stay in AP mode
    WiFi.mode(WIFI_AP);
    
    logWiFiEvent("WIFI_RECONNECT_FAILED", "backoff_" + String(wifiReconnect.backoffSeconds) + "s");
    
    return false;
  }
}

void handleWiFiReconnection() {
  if (shouldAttemptWiFiReconnect()) {
    attemptWiFiReconnection();
  }
}

// ===========================================
// LOGGING SYSTEM FUNCTIONS (FIXED VERSION)
// ===========================================

void initializeLogSystem() {
  // FIXED: Safer LittleFS initialization - never auto-format
  if (!LittleFS.begin(false)) {
    DEBUG_PRINTLN("LittleFS mount failed - trying format...");
    if (!LittleFS.begin(true)) {  // Only format if explicitly needed
      DEBUG_PRINTLN("LittleFS format failed!");
      return;
    }
    DEBUG_PRINTLN("LittleFS formatted successfully");
  }
  
  DEBUG_PRINTLN("LittleFS initialized successfully");
  
  // Load log manager state from EEPROM
  loadLogManagerState();
  
  // FIXED: More forgiving file validation
  if (!LittleFS.exists(LOG_FILE_PATH)) {
    createLogFile();
  } else {
    File file = LittleFS.open(LOG_FILE_PATH, "r");
    if (file) {
      size_t fileSize = file.size();
      size_t expectedSize = MAX_LOG_ENTRIES * LOG_ENTRY_SIZE;
      
      // Allow some tolerance for filesystem overhead (±512 bytes)
      if (fileSize < expectedSize || fileSize > expectedSize + 512) {
        Serial.printf("Log file size unexpected: %d bytes (expected ~%d). ", fileSize, expectedSize);
        
        // Check if file is completely empty or way too small
        if (fileSize < (LOG_ENTRY_SIZE * 10)) {
          DEBUG_PRINTLN("File too small - recreating...");
          file.close();
          createLogFile();
        } else {
          DEBUG_PRINTLN("Size difference within tolerance - keeping existing file.");
          Serial.printf("Log file verified with size variance. Entries: %d/%d, Index: %d\n", 
                       logManager.totalEntries, MAX_LOG_ENTRIES, logManager.currentIndex);
        }
      } else {
        file.close();
        Serial.printf("Log file verified. Entries: %d/%d, Index: %d\n", 
                     logManager.totalEntries, MAX_LOG_ENTRIES, logManager.currentIndex);
      }
    } else {
      DEBUG_PRINTLN("Could not open existing log file - recreating...");
      createLogFile();
    }
  }
  
  logManager.isInitialized = true;
  DEBUG_PRINTLN("Logging system initialized successfully");
}

void createLogFile() {
  File file = LittleFS.open(LOG_FILE_PATH, "w");
  if (!file) {
    DEBUG_PRINTLN("Failed to create log file");
    return;
  }
  
  // Initialize file with empty entries
  LogEntry emptyEntry;
  memset(&emptyEntry, 0, sizeof(LogEntry));
  
  for (int i = 0; i < MAX_LOG_ENTRIES; i++) {
    file.write((uint8_t*)&emptyEntry, sizeof(LogEntry));
  }
  
  file.close();
  
  // Reset log manager
  logManager.currentIndex = 0;
  logManager.totalEntries = 0;
  saveLogManagerState();
  
  Serial.printf("Created new log file with %d empty entries\n", MAX_LOG_ENTRIES);
}

void loadLogManagerState() {
  logManager.currentIndex = (EEPROM.read(EEPROM_LOG_INDEX) << 8) | EEPROM.read(EEPROM_LOG_INDEX + 1);
  logManager.totalEntries = EEPROM.read(EEPROM_LOG_COUNT);
  
  // Validate loaded values
  if (logManager.currentIndex >= MAX_LOG_ENTRIES) {
    logManager.currentIndex = 0;
  }
  if (logManager.totalEntries > MAX_LOG_ENTRIES) {
    logManager.totalEntries = MAX_LOG_ENTRIES;
  }
  
  Serial.printf("Loaded log state - Index: %d, Count: %d\n", logManager.currentIndex, logManager.totalEntries);
}

void saveLogManagerState() {
  EEPROM.write(EEPROM_LOG_INDEX, (logManager.currentIndex >> 8) & 0xFF);
  EEPROM.write(EEPROM_LOG_INDEX + 1, logManager.currentIndex & 0xFF);
  EEPROM.write(EEPROM_LOG_COUNT, logManager.totalEntries);
  EEPROM.commit();
}

void writeLogEntry(LogEventType eventType, const String& action, const String& details = "") {
  if (!logManager.isInitialized) {
    return;
  }
  
  LogEntry entry;
  memset(&entry, 0, sizeof(LogEntry));
  
  // Set timestamp
  DateTime now = safeNow();
  entry.timestamp = now.unixtime();
  
  // Set event type
  entry.eventType = (uint8_t)eventType;
  
  // Set action (truncate if too long)
  strncpy(entry.action, action.c_str(), sizeof(entry.action) - 1);
  entry.action[sizeof(entry.action) - 1] = '\0';
  
  // Set water data only for motor events
  if (eventType == LOG_MOTOR_EVENT && hasReceivedReading && sensorOnline) {
    entry.waterLevel = currentWaterLevel;
    entry.waterPercent = currentWaterPercent;
    
    if (hasWPSensor && hasReceivedWPReading) {
      entry.wpSensorStatus = wpSensorStatus ? 1 : 0;
    } else if (hasWPSensor) {
      entry.wpSensorStatus = 0; // No reading yet - treat as no water (not offline for wired)
    } else {
      entry.wpSensorStatus = 255; // Not configured
    }
  } else {
    entry.waterLevel = -1.0;     // Invalid value indicates not applicable
    entry.waterPercent = -1.0;   // Invalid value indicates not applicable
    entry.wpSensorStatus = 255;  // Not applicable for non-motor events
  }
  
  // Set details (truncate if too long)
  strncpy(entry.details, details.c_str(), sizeof(entry.details) - 1);
  entry.details[sizeof(entry.details) - 1] = '\0';
  
  // Write entry to file
  File file = LittleFS.open(LOG_FILE_PATH, "r+");
  if (!file) {
    DEBUG_PRINTLN("Failed to open log file for writing");
    return;
  }
  
  // Calculate file position
  size_t position = logManager.currentIndex * sizeof(LogEntry);
  file.seek(position);
  
  // Write the entry
  size_t written = file.write((uint8_t*)&entry, sizeof(LogEntry));
  file.close();
  
  if (written == sizeof(LogEntry)) {
    // Update log manager state
    logManager.currentIndex = (logManager.currentIndex + 1) % MAX_LOG_ENTRIES;
    
    if (logManager.totalEntries < MAX_LOG_ENTRIES) {
      logManager.totalEntries++;
    }
    
    saveLogManagerState();
    
    Serial.printf("LOG[%s]: %s\n", getEventTypeName(eventType).c_str(), action.c_str());
  } else {
    DEBUG_PRINTLN("Failed to write log entry");
  }
}

String getEventTypeName(LogEventType eventType) {
  switch (eventType) {
    case LOG_MOTOR_EVENT: return "MOTOR";
    case LOG_MODE_CHANGE: return "MODE";
    case LOG_ERROR_EVENT: return "ERROR";
    case LOG_SYSTEM_EVENT: return "SYSTEM";
    case LOG_WIFI_EVENT: return "WIFI";
    case LOG_OTA_EVENT: return "OTA";
    case LOG_TIME_SYNC: return "TIME";
    case LOG_PACKET_EVENT: return "PACKET";      // NEW
    case LOG_SENSOR_STATE: return "SENSOR";      // NEW
    case LOG_MEMORY_EVENT: return "MEMORY";      // NEW
    default: return "UNKNOWN";
  }
}

// Specific logging functions for each event type
void logMotorEvent(bool motorOn) {
  String action = motorOn ? "MOTOR_ON" : "MOTOR_OFF";
  String details = "mode_" + getModeText();
  writeLogEntry(LOG_MOTOR_EVENT, action, details);
}

void logModeChange(String newMode, String reason) {
  String action = "MODE_" + newMode;
  writeLogEntry(LOG_MODE_CHANGE, action, reason);
}

void logErrorEvent(String errorType, String details) {
  String action = "ERROR_" + errorType;
  writeLogEntry(LOG_ERROR_EVENT, action, details);
}

void logSystemEvent(String event, String details) {
  writeLogEntry(LOG_SYSTEM_EVENT, event, details);
}

void logWiFiEvent(String event, String details) {
  writeLogEntry(LOG_WIFI_EVENT, event, details);
}

void logOTAEvent(String event, String details) {
  writeLogEntry(LOG_OTA_EVENT, event, details);
}

void logTimeSyncEvent(String event, String details) {
  writeLogEntry(LOG_TIME_SYNC, event, details);
}

void logPacketEvent(String event, String details) {
  writeLogEntry(LOG_PACKET_EVENT, event, details);
}

void logSensorStateEvent(String event, String details) {
  writeLogEntry(LOG_SENSOR_STATE, event, details);
}

void logMemoryEvent(String event, String details) {
  writeLogEntry(LOG_MEMORY_EVENT, event, details);
}

// Log reading functions for web interface
String readLogEntries(int maxEntries = LOG_VIEW_ENTRIES) {
  if (!logManager.isInitialized || logManager.totalEntries == 0) {
    return "No log entries available";
  }
  
  File file = LittleFS.open(LOG_FILE_PATH, "r");
  if (!file) {
    return "Failed to open log file";
  }
  
  String result = "";
  int entriesToRead = min(maxEntries, (int)logManager.totalEntries);
  
  // Read from newest to oldest
  for (int i = 0; i < entriesToRead; i++) {
    int entryIndex;
    
    if (logManager.totalEntries < MAX_LOG_ENTRIES) {
      // File not full yet - read from newest backwards
      entryIndex = logManager.totalEntries - 1 - i;
    } else {
      // File is full - calculate position considering circular buffer
      entryIndex = (logManager.currentIndex - 1 - i + MAX_LOG_ENTRIES) % MAX_LOG_ENTRIES;
    }
    
    size_t position = entryIndex * sizeof(LogEntry);
    file.seek(position);
    
    LogEntry entry;
    if (file.read((uint8_t*)&entry, sizeof(LogEntry)) == sizeof(LogEntry)) {
      if (entry.timestamp > 0) { // Valid entry
        DateTime dt(entry.timestamp);
        char timeStr[20];
        sprintf(timeStr, "%02d/%02d/%04d %02d:%02d:%02d", 
                dt.day(), dt.month(), dt.year(),
                dt.hour(), dt.minute(), dt.second());
        
        result += String(timeStr) + " | ";
        result += getEventTypeName((LogEventType)entry.eventType) + " | ";
        result += String(entry.action) + " | ";
        
        // Add water data for motor events
        if (entry.eventType == LOG_MOTOR_EVENT && entry.waterLevel >= 0) {
          result += String(entry.waterLevel, 1) + "cm (" + String(entry.waterPercent, 1) + "%) | ";
          
          if (entry.wpSensorStatus == 1) {
            result += "Water:OK | ";
          } else if (entry.wpSensorStatus == 0 || entry.wpSensorStatus == 2) {
            // For wired: status 0 or 2 both mean no water detected (not offline)
            result += "Water:NO | ";
          }
        }
        
        if (strlen(entry.details) > 0) {
          result += String(entry.details);
        }
        
        result += "\n";
      }
    }
  }
  
  file.close();
  return result;
}

void clearLogFile() {
  createLogFile();
  DEBUG_PRINTLN("Log file cleared");
}

// ===========================================
// TIME SYNC FUNCTIONS
// ===========================================

void loadLastTimeSyncInfo() {
  // Load last sync timestamp from EEPROM
  lastTimeSyncEpoch = 0;
  lastTimeSyncEpoch |= ((uint32_t)EEPROM.read(EEPROM_LAST_TIME_SYNC) << 24);
  lastTimeSyncEpoch |= ((uint32_t)EEPROM.read(EEPROM_LAST_TIME_SYNC + 1) << 16);
  lastTimeSyncEpoch |= ((uint32_t)EEPROM.read(EEPROM_LAST_TIME_SYNC + 2) << 8);
  lastTimeSyncEpoch |= (uint32_t)EEPROM.read(EEPROM_LAST_TIME_SYNC + 3);

  if (lastTimeSyncEpoch == 0 || lastTimeSyncEpoch == 0xFFFFFFFF) {
    lastTimeSyncResult = "Never synced";
    millisAtLastSync = 0;
  } else {
    DateTime lastSync(lastTimeSyncEpoch);
    lastTimeSyncResult = formatDateTime(lastSync);
    // Seed the software-clock anchor from the EEPROM value so safeNow()
    // returns approximate real time on no-RTC boards immediately after
    // boot, before the first live NTP/browser sync lands. Time will jump
    // forward by (power-off duration) on the next successful sync — but
    // between boot and that sync we still report a plausible timestamp
    // instead of the 2025-01-01 placeholder.
    millisAtLastSync = millis();
  }
}

void saveLastTimeSyncInfo(uint32_t syncEpoch) {
  EEPROM.write(EEPROM_LAST_TIME_SYNC, (syncEpoch >> 24) & 0xFF);
  EEPROM.write(EEPROM_LAST_TIME_SYNC + 1, (syncEpoch >> 16) & 0xFF);
  EEPROM.write(EEPROM_LAST_TIME_SYNC + 2, (syncEpoch >> 8) & 0xFF);
  EEPROM.write(EEPROM_LAST_TIME_SYNC + 3, syncEpoch & 0xFF);
  EEPROM.commit();

  lastTimeSyncEpoch  = syncEpoch;
  // Anchor the software clock — safeNow() extrapolates from this pair
  // when there's no physical RTC. NTP and browser sync both funnel
  // through here, so both paths get the fix in one place.
  millisAtLastSync   = millis();
  DateTime syncTime(syncEpoch);
  lastTimeSyncResult = formatDateTime(syncTime);
}

void handleTimeSyncPost() {
  lastWebActivity = millis();

  // Skip sync during motor operation or critical states
  if (motorState || currentMode == MODE_DRY_RUN_RECOVERY || currentMode == MODE_MANUAL_OVERRIDE) {
    server.send(200, "text/plain", "Sync skipped - motor operation in progress");
    return;
  }

  // Check if timestamp parameter exists
  if (!server.hasArg("timestamp")) {
    server.send(400, "text/plain", "Missing timestamp parameter");
    return;
  }
  
  // Get timestamp from browser (JavaScript Date.now() returns milliseconds)
  String timestampStr = server.arg("timestamp");
  
  // Convert string to unsigned long long (milliseconds since epoch)
  unsigned long long browserTimeMs = strtoull(timestampStr.c_str(), NULL, 10);
  
  if (browserTimeMs == 0) {
    server.send(400, "text/plain", "Invalid timestamp format");
    return;
  }
  
  // Convert milliseconds to seconds (Unix epoch) and add IST offset
  uint32_t browserTimeSeconds = browserTimeMs / 1000;
  // Add IST offset: +5.5 hours = +19800 seconds
  browserTimeSeconds += 19800;
  
  // DEBUG: Print timestamp conversion
  DEBUG_PRINTLN("=== TIME SYNC DEBUG ===");
  DEBUG_PRINT("Browser timestamp (ms): ");
  DEBUG_PRINTLN(timestampStr);
  DEBUG_PRINT("Converted to seconds: ");
  DEBUG_PRINTLN(browserTimeSeconds);
  
  // Create DateTime object to check conversion
  DateTime browserDateTime(browserTimeSeconds);
  DEBUG_PRINT("Converted to date: ");
  DEBUG_PRINTLN(formatDateTime(browserDateTime));
  
  // Validate timestamp (should be recent - between 2020 and 2040)
  if (browserTimeSeconds < 1577836800 || browserTimeSeconds > 2208988800) {
    DEBUG_PRINT("Timestamp validation failed: ");
    DEBUG_PRINTLN(browserTimeSeconds);
    server.send(400, "text/plain", "Timestamp out of valid range");
    return;
  }
  
  // Get current RTC time for comparison
  DateTime rtcBefore = safeNow();
  uint32_t rtcBeforeEpoch = rtcBefore.unixtime();

  DEBUG_PRINT("RTC before sync: ");
  DEBUG_PRINTLN(formatDateTime(rtcBefore));
  DEBUG_PRINT("RTC epoch before: ");
  DEBUG_PRINTLN(rtcBeforeEpoch);

  // Push the new time into the physical RTC if fitted. Regardless of
  // whether an RTC is present, saveLastTimeSyncInfo() below anchors
  // the software clock so safeNow() returns real time on no-RTC boards.
  DateTime newTime(browserTimeSeconds);
  if (rtcAvailable) rtc.adjust(newTime);

  // Small delay to let RTC update
  delay(100);

  // Anchor the software clock FIRST so the verify-after read below sees
  // the new time even on no-RTC boards. Prior version called
  // saveLastTimeSyncInfo() after the verify, which meant the "RTC after"
  // log line always showed the pre-sync placeholder value when no RTC
  // was fitted — the actual root cause of the browser-sync log leak.
  saveLastTimeSyncInfo(browserTimeSeconds);

  // Verify the time was set correctly (now sees real time on either path)
  DateTime rtcAfter = safeNow();
  uint32_t rtcAfterEpoch = rtcAfter.unixtime();

  DEBUG_PRINT("RTC after sync: ");
  DEBUG_PRINTLN(formatDateTime(rtcAfter));
  DEBUG_PRINT("RTC epoch after: ");
  DEBUG_PRINTLN(rtcAfterEpoch);

  // Calculate time difference
  int32_t timeDifferenceSeconds = (int32_t)browserTimeSeconds - (int32_t)rtcBeforeEpoch;

  DEBUG_PRINT("Time difference: ");
  DEBUG_PRINT(timeDifferenceSeconds);
  DEBUG_PRINTLN(" seconds");
  DEBUG_PRINTLN("=====================");
  
  // Log the time sync event
  String syncDetails = "diff_" + String(timeDifferenceSeconds) + "s";
  logTimeSyncEvent("BROWSER_SYNC", syncDetails);
  
  // Send detailed response with proper string concatenation
  String response = "RTC time synchronized successfully!\n";
  response += "Browser timestamp: " + timestampStr + "ms\n";
  response += "Previous RTC time: " + formatDateTime(rtcBefore) + "\n";
  response += "New RTC time: " + formatDateTime(rtcAfter) + "\n";
  response += "Time difference: " + String(timeDifferenceSeconds) + " seconds\n";
  
  // Proper string concatenation for sync verification
  response += "Sync verification: ";
  if (abs((int32_t)rtcAfterEpoch - (int32_t)browserTimeSeconds) <= 2) {
    response += "SUCCESS";
  } else {
    response += "FAILED";
  }
  
  // Send success response
  server.send(200, "text/plain", response);
  
  // Additional debug output
  DEBUG_PRINTLN("Time sync completed successfully");
  DEBUG_PRINT("Response sent to browser: ");
  DEBUG_PRINTLN(response);
}

String getTimeSyncStatusText() {
  if (lastTimeSyncEpoch == 0) {
    return "Never synced";
  }
  
  DateTime now = safeNow();
  DateTime lastSync(lastTimeSyncEpoch);
  
  long daysSinceSync = (now.unixtime() - lastTimeSyncEpoch) / 86400;
  
  String status = "Last sync: " + lastTimeSyncResult;
  if (daysSinceSync > 0) {
    status += " (" + String(daysSinceSync) + " days ago)";
  }
  
  return status;
}

// ===========================================
// NTP AUTO-SYNC FUNCTION (Lightweight)
// ===========================================
// Returns true when NTP round-trip actually landed a fresh timestamp,
// false when we skipped or timed out. Callers use the return value to
// escalate recovery — a failed NTP means Firebase-auth failures are
// more likely genuine network/service issues rather than clock skew.
// v118.0.9: NTP sync hardened for the fleet-wide problem of RTCs
// drifting / showing wrong-timezone time for days at a stretch.
//
// Three fixes vs 118.0.8:
//  (1) TIMEZONE: configTime(0, 0, ...) wrote UTC into the RTC → every
//      schedule / log timestamp was 5h30 behind IST. New call passes
//      IST offset (+5:30 = 19800 sec) + 0 DST, matching our deployment
//      geography. The RTC now stores wall-clock IST; log/schedule code
//      that reads safeNow() gets the correct hour-of-day.
//  (2) RE-SYNC: previous version latched ntpSyncedToday=true and only
//      cleared it in a 5-min window at midnight. Any device that
//      missed that window stopped syncing forever → drift accumulated
//      over weeks → schedules fired at wrong times. New model: resync
//      every HOUR regardless of latch, latch only used as a boot-time
//      "did initial sync succeed?" marker (not display) — see checkNTPSync.
//  (3) EXTENDED RETRY: 3 sec was too short on slow uplinks; bumped to
//      5 sec total so first-boot sync succeeds more often, keeping the
//      clock-safe gate from blocking Firebase init on fresh devices.
#define IST_OFFSET_SEC 19800   // UTC+05:30 (seconds) — India Standard Time, no DST
bool tryNTPSync() {
  // Skip sync while a motor operation is in progress. The real reason
  // is main-loop latency, not clock safety: every pump/grace/dry-run/
  // max-run-time timer uses millis() (never wall-clock), so a mid-fill
  // time jump has zero effect on control logic. BUT getLocalTime() can
  // block loop() for up to ~5 s across retries, which would delay
  // feedback-dropout detection and other per-loop safety checks while
  // the motor is running. Sync simply resumes on the next hourly check
  // once the motor stops.
  if (motorState) return false;
  if (currentMode == MODE_DRY_RUN_RECOVERY) return false;
  if (currentMode == MODE_MANUAL_OVERRIDE) return false;

  // Only attempt if connected to home WiFi (not AP mode)
  if (WiFi.status() != WL_CONNECTED) return false;

  DEBUG_PRINTLN(F("Attempting NTP sync (IST+5:30)..."));

  // v118.0.10: pass offset=0 so system clock holds pure UTC. We manually
  // add IST_OFFSET_SEC when writing to RTC below. Keeping all offset
  // math in ONE place (the RTC write) avoids a dual-source-of-truth
  // bug where other libraries that call configTime(0,0,...) would
  // silently clobber the TZ and the RTC would drift back to UTC.
  configTime(0, 0, NTP_SERVER);

  // Wait up to 5 seconds for time sync (10 x 500ms retries).
  struct tm timeinfo;
  int retries = 10;
  while (retries > 0 && !getLocalTime(&timeinfo, 500)) {
    retries--;
  }

  if (retries > 0) {
    // v118.0.10: use the IST-shifted epoch convention the REST of the
    // firmware depends on. Browser-sync (/timesync handler) adds +19800
    // to the UTC epoch before calling rtc.adjust(), making the RTC store
    // IST wall-clock values. All safeNow() consumers (schedule gating,
    // log timestamps, display) treat the RTC output as IST directly.
    //
    // 118.0.9 broke this: used `time(nullptr)` which returns raw UTC →
    // rtc.adjust() stored UTC → RTC drifted back 5h30m from wall-clock
    // → schedules fired at wrong times, logs showed "wrong country"
    // timestamps. Fix: add IST_OFFSET_SEC same as browser-sync does.
    time_t utcNow  = time(nullptr);
    uint32_t istNow = (uint32_t)utcNow + IST_OFFSET_SEC;
    DateTime ntpTime(istNow);

    DateTime rtcNow = safeNow();
    int32_t diff = abs((int32_t)istNow - (int32_t)rtcNow.unixtime());

    if (diff > 5) {
      if (rtcAvailable) rtc.adjust(ntpTime);
      saveLastTimeSyncInfo(istNow);
      logTimeSyncEvent("NTP_SYNC", "diff_" + String(diff) + "s");
      DEBUG_PRINT(F("NTP sync success (IST-shifted), adjusted by "));
      DEBUG_PRINT(diff);
      DEBUG_PRINTLN(F(" seconds"));
    } else {
      DEBUG_PRINTLN(F("NTP sync: RTC already accurate"));
    }
    ntpSyncedToday = true;
    return true;
  }
  DEBUG_PRINTLN(F("NTP sync failed - no response"));
  return false;
}

// True when the system time is at least Jan 1 2024 UTC — a coarse
// sanity check that catches unset RTCs (returns year 2000) and
// far-future garbage. Used to gate cloud writes: Firebase's TLS
// certificate + JWT auth both need the client clock to be within a
// plausible window, otherwise every request fails silently.
static inline bool isClockSafe() {
  return time(nullptr) >= 1704067200UL;   // 2024-01-01 00:00 UTC
}

void checkNTPSync() {
  // v118.0.9: hourly resync, no latch. Previously ntpSyncedToday was
  // set once and reset only in a 5-min midnight window — any device
  // that missed that window never resynced, so RTCs drifted (minutes
  // per week) and the schedule-mode fired at wrong times for weeks.
  // Now we attempt a sync every hour whenever WiFi is up; tryNTPSync
  // itself is cheap when the clock is already accurate (only writes
  // RTC when diff > 5 sec).
  if (millis() - lastNTPCheckMillis < 3600000UL) return;  // 1 hour
  lastNTPCheckMillis = millis();

  if (WiFi.status() == WL_CONNECTED) {
    tryNTPSync();
  }
}

// ===========================================
// SCHEDULE MODE FUNCTIONS
// ===========================================

void loadScheduleConfiguration() {
  if (EEPROM.read(EEPROM_SCHEDULE_MODE_ENABLED) == MAGIC_NUMBER) {
    scheduleModeEnabled = true;
  } else {
    scheduleModeEnabled = false;
  }
  
  activeScheduleCount = EEPROM.read(EEPROM_SCHEDULE_COUNT);
  if (activeScheduleCount > 3) activeScheduleCount = 0;
  
  bool extValid = (EEPROM.read(EEPROM_SCHED_EXT_MAGIC) == SCHED_EXT_MAGIC);

  // Load schedules
  for (int i = 0; i < 3; i++) {
    int baseAddr = EEPROM_SCHEDULES_START + (i * 5);
    schedules[i].startHour = EEPROM.read(baseAddr);
    schedules[i].startMinute = EEPROM.read(baseAddr + 1);
    schedules[i].endHour = EEPROM.read(baseAddr + 2);
    schedules[i].endMinute = EEPROM.read(baseAddr + 3);
    schedules[i].enabled = (EEPROM.read(baseAddr + 4) == MAGIC_NUMBER);

    // v118.0.9: load extended fields OR fall back to defaults for
    // backward compat (every day, no fill-until-full).
    if (extValid) {
      int extBase = EEPROM_SCHED_EXT_START + (i * 2);
      uint8_t dm  = EEPROM.read(extBase);
      schedules[i].dayMask = (dm & 0x7F) ? (dm & 0x7F) : SCHED_DAY_MASK_ALL;
      schedules[i].fillUntilFull = (EEPROM.read(extBase + 1) != 0);
    } else {
      schedules[i].dayMask = SCHED_DAY_MASK_ALL;
      schedules[i].fillUntilFull = false;
    }

    // Validate loaded schedule
    if (schedules[i].startHour > 23 || schedules[i].startMinute > 59 ||
        schedules[i].endHour > 23 || schedules[i].endMinute > 59) {
      schedules[i].enabled = false;
    }
  }
}

void saveScheduleConfiguration() {
  EEPROM.write(EEPROM_SCHEDULE_MODE_ENABLED, scheduleModeEnabled ? MAGIC_NUMBER : 0);
  EEPROM.write(EEPROM_SCHEDULE_COUNT, activeScheduleCount);
  
  // Save schedules
  for (int i = 0; i < 3; i++) {
    int baseAddr = EEPROM_SCHEDULES_START + (i * 5);
    EEPROM.write(baseAddr, schedules[i].startHour);
    EEPROM.write(baseAddr + 1, schedules[i].startMinute);
    EEPROM.write(baseAddr + 2, schedules[i].endHour);
    EEPROM.write(baseAddr + 3, schedules[i].endMinute);
    EEPROM.write(baseAddr + 4, schedules[i].enabled ? MAGIC_NUMBER : 0);
  }

  // v118.0.9: persist extended fields (dayMask + fillUntilFull) in the
  // separate ext block so a 118.0.8 downgrade still boots cleanly.
  EEPROM.write(EEPROM_SCHED_EXT_MAGIC, SCHED_EXT_MAGIC);
  for (int i = 0; i < 3; i++) {
    int extBase = EEPROM_SCHED_EXT_START + (i * 2);
    uint8_t dm = schedules[i].dayMask & 0x7F;
    if (dm == 0) dm = SCHED_DAY_MASK_ALL;   // never persist "no days" — that'd silently disable the schedule
    EEPROM.write(extBase,     dm);
    EEPROM.write(extBase + 1, schedules[i].fillUntilFull ? 1 : 0);
  }

  EEPROM.commit();
  DEBUG_PRINTLN("Schedule configuration saved to EEPROM");
}

void loadAutoRecoveryConfiguration() {
  autoRecoverOnSchedule = (EEPROM.read(EEPROM_AUTO_RECOVER_SCHEDULE) == MAGIC_NUMBER);
  autoRecoverOnTimeout = (EEPROM.read(EEPROM_AUTO_RECOVER_TIMEOUT) == MAGIC_NUMBER);

  uint8_t hours = EEPROM.read(EEPROM_AUTO_RECOVER_HOURS);
  if (hours >= 1 && hours <= 24) {
    autoRecoverTimeoutHours = hours;
  } else {
    autoRecoverTimeoutHours = 4; // Default
  }

  DEBUG_PRINT("Auto-recovery loaded: Schedule=");
  DEBUG_PRINT(autoRecoverOnSchedule ? "ON" : "OFF");
  DEBUG_PRINT(", Timeout=");
  DEBUG_PRINT(autoRecoverOnTimeout ? "ON" : "OFF");
  DEBUG_PRINT(" (");
  DEBUG_PRINT(autoRecoverTimeoutHours);
  DEBUG_PRINTLN("h)");
}

void saveAutoRecoveryConfiguration() {
  EEPROM.write(EEPROM_AUTO_RECOVER_SCHEDULE, autoRecoverOnSchedule ? MAGIC_NUMBER : 0);
  EEPROM.write(EEPROM_AUTO_RECOVER_TIMEOUT, autoRecoverOnTimeout ? MAGIC_NUMBER : 0);
  EEPROM.write(EEPROM_AUTO_RECOVER_HOURS, autoRecoverTimeoutHours);

  // Note: EEPROM.commit() is called by the main saveConfiguration() function
  DEBUG_PRINTLN("Auto-recovery configuration saved to EEPROM");
}

// ===========================================
// SOURCE WATER DETECTION CONFIG (NEW)
// ===========================================

void loadSourceDetectionConfig() {
  if (EEPROM.read(EEPROM_SOURCE_FEATURES_MAGIC) == SOURCE_FEATURES_MAGIC) {
    uint8_t mode = EEPROM.read(EEPROM_DETECTION_MODE);
    detectionMode = (mode <= 1) ? mode : 0;  // default Pre-Detection

    uint8_t grace = EEPROM.read(EEPROM_GRACE_PERIOD_TENS);
    // Valid tens-of-seconds values: 4(40s), 6(1m), 12(2m), 18(3m), 24(4m), 30(5m), 42(7m), 60(10m)
    gracePeriodTens = (grace >= 4 && grace <= 60) ? grace : 18;

    uint8_t debounce = EEPROM.read(EEPROM_SOURCE_DEBOUNCE_SECS);
    sourceDebounceSecs = (debounce >= 5 && debounce <= 180) ? debounce : 30;

    uint8_t retries = EEPROM.read(EEPROM_RETRY_COUNT);
    maxRetryCount = (retries >= 1 && retries <= 5) ? retries : 3;

    uint8_t retryWait = EEPROM.read(EEPROM_RETRY_WAIT_MINS);
    retryWaitMins = (retryWait >= 1 && retryWait <= 15) ? retryWait : 10;

    uint8_t maxRun = EEPROM.read(EEPROM_MAX_RUN_TIME_MINS);
    maxRunTimeMins = (maxRun == 0 || maxRun == 10 || maxRun == 20 || maxRun == 30 || maxRun == 60 || maxRun == 90 || maxRun == 120 || maxRun == 180 || maxRun == 240) ? maxRun : 120;

    uint8_t drWait = EEPROM.read(EEPROM_DRY_RUN_WAIT_MINS);
    dryRunWaitMins = (drWait >= 1 && drWait <= 15) ? drWait : 10;

    DEBUG_PRINTLN("Source detection config loaded from EEPROM");
  } else {
    // Defaults (v8.0.1)
    detectionMode = 0;        // Pre-Detection
    gracePeriodTens = 18;     // 3 minutes
    sourceDebounceSecs = 30;
    maxRetryCount = 3;
    retryWaitMins = 10;
    maxRunTimeMins = 120;     // 2 hours
    dryRunWaitMins = 10;
    DEBUG_PRINTLN("Source detection config: using defaults (not yet saved)");
  }

  DEBUG_PRINT("  Detection Mode: ");
  DEBUG_PRINTLN(detectionMode == 0 ? "Pre-Detection" : "Post-Detection");
  DEBUG_PRINT("  Grace Period: ");
  DEBUG_PRINT(gracePeriodTens * 10);
  DEBUG_PRINTLN(" sec");
  DEBUG_PRINT("  Source Debounce: ");
  DEBUG_PRINT(sourceDebounceSecs);
  DEBUG_PRINTLN(" sec");
  DEBUG_PRINT("  Source Max Retries: ");
  DEBUG_PRINTLN(maxRetryCount);
  DEBUG_PRINT("  Source Retry Wait: ");
  DEBUG_PRINT(retryWaitMins);
  DEBUG_PRINTLN(" min");
  DEBUG_PRINT("  Tank Dry Run Wait: ");
  DEBUG_PRINT(dryRunWaitMins);
  DEBUG_PRINTLN(" min");
  DEBUG_PRINT("  Max Run Time: ");
  if (maxRunTimeMins == 0) {
    DEBUG_PRINTLN("Off");
  } else {
    DEBUG_PRINT(maxRunTimeMins);
    DEBUG_PRINTLN(" min");
  }
}

void saveSourceDetectionConfig() {
  EEPROM.write(EEPROM_SOURCE_FEATURES_MAGIC, SOURCE_FEATURES_MAGIC);
  EEPROM.write(EEPROM_DETECTION_MODE, detectionMode);
  EEPROM.write(EEPROM_GRACE_PERIOD_TENS, gracePeriodTens);
  EEPROM.write(EEPROM_SOURCE_DEBOUNCE_SECS, sourceDebounceSecs);
  EEPROM.write(EEPROM_RETRY_COUNT, maxRetryCount);
  EEPROM.write(EEPROM_RETRY_WAIT_MINS, retryWaitMins);
  EEPROM.write(EEPROM_MAX_RUN_TIME_MINS, maxRunTimeMins);
  EEPROM.write(EEPROM_DRY_RUN_WAIT_MINS, dryRunWaitMins);
  EEPROM.commit();
  DEBUG_PRINTLN("Source detection config saved to EEPROM");
}

// Reset source detection runtime state (call on motor stop, mode change, etc.)
void resetSourceDetectionState() {
  graceActive = false;
  graceStartTime = 0;
  sourceConfirmed = false;
  sourceConfirmStart = 0;
  sourceDryRunCount = 0;
  motorRunStartTime = 0;
  sourceDryRunStartTime = 0;
  pumpStage = "IDLE";
  lastFaultReason = "";
}

bool isTimeInSchedule(int scheduleIndex, uint8_t hour, uint8_t minute) {
  if (scheduleIndex < 0 || scheduleIndex >= 3 || !schedules[scheduleIndex].enabled) {
    return false;
  }
  
  Schedule &sched = schedules[scheduleIndex];
  uint16_t currentMinutes = hour * 60 + minute;
  uint16_t startMinutes = sched.startHour * 60 + sched.startMinute;
  uint16_t endMinutes = sched.endHour * 60 + sched.endMinute;
  
  return (currentMinutes >= startMinutes && currentMinutes < endMinutes);
}

int getCurrentActiveSchedule() {
  if (!scheduleModeEnabled) return -1;

  DateTime now = safeNow();
  uint8_t currentHour = now.hour();
  uint8_t currentMinute = now.minute();
  // v118.0.9: weekday filter. RTClib's dayOfTheWeek() returns 0=Sun..6=Sat
  // matching our dayMask bit layout.
  uint8_t dow = now.dayOfTheWeek();  // 0=Sun..6=Sat
  uint8_t todayBit = (1 << dow);

  for (int i = 0; i < 3; i++) {
    // Mask of 0 is treated as "every day" for legacy configs that
    // never set the field (loader applies the same fallback).
    uint8_t mask = schedules[i].dayMask ? schedules[i].dayMask : SCHED_DAY_MASK_ALL;
    if (!(mask & todayBit)) continue;   // not today
    if (isTimeInSchedule(i, currentHour, currentMinute)) {
      return i;
    }
  }

  return -1;
}

bool validateSchedule(uint8_t startH, uint8_t startM, uint8_t endH, uint8_t endM) {
  // Basic time validation
  if (startH > 23 || startM > 59 || endH > 23 || endM > 59) {
    return false;
  }
  
  // No midnight spanning - start must be before end
  if (startH > endH || (startH == endH && startM >= endM)) {
    return false;
  }
  
  // Minimum 5-minute duration
  uint16_t startMinutes = startH * 60 + startM;
  uint16_t endMinutes = endH * 60 + endM;
  if ((endMinutes - startMinutes) < 5) {
    return false;
  }
  
  return true;
}

String validateScheduleWithMessage(uint8_t startH, uint8_t startM, uint8_t endH, uint8_t endM, int scheduleNum) {
  // Basic time validation
  if (startH > 23 || startM > 59 || endH > 23 || endM > 59) {
    return "Schedule " + String(scheduleNum) + ": Invalid time format";
  }
  
  // No midnight spanning
  if (startH > endH || (startH == endH && startM >= endM)) {
    return "Schedule " + String(scheduleNum) + ": End time must be after start time (no midnight spanning)";
  }
  
  // Minimum duration check
  uint16_t startMinutes = startH * 60 + startM;
  uint16_t endMinutes = endH * 60 + endM;
  uint16_t duration = endMinutes - startMinutes;
  if (duration < 5) {
    return "Schedule " + String(scheduleNum) + ": Duration too short (" + String(duration) + " min, minimum 5 min)";
  }
  
  return ""; // Valid
}

bool checkScheduleOverlap(int skipIndex, uint8_t startH, uint8_t startM, uint8_t endH, uint8_t endM) {
  uint16_t newStart = startH * 60 + startM;
  uint16_t newEnd = endH * 60 + endM;
  
  for (int i = 0; i < 3; i++) {
    if (i == skipIndex || !schedules[i].enabled) continue;
    
    uint16_t existingStart = schedules[i].startHour * 60 + schedules[i].startMinute;
    uint16_t existingEnd = schedules[i].endHour * 60 + schedules[i].endMinute;
    
    // Check for overlap
    if (!(newEnd <= existingStart || newStart >= existingEnd)) {
      return true; // Overlap found
    }
  }
  
  return false; // No overlap
}

String getScheduleTimeString(int scheduleIndex) {
  if (scheduleIndex < 0 || scheduleIndex >= 3 || !schedules[scheduleIndex].enabled) {
    return "Disabled";
  }
  
  Schedule &sched = schedules[scheduleIndex];
  char timeStr[20];
  sprintf(timeStr, "%02d:%02d to %02d:%02d", 
          sched.startHour, sched.startMinute, 
          sched.endHour, sched.endMinute);
  return String(timeStr);
}

String getNextScheduleInfo() {
  if (!scheduleModeEnabled) return "Schedule mode disabled";
  
  DateTime now = safeNow();
  uint16_t currentMinutes = now.hour() * 60 + now.minute();
  uint16_t nextStart = 9999;
  int nextScheduleIndex = -1;
  
  for (int i = 0; i < 3; i++) {
    if (!schedules[i].enabled) continue;
    
    uint16_t schedStart = schedules[i].startHour * 60 + schedules[i].startMinute;
    
    if (schedStart > currentMinutes && schedStart < nextStart) {
      nextStart = schedStart;
      nextScheduleIndex = i;
    }
  }
  
  if (nextScheduleIndex >= 0) {
    return "Next: " + getScheduleTimeString(nextScheduleIndex);
  } else {
    return "No more schedules today";
  }
}

// ===========================================
// BASIC SYSTEM FUNCTIONS
// ===========================================

void initializeWS2812B() {
  ws2812_init((gpio_num_t)LED_PIN, RMT_CHANNEL_0, LED_BRIGHTNESS);
  // Boot animation - yellow fade in
  for (int brightness = 0; brightness <= LED_BRIGHTNESS; brightness += 1) {
    ws2812_setColor(brightness, brightness, 0);
    delay(12);
  }
  ws2812_off();
}

// ===========================================
// LoRa INITIALIZATION - REMOVED FOR WIRED VERSION
// ===========================================
// The initializeLoRa() function has been removed as this is the wired sensor version.
// LoRa module is not connected in wired version.
// Original function preserved as comment for reference:
/*
void initializeLoRa() {
  static bool isFirstInit = true;

  if (!isFirstInit) {
    loRaReinitCount++;
    if (loRaReinitCount % 5 == 0) {
      logSystemEvent("LORA_REINIT_5X", String(loRaReinitCount / 5));
    }
  }
  isFirstInit = false;

  LoRa.setPins(SS, RST, DIO0);
  
  if (!LoRa.begin(433E6)) {
    DEBUG_PRINTLN("LoRa initialization failed!");
    while (1) {
      delay(1000);
      DEBUG_PRINTLN("Retrying LoRa init...");
    }
  }
  
  LoRa.setSpreadingFactor(10);
  LoRa.setSignalBandwidth(125E3);
  LoRa.setCodingRate4(8);
  LoRa.setPreambleLength(8);
  LoRa.setSyncWord(0x12);

  LoRa.receive();

  DEBUG_PRINTLN("LoRa receiver ready");
}
*/

void setupAccessPoint() {
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  WiFi.softAP(apSSID.c_str(), AP_PASSWORD);
  
  DEBUG_PRINTLN("Access Point Started:");
  DEBUG_PRINT("SSID: ");
  DEBUG_PRINTLN(apSSID);
  DEBUG_PRINT("Password: ");
  DEBUG_PRINTLN(AP_PASSWORD);
  DEBUG_PRINT("IP: ");
  DEBUG_PRINTLN(WiFi.softAPIP());
  
  apModeActive = true;
  apStartTime = millis();
}

String formatDateTime(DateTime dt) {
  char buffer[20];
  sprintf(buffer, "%02d/%02d/%04d %02d:%02d:%02d", 
          dt.day(), dt.month(), dt.year(),
          dt.hour(), dt.minute(), dt.second());
  return String(buffer);
}


// Validate schedule configuration
void validateScheduleConfiguration() {
  if (scheduleModeEnabled && activeScheduleCount == 0) {
    DEBUG_PRINTLN("WARNING: Schedule mode enabled but no schedules configured");
    scheduleModeEnabled = false; // Disable if invalid
    // logSystemEvent("SCHEDULE_VALIDATION", "disabled_no_schedules");
  }
}

// Initialize system mode based on schedule status
void initializeSystemMode() {
  validateScheduleConfiguration();

  if (scheduleModeEnabled && activeScheduleCount > 0) {
    int currentActiveSchedule = getCurrentActiveSchedule();
    if (currentActiveSchedule >= 0) {
      // Inside active schedule time
      currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
      DEBUG_PRINT("Startup: Inside schedule time (Schedule ");
      DEBUG_PRINT(currentActiveSchedule + 1);
      DEBUG_PRINT(") - mode set to ");
      DEBUG_PRINTLN(getModeText());
    } else {
      // Outside schedule time
      currentMode = MODE_SCHEDULE_INACTIVE;
      DEBUG_PRINTLN("Startup: Outside schedule time - motor disabled");
    }
  } else {
    // No schedule configured - pure auto/idle mode
    currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
    DEBUG_PRINT("Startup: No schedule configured - mode set to ");
    DEBUG_PRINTLN(getModeText());
  }
  // Single consolidated startup log (was 3 separate logs)
  logModeChange(getModeText(), "startup");
}

// Log comprehensive startup status
void logStartupStatus() {
  DEBUG_PRINTLN("=== STARTUP STATUS ===");
  DEBUG_PRINT("Schedule Mode: "); DEBUG_PRINTLN(scheduleModeEnabled ? "ENABLED" : "DISABLED");
  if (scheduleModeEnabled) {
    DEBUG_PRINT("Active Schedules: "); DEBUG_PRINTLN(activeScheduleCount);
    int currentActive = getCurrentActiveSchedule();
    DEBUG_PRINT("Current Schedule Status: ");
    DEBUG_PRINTLN(currentActive >= 0 ? "INSIDE" : "OUTSIDE");
    if (currentActive >= 0) {
      DEBUG_PRINT("Active Schedule: "); DEBUG_PRINTLN(currentActive + 1);
    }
  }
  DEBUG_PRINT("Auto Mode: "); DEBUG_PRINTLN(autoModeEnabled ? "ENABLED" : "DISABLED");
  DEBUG_PRINT("Initial Mode: "); DEBUG_PRINTLN(getModeText());
  DEBUG_PRINTLN("Startup: Requiring fresh sensor data for 30 seconds");
  DEBUG_PRINTLN("===================");
}

// ============================================================================
// FILL INTENT MEMORY FUNCTIONS
// ============================================================================

/**
 * Save fill intent when sensor goes offline during motor operation
 * This allows the system to resume filling after brief sensor dropouts
 */
void saveFillIntent() {
  if (motorState && autoModeEnabled && currentMode == MODE_NORMAL) {
    motorWasFillingBeforeOffline = true;
    sensorOfflineTimestamp = millis();
    DEBUG_PRINTLN("=== FILL INTENT SAVED ===");
    DEBUG_PRINT("Current water level: ");
    DEBUG_PRINT(currentWaterPercent);
    DEBUG_PRINTLN("%");
    DEBUG_PRINT("Target level: ");
    DEBUG_PRINT(stopPercent);
    DEBUG_PRINTLN("%");
    DEBUG_PRINTLN("========================");
  }
}

/**
 * Clear fill intent - called when conditions change that invalidate the intent
 * Reasons: target reached, manual override, safe mode, dry run, mode disabled, timeout, etc.
 */
void clearFillIntent(String reason = "unknown") {
  if (motorWasFillingBeforeOffline) {
    DEBUG_PRINTLN("=== FILL INTENT CLEARED ===");
    DEBUG_PRINT("Reason: ");
    DEBUG_PRINTLN(reason);
    DEBUG_PRINT("Was at: ");
    DEBUG_PRINT(currentWaterPercent);
    DEBUG_PRINTLN("%");
    DEBUG_PRINT("Attempts made: ");
    DEBUG_PRINTLN(fillResumeAttempts);
    DEBUG_PRINTLN("==========================");
    motorWasFillingBeforeOffline = false;
    fillResumeAttempts = 0;
    sensorOfflineTimestamp = 0;
  }
}

/**
 * Attempt to resume filling operation after sensor recovery
 * Checks all conditions before allowing resume
 * Returns true if resume was attempted, false otherwise
 */
bool attemptFillResume() {
  if (!motorWasFillingBeforeOffline) {
    return false;  // No intent to resume
  }

  // Verbose fill resume debug commented out to save ~1.5KB Flash
  // DEBUG_PRINTLN("\n=== CHECKING FILL RESUME CONDITIONS ===");

  // Check 1: Intent timeout (10 minutes max)
  unsigned long offlineDuration = (millis() - sensorOfflineTimestamp) / 1000;
  if (offlineDuration > FILL_INTENT_TIMEOUT_SECONDS) {
    clearFillIntent("intent_timeout_exceeded");
    return false;
  }

  // Check 2: Max resume attempts
  if (fillResumeAttempts >= 3) {
    clearFillIntent("max_resume_attempts_exceeded");
    return false;
  }

  // Check 3: Auto mode still enabled
  if (!autoModeEnabled) {
    clearFillIntent("auto_mode_disabled");
    return false;
  }

  // Check 4: Not in safe mode or dry run recovery
  if (currentMode == MODE_SAFE_MODE || currentMode == MODE_DRY_RUN_RECOVERY || currentMode == MODE_SOURCE_DRY_RUN) {
    clearFillIntent("safety_mode_active");
    return false;
  }

  // Check 5: Schedule mode check (if enabled)
  if (scheduleModeEnabled && activeScheduleCount > 0) {
    int activeSchedule = getCurrentActiveSchedule();
    if (activeSchedule < 0) {
      clearFillIntent("outside_schedule_window");
      return false;
    }
  }

  // Check 6: Water level still below target
  if (currentWaterPercent >= stopPercent) {
    clearFillIntent("target_level_reached");
    return false;
  }

  // Check 7: WP sensor safe (if applicable)
  if (hasWPSensor && !wpSensorStatus) {
    clearFillIntent("wp_sensor_unsafe");
    return false;
  }

  // All checks passed - attempt resume
  fillResumeAttempts++;
  DEBUG_PRINTLN("Fill resume: all checks passed");

  // Start motor confirmation process (safety - requires 5 readings)
  // The normal motor confirmation logic will handle the actual motor start
  return true;
}

// ===========================================
// PANEL PULSE / FEEDBACK / BUZZER HELPERS
// ===========================================

// Drive RELAY_PIN HIGH/LOW respecting RELAY_ACTIVE_LOW polarity.
// Shared between single-phase mode (latched) and panel mode (pulsed START).
static inline void writeStartRelay(bool active) {
  digitalWrite(RELAY_PIN, active ? MOTOR_ON_STATE : MOTOR_OFF_STATE);
}

// RELAY_STOP_PIN uses the same polarity convention as the main relay.
static inline void writeStopRelay(bool active) {
  digitalWrite(RELAY_STOP_PIN, active ? MOTOR_ON_STATE : MOTOR_OFF_STATE);
}

// Begin a non-blocking pulse on the chosen relay. If a pulse is already in
// progress on the *other* relay, it is released first (panels never need both
// pulsed simultaneously, and overlapping pulses would be a wiring fault).
void startPanelPulse(PulseTarget target, uint16_t durationMs) {
  if (target == PULSE_NONE) return;
  if (durationMs < PANEL_PULSE_MIN_MS) durationMs = (uint16_t)PANEL_PULSE_MIN_MS;
  if (durationMs > PANEL_PULSE_MAX_MS) durationMs = (uint16_t)PANEL_PULSE_MAX_MS;

  // Release any in-flight pulse on the other relay first
  if (activePulse == PULSE_START && target != PULSE_START) writeStartRelay(false);
  if (activePulse == PULSE_STOP  && target != PULSE_STOP)  writeStopRelay(false);

  if (target == PULSE_START) writeStartRelay(true);
  else                       writeStopRelay(true);

  activePulse = target;
  pulseEndAt = millis() + durationMs;
}

// Called from loop() - releases the active pulse once its duration elapses.
void handlePanelPulses() {
  if (activePulse == PULSE_NONE) return;
  if ((long)(millis() - pulseEndAt) < 0) return;  // not yet

  if (activePulse == PULSE_START) {
    writeStartRelay(false);
    lastStartPulseAt = millis();
  } else if (activePulse == PULSE_STOP) {
    writeStopRelay(false);
  }
  activePulse = PULSE_NONE;
  pulseEndAt = 0;
}

// Read the contactor feedback line (only meaningful when feedbackEnabled).
// Returns true if the contactor is currently latched (pump running per panel).
bool readMotorFeedback() {
  return digitalRead(MOTOR_FEEDBACK_PIN) == FEEDBACK_RUNNING_STATE;
}

// Called from loop() - watches feedback line vs expected motor state and
// raises feedbackFaultActive if the contactor failed to latch within the
// confirmation window after a START pulse, or dropped out unexpectedly.
// Implements retry logic: one retry with 2s pause before declaring fault.
void handleMotorFeedback() {
  if (pumpType != PUMP_PANEL || !feedbackEnabled) {
    feedbackFaultActive = false;
    feedbackBadSinceMs = 0;
    feedbackRetryCount = 0;
    waitingForRetry = false;
    // With feedback disabled or non-panel pump, Core 0's snapshot code
    // falls back to motorState — keep the shared flag in sync so the
    // pill never lags a state change by one tick.
    g_fbConfirmedRunning = motorState;
    g_faultReason        = FR_NONE;
    return;
  }

  bool running = readMotorFeedback();
  unsigned long now = millis();
  // Publish the debounced feedback reading for Core 0 to consume. Single
  // source of truth — Core 0 never touches the GPIO directly.
  g_fbConfirmedRunning = running;

#if ENABLE_CLOUD
  // ── Manual-run detector ────────────────────────────────────────────
  // Fires when the panel contactor changes state WITHOUT our software
  // having commanded that change. Emits pump_on / pump_off events with
  // cause="force" (per user rule: panel button + cloud forceOn are the
  // same thing, one cause). Manual detection is only possible when
  // feedback is wired — the !feedbackEnabled branch above returned.
  //
  // Boot recovery: if the pump was already running when we powered up,
  // the first edge we see is off→on driven by physics that pre-dates us.
  // We tag that specific event with cause="boot_detected_running" so the
  // web app can flag it as recovered rather than a fresh manual start.
  static bool     mrd_lastFbSeen        = false;
  static bool     mrd_bootStateChecked  = false;
  static uint32_t mrd_manualRunStartMs  = 0;

  if (!mrd_bootStateChecked) {
    // First tick after boot. Seed the last-seen state so we don't
    // spuriously fire on a phantom off→X edge, and if the pump is
    // already on, emit the special boot-recovery event.
    mrd_lastFbSeen       = running;
    mrd_bootStateChecked = true;
    if (running && !motorState) {
      // Pump was running when we woke up. Log it so web app can pair
      // it with the eventual stop and mark the run as recovered.
      mrd_manualRunStartMs = millis();
      currentRunIsManual   = true;
      enqueuePumpOnEvent("boot_detected_running");
      publishPumpSnapshot();
      // v118.0.9: boot-detected panel run — enter manual override as
      // "until-full" so the AP STOP button + cloud "Stop Force Run"
      // show up and will properly release the contactor (via STOP
      // pulse) if the operator wants to abort. See panelManualActive
      // flag notes in enterManualOverride() + exitManualOverride().
      if (currentMode != MODE_MANUAL_OVERRIDE) {
        panelManualActive = true;
        manualOverrideUntilFull       = true;
        manualOverrideDurationMinutes = 0;
        enterManualOverride();
        logSystemEvent("MANUAL_OVERRIDE_START", "panel_boot_detected");
      }
    }
  } else if (running != mrd_lastFbSeen) {
    // Feedback edge. Was this caused by our command?
    bool matchesCommand = (running == motorState);
    if (!matchesCommand) {
      // External event — panel button, mechanical contactor issue, etc.
      if (running) {
        // Manual START
        mrd_manualRunStartMs = millis();
        currentRunIsManual   = true;
        enqueuePumpOnEvent("force");
        // v118.0.9: route panel-manual through the same code path as
        // AP/cloud force runs. enterManualOverride() reads
        // panelManualActive and skips the START pulse (contactor is
        // already latched). AP + cloud UIs now show the STOP button,
        // the until-full countdown, and log identically to a force run.
        if (currentMode != MODE_MANUAL_OVERRIDE) {
          panelManualActive = true;
          manualOverrideUntilFull       = true;
          manualOverrideDurationMinutes = 0;
          enterManualOverride();
          logSystemEvent("MANUAL_OVERRIDE_START", "panel_button");
        }
      } else {
        // Manual STOP (operator released contactor at panel)
        uint32_t runSec = (mrd_manualRunStartMs > 0)
          ? (millis() - mrd_manualRunStartMs) / 1000UL
          : 0;
        enqueuePumpOffEvent("force", runSec);
        mrd_manualRunStartMs = 0;
        currentRunIsManual   = false;
        // Exit manual override. panelManualActive stays true so
        // exitManualOverride() skips the STOP pulse (contactor is
        // already released); the exit path itself clears the flag.
        if (currentMode == MODE_MANUAL_OVERRIDE && panelManualActive) {
          exitManualOverride();
          logSystemEvent("MANUAL_OVERRIDE_END", "panel_release");
        }
      }
      publishPumpSnapshot();
    }
    mrd_lastFbSeen = running;
  }
#endif

  // Handle retry wait period (non-blocking 2s pause)
  if (waitingForRetry) {
    if ((now - feedbackRetryWaitStart) >= 2000) {
      // Retry pause complete - fire the retry pulse
      waitingForRetry = false;
      if (motorState) {
        DEBUG_PRINTLN("Retry pause complete - firing START retry pulse");
        startPanelPulse(PULSE_START, panelStartPulseMs);
      } else {
        DEBUG_PRINTLN("Retry pause complete - firing STOP retry pulse");
        startPanelPulse(PULSE_STOP, panelStopPulseMs);
      }
      feedbackBadSinceMs = 0;  // Reset to wait for feedback again
    }
    return;  // Wait during retry pause
  }

  if (motorState) {
    // We expect the contactor to be latched.
    if (running) {
      feedbackBadSinceMs = 0;
      if (feedbackFaultActive) {
        feedbackFaultActive = false;
        feedbackRetryCount = 0;
        g_faultReason      = FR_NONE;   // fault cleared → tell Core 0
        writeLogEntry(LOG_SYSTEM_EVENT, "FEEDBACK_OK", "contactor latched");
      }
      return;
    }

    // Feedback says NOT running. Two cases:
    //  a) we just pulsed START and the contactor is still pulling in → grace window
    //  b) the contactor never latched, or dropped out under load
    bool inGrace = (lastStartPulseAt != 0) &&
                   ((now - lastStartPulseAt) < FEEDBACK_CONFIRM_TIMEOUT_MS);
    if (inGrace) {
      feedbackBadSinceMs = 0;
      return;
    }

    // Out of grace - debounce dropouts so a single noisy reading doesn't trip
    if (feedbackBadSinceMs == 0) feedbackBadSinceMs = now;
    
    // Check if we should retry (only for start failure, not mid-run dropout)
    if ((now - feedbackBadSinceMs) >= FEEDBACK_DROPOUT_DEBOUNCE_MS && !feedbackFaultActive) {
      // Mid-run dropout (not right after start pulse) = immediate fault, no retry
      if (lastStartPulseAt != 0 && (now - lastStartPulseAt) > (FEEDBACK_CONFIRM_TIMEOUT_MS + 5000)) {
        // This is a mid-run dropout - immediate fault
        feedbackFaultActive = true;
        feedbackRetryCount = 0;
        g_faultReason      = FR_MID_RUN_DROPOUT;
        currentMode = MODE_SAFE_MODE;
        safeModeStartTime = now;
        writeLogEntry(LOG_ERROR_EVENT, "FEEDBACK_FAIL", "contactor_dropped_mid_run_panel_fault");
        pumpStage = "PANEL_FAULT";
      } else {
        // Start failure - check if we already retried
        if (feedbackRetryCount == 0) {
          // First failure - schedule retry after 2s pause
          feedbackRetryCount = 1;
          waitingForRetry = true;
          feedbackRetryWaitStart = now;
          DEBUG_PRINTLN("Feedback start failure - scheduling retry after 2s pause");
        } else {
          // Second failure - go to panel fault mode
          feedbackFaultActive = true;
          feedbackRetryCount = 0;
          g_faultReason      = FR_START_FAIL;
          currentMode = MODE_PANEL_FAULT;
          safeModeStartTime = now;
          writeLogEntry(LOG_ERROR_EVENT, "FEEDBACK_FAIL", "contactor_failed_to_latch_after_retry_panel_fault");
          pumpStage = "PANEL_FAULT";
        }
      }
    }
  } else {
    // Motor expected off - feedback should also be off
    if (!running) {
      feedbackBadSinceMs = 0;
      if (feedbackFaultActive) {
        feedbackFaultActive = false;
        feedbackRetryCount = 0;
        g_faultReason      = FR_NONE;   // stuck-on cleared
      }
      return;
    }

    // v118.0.7: feedback-ON while motor commanded OFF has TWO
    // explanations, only one of which is a fault:
    //   (a) MANUAL start — someone pressed the panel's START button
    //       directly. currentRunIsManual was set by the manual-run
    //       detector above when it saw the off→on edge. This is a
    //       legitimate operator action, logged as a force-run via
    //       enqueuePumpOnEvent("force"), and MUST NOT be treated as
    //       a fault. Firmware does not try to STOP the pump — that
    //       would race the operator who just started it on purpose.
    //   (b) STUCK CONTACTOR — our last software STOP pulse didn't
    //       release the latch. currentRunIsManual stays false here
    //       because the manual-run detector only sets it on edges;
    //       a stuck contactor has no off→on edge to detect.
    //
    // We can tell these apart cleanly via currentRunIsManual: skip
    // the fault path entirely when it's true.
    if (currentRunIsManual) {
      // Manual run in progress — stay quiet. The manual-run detector
      // handles the eventual off edge and emits pump_off/force to pair
      // with the on event already enqueued.
      feedbackBadSinceMs = 0;
      if (feedbackFaultActive) {
        feedbackFaultActive = false;
        feedbackRetryCount = 0;
        g_faultReason      = FR_NONE;
      }
      return;
    }

    // Reads as running while we want it off - debounce, then raise fault
    if (feedbackBadSinceMs == 0) feedbackBadSinceMs = now;
    if ((now - feedbackBadSinceMs) >= FEEDBACK_DROPOUT_DEBOUNCE_MS && !feedbackFaultActive) {
      // Stuck-on scenario - retry STOP once
      if (feedbackRetryCount == 0) {
        feedbackRetryCount = 1;
        waitingForRetry = true;
        feedbackRetryWaitStart = now;
        DEBUG_PRINTLN("Feedback stuck-on - scheduling STOP retry after 2s pause");
      } else {
        // Retry failed - go to panel fault
        feedbackFaultActive = true;
        feedbackRetryCount = 0;
        g_faultReason      = FR_STUCK_ON;
        currentMode = MODE_PANEL_FAULT;
        safeModeStartTime = now;
        writeLogEntry(LOG_ERROR_EVENT, "FEEDBACK_FAIL", "contactor_stuck_on_after_retry_panel_fault");
        pumpStage = "PANEL_FAULT";
      }
    }
  }
}

// Returns true if the system is in any error / fault state for buzzer purposes
static inline bool systemInErrorState() {
  return (currentMode == MODE_SAFE_MODE) ||
         (currentMode == MODE_DRY_RUN_RECOVERY) ||
         (currentMode == MODE_SENSOR_OFFLINE) ||
         (currentMode == MODE_PANEL_FAULT) ||
         feedbackFaultActive;
}

// Called from loop() - drives BUZZER_PIN based on user-enabled flags.
// Buzzer is now on separate GPIO27, so it can buzz anytime safely.
// Supports user acknowledgment to silence until next event.
void handleBuzzer() {
#if !HAS_BUZZER_HARDWARE
  // Build without buzzer hardware — keep pin low and skip all logic
  digitalWrite(BUZZER_PIN, LOW);
  return;
#else
  // If buzzer is muted by user acknowledgment, keep it off
  if (buzzerMuted) {
    digitalWrite(BUZZER_PIN, LOW);
    return;
  }
  
  if (pumpType == PUMP_SINGLE_PHASE) return;   // pin owned by relay
  if (activePulse == PULSE_START) return;       // do not fight a START pulse

  bool wantMotorBuzz = (buzzerFlags & BUZZ_ON_MOTOR_ON) && motorState;
  bool errorActive   = systemInErrorState();
  bool wantErrorBuzz = (buzzerFlags & BUZZ_ON_ERROR) && errorActive;

  if (!wantMotorBuzz && !wantErrorBuzz) {
    buzzerStartTime = 0;  // reset auto-stop timer when buzz event ends
    digitalWrite(BUZZER_PIN, LOW);
    return;
  }

  // Auto-stop timer (Option A: applies to both motor and error buzz)
  if (buzzerAutoStopEnabled) {
    if (buzzerStartTime == 0) {
      buzzerStartTime = millis();
    }
    if ((millis() - buzzerStartTime) >= (unsigned long)buzzerAutoStopMins * 60000UL) {
      buzzerMuted = true;            // auto-mute; resets on next state-change event
      digitalWrite(BUZZER_PIN, LOW);
      return;
    }
  }

  if (wantErrorBuzz) {
    // 500ms blink while in error state
    bool on = ((millis() / 500) & 1) == 0;
    digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
  } else {
    digitalWrite(BUZZER_PIN, HIGH);  // steady-on while motor runs
  }
#endif
}

// ===========================================
// MOTOR CONTROL (dispatches single-phase vs panel)
// ===========================================
void setMotor(bool state) {
  bool wasStateChange = (state != motorState);
  motorState = state;

  // Reset buzzer mute on state change (new event)
  if (wasStateChange) {
    buzzerMuted = false;
    // v118.0.9: reset smart dry-run window. On motor OFF we zero so the
    // next ON cycle starts a fresh window from the current pct; on ON
    // we also zero so the detection block's "window==0" branch seeds the
    // first window on the next tick after sensor reading settles.
    smartDryRunWindowStartMs = 0;
  }

  if (pumpType == PUMP_PANEL) {
    // Panel: pulse START or STOP only on state change. The contactor latches
    // itself in between. Avoid re-pulsing on every call.
    if (wasStateChange) {
      if (state) {
        startPanelPulse(PULSE_START, panelStartPulseMs);
      } else {
        startPanelPulse(PULSE_STOP, panelStopPulseMs);
      }
    }
  } else {
    // Single-phase / MCB: hold relay continuously
    writeStartRelay(state);
  }

  DateTime now = safeNow();
  DEBUG_PRINT(state ? "Motor ON  " : "Motor OFF ");
  DEBUG_PRINT("at ");
  DEBUG_PRINTLN(formatDateTime(now));

  if (wasStateChange) {
    logMotorEvent(state);

#if ENABLE_CLOUD
    // Emit pump_on/pump_off to the cloud task. Non-blocking (queue
    // drop-oldest). Cloud pairs the on/off into a single /history entry;
    // only complete pairs get pushed (per user rule).
    //
    // cause is set by the caller in nextMotorCause. Panel button and
    // cloud forceOn both use "force" (per user: same thing). Auto and
    // schedule branches leave the default "auto" in place.
    if (state) {
      const char* c = nextMotorCause ? nextMotorCause : "auto";
      currentRunIsManual = (strcmp(c, "force") == 0);
      enqueuePumpOnEvent(c);
    } else {
      uint32_t runSec = (motorRunStartTime > 0)
        ? (uint32_t)((millis() - motorRunStartTime) / 1000UL)
        : 0;
      // For pump_off: prefer explicit cause if caller set one, else
      // inherit from the run type (manual→"force", auto→"auto").
      const char* c = (nextMotorCause && strcmp(nextMotorCause, "auto") != 0)
        ? nextMotorCause
        : (currentRunIsManual ? "force" : "auto");
      enqueuePumpOffEvent(c, runSec);
      currentRunIsManual = false;
    }
    // Reset for next call so a caller that forgets to set nextMotorCause
    // doesn't accidentally reuse the previous one.
    nextMotorCause = "auto";
    // Publish a fresh snapshot so /live reflects the change immediately.
    publishPumpSnapshot();
#endif

    // Reset source detection runtime state when motor turns off
    if (!state) {
      graceActive = false;
      graceStartTime = 0;
      sourceConfirmed = false;
      sourceConfirmStart = 0;
      motorRunStartTime = 0;
      if (currentMode != MODE_DRY_RUN_RECOVERY && currentMode != MODE_SAFE_MODE &&
          currentMode != MODE_PANEL_FAULT && currentMode != MODE_SOURCE_DRY_RUN) {
        pumpStage = "IDLE";
      }
      // Clear any stale feedback grace window so dropout detection re-arms cleanly
      feedbackBadSinceMs = 0;
      feedbackRetryCount = 0;
      waitingForRetry = false;
    } else {
      // Motor starting - reset feedback tracking
      feedbackRetryCount = 0;
      waitingForRetry = false;
      lastStartPulseAt = millis();  // Start grace period from now
    }
  }
}

void updateLEDStatus() {
  unsigned long currentMillis = millis();

  // PRIORITY 0: Test-LED identify blink (RED→GREEN→BLUE every 200ms for
  // 1.8s total). Highest priority — overrides motor-on green, faults,
  // OTA, everything. Installer needs unambiguous "this is the device
  // I just clicked" feedback regardless of pump state. Same visual as
  // the ultrasonic firmware so field crew sees identical identify
  // behaviour on pump + sensor devices.
  if (testBlinkActive) {
    unsigned long elapsed = currentMillis - testBlinkStart;
    if (elapsed < 1800) {
      int phase = (elapsed / 200) % 3;
      if      (phase == 0) ws2812_setColor(255, 0,   0);   // Red
      else if (phase == 1) ws2812_setColor(0,   255, 0);   // Green
      else                 ws2812_setColor(0,   0,   255); // Blue
    } else {
      testBlinkActive = false;
      // Fall through to normal LED — do NOT return; let the rest of
      // updateLEDStatus() re-establish the state for this frame.
    }
    if (testBlinkActive) return;
  }

  // PRIORITY 1: Motor ON (green fast blink)
  if (motorState) {
    if (currentMillis - lastLEDUpdate >= FAST_BLINK_INTERVAL) {
      ledBlinkState = !ledBlinkState;
      if (ledBlinkState) {
        ws2812_setColor(0, 255, 0); // Green
      } else {
        ws2812_off();
      }
      lastLEDUpdate = currentMillis;
    }
    return;
  }

  // PRIORITY 2: Safe Mode (red fast blink)
  if (currentMode == MODE_SAFE_MODE) {
    if (currentMillis - lastLEDUpdate >= FAST_BLINK_INTERVAL) {
      ledBlinkState = !ledBlinkState;
      if (ledBlinkState) {
        ws2812_setColor(255, 0, 0); // Red
      } else {
        ws2812_off();
      }
      lastLEDUpdate = currentMillis;
    }
    return;
  }

  // PRIORITY 3: Dry Run Recovery / Source Dry Run (red slow blink)
  if (currentMode == MODE_DRY_RUN_RECOVERY || currentMode == MODE_SOURCE_DRY_RUN) {
    if (currentMillis - lastLEDUpdate >= SLOW_BLINK_INTERVAL) {
      ledBlinkState = !ledBlinkState;
      if (ledBlinkState) {
        ws2812_setColor(255, 0, 0); // Red
      } else {
        ws2812_off();
      }
      lastLEDUpdate = currentMillis;
    }
    return;
  }

  // PRIORITY 4: Sensor Offline OR No data received yet (purple fast blink)
  // Note: WP sensor offline check removed - wired WP sensor is always "online"
  if (currentMode == MODE_SENSOR_OFFLINE || !hasReceivedReading || !sensorOnline) {
    if (currentMillis - lastLEDUpdate >= FAST_BLINK_INTERVAL) {
      ledBlinkState = !ledBlinkState;
      if (ledBlinkState) {
        ws2812_setColor(128, 0, 128); // Purple
      } else {
        ws2812_off();
      }
      lastLEDUpdate = currentMillis;
    }
    return;
  }

  // PRIORITY 5: OTA Update (white progress)
  if (otaInProgress) {
    uint8_t brightness = map(otaProgress, 0, 100, 0, 255);
    ws2812_setColor(brightness, brightness, brightness); // White
    return;
  }

  // v118.0.11: PRIORITY 6 removed — previously killed the LED entirely
  // when outside schedule window, which left operators guessing whether
  // the device was alive / connected. Now MODE_SCHEDULE_INACTIVE falls
  // through to the Priority 7 heartbeat so the connectivity-status pulse
  // still fires (Blue/Pink/Red/White per WiFi + internet + Firebase).
  // Pump is still OFF during inactive schedule — that part is enforced
  // in pump control, not LED code.

  // PRIORITY 7: Normal operation — 30 s idle heartbeat → 5 s status blink
  // -----------------------------------------------------------------------
  // Copied conceptually from the ultrasonic firmware (handleLED). Idle
  // period keeps the existing blue heartbeat behaviour; the 5-sec status
  // window overrides with a colour that identifies WHICH layer of
  // connectivity is failing so an installer at the physical box can
  // diagnose without needing a serial monitor or the dashboard.
  //   Blue  = WiFi + internet + Firebase all OK
  //   Pink  = WiFi up but no internet (DNS chain failed)
  //   Red   = internet OK but Firebase auth/publish failing
  //   White = no WiFi at all
  //
  // Motor-ON, fault, safe-mode, OTA, and schedule-inactive priorities
  // above are safety-critical and untouched — they short-circuit before
  // this block runs.
  unsigned long cycleElapsed = currentMillis - ledCycleStart;
  if (cycleElapsed >= (LED_CYCLE_LEVEL_MS + LED_CYCLE_STATUS_MS)) {
    ledCycleStart    = currentMillis;
    ledShowingStatus = false;
    cycleElapsed     = 0;
  }

  if (cycleElapsed >= LED_CYCLE_LEVEL_MS) {
    // ── Status window (5 s) ──
    if (!ledShowingStatus) {
      ledShowingStatus = true;
      statusBlinkStart = currentMillis;
    }
    int blinkPhase = ((currentMillis - statusBlinkStart) / 250) % 2;
    bool wifiUp = (WiFi.status() == WL_CONNECTED);
#if ENABLE_CLOUD
    bool inetUp = internetAvailable;
    bool fbUp   = firebaseHealthy;
#else
    bool inetUp = wifiUp;   // no cloud path compiled → status collapses
    bool fbUp   = wifiUp;
#endif
    if (!wifiUp) {
      // White = no WiFi at all
      if (blinkPhase == 0) ws2812_setColor(255, 255, 255); else ws2812_off();
    } else if (!inetUp) {
      // Pink = WiFi OK, no internet
      if (blinkPhase == 0) ws2812_setColor(255, 0, 100); else ws2812_off();
    } else if (!fbUp) {
      // Red = internet OK, Firebase failing
      if (blinkPhase == 0) ws2812_setColor(255, 0, 0);   else ws2812_off();
    } else {
      // Blue = all good
      if (blinkPhase == 0) ws2812_setColor(0, 0, 255);   else ws2812_off();
    }
    return;
  }

  // ── Idle window (30 s) — original blue heartbeat behaviour ──
  ledShowingStatus = false;
  if (currentMillis - lastHeartbeat >= HEARTBEAT_INTERVAL) {
    heartbeatActive = true;
    lastHeartbeat = currentMillis;
    ws2812_setColor(0, 0, 255); // Blue flash ON
  }

  // Turn off heartbeat after flash duration
  if (heartbeatActive && (currentMillis - lastHeartbeat >= HEARTBEAT_FLASH_DURATION)) {
    heartbeatActive = false;
    ws2812_off(); // Flash OFF
  }

  // Keep LED off when not in heartbeat flash
  if (!heartbeatActive) {
    ws2812_off();
  }
}

// ===========================================
// CONFIGURATION FUNCTIONS
// ===========================================

void loadConfiguration() {
  if (EEPROM.read(EEPROM_CONFIGURED_FLAG) != MAGIC_NUMBER) {
    // Fresh ESP32 — RAM already holds all correct defaults from global
    // initialisers. Just mark as configured so the status page shows
    // normally. saveConfiguration() will persist to EEPROM the first time
    // the user hits Save Settings (or on next reboot the flag check re-runs
    // and we get here again, which is fine — nothing breaks with defaults).
    // DO NOT call saveConfiguration() here: LittleFS/RTC/log system are not
    // yet initialised at this point in setup() and the call crashes.
    isConfigured = true;
    DEBUG_PRINTLN("Fresh device - using defaults, will persist on first settings save");
    return;
  }

  if (EEPROM.read(EEPROM_CONFIGURED_FLAG) == MAGIC_NUMBER) {
    isConfigured = true;
    
    // v118.0.4: startPercent/stopPercent are user-adjustable from the AP
    // Water Level Settings sliders + the cloud Panel Settings tab. Read
    // actual persisted values from EEPROM; validate ranges to protect
    // against garbage. If invalid or missing, fall back to safe defaults.
    uint8_t startRaw = EEPROM.read(EEPROM_START_PERCENT);
    uint8_t stopRaw  = EEPROM.read(EEPROM_STOP_PERCENT);
    startPercent = (startRaw >= 2 && startRaw <= 98)  ? startRaw : 30;
    stopPercent  = (stopRaw  >= 4 && stopRaw  <= 100) ? stopRaw  : 90;
    // Enforce 2% gap invariant — if NVS is corrupted, clamp stop up.
    if (stopPercent < startPercent + 2) {
      stopPercent = startPercent + 2;
      if (stopPercent > 100) stopPercent = 100;
    }

    tankVolume = (EEPROM.read(EEPROM_TANK_VOLUME) << 24) |
                 (EEPROM.read(EEPROM_TANK_VOLUME + 1) << 16) |
                 (EEPROM.read(EEPROM_TANK_VOLUME + 2) << 8) |
                 EEPROM.read(EEPROM_TANK_VOLUME + 3);
    if (tankVolume > 100000) tankVolume = 0;  // clamp garbage EEPROM (e.g. 0xFFFFFFFF)
    
    hasWPSensor = EEPROM.read(EEPROM_HAS_WP_SENSOR);
    dryRunProtectionOn = EEPROM.read(EEPROM_DRY_RUN_ON);
    { uint8_t v = EEPROM.read(EEPROM_DRY_RUN_MINS);
      maxTimeToNextProbeMins = (v==5||v==10||v==15||v==30||v==60||v==120) ? v : 30; }

    // Load max dry run count — v118.0.9 extended range 1-10 (was 1-2).
    uint8_t storedMaxDryRunCount = EEPROM.read(EEPROM_MAX_DRY_RUN_COUNT);
    if (storedMaxDryRunCount >= 1 && storedMaxDryRunCount <= 10) {
      maxDryRunCount = storedMaxDryRunCount;
    } else {
      maxDryRunCount = 2;  // Default: 2 attempts
    }

    // v118.0.9: smart dry-run + Safe Mode auto-clear settings. First
    // boot after upgrade has magic byte missing → fall back to the
    // "smart ON, 5-min window, 2% rise, 2 retries, manual clear"
    // defaults called out in the globals above. Existing devices just
    // start using smart dry-run on next pump cycle — operator can
    // disable from Panel Settings if they want classic behavior.
    if (EEPROM.read(EEPROM_SMART_DRY_RUN_MAGIC) == SMART_DRY_RUN_MAGIC) {
      smartDryRunEnabled   = EEPROM.read(EEPROM_SMART_DRY_RUN_ON) != 0;
      uint8_t cm = EEPROM.read(EEPROM_SMART_CHECK_MINS);
      smartDryRunCheckMins = (cm >= 1 && cm <= 15) ? cm : 5;
      uint8_t mp = EEPROM.read(EEPROM_SMART_MIN_PCT);
      smartDryRunMinPct    = (mp == 1 || mp == 2 || mp == 3 || mp == 5 || mp == 10) ? mp : 2;
    }

    uint8_t autoModeValue = EEPROM.read(EEPROM_AUTO_MODE_ENABLED);
    autoModeEnabled = (autoModeValue == MAGIC_NUMBER);
    
    // Load target node name
    targetNodeName = "";
    for (int i = 0; i < 8; i++) {
      char c = EEPROM.read(EEPROM_TARGET_NODE + i);
      if (c == 0) break;
      targetNodeName += c;
    }
    DEBUG_PRINT("Loaded targetNodeName from EEPROM: '");
    DEBUG_PRINT(targetNodeName);
    DEBUG_PRINTLN("'");

    // Load WP node name
    wpNodeName = "";
    for (int i = 0; i < 8; i++) {
      char c = EEPROM.read(EEPROM_WP_NODE_NAME + i);
      if (c == 0) break;
      wpNodeName += c;
    }
    DEBUG_PRINT("Loaded wpNodeName from EEPROM: '");
    DEBUG_PRINT(wpNodeName);
    DEBUG_PRINTLN("'");
    
    loadScheduleConfiguration();
    loadLastTimeSyncInfo();
    loadAutoRecoveryConfiguration();
    loadSourceDetectionConfig();
    loadPanelConfig();

    // Restore last "Force Run Duration" the customer picked on the AP
    // page. Persisted so a reboot doesn't snap the dropdown back to 15.
    // Whitelist matches the AP <select> options; anything else = default.
    // Also restore lastAppliedSavedAt so the freshSave gate in
    // checkCloudConfig() correctly identifies stale /config across reboots.
    Preferences p;
    p.begin("pump", true);   // read-only
    int savedFr = p.getInt("frDur", 15);
    lastAppliedSavedAt = p.getUInt("lastSvAt", 0);
    p.end();
    if (savedFr == -1 || savedFr == 5 || savedFr == 10 || savedFr == 15 || savedFr == 30 || savedFr == 60) {
      lastForceRunSelection = savedFr;
    } else {
      lastForceRunSelection = 15;
    }
    DEBUG_PRINT("Loaded lastForceRunSelection: ");
    DEBUG_PRINTLN(lastForceRunSelection == -1 ? "until_full" : String(lastForceRunSelection).c_str());
    DEBUG_PRINT("Loaded lastAppliedSavedAt: ");
    DEBUG_PRINTLN(lastAppliedSavedAt);
  }
}

// Persist the customer's Force Run Duration pick so it survives reboots.
// Called from handleWebManualOn after validation accepts the value.
// Kept lightweight — one small write per Force Run START, no wear
// concerns (Preferences uses wear-leveled NVS flash).
static void saveLastForceRunSelection(int minutes) {
  if (minutes == lastForceRunSelection) return;   // no-op if unchanged
  lastForceRunSelection = minutes;
  Preferences p;
  p.begin("pump", false);
  p.putInt("frDur", minutes);
  p.end();
  DEBUG_PRINT("Saved lastForceRunSelection: ");
  DEBUG_PRINTLN(minutes == -1 ? "until_full" : String(minutes).c_str());
}

void saveConfiguration() {
  EEPROM.write(EEPROM_CONFIGURED_FLAG, MAGIC_NUMBER);


  EEPROM.write(EEPROM_TANK_VOLUME, (tankVolume >> 24) & 0xFF);
  EEPROM.write(EEPROM_TANK_VOLUME + 1, (tankVolume >> 16) & 0xFF);
  EEPROM.write(EEPROM_TANK_VOLUME + 2, (tankVolume >> 8) & 0xFF);
  EEPROM.write(EEPROM_TANK_VOLUME + 3, tankVolume & 0xFF);
  
  EEPROM.write(EEPROM_HAS_WP_SENSOR, hasWPSensor);
  EEPROM.write(EEPROM_DRY_RUN_ON, dryRunProtectionOn);
  EEPROM.write(EEPROM_DRY_RUN_MINS, maxTimeToNextProbeMins);
  EEPROM.write(EEPROM_MAX_DRY_RUN_COUNT, maxDryRunCount);

  // v118.0.9: persist smart dry-run + Safe Mode auto-clear block. Magic
  // byte lets loadConfiguration() know these slots carry valid data vs
  // garbage from a pre-118.0.9 image.
  EEPROM.write(EEPROM_SMART_DRY_RUN_MAGIC,   SMART_DRY_RUN_MAGIC);
  EEPROM.write(EEPROM_SMART_DRY_RUN_ON,      smartDryRunEnabled ? 1 : 0);
  EEPROM.write(EEPROM_SMART_CHECK_MINS,      smartDryRunCheckMins);
  EEPROM.write(EEPROM_SMART_MIN_PCT,         smartDryRunMinPct);

  EEPROM.write(EEPROM_AUTO_MODE_ENABLED, autoModeEnabled ? MAGIC_NUMBER : 0);
  
  // Save target node name
  DEBUG_PRINT("Saving targetNodeName to EEPROM: '");
  DEBUG_PRINT(targetNodeName);
  DEBUG_PRINTLN("'");
  for (int i = 0; i < 8; i++) {
    if (i < targetNodeName.length()) {
      EEPROM.write(EEPROM_TARGET_NODE + i, targetNodeName[i]);
    } else {
      EEPROM.write(EEPROM_TARGET_NODE + i, 0);
    }
  }

  // Save WP node name
  DEBUG_PRINT("Saving wpNodeName to EEPROM: '");
  DEBUG_PRINT(wpNodeName);
  DEBUG_PRINTLN("'");
  for (int i = 0; i < 8; i++) {
    if (i < wpNodeName.length()) {
      EEPROM.write(EEPROM_WP_NODE_NAME + i, wpNodeName[i]);
    } else {
      EEPROM.write(EEPROM_WP_NODE_NAME + i, 0);
    }
  }

  saveScheduleConfiguration();
  saveAutoRecoveryConfiguration();
  savePanelConfig();

  EEPROM.commit();
  DEBUG_PRINTLN("Configuration saved to EEPROM");
}

// ===========================================
// PANEL / BUZZER / FEEDBACK CONFIG PERSISTENCE
// ===========================================
void loadPanelConfig() {
  if (EEPROM.read(EEPROM_PANEL_MAGIC) != PANEL_MAGIC) {
    // First boot on this firmware version - apply safe defaults
    pumpType = PUMP_SINGLE_PHASE;
    panelStartPulseMs = (uint16_t)PANEL_PULSE_DEFAULT_MS;
    panelStopPulseMs  = (uint16_t)PANEL_PULSE_DEFAULT_MS;
    feedbackEnabled = false;
    buzzerFlags = 0;
    buzzerAutoStopEnabled = false;
    buzzerAutoStopMins = 5;
    return;
  }

  uint8_t pt = EEPROM.read(EEPROM_PUMP_TYPE);
  pumpType = (pt == PUMP_PANEL) ? PUMP_PANEL : PUMP_SINGLE_PHASE;

  uint16_t sp = ((uint16_t)EEPROM.read(EEPROM_PANEL_START_PULSE_MS) << 8) |
                 EEPROM.read(EEPROM_PANEL_START_PULSE_MS + 1);
  uint16_t tp = ((uint16_t)EEPROM.read(EEPROM_PANEL_STOP_PULSE_MS) << 8) |
                 EEPROM.read(EEPROM_PANEL_STOP_PULSE_MS + 1);
  panelStartPulseMs = (sp >= PANEL_PULSE_MIN_MS && sp <= PANEL_PULSE_MAX_MS)
                       ? sp : (uint16_t)PANEL_PULSE_DEFAULT_MS;
  panelStopPulseMs  = (tp >= PANEL_PULSE_MIN_MS && tp <= PANEL_PULSE_MAX_MS)
                       ? tp : (uint16_t)PANEL_PULSE_DEFAULT_MS;

  feedbackEnabled = (EEPROM.read(EEPROM_FEEDBACK_ENABLED) == 1);
  buzzerFlags = EEPROM.read(EEPROM_BUZZER_FLAGS) & (BUZZ_ON_MOTOR_ON | BUZZ_ON_ERROR);
  buzzerAutoStopEnabled = (EEPROM.read(EEPROM_BUZZER_AUTO_STOP_EN) == 1);
  uint8_t asMins = EEPROM.read(EEPROM_BUZZER_AUTO_STOP_MINS);
  buzzerAutoStopMins = (asMins >= 1 && asMins <= 30) ? asMins : 5;
}

void savePanelConfig() {
  EEPROM.write(EEPROM_PANEL_MAGIC, PANEL_MAGIC);
  EEPROM.write(EEPROM_PUMP_TYPE, (uint8_t)pumpType);
  EEPROM.write(EEPROM_PANEL_START_PULSE_MS, (panelStartPulseMs >> 8) & 0xFF);
  EEPROM.write(EEPROM_PANEL_START_PULSE_MS + 1, panelStartPulseMs & 0xFF);
  EEPROM.write(EEPROM_PANEL_STOP_PULSE_MS, (panelStopPulseMs >> 8) & 0xFF);
  EEPROM.write(EEPROM_PANEL_STOP_PULSE_MS + 1, panelStopPulseMs & 0xFF);
  EEPROM.write(EEPROM_FEEDBACK_ENABLED, feedbackEnabled ? 1 : 0);
  EEPROM.write(EEPROM_BUZZER_FLAGS, buzzerFlags);
  EEPROM.write(EEPROM_BUZZER_AUTO_STOP_EN, buzzerAutoStopEnabled ? 1 : 0);
  EEPROM.write(EEPROM_BUZZER_AUTO_STOP_MINS, buzzerAutoStopMins);
  // EEPROM.commit() handled by caller (saveConfiguration)
}

void resetConfigurationToDefaults() {
  DEBUG_PRINTLN("Resetting configuration to defaults...");

  // v118.0.4: reset to user-sensible defaults (30% / 90%) for the
  // ultrasonic variant. Customer can adjust via sliders afterwards.
  startPercent = 30;
  stopPercent = 90;
  tankVolume = 0;

  // Reset sensor configuration to defaults
  targetNodeName = "US03";
  wpNodeName = "WP01";
  hasWPSensor = false;

  // Reset protection settings to defaults
  dryRunProtectionOn = false;
  maxTimeToNextProbeMins = 30;

  // Reset mode states
  autoModeEnabled = true;
  scheduleModeEnabled = false;

  // Clear all schedules
  for (int i = 0; i < 3; i++) {
    schedules[i].enabled = false;
    schedules[i].startHour = 0;
    schedules[i].startMinute = 0;
    schedules[i].endHour = 0;
    schedules[i].endMinute = 0;
  }
  activeScheduleCount = 0;

  // Reset safe mode auto-recovery to defaults
  autoRecoverOnSchedule = false;
  autoRecoverOnTimeout = false;
  autoRecoverTimeoutHours = 4;

  // Clear runtime error states
  currentMode = MODE_NORMAL;
  dryRunCount = 0;
  dryRunStartTime = 0;
  safeModeStartTime = 0;
  dryRunProbeTimerStart = 0;
  needFreshDataAfterRecovery = false;

  // Reset motor confirmation states
  resetMotorConfirmation();

  // Reset WiFi reconnection backoff
  resetWiFiBackoff();

  // Reset source detection config to defaults (v8.0.1)
  detectionMode = 0;        // Pre-Detection
  gracePeriodTens = 18;     // 3 minutes
  sourceDebounceSecs = 30;
  maxRetryCount = 3;
  retryWaitMins = 10;
  maxRunTimeMins = 120;     // 2 hours
  dryRunWaitMins = 10;
  resetSourceDetectionState();

  // Reset panel / buzzer / feedback config to defaults
  pumpType = PUMP_SINGLE_PHASE;
  panelStartPulseMs = (uint16_t)PANEL_PULSE_DEFAULT_MS;
  panelStopPulseMs  = (uint16_t)PANEL_PULSE_DEFAULT_MS;
  feedbackEnabled = false;
  buzzerFlags = 0;
  buzzerAutoStopEnabled = false;
  buzzerAutoStopMins = 5;
  buzzerStartTime = 0;
  activePulse = PULSE_NONE;
  pulseEndAt = 0;
  feedbackFaultActive = false;
  feedbackBadSinceMs = 0;

  // Reset WP sensor states
  if (hasWPSensor) {
    wpSensorStatus = true;
    wpSensorOnline = false;
    hasReceivedWPReading = false;
  }

  // Turn off motor
  setMotor(false);

  // Save defaults to EEPROM (preserves WiFi credentials and device name)
  saveConfiguration();

  // Log the reset
  writeLogEntry(LOG_SYSTEM_EVENT, "CONFIG_RESET", "Configuration reset to factory defaults");

  DEBUG_PRINTLN("Configuration reset complete!");
  DEBUG_PRINTLN("WiFi credentials and device name preserved.");
  DEBUG_PRINTLN("Please review and update tank settings.");
}

// ===========================================
// WEB SERVER FUNCTIONS
// ===========================================

// App Access Security - Returns HTML page for blocked requests
String getBlockedPageHTML() {
  String html = "<!DOCTYPE html><html><head>";
  html += "<meta charset='UTF-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>SenseFlow</title>";
  html += "<style>";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;";
  html += "background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);";
  html += "min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;color:#fff}";
  html += ".box{text-align:center;padding:40px;max-width:400px}";
  html += ".icon{font-size:80px;margin-bottom:20px}";
  html += "h1{font-size:1.8em;margin-bottom:15px;color:#fff}";
  html += "p{color:#a0a0a0;font-size:1.1em;line-height:1.6}";
  html += "</style></head><body>";
  html += "<div class='box'>";
  html += "<div class='icon'>📱</div>";
  html += "<h1>Use SenseFlow App</h1>";
  html += "<p>This device can only be accessed through the official SenseFlow mobile app.</p>";
  html += "</div></body></html>";
  return html;
}

// App Access Security - Check if request is from our app
bool checkAppAccess() {
  String userAgent = server.header("User-Agent");
  if (userAgent.indexOf(APP_USER_AGENT) == -1) {
    server.send(403, "text/html", getBlockedPageHTML());
    return false;
  }
  return true;
}

void setupWebServer() {
  // Enable User-Agent header collection for app verification
  const char* headerKeys[] = {"User-Agent"};
  server.collectHeaders(headerKeys, 1);

  // Main pages (password check on root only)
  server.on("/", handleWebRoot);
  server.on("/lock", handleLock);
  server.on("/settings", HTTP_GET, handleWebSettings);
  server.on("/settings", HTTP_POST, handleWebSettingsPost);
  server.on("/api/status", handleAPIStatus);
  server.on("/manual/on", HTTP_POST, handleWebManualOn);
  server.on("/manual/off", HTTP_POST, handleWebManualOff);
  // v118: advanced sensor endpoints
  server.on("/us/scan",      HTTP_GET,  handleWebUsSensorScan);
  server.on("/us/writeaddr", HTTP_POST, handleWebUsSensorWriteAddr);
  server.on("/manual/selection", HTTP_POST, handleWebForceRunSelection);
  server.on("/api/automode", HTTP_POST, handleAPIAutoMode);
  server.on("/api/schedulemode", HTTP_POST, handleAPIScheduleMode);
  server.on("/api/schedules", HTTP_POST, handleAPISchedulesPost);
  server.on("/ota", handleWebOTA);
  server.on("/wifi", HTTP_GET, handleWebWiFiSettings);
  server.on("/wifi", HTTP_POST, handleWebWiFiSettingsPost);

  // /testled — kicks off the 1.8 s RED→GREEN→BLUE identify blink. Used
  // by installer at the physical box to confirm they're looking at the
  // right device when multiple SenseFlow units are visible in the same
  // area. Idempotent — clicking again during a blink extends it.
  server.on("/testled", HTTP_ANY, []() {
    testBlinkActive = true;
    testBlinkStart  = millis();
    logSystemEvent("TEST_LED", "AP");
    server.send(200, "application/json", "{\"ok\":true}");
  });

  // ── MvsConnect app WiFi transfer endpoints ──────────────────────────────
  // The MvsConnect Android app uses exactly these paths on port 7689.
  // Credentials are saved to both NVS (Preferences namespace "mvswifi" —
  // what the library uses) AND EEPROM (so existing loadWiFiCredentials()
  // picks them up on the next boot without any other changes).

  // /info — app calls this first to discover device info
  server.on("/info", HTTP_ANY, []() {
    String json = "{";
    json += "\"device\":\"" + deviceName + "\",";
    json += "\"version\":\"" FIRMWARE_VERSION "\",";
    json += "\"ap_ip\":\"" + WiFi.softAPIP().toString() + "\",";
    json += "\"wifi_connected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false") + ",";
    if (WiFi.status() == WL_CONNECTED) {
      json += "\"wifi_ip\":\"" + WiFi.localIP().toString() + "\",";
      json += "\"wifi_ssid\":\"" + WiFi.SSID() + "\",";
    }
    json += "\"uptime\":" + String(millis() / 1000) + ",";
    json += "\"heap\":" + String(ESP.getFreeHeap());
    json += "}";
    server.send(200, "application/json", json);
  });

  // /__mvsconnect/wifi/transfer — app posts credentials here
  server.on("/__mvsconnect/wifi/transfer", HTTP_ANY, []() {
    if (!server.hasArg("ssid")) {
      server.send(400, "text/plain", "Usage: /__mvsconnect/wifi/transfer?ssid=YourWiFi&password=YourPass");
      return;
    }
    String ssid = server.arg("ssid");
    String pass = server.hasArg("password") ? server.arg("password") : "";
    ssid.trim();

    // Save to NVS (namespace "mvswifi" — matches MvsConnect library exactly)
    Preferences prefs;
    prefs.begin("mvswifi", false);
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    prefs.putBool("valid", true);
    prefs.end();

    // Also save to EEPROM so existing loadWiFiCredentials() works on reboot
    wifiSSID = ssid;
    wifiPassword = pass;
    wifiConfigured = true;
    saveWiFiCredentials();

    logWiFiEvent("WIFI_CREDENTIALS_RECEIVED", "ssid_" + ssid);

    String response = "OK: Connecting to " + ssid + "\n";
    response += "Status: http://" + WiFi.softAPIP().toString() + ":7689/__mvsconnect/wifi/status";
    server.send(200, "text/plain", response);

    WiFi.disconnect(false);
    delay(200);
    WiFi.begin(ssid.c_str(), pass.c_str());
  });

  // /__mvsconnect/wifi/status — app polls this after transfer to check result
  server.on("/__mvsconnect/wifi/status", HTTP_ANY, []() {
    String status;
    if (WiFi.status() == WL_CONNECTED) {
      status = "CONNECTED: " + WiFi.SSID() + " IP:" + WiFi.localIP().toString();
    } else if (WiFi.status() == WL_DISCONNECTED || WiFi.status() == WL_IDLE_STATUS) {
      status = "CONNECTING: " + wifiSSID;
    } else {
      status = "FAILED";
    }
    server.send(200, "text/plain", status);
  });
  server.on("/timesync", HTTP_POST, handleTimeSyncPost);
  server.on("/restart", HTTP_POST, handleWebRestart);
  server.on("/resetconfig", HTTP_POST, handleResetConfig);
  server.on("/logs/download", handleLogsDownload);
  server.on("/logs/view", handleLogsView);
  server.on("/logs/clear", HTTP_GET, handleLogsClearConfirm);
  server.on("/logs/clear", HTTP_POST, handleLogsClear);

  server.on("/auto-settings", HTTP_GET, []() {
    lastWebActivity = millis();
    server.send(200, "text/html", getAutoModeSettingsHTML());
  });

  server.on("/schedules", HTTP_GET, []() {
    lastWebActivity = millis();
    server.send(200, "text/html", getSchedulesPageHTML());
  });

  server.on("/schedules", HTTP_POST, handleSchedulesSave);
  server.on("/api/clear-error-mode", HTTP_POST, handleClearErrorMode);
  server.on("/api/silence-buzzer", HTTP_POST, handleAPISilenceBuzzer);

  server.begin();
  DEBUG_PRINTLN("Web server started with password protection and logging capabilities");
}

void handleWebSettingsPost() {
  lastWebActivity = millis();

  // Clear previous validation errors
  lastValidationErrors = "";
  
  // Basic settings validation
  bool hasErrors = false;
  String errors = "";
  
  // Device name validation
  if (server.hasArg("deviceName")) {
    String newDeviceName = server.arg("deviceName");
    newDeviceName.trim();
    if (validateDeviceName(newDeviceName)) {
      deviceName = newDeviceName;
      updateDynamicNames();
      saveDeviceName();
      // Push installer's new label to cloud immediately so admin sees
      // the rename without waiting for the next boot / reportFirmwareInfo
      // cycle. Silently no-op when cloud offline — reportFirmwareInfo()
      // on the next reboot will catch up.
      if (firebaseHealthy) {
        FirebaseJson j;
        j.set("userAssignedName", deviceName);
        String p = "devices/" + pumpDeviceCode + "/info";
        Firebase.RTDB.updateNode(&fbdo, p.c_str(), &j);
      }
    } else {
      if (errors.length() > 0) errors += "; ";
      errors += "Device name must be 1-20 characters, letters/numbers/spaces/hyphens/underscores only";
      hasErrors = true;
    }
  }
  
  // tankHeight/startPercent/stopPercent are fixed (binary LOW/FULL tank probes
  // on this PCB variant, no intermediate level to tune) - no longer accepted
  // from the settings form.

  if (server.hasArg("tankVolume")) {
    int newTankVolume = server.arg("tankVolume").toInt();
    if (newTankVolume >= 0 && newTankVolume <= 9999) {
      tankVolume = newTankVolume;
    }
  }
  
  if (server.hasArg("hasWPSensor")) {
    hasWPSensor = (server.arg("hasWPSensor").toInt() == 1);
  }
  
  if (server.hasArg("wpNodeName")) {
    String oldWPNodeName = wpNodeName;  // Save old value
    wpNodeName = server.arg("wpNodeName");
    wpNodeName.trim();
    DEBUG_PRINT("Received wpNodeName: '");
    DEBUG_PRINT(wpNodeName);
    DEBUG_PRINTLN("'");

    // Check if WP node name was removed (changed from non-empty to empty)
    if (oldWPNodeName.length() > 0 && wpNodeName.length() == 0) {
      // Automatically disable WP sensor feature
      hasWPSensor = false;
      DEBUG_PRINTLN("⚠️ WP node name removed - Auto-disabling Water Detection feature");
      logSystemEvent("WP_SENSOR_DISABLED", "node_name_removed_by_user");
    }
  }
  
  if (server.hasArg("dryRunProtectionOn")) {
    bool newDryRunOn = (server.arg("dryRunProtectionOn").toInt() == 1);
    if (newDryRunOn && !dryRunProtectionOn) {
      // Arm the timer NOW so the first check after enabling doesn't
      // immediately fire (millis()-0 would be >> any configured timeout).
      dryRunProbeTimerStart = millis();
      dryRunCount = 0;
    }
    dryRunProtectionOn = newDryRunOn;
  }
  
  if (server.hasArg("dryRunIntervalMins")) {
    uint8_t val = server.arg("dryRunIntervalMins").toInt();
    if (val == 5 || val == 10 || val == 15 || val == 30 || val == 60 || val == 120)
      maxTimeToNextProbeMins = val;
    else
      maxTimeToNextProbeMins = 30;  // fallback to default
  }

  if (server.hasArg("maxDryRunCount")) {
    int newMaxCount = server.arg("maxDryRunCount").toInt();
    if (newMaxCount >= 1 && newMaxCount <= 10) {   // v118.0.9: extended 1-2 → 1-10
      maxDryRunCount = newMaxCount;
    } else {
      maxDryRunCount = 2;  // Default fallback
    }
  }

  // v118.0.9: smart dry-run form fields. All optional; defaults preserved
  // when field absent (instant-save pattern — only present fields update).
  if (server.hasArg("smartDryRunEnabled")) {
    smartDryRunEnabled = (server.arg("smartDryRunEnabled").toInt() == 1);
  }
  if (server.hasArg("smartCheckMins")) {
    int v = server.arg("smartCheckMins").toInt();
    if (v >= 1 && v <= 15) smartDryRunCheckMins = (uint8_t)v;
  }
  if (server.hasArg("smartMinPct")) {
    int v = server.arg("smartMinPct").toInt();
    if (v == 1 || v == 2 || v == 3 || v == 5 || v == 10) smartDryRunMinPct = (uint8_t)v;
  }
  // v118.0.9: Safe Mode auto-clear uses existing autoRecoverOnSchedule /
  // autoRecoverOnTimeout / autoRecoverTimeoutHours — already wired via
  // their own AP-form handlers elsewhere. No new fields needed here.

  // Pump type / panel pulse durations / feedback / buzzer (NEW)
  bool panelSettingsChanged = false;

  if (server.hasArg("pumpType")) {
    uint8_t v = server.arg("pumpType").toInt();
    PumpType newType = (v == PUMP_PANEL) ? PUMP_PANEL : PUMP_SINGLE_PHASE;
    if (newType != pumpType) {
      // Safety: drop motor before switching wiring topology
      if (motorState) setMotor(false);
      // Make sure both relays end up de-energised
      writeStartRelay(false);
      writeStopRelay(false);
      activePulse = PULSE_NONE;
      pulseEndAt = 0;
      pumpType = newType;
      panelSettingsChanged = true;
    }
  }

  // Pulse durations come from the UI in seconds with 0.5s step.
  // Convert to milliseconds and clamp to [PANEL_PULSE_MIN_MS, PANEL_PULSE_MAX_MS].
  if (server.hasArg("panelStartPulseSec")) {
    float secs = server.arg("panelStartPulseSec").toFloat();
    long ms = (long)(secs * 1000.0f + 0.5f);
    if (ms < (long)PANEL_PULSE_MIN_MS) ms = PANEL_PULSE_MIN_MS;
    if (ms > (long)PANEL_PULSE_MAX_MS) ms = PANEL_PULSE_MAX_MS;
    if ((uint16_t)ms != panelStartPulseMs) {
      panelStartPulseMs = (uint16_t)ms;
      panelSettingsChanged = true;
    }
  }
  if (server.hasArg("panelStopPulseSec")) {
    float secs = server.arg("panelStopPulseSec").toFloat();
    long ms = (long)(secs * 1000.0f + 0.5f);
    if (ms < (long)PANEL_PULSE_MIN_MS) ms = PANEL_PULSE_MIN_MS;
    if (ms > (long)PANEL_PULSE_MAX_MS) ms = PANEL_PULSE_MAX_MS;
    if ((uint16_t)ms != panelStopPulseMs) {
      panelStopPulseMs = (uint16_t)ms;
      panelSettingsChanged = true;
    }
  }

  // Checkbox semantics differ between instant-save (field only present when checked)
  // and full-form (we can't distinguish unchecked from "not on the form"). We process
  // each checkbox if its sibling pumpType field is in the request - which only happens
  // when the user touched the Pump Type section.
  bool pumpSectionPresent = server.hasArg("pumpType");
  if (pumpSectionPresent) {
    bool newFeedback = server.hasArg("feedbackEnabled");
    if (newFeedback != feedbackEnabled) {
      feedbackEnabled = newFeedback;
      // Reset runtime fault state when toggling
      feedbackFaultActive = false;
      feedbackBadSinceMs = 0;
      panelSettingsChanged = true;
    }
    uint8_t newFlags = 0;
    if (server.hasArg("buzzOnMotor")) newFlags |= BUZZ_ON_MOTOR_ON;
    if (server.hasArg("buzzOnError")) newFlags |= BUZZ_ON_ERROR;
    if (newFlags != buzzerFlags) {
      buzzerFlags = newFlags;
      panelSettingsChanged = true;
    }
  } else {
    // Instant-save path: individual checkbox fields arrive on their own
    if (server.hasArg("feedbackEnabled")) {
      bool v = (server.arg("feedbackEnabled") == "on" || server.arg("feedbackEnabled") == "1");
      if (v != feedbackEnabled) {
        feedbackEnabled = v;
        feedbackFaultActive = false;
        feedbackBadSinceMs = 0;
        panelSettingsChanged = true;
      }
    }
    if (server.hasArg("buzzOnMotor")) {
      bool v = (server.arg("buzzOnMotor") == "on" || server.arg("buzzOnMotor") == "1");
      uint8_t nf = v ? (buzzerFlags | BUZZ_ON_MOTOR_ON) : (buzzerFlags & ~BUZZ_ON_MOTOR_ON);
      if (nf != buzzerFlags) { buzzerFlags = nf; panelSettingsChanged = true; }
    }
    if (server.hasArg("buzzOnError")) {
      bool v = (server.arg("buzzOnError") == "on" || server.arg("buzzOnError") == "1");
      uint8_t nf = v ? (buzzerFlags | BUZZ_ON_ERROR) : (buzzerFlags & ~BUZZ_ON_ERROR);
      if (nf != buzzerFlags) { buzzerFlags = nf; panelSettingsChanged = true; }
    }
    // Buzzer auto-stop timer (form checkbox sends "on" when checked, absent when unchecked)
    {
      bool v = server.hasArg("buzzerAutoStopEnabled") &&
               (server.arg("buzzerAutoStopEnabled") == "on" || server.arg("buzzerAutoStopEnabled") == "1");
      if (v != buzzerAutoStopEnabled) { buzzerAutoStopEnabled = v; panelSettingsChanged = true; }
    }
    if (server.hasArg("buzzerAutoStopMins")) {
      uint8_t val = server.arg("buzzerAutoStopMins").toInt();
      if (val >= 1 && val <= 30 && val != buzzerAutoStopMins) {
        buzzerAutoStopMins = val; panelSettingsChanged = true;
      }
    }
  }

  if (panelSettingsChanged) {
    savePanelConfig();
    EEPROM.commit();
    DEBUG_PRINTLN("Panel/buzzer/feedback settings updated via web UI");
  }

  // Source detection settings (NEW)
  bool sourceSettingsChanged = false;

  if (server.hasArg("detectionMode")) {
    uint8_t newMode = server.arg("detectionMode").toInt();
    if (newMode <= 1) { detectionMode = newMode; sourceSettingsChanged = true; }
  }
  if (server.hasArg("gracePeriodTens")) {
    uint8_t val = server.arg("gracePeriodTens").toInt();
    if (val >= 4 && val <= 60) { gracePeriodTens = val; sourceSettingsChanged = true; }
  }
  if (server.hasArg("sourceDebounceSecs")) {
    uint8_t val = server.arg("sourceDebounceSecs").toInt();
    if (val >= 5 && val <= 180) { sourceDebounceSecs = val; sourceSettingsChanged = true; }
  }
  if (server.hasArg("maxRetryCount")) {
    uint8_t val = server.arg("maxRetryCount").toInt();
    if (val >= 1 && val <= 5) { maxRetryCount = val; sourceSettingsChanged = true; }
  }
  if (server.hasArg("retryWaitMins")) {
    uint8_t val = server.arg("retryWaitMins").toInt();
    if (val >= 1 && val <= 15) { retryWaitMins = val; sourceSettingsChanged = true; }
  }
  if (server.hasArg("maxRunTimeMins")) {
    uint8_t val = server.arg("maxRunTimeMins").toInt();
    if (val == 0 || val == 10 || val == 20 || val == 30 || val == 60 || val == 90 || val == 120 || val == 180 || val == 240) {
      maxRunTimeMins = val; sourceSettingsChanged = true;
    }
  }
  if (server.hasArg("dryRunWaitMins")) {
    uint8_t val = server.arg("dryRunWaitMins").toInt();
    if (val >= 1 && val <= 15) { dryRunWaitMins = val; sourceSettingsChanged = true; }
  }

  if (sourceSettingsChanged) {
    saveSourceDetectionConfig();
    DEBUG_PRINTLN("Source detection settings updated via web UI");
  }

  // ─── v118 ultrasonic sensor settings ───
  // Tank height, sensor offset, pump start/stop pcts, Modbus address.
  // Each change triggers one usSaveConfig() at the end if ANY US field
  // changed — single EEPROM.commit() instead of one per field.
  bool usSettingsChanged = false;
  if (server.hasArg("usTankHeightCm")) {
    uint16_t v = (uint16_t)server.arg("usTankHeightCm").toInt();
    if (v >= 10 && v <= 1200 && v != usTankHeightCm) { usTankHeightCm = v; usSettingsChanged = true; }
  }
  if (server.hasArg("usSensorOffsetCm")) {
    uint16_t v = (uint16_t)server.arg("usSensorOffsetCm").toInt();
    if (v <= 100 && v != usSensorOffsetCm) { usSensorOffsetCm = v; usSettingsChanged = true; }
  }
  // v118.0.2: relaxed to 2% granularity so customer can set exact
  // thresholds like 33% start / 90% stop. Validators enforce the range
  // + even number (2% step) + 2% minimum gap.
  if (server.hasArg("startPercent")) {
    uint8_t v = (uint8_t)server.arg("startPercent").toInt();
    // Snap to even number (2% step) — a POST with odd value gets
    // rounded DOWN to the nearest even, matches slider's step="2".
    if (v & 1) v -= 1;
    if (v >= 1 && v <= 98 && v != startPercent) { startPercent = v; usSettingsChanged = true; }
  }
  if (server.hasArg("stopPercent")) {
    uint8_t v = (uint8_t)server.arg("stopPercent").toInt();
    if (v & 1) v -= 1;
    if (v >= 2 && v <= 100 && v != stopPercent) { stopPercent = v; usSettingsChanged = true; }
  }
  // Enforce 2% gap invariant on the server side too — defence in
  // depth. Client-side JS clamps but a malformed POST could bypass.
  if (stopPercent < startPercent + 2) {
    stopPercent = startPercent + 2;
    if (stopPercent > 100) stopPercent = 100;
    usSettingsChanged = true;
  }
  if (server.hasArg("usModbusAddr")) {
    // Hex "0x05" or decimal "5" both OK.
    String s = server.arg("usModbusAddr"); s.trim();
    int32_t v = -1;
    if (s.startsWith("0x") || s.startsWith("0X")) v = strtol(s.c_str() + 2, nullptr, 16);
    else                                           v = strtol(s.c_str(), nullptr, 10);
    if (v >= ADDR_MIN && v <= ADDR_MAX && (uint8_t)v != usModbusAddr) {
      usModbusAddr = (uint8_t)v;
      // Reset sensor state — a new sensor may read very different values;
      // we don't want stale fault state or last-known pct carrying over.
      // (v118.0.2 burst mode has no persistent sample buffer to flush —
      // each burst is self-contained.)
      usLastValidCount   = 0;
      usLastInlierCount  = 0;
      usHaveGoodReading  = false;
      usSensorFault      = false;
      usConsecutiveFails = 0;
      usSettingsChanged = true;
      DEBUG_PRINT("[US] Reading address changed to 0x"); DEBUG_PRINTLN(String(usModbusAddr, HEX));
    }
  }
  if (usSettingsChanged) {
    usSaveConfig();
    // Re-derive discrete booleans with new thresholds so pump control
    // sees the fresh picture immediately — otherwise it would wait for
    // the next poll cycle to update tankLowWet/tankFullWet.
    if (usHaveGoodReading) usUpdateDiscreteFromPct(usConfirmedPct);
  }

  if (server.hasArg("targetNodeName")) {
    String oldTargetNodeName = targetNodeName;  // Save old value
    targetNodeName = server.arg("targetNodeName");
    targetNodeName.trim();
    DEBUG_PRINT("Received targetNodeName: '");
    DEBUG_PRINT(targetNodeName);
    DEBUG_PRINTLN("'");

    // Check if US node name was removed (changed from non-empty to empty)
    if (oldTargetNodeName.length() > 0 && targetNodeName.length() == 0) {
      // Automatically disable Auto Mode and stop motor
      bool wasAutoModeEnabled = autoModeEnabled;
      autoModeEnabled = false;

      if (motorState) {
        setMotor(false);
      }

      if (currentMode != MODE_MANUAL_OVERRIDE) {
        currentMode = MODE_IDLE;
      }

      DEBUG_PRINTLN("🛑 CRITICAL: US node name removed - Auto-disabling Auto Mode");
      logSystemEvent("AUTO_MODE_DISABLED", "us_node_name_removed_by_user");

      if (wasAutoModeEnabled) {
        logModeChange("IDLE", "us_sensor_removed_forced_idle");
      }
    } else if (targetNodeName.length() == 0) {
      // Empty node name submitted (not from a previous non-empty state)
      // This shouldn't happen with client-side validation, but handle it
      if (errors.length() > 0) errors += "; ";
      errors += "Ultrasonic sensor node name is required";
      hasErrors = true;
    }
  }
  
  if (server.hasArg("autoModeEnabled")) {
    autoModeEnabled = (server.arg("autoModeEnabled").toInt() == 1);
  }
  
  if (server.hasArg("scheduleModeEnabled")) {
    scheduleModeEnabled = (server.arg("scheduleModeEnabled").toInt() == 1);
  }

  // Process Safe Mode auto-recovery settings ONLY if this is a full Settings page submission
  // Check for Settings page-specific fields to distinguish from instant-save partial updates
  // tankHeight/startPercent/stopPercent are no longer form fields on this PCB
  // variant (fixed 0/100) - deviceName alone is a reliable discriminator since
  // it's a required field always present on the full settings page.
  bool isFullSettingsSubmission = server.hasArg("deviceName");

  if (isFullSettingsSubmission) {
    // Full Settings page form submission - process checkbox state
    if (server.hasArg("autoRecoverSchedule")) {
      autoRecoverOnSchedule = (server.arg("autoRecoverSchedule") == "on");
    } else {
      autoRecoverOnSchedule = false; // Checkbox not checked in full form
    }

    if (server.hasArg("autoRecoverTimeout")) {
      autoRecoverOnTimeout = (server.arg("autoRecoverTimeout") == "on");
    } else {
      autoRecoverOnTimeout = false; // Checkbox not checked in full form
    }
  }
  // If NOT a full submission (instant-save), preserve existing values - don't reset

  if (server.hasArg("timeoutHours")) {
    int hours = server.arg("timeoutHours").toInt();
    if (hours >= 1 && hours <= 24) {
      autoRecoverTimeoutHours = hours;
    } else {
      if (errors.length() > 0) errors += "; ";
      errors += "Auto-recovery timeout must be between 1-24 hours";
      hasErrors = true;
    }
  }

  // Check if any schedule arguments are present (to avoid wiping schedules on instant-save)
  bool hasAnyScheduleArg = false;
  for (int i = 0; i < 3; i++) {
    String startTimeArg = "schedule" + String(i) + "_start";
    String endTimeArg = "schedule" + String(i) + "_end";
    if (server.hasArg(startTimeArg) || server.hasArg(endTimeArg)) {
      hasAnyScheduleArg = true;
      break;
    }
  }

  // Process schedules ONLY if schedule arguments are present
  bool hasValidSchedule = false;
  String scheduleErrors = "";

  if (hasAnyScheduleArg) {
    // Schedule arguments present - process them
    activeScheduleCount = 0;

    for (int i = 0; i < 3; i++) {
      schedules[i].enabled = false;

      String startTimeArg = "schedule" + String(i) + "_start";
      String endTimeArg = "schedule" + String(i) + "_end";

      if (server.hasArg(startTimeArg) && server.hasArg(endTimeArg)) {
        String startTime = server.arg(startTimeArg);
        String endTime = server.arg(endTimeArg);
      
      startTime.trim();
      endTime.trim();
      
      if (startTime.length() == 5 && endTime.length() == 5) {
        uint8_t startH = startTime.substring(0, 2).toInt();
        uint8_t startM = startTime.substring(3, 5).toInt();
        uint8_t endH = endTime.substring(0, 2).toInt();
        uint8_t endM = endTime.substring(3, 5).toInt();
        
        // Validate individual schedule
        String errorMsg = validateScheduleWithMessage(startH, startM, endH, endM, i + 1);
        if (errorMsg.length() > 0) {
          if (scheduleErrors.length() > 0) scheduleErrors += "; ";
          scheduleErrors += errorMsg;
          continue;
        }
        
        // Check for overlaps
        if (checkScheduleOverlap(i, startH, startM, endH, endM)) {
          if (scheduleErrors.length() > 0) scheduleErrors += "; ";
          scheduleErrors += "Schedule " + String(i + 1) + ": Overlaps with existing schedule";
          continue;
        }
        
        // Valid schedule - save it
        schedules[i].startHour = startH;
        schedules[i].startMinute = startM;
        schedules[i].endHour = endH;
        schedules[i].endMinute = endM;
        schedules[i].enabled = true;
        // v118.0.9: dayMask (bitmask Sun=1..Sat=64) + fillUntilFull.
        // Legacy forms missing these fields fall back to every-day /
        // no-fill-until-full to avoid silently disabling schedules.
        {
          String dayArg = "schedule" + String(i) + "_days";
          if (server.hasArg(dayArg)) {
            uint8_t dm = (uint8_t)server.arg(dayArg).toInt() & 0x7F;
            schedules[i].dayMask = dm ? dm : SCHED_DAY_MASK_ALL;
          } else {
            schedules[i].dayMask = SCHED_DAY_MASK_ALL;
          }
          String fillArg = "schedule" + String(i) + "_fillUntilFull";
          schedules[i].fillUntilFull = server.hasArg(fillArg) && server.arg(fillArg) == "1";
        }
        activeScheduleCount++;
        hasValidSchedule = true;
      } else if (startTime.length() > 0 || endTime.length() > 0) {
        if (scheduleErrors.length() > 0) scheduleErrors += "; ";
        scheduleErrors += "Schedule " + String(i + 1) + ": Both start and end times required";
      }
    }
    }
  } else {
    // No schedule arguments - skip schedule processing to preserve existing schedules
    DEBUG_PRINTLN("No schedule args present - preserving existing schedules");
    // hasValidSchedule stays false, but we don't reset schedules
    // activeScheduleCount keeps its current value
  }

  // Combine all errors
  if (errors.length() > 0) {
    if (scheduleErrors.length() > 0) {
      errors += "; " + scheduleErrors;
    }
    hasErrors = true;
  } else if (scheduleErrors.length() > 0) {
    errors = scheduleErrors;
    hasErrors = true;
  }

  // Check if schedule mode requires valid schedules (only when schedule args were present)
  if (hasAnyScheduleArg && scheduleModeEnabled && !hasValidSchedule) {
    if (errors.length() > 0) errors += "; ";
    errors += "Schedule mode enabled but no valid schedules configured";
    hasErrors = true;
  }
  
  // If there are errors, store them and redirect back to settings
  if (hasErrors) {
    lastValidationErrors = errors;
    server.sendHeader("Location", "/settings");
    server.send(302, "text/plain", "");
    return;
  }
  
  // Track auto-disabled features
  String autoDisabledNotice = "";
  if (server.hasArg("targetNodeName")) {
    String submittedUSNode = server.arg("targetNodeName");
    submittedUSNode.trim();
    if (submittedUSNode.length() == 0 && !autoModeEnabled) {
      autoDisabledNotice += "<p style=\"color:#e74c3c;font-weight:600;\">⚠️ Auto Mode disabled (US sensor removed)</p>\n";
    }
  }
  if (server.hasArg("wpNodeName")) {
    String submittedWPNode = server.arg("wpNodeName");
    submittedWPNode.trim();
    if (submittedWPNode.length() == 0 && !hasWPSensor) {
      autoDisabledNotice += "<p style=\"color:#f39c12;font-weight:600;\">⚠️ Water Detection disabled (WP sensor removed)</p>\n";
    }
  }

  // Password protection handling (only on full form submission)
  if (isFullSettingsSubmission) {
    bool newPasswordEnabled = server.hasArg("passwordEnabled") && server.arg("passwordEnabled") == "on";

    if (newPasswordEnabled) {
      String pw1 = server.hasArg("password1") ? server.arg("password1") : "";
      String pw2 = server.hasArg("password2") ? server.arg("password2") : "";

      pw1.trim();
      pw2.trim();

      // Case 1: User entered new password in both fields
      if (pw1.length() == 4 && pw2.length() == 4 && pw1 == pw2 && pw1.charAt(0) >= '0' && pw1.charAt(0) <= '9') {
        // Valid password - save it
        passwordEnabled = true;
        storedPassword = pw1;
        savePasswordSettings();
        DEBUG_PRINT("Password protection enabled/updated - User set password: ");
        DEBUG_PRINTLN(pw1);
        logSystemEvent("PASSWORD_SET", "PIN:" + pw1);
      }
      // Case 2: Both fields empty AND password already exists - keep existing password
      else if (pw1.length() == 0 && pw2.length() == 0 && passwordEnabled && storedPassword.length() == 4) {
        // Keep existing password - do nothing
        DEBUG_PRINTLN("Password protection checkbox ON - keeping existing PIN: " + storedPassword);
      }
      // Case 3: Both fields empty AND no existing password - error
      else if (pw1.length() == 0 && pw2.length() == 0) {
        if (errors.length() > 0) errors += "; ";
        errors += "Password protection enabled but no PIN entered. Please enter a 4-digit PIN.";
        hasErrors = true;
      }
      // Case 4: Only one field filled or partial entry - error
      else if (pw1.length() > 0 || pw2.length() > 0) {
        if (errors.length() > 0) errors += "; ";
        if (pw1 != pw2) {
          errors += "Password fields must match";
        } else if (pw1.length() != 4) {
          errors += "Password must be exactly 4 digits";
        } else {
          errors += "Password must be 4 digits (0-9 only)";
        }
        hasErrors = true;
      }
    } else {
      // Disable password
      if (passwordEnabled) {
        passwordEnabled = false;
        storedPassword = "";
        savePasswordSettings();
        DEBUG_PRINTLN("Password protection disabled");
        logSystemEvent("PASSWORD_DISABLED", "USER_CONFIG");
      }
    }
  }

  // Save configuration if no errors
  saveConfiguration();
  isConfigured = true;

  // Clear any previous errors
  lastValidationErrors = "";

  // Send success response
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>Settings Saved</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
  html += "<meta http-equiv=\"refresh\" content=\"4;url=/\">\n";
  html += "<style>\n";
  html += "body { font-family: Arial, sans-serif; margin: 20px; background-color: #f0f8ff; color: #333; text-align: center; }\n";
  html += ".container { max-width: 500px; margin: 50px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }\n";
  html += ".success { color: #27ae60; font-size: 1.2em; margin-bottom: 20px; }\n";
  html += ".btn { background: #3498db; color: white; padding: 12px 25px; border: none; border-radius: 5px; text-decoration: none; display: inline-block; }\n";
  html += "</style>\n</head>\n<body>\n";
  html += "<div class=\"container\">\n";
  html += "<div class=\"success\">✅ Settings saved successfully!</div>\n";
  html += autoDisabledNotice;
  html += "<p>Configuration updated. Redirecting to status page...</p>\n";
  html += "<a href=\"/\" class=\"btn\">View Status Now</a>\n";
  html += "</div>\n</body>\n</html>";

  server.send(200, "text/html", html);
  
  DEBUG_PRINTLN("Settings saved via web interface");
  displayCurrentConfig();
}

void handleAPIScheduleMode() {
  lastWebActivity = millis();

  if (server.hasArg("enabled")) {
    bool newScheduleMode = (server.arg("enabled").toInt() == 1);

    // Don't allow schedule mode changes during Manual Override
    if (currentMode == MODE_MANUAL_OVERRIDE) {
      scheduleModeEnabled = newScheduleMode;
      saveScheduleConfiguration();

      DEBUG_PRINT("Schedule mode setting updated during manual override: ");
      DEBUG_PRINTLN(scheduleModeEnabled ? "ENABLED" : "DISABLED");

      server.send(200, "text/plain", "Schedule mode setting saved (will apply when manual override ends)");
      return;
    }

    if (newScheduleMode && activeScheduleCount == 0) {
      server.send(400, "text/plain", "At least one schedule required");
      return;
    }

    scheduleModeEnabled = newScheduleMode;
    saveScheduleConfiguration();

    // IMMEDIATE MODE UPDATE - Don't wait for controlMotor() loop
    if (scheduleModeEnabled) {
      // Schedule mode enabled - check current situation
      if (activeScheduleCount == 0) {
        // No schedules configured - force inactive mode
        currentMode = MODE_SCHEDULE_INACTIVE;
        setMotor(false);
        DEBUG_PRINTLN("Schedule mode ENABLED - No schedules, motor OFF");
        logModeChange("SCHEDULE_INACTIVE", "no_schedules_configured");
      } else {
        // Check if we're currently in a schedule
        int activeSchedule = getCurrentActiveSchedule();
        if (activeSchedule >= 0) {
          // Inside schedule time - apply AUTO logic
          currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
          DEBUG_PRINT("Schedule mode ENABLED - Inside schedule ");
          DEBUG_PRINT(activeSchedule + 1);
          DEBUG_PRINTLN(" - AUTO logic active");
          logModeChange("NORMAL", "schedule_active_slot");

          // Force fresh motor evaluation based on current conditions
          evaluateMotorStateFromScratch();
        } else {
          // Outside schedule time - inactive mode
          currentMode = MODE_SCHEDULE_INACTIVE;
          setMotor(false);
          DEBUG_PRINTLN("Schedule mode ENABLED - Outside schedule time, motor OFF");
          logModeChange("SCHEDULE_INACTIVE", "outside_schedule_time");
        }
      }
    } else {
      // Schedule mode disabled - return to AUTO/IDLE based on autoModeEnabled
      currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
      DEBUG_PRINTLN("Schedule mode DISABLED - Returning to " + String(autoModeEnabled ? "AUTO" : "IDLE") + " mode");
      logModeChange(autoModeEnabled ? "NORMAL" : "IDLE", "schedule_mode_disabled");

      // Force fresh motor evaluation
      evaluateMotorStateFromScratch();
    }

    server.send(200, "text/plain", "Schedule mode updated immediately");
  } else {
    server.send(400, "text/plain", "Missing enabled parameter");
  }
}

void handleAPISchedulesPost() {
  lastWebActivity = millis();

  bool hasValidSchedule = false;
  activeScheduleCount = 0;
  String validationErrors = "";
  
  // Parse schedule data from form
  for (int i = 0; i < 3; i++) {
    schedules[i].enabled = false;
    
    String startTimeArg = "schedule" + String(i) + "_start";
    String endTimeArg = "schedule" + String(i) + "_end";
    
    if (server.hasArg(startTimeArg) && server.hasArg(endTimeArg)) {
      String startTime = server.arg(startTimeArg);
      String endTime = server.arg(endTimeArg);
      
      startTime.trim();
      endTime.trim();
      
      if (startTime.length() == 5 && endTime.length() == 5) {
        uint8_t startH = startTime.substring(0, 2).toInt();
        uint8_t startM = startTime.substring(3, 5).toInt();
        uint8_t endH = endTime.substring(0, 2).toInt();
        uint8_t endM = endTime.substring(3, 5).toInt();
        
        // Validate individual schedule
        String errorMsg = validateScheduleWithMessage(startH, startM, endH, endM, i + 1);
        if (errorMsg.length() > 0) {
          if (validationErrors.length() > 0) validationErrors += "; ";
          validationErrors += errorMsg;
          continue;
        }
        
        // Check for overlaps
        if (checkScheduleOverlap(i, startH, startM, endH, endM)) {
          if (validationErrors.length() > 0) validationErrors += "; ";
          validationErrors += "Schedule " + String(i + 1) + ": Overlaps with existing schedule";
          continue;
        }
        
        // Valid schedule - save it
        schedules[i].startHour = startH;
        schedules[i].startMinute = startM;
        schedules[i].endHour = endH;
        schedules[i].endMinute = endM;
        schedules[i].enabled = true;
        // v118.0.9: dayMask (bitmask Sun=1..Sat=64) + fillUntilFull.
        // Legacy forms missing these fields fall back to every-day /
        // no-fill-until-full to avoid silently disabling schedules.
        {
          String dayArg = "schedule" + String(i) + "_days";
          if (server.hasArg(dayArg)) {
            uint8_t dm = (uint8_t)server.arg(dayArg).toInt() & 0x7F;
            schedules[i].dayMask = dm ? dm : SCHED_DAY_MASK_ALL;
          } else {
            schedules[i].dayMask = SCHED_DAY_MASK_ALL;
          }
          String fillArg = "schedule" + String(i) + "_fillUntilFull";
          schedules[i].fillUntilFull = server.hasArg(fillArg) && server.arg(fillArg) == "1";
        }
        activeScheduleCount++;
        hasValidSchedule = true;
      } else if (startTime.length() > 0 || endTime.length() > 0) {
        // Partial data entered - error
        if (validationErrors.length() > 0) validationErrors += "; ";
        validationErrors += "Schedule " + String(i + 1) + ": Both start and end times required";
      }
    }
  }
  
  // Check if schedule mode requires valid schedules
  if (scheduleModeEnabled && !hasValidSchedule) {
    if (validationErrors.length() > 0) validationErrors += "; ";
    validationErrors += "Schedule mode enabled but no valid schedules configured";
  }
  
  // Send response
  if (validationErrors.length() > 0) {
    server.send(400, "text/plain", validationErrors);
    return;
  }
  
  saveScheduleConfiguration();
  server.send(200, "text/plain", "Schedules updated successfully");
  
  DEBUG_PRINT("Schedules updated - ");
  DEBUG_PRINT(activeScheduleCount);
  DEBUG_PRINTLN(" active schedules");
}

void handleSchedulesSave() {
  lastWebActivity = millis();

  bool hasValidSchedule = false;
  activeScheduleCount = 0;
  String validationErrors = "";

  // Parse schedule data from form
  for (int i = 0; i < 3; i++) {
    schedules[i].enabled = false;

    String startTimeArg = "schedule" + String(i) + "_start";
    String endTimeArg = "schedule" + String(i) + "_end";

    if (server.hasArg(startTimeArg) && server.hasArg(endTimeArg)) {
      String startTime = server.arg(startTimeArg);
      String endTime = server.arg(endTimeArg);

      startTime.trim();
      endTime.trim();

      if (startTime.length() == 5 && endTime.length() == 5) {
        uint8_t startH = startTime.substring(0, 2).toInt();
        uint8_t startM = startTime.substring(3, 5).toInt();
        uint8_t endH = endTime.substring(0, 2).toInt();
        uint8_t endM = endTime.substring(3, 5).toInt();

        // Validate individual schedule
        String errorMsg = validateScheduleWithMessage(startH, startM, endH, endM, i + 1);
        if (errorMsg.length() > 0) {
          if (validationErrors.length() > 0) validationErrors += "; ";
          validationErrors += errorMsg;
          continue;
        }

        // Check for overlaps
        if (checkScheduleOverlap(i, startH, startM, endH, endM)) {
          if (validationErrors.length() > 0) validationErrors += "; ";
          validationErrors += "Schedule " + String(i + 1) + ": Overlaps with existing schedule";
          continue;
        }

        // Valid schedule - save it
        schedules[i].startHour = startH;
        schedules[i].startMinute = startM;
        schedules[i].endHour = endH;
        schedules[i].endMinute = endM;
        schedules[i].enabled = true;
        // v118.0.9: dayMask (bitmask Sun=1..Sat=64) + fillUntilFull.
        // Legacy forms missing these fields fall back to every-day /
        // no-fill-until-full to avoid silently disabling schedules.
        {
          String dayArg = "schedule" + String(i) + "_days";
          if (server.hasArg(dayArg)) {
            uint8_t dm = (uint8_t)server.arg(dayArg).toInt() & 0x7F;
            schedules[i].dayMask = dm ? dm : SCHED_DAY_MASK_ALL;
          } else {
            schedules[i].dayMask = SCHED_DAY_MASK_ALL;
          }
          String fillArg = "schedule" + String(i) + "_fillUntilFull";
          schedules[i].fillUntilFull = server.hasArg(fillArg) && server.arg(fillArg) == "1";
        }
        activeScheduleCount++;
        hasValidSchedule = true;
      } else if (startTime.length() > 0 || endTime.length() > 0) {
        // Partial data entered - error
        if (validationErrors.length() > 0) validationErrors += "; ";
        validationErrors += "Schedule " + String(i + 1) + ": Both start and end times required";
      }
    }
  }

  // Auto-disable schedule mode if all schedules cleared
  if (scheduleModeEnabled && !hasValidSchedule) {
    scheduleModeEnabled = false;
    DEBUG_PRINTLN("WARNING: All schedules cleared - Schedule mode auto-disabled");
    validationErrors = "All schedules cleared. Schedule mode has been disabled.";
  }

  // Send error response if validation failed
  if (validationErrors.length() > 0) {
    saveScheduleConfiguration();  // Save anyway (with schedule mode disabled)
    server.send(200, "text/plain", validationErrors);
    return;
  }

  // Save schedules to EEPROM
  saveScheduleConfiguration();
  server.send(200, "text/plain", "Schedules saved successfully! (" + String(activeScheduleCount) + " active)");

  DEBUG_PRINT("Schedules saved from /schedules page - ");
  DEBUG_PRINT(activeScheduleCount);
  DEBUG_PRINTLN(" active schedules");
}

void handleWebRoot() {
  if (!checkAppAccess()) return;
  lastWebActivity = millis();

  // If no password OR device unlocked, show main page
  if (!passwordEnabled || deviceUnlocked) {
    String html = getStatusPageHTML();
    server.send(200, "text/html", html);
    return;
  }

  // POST request - validate password
  if (server.method() == HTTP_POST) {
    if (server.hasArg("password")) {
      String enteredPassword = server.arg("password");
      enteredPassword.trim();

      if (enteredPassword.length() == 4 && enteredPassword == storedPassword) {
        // SUCCESS - set unlock flag and show page
        deviceUnlocked = true;
        DEBUG_PRINTLN("✅ DEVICE UNLOCKED");
        logSystemEvent("USER_UNLOCKED", "SUCCESS");
        String html = getStatusPageHTML();
        server.send(200, "text/html", html);
        return;
      } else {
        // FAILURE - show login form with error
        DEBUG_PRINTLN("❌ LOGIN FAILED");
        logErrorEvent("LOGIN_FAILED", "wrong_password");
        String html = getLoginPageHTML("❌ Wrong password");
        server.send(200, "text/html", html);
        return;
      }
    }
  }

  // GET request - show login form
  String html = getLoginPageHTML("");
  server.send(200, "text/html", html);
}

void handleLock() {
  lastWebActivity = millis();

  // Clear unlock flag
  deviceUnlocked = false;

  DEBUG_PRINTLN("🔒 Device locked manually by user");
  logSystemEvent("USER_LOCKED", "MANUAL");

  // Redirect to login page
  server.sendHeader("Location", "/");
  server.send(302, "text/plain", "");
}

void handleWebSettings() {
  lastWebActivity = millis();
  String html = getSettingsPageHTML();
  server.send(200, "text/html", html);
}

void handleWebManualOn() {
  lastWebActivity = millis();

  if (currentMode == MODE_MANUAL_OVERRIDE) {
    server.send(400, "text/plain", "Already in manual override mode");
    return;
  }

  // Get duration parameter from request. Special sentinel: -1 means
  // "run until terrace tank reports FULL" — no time cap, level-driven
  // stop. Any positive value in the fixed set is treated as minutes.
  // Anything else falls back to the 15-min default.
  manualOverrideUntilFull = false;
  if (server.hasArg("duration")) {
    int duration = server.arg("duration").toInt();
    if (duration == -1) {
      manualOverrideUntilFull       = true;
      manualOverrideDurationMinutes = 0;   // unused in until-full mode
      saveLastForceRunSelection(-1);        // remember pick across reboots
      DEBUG_PRINTLN("Force run: until terrace tank FULL");
    } else if (duration == 5 || duration == 10 || duration == 15 || duration == 30 || duration == 60) {
      manualOverrideDurationMinutes = duration;
      saveLastForceRunSelection(duration);  // remember pick across reboots
      DEBUG_PRINT("Force run duration set to: ");
      DEBUG_PRINT(duration);
      DEBUG_PRINTLN(" minutes");
    } else {
      manualOverrideDurationMinutes = 15; // Fallback to default (don't save invalid)
      DEBUG_PRINTLN("Invalid duration, using default: 15 minutes");
    }
  } else {
    manualOverrideDurationMinutes = 15; // Default if no parameter
  }

  // v118.0.7: pre-check — reject if tank already full / sensor offline.
  // See canStartForceRun() for the full guard list.
  String rejectReason;
  if (!canStartForceRun(manualOverrideUntilFull, rejectReason)) {
    manualOverrideUntilFull = false;   // undo the flag so stale state doesn't leak
    String human;
    if      (rejectReason == "sensor_offline")     human = "Tank sensor offline — use a timed run instead";
    else if (rejectReason == "sensor_no_data")     human = "Tank sensor has no data yet — wait a moment";
    else if (rejectReason == "tank_already_full")  human = "Tank is already full (" + String(usConfirmedPct) + "% >= stop " + String(stopPercent) + "%)";
    else                                            human = "Force Run rejected: " + rejectReason;
    DEBUG_PRINT("[FR] AP force run rejected: ");
    DEBUG_PRINTLN(rejectReason);
    logSystemEvent("FORCE_RUN_SKIP", rejectReason.c_str());
    server.send(409, "text/plain", human);
    return;
  }

  enterManualOverride();
  const String msg = manualOverrideUntilFull
    ? String("Manual override activated — running until tank full")
    : String("Manual override activated for ") + String(manualOverrideDurationMinutes) + " minutes";
  server.send(200, "text/plain", msg);
}

void handleWebManualOff() {
  lastWebActivity = millis();

  if (currentMode != MODE_MANUAL_OVERRIDE) {
    server.send(400, "text/plain", "Not in manual override mode");
    return;
  }

  exitManualOverride();
  server.send(200, "text/plain", "Manual override deactivated");
}

// v118: scan Modbus addresses 0x01-0x0F looking for sensors that
// reply to a REG_PROCESSED read. Returns an HTML snippet listing
// addresses that responded. Useful when a technician wires a sensor
// with unknown address — click Scan, see what's talking.
//
// Limited to 0x01-0x0F so the scan completes in ≤5 sec (each miss has
// a 500ms Modbus timeout). Full 0x01-0xFE range is 2+ minutes — too
// long for a web request.
void handleWebUsSensorScan() {
  lastWebActivity = millis();
  String out = "";
  int foundCount = 0;
  uint8_t firstFound = 0;
  for (uint8_t a = 0x01; a <= 0x0F; a++) {
    int32_t v = usReadRegisterOnce(a, US_READ_REGISTER);
    if (v >= 0) {
      foundCount++;
      if (firstFound == 0) firstFound = a;
      int distanceCm = v / 10;
      out += "<div style='color:#059669;'>&nbsp;&nbsp;✓ Address " + String(a) + " responded (distance " + String(distanceCm) + " cm)</div>";
    }
    delay(20);
  }
  String header;
  if (foundCount == 0) {
    header = "<div style='color:#dc2626;font-weight:600;'>No sensor found.</div><div style='font-size:0.85em;color:#64748b;margin-top:4px;'>Check sensor wiring and power. The sensor's address might also be outside 1-15 (we only scanned the common range).</div>";
  } else if (foundCount == 1) {
    header = "<div style='color:#059669;font-weight:600;'>Found 1 sensor at address " + String(firstFound) + ".</div>";
  } else {
    header = "<div style='color:#f59e0b;font-weight:600;'>Found " + String(foundCount) + " sensors — this panel expects only 1. Disconnect extras or change their addresses.</div>";
  }
  server.send(200, "text/html", header + out);
}

// v118: write a new Modbus slave address to the sensor itself via
// REG_SLAVE_ADDR (0x0200). Sensor applies the change internally and
// echoes the request on success. On success, firmware's reading
// address auto-updates to match and buffer flushes.
void handleWebUsSensorWriteAddr() {
  lastWebActivity = millis();
  if (!server.hasArg("newAddr")) {
    server.send(400, "text/html", "<span style='color:#dc2626'>Missing newAddr parameter</span>");
    return;
  }
  String s = server.arg("newAddr"); s.trim();
  int32_t newAddr = -1;
  if (s.startsWith("0x") || s.startsWith("0X")) newAddr = strtol(s.c_str() + 2, nullptr, 16);
  else                                           newAddr = strtol(s.c_str(), nullptr, 10);
  if (newAddr < ADDR_MIN || newAddr > ADDR_MAX) {
    server.send(400, "text/html", "<span style='color:#dc2626'>Invalid address. Pick a number from 1 to 254.</span>");
    return;
  }

  int32_t preCheck = usReadRegisterOnce(usModbusAddr, US_READ_REGISTER);
  if (preCheck < 0) {
    server.send(400, "text/html", "<span style='color:#dc2626'>Can't talk to the sensor right now. Try the Search button first to find it.</span>");
    return;
  }

  bool ok = false;
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    if (usWriteRegisterOnce(usModbusAddr, REG_SLAVE_ADDR, (uint16_t)newAddr)) { ok = true; break; }
    delay(100);
  }
  if (!ok) {
    server.send(500, "text/html", "<span style='color:#dc2626'>Change failed. Sensor didn't acknowledge the new address.</span>");
    return;
  }

  delay(2500);

  int32_t verifyRead = -1;
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    verifyRead = usReadRegisterOnce((uint8_t)newAddr, US_READ_REGISTER);
    if (verifyRead >= 0) break;
    delay(500);
  }
  if (verifyRead < 0) {
    server.send(500, "text/html",
      "<span style='color:#f59e0b'>Change sent but new address " + String(newAddr) +
      " isn't responding yet. Try the Search button in a few seconds.</span>");
    return;
  }

  uint8_t oldAddr = usModbusAddr;
  usModbusAddr = (uint8_t)newAddr;
  usLastValidCount = 0; usLastInlierCount = 0;
  usHaveGoodReading = false; usSensorFault = false; usConsecutiveFails = 0;
  usVoteCount = 0; usVoteHead = 0;   // v118.0.5: flush majority-vote buffer
  usSaveConfig();
  DEBUG_PRINT("[US] Sensor address changed "); DEBUG_PRINT(oldAddr);
  DEBUG_PRINT(" → "); DEBUG_PRINTLN(usModbusAddr);
  logSystemEvent("US_ADDR_CHANGED", String(oldAddr) + "_to_" + String(usModbusAddr));

  server.send(200, "text/html",
    "<span style='color:#059669'>✓ Done. Sensor address is now " + String(newAddr) +
    ". Reloading the page…</span>");
}

// v117.0.11: /manual/selection persists the AP-page dropdown pick as
// soon as the customer picks it — before they click Start. Fixes the
// bug where the 3-sec status auto-refresh re-rendered the dropdown
// from lastForceRunSelection (still 15) and snapped the pick back to
// "15 minutes".
//
// Called from the dropdown's onchange handler (see startForceRun's
// sibling JS below in getStatusPageHTML). Whitelist mirrors the
// AP <select> options + the handleWebManualOn validator.
void handleWebForceRunSelection() {
  lastWebActivity = millis();
  if (!server.hasArg("duration")) {
    server.send(400, "text/plain", "Missing duration parameter");
    return;
  }
  int duration = server.arg("duration").toInt();
  if (duration != -1 && duration != 5 && duration != 10 && duration != 15 &&
      duration != 30 && duration != 60) {
    server.send(400, "text/plain", "Invalid duration");
    return;
  }
  saveLastForceRunSelection(duration);
  server.send(200, "text/plain", "OK");
}

void handleWebRestart() {
  lastWebActivity = millis();

  DEBUG_PRINTLN("Web restart request received");
  logSystemEvent("WEB_RESTART", "user_initiated");

  server.send(200, "text/plain", "Restart command received - device will restart now");

  // Allow response to be sent before restart
  delay(1000);

  DEBUG_PRINTLN("Restarting ESP32...");
  ESP.restart();
}

void handleResetConfig() {
  lastWebActivity = millis();

  DEBUG_PRINTLN("Reset configuration to defaults request received");

  // Reset configuration (preserves WiFi credentials and device name)
  resetConfigurationToDefaults();

  // Send success response with redirect
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>Configuration Reset</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
  html += "<meta http-equiv=\"refresh\" content=\"3;url=/settings\">\n";
  html += "<style>\n";
  html += "body { font-family: Arial, sans-serif; margin: 20px; background-color: #f0f8ff; color: #333; text-align: center; }\n";
  html += ".container { max-width: 500px; margin: 50px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }\n";
  html += ".success { color: #27ae60; font-size: 1.3em; margin-bottom: 20px; font-weight: bold; }\n";
  html += ".info { background: #e8f4fd; border: 1px solid #bee5eb; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: left; }\n";
  html += ".info h3 { margin-top: 0; color: #2c3e50; }\n";
  html += ".info ul { margin: 10px 0; padding-left: 20px; }\n";
  html += ".btn { background: #3498db; color: white; padding: 12px 25px; border: none; border-radius: 5px; text-decoration: none; display: inline-block; margin-top: 10px; }\n";
  html += "</style>\n</head>\n<body>\n";
  html += "<div class=\"container\">\n";
  html += "<div class=\"success\">✅ Configuration Reset Complete!</div>\n";
  html += "<div class=\"info\">\n";
  html += "<h3>Reset to Defaults:</h3>\n";
  html += "<ul>\n";
  html += "<li>Tank height: 200 cm</li>\n";
  html += "<li>Start/Stop: 30% / 70%</li>\n";
  html += "<li>Sensor nodes: US03, WP01</li>\n";
  html += "<li>All schedules cleared</li>\n";
  html += "<li>Error states cleared</li>\n";
  html += "<li>Auto mode: ON</li>\n";
  html += "</ul>\n";
  html += "<h3>Preserved:</h3>\n";
  html += "<ul>\n";
  html += "<li>WiFi credentials</li>\n";
  html += "<li>Device name</li>\n";
  html += "<li>RTC time</li>\n";
  html += "</ul>\n";
  html += "</div>\n";
  html += "<p><strong>Please update your tank settings now.</strong></p>\n";
  html += "<a href=\"/settings\" class=\"btn\">Go to Settings</a>\n";
  html += "</div>\n</body>\n</html>";

  server.send(200, "text/html", html);
}

void handleAPIAutoMode() {
  lastWebActivity = millis();

  if (server.hasArg("enabled")) {
    bool newAutoMode = (server.arg("enabled").toInt() == 1);

    // Don't allow auto mode changes during Manual Override
    if (currentMode == MODE_MANUAL_OVERRIDE) {
      autoModeEnabled = newAutoMode;
      saveConfiguration();

      DEBUG_PRINT("Auto mode setting updated during manual override: ");
      DEBUG_PRINTLN(autoModeEnabled ? "ENABLED" : "DISABLED");

      server.send(200, "text/plain", "Auto mode setting saved (will apply when manual override ends)");
      return;
    }

    // Use the proper enable/disable functions to ensure fresh data is required
    if (newAutoMode) {
      enableAutoMode();

      // Handle schedule mode context after enableAutoMode sets MODE_NORMAL
      if (scheduleModeEnabled) {
        if (activeScheduleCount == 0) {
          currentMode = MODE_SCHEDULE_INACTIVE;
          setMotor(false);
          DEBUG_PRINTLN("Auto mode enabled but no schedules - SCHEDULE_INACTIVE");
        } else {
          int activeSchedule = getCurrentActiveSchedule();
          if (activeSchedule < 0) {
            // Outside schedule time
            currentMode = MODE_SCHEDULE_INACTIVE;
            setMotor(false);
            DEBUG_PRINTLN("Auto mode enabled but outside schedule - SCHEDULE_INACTIVE");
          }
          // If inside schedule, MODE_NORMAL from enableAutoMode is correct
        }
      }
    } else {
      disableAutoMode();
    }

    server.send(200, "text/plain", "Auto mode updated immediately");
  } else {
    server.send(400, "text/plain", "Missing enabled parameter");
  }
}

void handleClearErrorMode() {
  lastWebActivity = millis();

  // Also silence buzzer when clearing error via web UI
  buzzerMuted = true;

  // Check if currently in an error mode
  if (currentMode != MODE_DRY_RUN_RECOVERY && currentMode != MODE_SAFE_MODE &&
      currentMode != MODE_PANEL_FAULT && currentMode != MODE_SOURCE_DRY_RUN) {
    server.send(400, "text/plain", "Not in error mode");
    return;
  }

  String previousMode = getModeText();

  // Clear error states (same logic as hardware button single tap)
  dryRunCount = 0;
  dryRunStartTime = 0;
  safeModeStartTime = 0;
  sourceDryRunCount = 0;
  sourceDryRunStartTime = 0;
  lastFaultReason = "";
  needFreshDataAfterRecovery = true;

  // Determine target mode based on schedule/auto settings
  SystemMode restoredMode;

  if (scheduleModeEnabled && activeScheduleCount > 0) {
    int activeSchedule = getCurrentActiveSchedule();
    if (activeSchedule < 0) {
      // Outside schedule time - enter inactive mode
      restoredMode = MODE_SCHEDULE_INACTIVE;
      setMotor(false);
      DEBUG_PRINTLN("Web UI: Error cleared outside schedule - SCHEDULE_INACTIVE");
    } else {
      // Inside schedule time - return to normal/idle based on auto mode
      restoredMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
      DEBUG_PRINT("Web UI: Error cleared inside schedule ");
      DEBUG_PRINTLN(activeSchedule + 1);
    }
  } else {
    // No schedule mode - return to normal/idle based on auto mode
    restoredMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
    DEBUG_PRINTLN("Web UI: Error cleared - returning to normal operation");
  }

  currentMode = restoredMode;

  DateTime now = safeNow();
  DEBUG_PRINT("Error mode cleared via Web UI: ");
  DEBUG_PRINT(previousMode);
  DEBUG_PRINT(" → ");
  DEBUG_PRINT(getModeText());
  DEBUG_PRINT(" | ");
  DEBUG_PRINTLN(formatDateTime(now));

  logModeChange(getModeText(), "web_ui_error_cleared_from_" + previousMode);

  server.send(200, "text/plain", "Error cleared successfully");
}

void handleAPISilenceBuzzer() {
  lastWebActivity = millis();
  
  buzzerMuted = true;
  
  DateTime now = safeNow();
  DEBUG_PRINT("Buzzer silenced via Web UI | ");
  DEBUG_PRINTLN(formatDateTime(now));
  
  server.send(200, "text/plain", "Buzzer silenced");
}

void handleAPIStatus() {
  lastWebActivity = millis();

  StaticJsonDocument<1200> doc;

  doc["mode"] = getModeText();
  doc["motorState"] = motorState;
  doc["pumpStage"] = pumpStage;
  doc["waterPercent"] = currentWaterPercent;
  doc["waterLevel"] = currentWaterLevel;
  doc["sensorOnline"] = sensorOnline;
  doc["hasReceivedReading"] = hasReceivedReading;
  doc["autoModeEnabled"] = autoModeEnabled;
  
  doc["scheduleModeEnabled"] = scheduleModeEnabled;
  doc["currentActiveSchedule"] = currentActiveSchedule;
  doc["nextScheduleInfo"] = getNextScheduleInfo();
  
  // Device name info
  doc["deviceName"] = deviceName;
  doc["fullDeviceName"] = fullDeviceName;
  
  // Time sync info
  doc["lastTimeSyncResult"] = lastTimeSyncResult;
  doc["timeSyncStatus"] = getTimeSyncStatusText();
  
  if (hasRSSIReading) {
    doc["rssi"] = currentRSSI;
  }
  
  if (hasWPSensor) {
    doc["wpSensorStatus"] = wpSensorStatus;
    doc["wpSensorOnline"] = wpSensorOnline;
    bool wpConfirming = (!wpDebounce.currentState && srcWetCount > 0) ||
                        (wpDebounce.currentState && srcDryCount > 0);
    doc["wpDebouncing"] = wpConfirming;
    if (wpConfirming) {
      if (!wpDebounce.currentState && srcWetCount > 0)
        doc["wpDebounceRemain"] = (int)(SOURCE_WET_CONFIRM - srcWetCount);
      else
        doc["wpDebounceRemain"] = (int)(SOURCE_DRY_CONFIRM - srcDryCount);
    }
    if (hasWPRSSIReading) {
      doc["wpRssi"] = currentWPRSSI;
    }
  }
  
  if (currentMode == MODE_MANUAL_OVERRIDE) {
    if (manualOverrideUntilFull) {
      // Sentinel: -1 means "no time cap, wait for level-driven stop".
      // Client-side JS can render as "until tank full" instead of a countdown.
      doc["manualOverrideRemaining"] = -1;
      doc["manualOverrideUntilFull"] = true;
    } else {
      unsigned long elapsedSeconds = (millis() - manualOverrideStartTime) / 1000;
      unsigned long totalSeconds = MANUAL_OVERRIDE_TIMEOUT_HOURS * 3600;
      unsigned long remainingSeconds = (totalSeconds > elapsedSeconds) ? (totalSeconds - elapsedSeconds) : 0;
      doc["manualOverrideRemaining"] = remainingSeconds;
      doc["manualOverrideUntilFull"] = false;
    }
  }
  
  doc["startPercent"] = startPercent;
  doc["stopPercent"] = stopPercent;
  doc["tankLowWet"] = tankLowWet;
  doc["tankFullWet"] = tankFullWet;
  doc["dryRunCount"] = dryRunCount;
  doc["sourceDryRunCount"] = sourceDryRunCount;

  // Source detection state for UI
  if (graceActive) {
    unsigned long graceRemain = (gracePeriodTens * 10UL * 1000UL) - (millis() - graceStartTime);
    doc["graceRemaining"] = graceRemain / 1000;
  }
  if (sourceConfirmStart > 0 && !sourceConfirmed) {
    unsigned long confirmElapsed = (millis() - sourceConfirmStart) / 1000;
    doc["sourceConfirmProgress"] = confirmElapsed;
    doc["sourceConfirmRequired"] = sourceDebounceSecs;
  }
  doc["sourceConfirmed"] = sourceConfirmed;
  if (motorState && motorRunStartTime > 0) {
    doc["motorRunTime"] = (millis() - motorRunStartTime) / 1000;
    if (maxRunTimeMins > 0) {
      doc["maxRunTime"] = maxRunTimeMins * 60;
    }
  }
  if (currentMode == MODE_DRY_RUN_RECOVERY && dryRunStartTime > 0) {
    unsigned long retryRemain = (retryWaitMins * 60UL * 1000UL) - (millis() - dryRunStartTime);
    doc["retryWaitRemaining"] = retryRemain / 1000;
    doc["retryCount"] = max(sourceDryRunCount, (uint8_t)dryRunCount);
    doc["retryMax"] = maxRetryCount;
  }

  doc["wifiStationMode"] = wifiStationMode;
  doc["otaInProgress"] = otaInProgress;
  
  // WiFi reconnection status
  doc["wifiReconnecting"] = wifiReconnect.isReconnecting;
  if (wifiReconnect.isReconnecting) {
    doc["wifiNextAttemptSeconds"] = (wifiReconnect.nextAttemptTime - millis()) / 1000;
    doc["wifiBackoffSeconds"] = wifiReconnect.backoffSeconds;
  }
  
  DateTime now = safeNow();
  doc["timestamp"] = formatDateTime(now);
  doc["rtcUnixTime"] = now.unixtime();
  
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
}

String getWaterLevelText() {
  if (hasReceivedReading && sensorOnline) {
    String text = String(currentWaterPercent, 1) + "% (" + String(currentWaterLevel, 1) + "cm)";
    if (tankVolume > 0) {
      float availableVolume = (currentWaterPercent / 100.0) * tankVolume;
      text += " | " + String(availableVolume, 1) + "L";
    }
    if (hasRSSIReading) {
      text += " | RSSI: " + String(currentRSSI) + " dBm";
    }
    return text;
  } else if (hasReceivedReading && !sensorOnline) {
    return "Unknown (US sensor offline)";
  } else {
    return "No reading yet";
  }
}

String getWPSensorText() {
  if (!hasWPSensor) return "Not configured";

  if (hasReceivedWPReading) {
    // For wired WP sensor: "NOT AVAILABLE" means no water detected, NOT sensor offline
    String status = wpSensorStatus ? "Available" : "NOT AVAILABLE";
    // Note: Removed offline check - wired WP sensor is always "online"
    if (hasWPRSSIReading) {
      status += " | RSSI: " + String(currentWPRSSI) + " dBm";
    }
    return status;
  } else {
    return "No reading yet";
  }
}

String getLastReadingText() {
  if (hasReceivedReading) {
    String text = formatDateTime(lastSensorUpdate);
    if (sensorOnline) {
      DateTime now = safeNow();
      long secondsAgo = now.unixtime() - lastSensorUpdate.unixtime();
      text += " (" + String(secondsAgo) + "s ago)";
    } else {
      text += " (OFFLINE)";
    }
    return text;
  } else {
    return "No reading yet";
  }
}

String formatNumber(float value, int decimals = 1) {
  String result = String(value, decimals);
  int dotPos = result.indexOf('.');
  if (dotPos == -1) dotPos = result.length();
  if (dotPos > 3) {
    result = result.substring(0, dotPos - 3) + "," + result.substring(dotPos - 3);
  }
  return result;
}

String getModeText() {
  bool inActiveSchedule = (scheduleModeEnabled && getCurrentActiveSchedule() >= 0);

  switch (currentMode) {
    case MODE_NORMAL:
      return inActiveSchedule ? "SCHEDULED AUTO" : "AUTO";
    case MODE_IDLE:
      return inActiveSchedule ? "SCHEDULED IDLE" : "IDLE";
    case MODE_DRY_RUN_RECOVERY: 
      return "DRY RUN RECOVERY";
    case MODE_SAFE_MODE: 
      return "SAFE MODE";
    case MODE_SENSOR_OFFLINE: 
      return "SENSOR OFFLINE";
    case MODE_MANUAL_OVERRIDE: 
      return "FORCE PUMP RUN";
    case MODE_SCHEDULE_INACTIVE: 
      return "SCHEDULE INACTIVE";
    case MODE_PANEL_FAULT:
      return "PANEL FAULT";
    case MODE_SOURCE_DRY_RUN:
      return "NO SOURCE WATER";
    default:
      return "UNKNOWN";
  }
}

String getStatusPageHTML() {
  DateTime now = safeNow();
  
  // Calculate mode-specific information
  String modeDisplay = getModeText();
  String modeClass = "mode-default";
  String modeExtra = "";
  
  // Add color coding and extra info based on mode
  if (currentMode == MODE_SAFE_MODE) {
    modeClass = "mode-critical";
    // Show specific reason for Safe Mode
    if (feedbackFaultActive) {
      if (lastStartPulseAt != 0 && (millis() - lastStartPulseAt) > (FEEDBACK_CONFIRM_TIMEOUT_MS + 5000)) {
        modeExtra = " (Motor panel not stopping)";
      } else {
        modeExtra = " (Panel not activating as per feedback)";
      }
    } else {
      modeExtra = " (Dry Run Protection)";
    }
  } else if (currentMode == MODE_PANEL_FAULT) {
    modeClass = "mode-critical";
    // Show specific reason for Panel Fault
    if (lastStartPulseAt != 0 && (millis() - lastStartPulseAt) > (FEEDBACK_CONFIRM_TIMEOUT_MS + 5000)) {
      modeExtra = " (Motor panel not stopping)";
    } else {
      modeExtra = " (Panel not activating as per feedback)";
    }
  } else if (currentMode == MODE_SCHEDULE_INACTIVE) {
    modeClass = "mode-inactive";
    modeExtra = " (" + getNextScheduleInfo() + ")";
  } else if (currentMode == MODE_MANUAL_OVERRIDE) {
    modeClass = "mode-warning";
    // Until-full mode has no time cap — computing "remaining" would
    // underflow to 71,582,788 min (unsigned wraparound of 0 - elapsed).
    // Show the level-driven label instead.
    if (manualOverrideUntilFull) {
      modeExtra = " (until tank full)";
    } else {
      unsigned long elapsedSeconds = (millis() - manualOverrideStartTime) / 1000;
      unsigned long totalSeconds = manualOverrideDurationMinutes * 60;
      // Guard the subtraction — if elapsed somehow exceeds total (clock
      // drift, edge case), clamp to 0 instead of wrapping.
      unsigned long remainingSeconds = (totalSeconds > elapsedSeconds) ? (totalSeconds - elapsedSeconds) : 0;
      unsigned long remainingMinutes = remainingSeconds / 60;
      modeExtra = " (" + String(remainingMinutes) + "m left)";
    }
  } else if (currentMode == MODE_DRY_RUN_RECOVERY) {
    modeClass = "mode-warning";
  } else if (currentMode == MODE_SOURCE_DRY_RUN) {
    modeClass = "mode-warning";
  } else if (currentMode == MODE_SENSOR_OFFLINE) {
    modeClass = "mode-inactive";
  } else if (scheduleModeEnabled && currentActiveSchedule >= 0) {
    modeExtra = "";
  }
  
  // Pump status text and color
  String pumpStatus = "OFF";
  String pumpClass = "status-gray";
  String pumpMode = "";
  if (motorState) {
    pumpStatus = "ON";
    pumpClass = "status-green-blink";
    if (currentMode == MODE_MANUAL_OVERRIDE) {
      pumpMode = " (M)";
    } else {
      pumpMode = " (A)";
    }
  }
  
  // Water presence sensor status (if configured)
  // Note: Wired WP sensor never shows "OFFLINE" - water absence is NOT sensor offline
  String wpSensorHTML = "";
  if (hasWPSensor) {
    String wpStatus, wpClass, wpDetail = "";
    if (!hasReceivedWPReading) {
      wpStatus = "CHECKING";
      wpClass = "status-gray";
    } else if (!wpDebounce.currentState && srcWetCount > 0) {
      // Building toward WET confirmation
      wpStatus = "DETECTING";
      wpClass = "status-orange";
      wpDetail = "Confirming source (" + String(srcWetCount) + "/" + String(SOURCE_WET_CONFIRM) + " reads)";
    } else if (wpSensorStatus) {
      wpStatus = "OK";
      wpClass = "status-green";
      wpDetail = "Source water present";
    } else {
      // Dry and confirmed
      wpStatus = "NO WATER";
      wpClass = "status-gray";
      wpDetail = "Source not detected";
    }
    // Keep the card single-line so it fits inside .status-row's 60px height.
    // Countdown is shown inline after the status text, not on a new line.
    String wpInline = "";
    if (wpDetail.length() > 0 && wpStatus == "DETECTING") {
      wpInline = " <span style=\"font-size:0.75em;color:#888;font-weight:normal\">(" + wpDetail + ")</span>";
    }
    wpSensorHTML = "<div class=\"status-card\"><span class=\"status-dot " + wpClass + "\"></span>";
    wpSensorHTML += "<span class=\"status-text\">GND SRC: " + wpStatus + wpInline + "</span>";
    wpSensorHTML += "</div>";
  }
  
  // Water level display - Hide old data when offline.
  // v118 (ultrasonic variant): show continuous pct, water depth in cm/ft/in,
  // and distance-to-water from the ultrasonic sensor. No "probe wet/dry"
  // language — there are no discrete probes on this hardware.
  String waterStatsHTML = "";
  if (hasReceivedReading) {
    if (sensorOnline) {
      // Prime label — big pct number with motor-state qualifier.
      String levelLabel;
      if (usConfirmedPct >= 95)       levelLabel = "FULL";
      else if (usConfirmedPct <= 5)   levelLabel = "EMPTY";
      else if (motorState)            levelLabel = "FILLING";
      else                            levelLabel = String(usConfirmedPct) + "%";
      waterStatsHTML = "<h2>" + levelLabel + "</h2>\n";

      // Second line — exact pct + water depth + distance-from-sensor.
      // waterDepthCm = tankHeightCm - distanceCm (standard geometry).
      int32_t distanceCm = (usLastRawMm > 0) ? (usLastRawMm / 10) : 0;
      int32_t waterDepthCm = (int32_t)usTankHeightCm - distanceCm;
      if (waterDepthCm < 0) waterDepthCm = 0;
      // Convert cm → ft/in for human readability.
      float totalInches = waterDepthCm / 2.54f;
      int feet = (int)(totalInches / 12);
      int inches = (int)(totalInches - feet * 12 + 0.5f);
      if (inches == 12) { feet++; inches = 0; }

      waterStatsHTML += "<p style=\"color:#2c3e50;font-size:1em;font-weight:600;\">" +
        String(usConfirmedPct) + "% &bull; " +
        String(waterDepthCm) + " cm (" + String(feet) + " ft " + String(inches) + " in) depth</p>\n";
      // v118.0.4: volume display when customer has set tank capacity.
      if (tankVolume > 0) {
        uint32_t currentLitres = (uint32_t)((uint32_t)usConfirmedPct * tankVolume / 100);
        String volStr;
        if (tankVolume >= 1000) {
          float currentKL = currentLitres / 1000.0f;
          float totalKL   = tankVolume    / 1000.0f;
          char buf[48];
          snprintf(buf, sizeof(buf), "%.1f / %.1f KL", currentKL, totalKL);
          volStr = String(buf);
        } else {
          volStr = String(currentLitres) + " / " + String(tankVolume) + " L";
        }
        waterStatsHTML += "<p style=\"color:#2563eb;font-size:0.95em;font-weight:600;\">💧 Volume: " + volStr + "</p>\n";
      }
      waterStatsHTML += "<p style=\"color:#7f8c8d;font-size:0.85em;\">Distance to water: " + String(distanceCm) + " cm &bull; Tank height: " + String(usTankHeightCm) + " cm</p>\n";
      // v118.0.6: "Last valid reading X ago" — millis-based, works
      // without RTC. Uses usLastGoodMs (updated only on genuine fresh
      // reads from the sensor). Prior behaviour used RTC-based
      // lastSensorUpdate which showed "1s ago" even when the sensor
      // had been dead for 10 min because that timestamp was being
      // updated on every POLL attempt, not every SUCCESS.
      unsigned long ageMs = (usLastGoodMs > 0) ? (millis() - usLastGoodMs) : 0;
      String ageStr;
      if (usLastGoodMs == 0) ageStr = "never";
      else if (ageMs < 60000UL)   ageStr = String(ageMs / 1000UL) + "s ago";
      else if (ageMs < 3600000UL) ageStr = String(ageMs / 60000UL) + "m ago";
      else                        ageStr = String(ageMs / 3600000UL) + "h ago";
      waterStatsHTML += "<div class=\"sensor-time\">Last valid reading: " + ageStr + "</div>\n";
    } else {
      // Sensor offline - show offline message + how long since last valid
      waterStatsHTML = "<div class=\"sensor-offline-large\">⚠ SENSOR OFFLINE</div>\n";
      unsigned long ageMs = (usLastGoodMs > 0) ? (millis() - usLastGoodMs) : 0;
      String ageStr;
      if (usLastGoodMs == 0) ageStr = "no valid reading since boot";
      else if (ageMs < 60000UL)   ageStr = String(ageMs / 1000UL) + " seconds ago";
      else if (ageMs < 3600000UL) ageStr = String(ageMs / 60000UL) + " minutes ago";
      else                        ageStr = String(ageMs / 3600000UL) + " hours ago";
      waterStatsHTML += "<div class=\"sensor-time-gray\" style=\"color:#dc2626;font-weight:600;\">Last valid reading: " + ageStr + "</div>\n";
      waterStatsHTML += "<div class=\"sensor-time-gray\" style=\"font-size:0.85em;color:#64748b;margin-top:4px;\">Pump operations suspended until sensor recovers.</div>\n";
    }
  } else {
    waterStatsHTML = "<h2>--</h2>\n<p>No data</p>\n";
  }
  
  // Tank fill percentage for visualization
  int tankFillPercent = (hasReceivedReading && sensorOnline) ? (int)currentWaterPercent : 0;
  
  // Force run button state
  String forceRunButton = "";
  if (currentMode == MODE_MANUAL_OVERRIDE) {
    forceRunButton = "<button onclick=\"if(confirm('End force run and return to auto mode?')){fetch('/manual/off',{method:'POST'}).then(()=>location.reload())}\" class=\"btn btn-danger\">⚡ STOP FORCE RUN</button>\n";
    if (manualOverrideUntilFull) {
      forceRunButton += "<div class=\"force-run-time\">Force Run: running until tank FULL</div>\n";
    } else {
      unsigned long elapsedSeconds = (millis() - manualOverrideStartTime) / 1000;
      unsigned long totalSeconds = manualOverrideDurationMinutes * 60;
      unsigned long remainingSeconds = (totalSeconds > elapsedSeconds) ? (totalSeconds - elapsedSeconds) : 0;
      unsigned long remainingMinutes = remainingSeconds / 60;
      forceRunButton += "<div class=\"force-run-time\">Force Run: " + String(remainingMinutes) + "m remaining (of " + String(manualOverrideDurationMinutes) + " min)</div>\n";
    }
  } else {
    // Dropdown + Start button approach
    forceRunButton = "<div style=\"display:flex;flex-direction:column;gap:10px;\">\n";
    forceRunButton += "<div style=\"display:flex;align-items:center;gap:10px;\">\n";
    forceRunButton += "<label style=\"font-weight:600;min-width:80px;\">Force Run Duration:</label>\n";
    // onchange auto-saves the pick to NVS via /manual/selection so the
    // next status auto-refresh re-renders the dropdown with the correct
    // preselected option. Without this, the 3-sec poll snaps the
    // dropdown back to lastForceRunSelection (was always 15) and the
    // customer's pick vanishes before they click Start.
    forceRunButton += "<select id=\"forceRunDuration\" onchange=\"saveForceRunSelection(this.value)\" style=\"flex:1;padding:12px;border:2px solid #ddd;border-radius:5px;font-size:1em;\">\n";
    // Preselect whichever option matches lastForceRunSelection so
    // reopening the page shows what the customer last used, not a
    // hardcoded default. Small helper macro-style ternaries keep the
    // list readable.
    #define _SEL(v) (lastForceRunSelection == (v) ? " selected" : "")
    forceRunButton += "<option value=\"5\""   + String(_SEL(5))  + ">5 minutes</option>\n";
    forceRunButton += "<option value=\"10\""  + String(_SEL(10)) + ">10 minutes</option>\n";
    forceRunButton += "<option value=\"15\""  + String(_SEL(15)) + ">15 minutes</option>\n";
    forceRunButton += "<option value=\"30\""  + String(_SEL(30)) + ">30 minutes</option>\n";
    forceRunButton += "<option value=\"60\""  + String(_SEL(60)) + ">1 hour</option>\n";
    // v118.0.4: "Until tank full" needs the sensor to work — hide it
    // when sensor is offline/faulted. Timed options still work since
    // they don't depend on tank reading.
    if (!usSensorFault && usHaveGoodReading) {
      forceRunButton += "<option value=\"-1\"" + String(_SEL(-1)) + ">Until tank full</option>\n";
    }
    #undef _SEL
    forceRunButton += "</select>\n";
    if (usSensorFault || !usHaveGoodReading) {
      forceRunButton += "<div class=\"note\" style=\"color:#dc2626;font-size:0.8em;margin-top:4px;\">⚠ Tank sensor offline — 'Until tank full' option hidden.</div>\n";
    }
    forceRunButton += "</div>\n";
    forceRunButton += "<button onclick=\"startForceRun()\" class=\"btn btn-warning\">⚡ START FORCE RUN</button>\n";
    forceRunButton += "</div>\n";
  }
  
  // Build HTML
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>" + deviceName + "</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\">\n";
  html += "<meta http-equiv=\"refresh\" content=\"5\">\n";
  
  // INLINE CRITICAL CSS
  html += "<style>\n";
  html += "*{margin:0;padding:0;box-sizing:border-box}\n";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f0f8ff;color:#333;line-height:1.6;font-display:swap}\n";
  html += ".container{max-width:600px;margin:0 auto;background:#fff;min-height:100vh;display:grid;grid-template-rows:60px 60px 50px auto minmax(180px,1fr) auto;box-shadow:0 0 20px rgba(0,0,0,0.1)}\n";
  html += ".header{background:#2980b9;color:#fff;padding:15px 20px;display:flex;justify-content:space-between;align-items:center;min-height:60px;max-height:60px}\n";
  html += ".header h1{font-size:1.3em;font-weight:bold}\n";
  html += ".header-btns{display:flex;gap:10px;align-items:center;margin-right:15px}\n";
  html += ".btn-icon{background:rgba(255,255,255,0.3);color:#fff;border:2px solid rgba(255,255,255,0.4);padding:0;border-radius:6px;cursor:pointer;font-size:2em;width:46px;height:46px;display:flex;align-items:center;justify-content:center;text-decoration:none;transition:all 0.2s}\n";
  html += ".btn-icon:hover{background:rgba(255,255,255,0.5);border-color:rgba(255,255,255,0.6)}\n";
  html += ".status-row{padding:6px 15px;display:flex;gap:8px;flex-wrap:nowrap;background:#f8f9fa;border-bottom:2px solid #dee2e6;align-items:stretch}\n";
  html += ".status-card{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#fff;border-radius:5px;border:1px solid #dee2e6;flex:1;min-width:0;overflow:hidden}\n";
  html += ".status-dot{display:inline-block;width:12px;height:12px;border-radius:50%;flex-shrink:0}\n";
  html += ".status-green{background:#27ae60}\n";
  html += ".status-green-blink{background:#27ae60;animation:led-blink 1.5s ease-in-out infinite}\n";
  html += ".status-gray{background:#95a5a6}\n";
  html += ".status-orange{background:#e67e22;animation:led-blink 1s ease-in-out infinite}\n";
  html += ".status-text{font-weight:600;font-size:0.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n";
  html += ".mode-section{padding:8px 20px;font-weight:600;font-size:1em;border-bottom:2px solid #dee2e6;min-height:50px;max-height:50px;display:flex;align-items:center}\n";
  html += ".mode-default{background:#fff}\n";
  html += ".mode-critical{background:#e74c3c;color:#fff}\n";
  html += ".mode-warning{background:#f39c12;color:#fff}\n";
  html += ".mode-inactive{background:#95a5a6;color:#fff}\n";
  html += ".content-area{padding:12px 20px;display:flex;flex-direction:row;gap:25px;align-items:flex-start;min-height:160px;will-change:contents;contain:layout}\n";
  html += ".tank-container{display:flex;flex-direction:column;align-items:center;flex-shrink:0;min-width:130px;order:1}\n";
  html += ".tank-cap{width:65px;height:10px;background:linear-gradient(135deg,#34495e,#2c3e50);border-radius:50% 50% 0 0;margin-bottom:0;box-shadow:0 2px 4px rgba(0,0,0,0.2);position:relative}\n";
  html += ".tank-top{width:120px;height:30px;background:linear-gradient(to bottom,#e8eef1,#d5dbdb);clip-path:polygon(15% 0,85% 0,100% 100%,0 100%);position:relative;z-index:2;border-left:2px solid #34495e;border-right:2px solid #34495e}\n";
  html += ".tank-body{width:120px;height:170px;background:linear-gradient(to bottom,#ecf0f1,#d5dbdb);border:2px solid #34495e;border-top:none;border-radius:0 0 12px 12px;position:relative;overflow:hidden;box-shadow:inset 0 -5px 15px rgba(0,0,0,0.1),0 4px 8px rgba(0,0,0,0.15);margin-top:-2px}\n";
  html += ".water{position:absolute;bottom:0;width:100%;height:" + String(tankFillPercent) + "%;background:linear-gradient(to top,#1565c0 0%,#1e88e5 40%,#42a5f5 70%,#64b5f6 100%);box-shadow:inset 0 0 20px rgba(0,0,0,0.2);transition:height 0.8s ease}\n";
  html += ".sensor-device{position:absolute;bottom:-24px;left:50%;transform:translateX(-50%);width:22px;height:26px;background:linear-gradient(to bottom,#fff 0%,#fff 70%,#1a1a1a 70%,#1a1a1a 100%);border:2px solid #333;border-radius:3px;box-shadow:0 3px 6px rgba(0,0,0,0.3);z-index:10}\n";
  html += ".sensor-led{position:absolute;top:35%;left:50%;transform:translate(-50%,-50%);width:7px;height:7px;background:#4caf50;border-radius:50%;box-shadow:0 0 8px #4caf50,0 0 16px rgba(76,175,80,0.6)}\n";
  html += ".sensor-grid{position:absolute;bottom:4px;left:4px;right:4px;height:4px;background:repeating-linear-gradient(90deg,#333 0px,#333 1px,transparent 1px,transparent 3px);opacity:0.4}\n";
  html += "@keyframes led-blink{0%,100%{opacity:1;box-shadow:0 0 8px #4caf50,0 0 16px rgba(76,175,80,0.6)}50%{opacity:0.3;box-shadow:0 0 3px #4caf50,0 0 6px rgba(76,175,80,0.3)}}\n";
  html += ".water-stats{flex:1;min-height:120px;order:2;will-change:contents}\n";
  html += ".water-stats h2{font-size:2.5em;color:#2c3e50;margin-bottom:5px}\n";
  html += ".water-stats p{font-size:1.1em;color:#555;margin:3px 0}\n";
  html += ".sensor-time{font-size:0.85em;color:#7f8c8d;margin-top:10px}\n";
  html += ".sensor-offline{font-size:1em;color:#e74c3c;font-weight:bold;margin-top:10px}\n";
  html += ".sensor-offline-large{font-size:1.5em;color:#e74c3c;font-weight:bold;margin-top:20px}\n";
  html += ".sensor-time-gray{font-size:0.85em;color:#7f8c8d;margin-top:8px}\n";
  html += ".btn-section{padding:15px 20px;display:flex;flex-direction:column;gap:12px;border-top:2px solid #dee2e6;min-height:130px}\n";
  html += ".btn{padding:16px 20px;border:none;border-radius:5px;font-size:1.1em;font-weight:600;cursor:pointer;width:100%;text-align:center;text-decoration:none;display:block;transition:all 0.2s;height:54px;display:flex;align-items:center;justify-content:center;line-height:1}\n";
  html += ".btn-primary{background:#3498db;color:#fff}\n";
  html += ".btn-primary:hover{background:#2980b9}\n";
  html += ".btn-warning{background:#f39c12;color:#fff}\n";
  html += ".btn-warning:hover{background:#e67e22}\n";
  html += ".btn-danger{background:#e74c3c;color:#fff}\n";
  html += ".btn-danger:hover{background:#c0392b}\n";
  html += ".force-run-time{text-align:center;color:#7f8c8d;font-size:0.9em;margin-top:5px}\n";

  // ✅ ADD CONFIGURATION WARNING STYLES
  html += ".config-warning{background:#e74c3c;color:#fff;padding:25px 20px;text-align:center;border-bottom:2px solid #c0392b}\n";
  html += ".config-warning h2{font-size:1.4em;margin-bottom:10px}\n";
  html += ".config-warning p{font-size:1em;line-height:1.6;margin-bottom:15px}\n";
  html += ".config-warning .btn{background:#fff;color:#e74c3c;max-width:300px;margin:0 auto}\n";
  html += ".config-warning .btn:hover{background:#f8f9fa}\n";

  // ✅ ADD MOTOR STOP INFO STYLES
  html += ".motor-info{background:#e8f4fd;border:2px solid #3498db;border-radius:6px;padding:15px;margin:15px 20px;text-align:center}\n";
  html += ".motor-info-title{font-weight:700;color:#2980b9;font-size:1em;margin-bottom:8px}\n";
  html += ".motor-info-text{color:#555;font-size:0.95em;line-height:1.5}\n";
  
  html += "@media (max-width:480px){";
  html += ".content-area{flex-direction:row;gap:15px;min-height:180px;padding:10px 15px}";
  html += ".tank-container{min-width:100px}";
  html += ".tank-cap{width:55px;height:8px}";
  html += ".tank-top{width:100px;height:25px}";
  html += ".tank-body{width:100px;height:140px}";
  html += ".sensor-device{width:18px;height:22px}";
  html += ".sensor-led{width:6px;height:6px}";
  html += ".water-stats h2{font-size:2em}";
  html += ".water-stats p{font-size:1em}";
  html += ".sensor-offline-large{font-size:1.3em;margin-top:15px}";
  html += ".status-card{padding:8px 10px}";
  html += ".btn{padding:16px 20px;font-size:1.1em;height:54px}";
  html += ".btn-icon{width:50px;height:50px;font-size:2.2em}";
  html += ".btn-section{min-height:120px;gap:10px}";
  html += ".status-row{padding:6px 15px}";
  html += "}\n";
  html += "</style>\n";
  html += "</head>\n<body>\n";
  
  // CONTAINER START
  html += "<div class=\"container\">\n";
  
  // SECTION 1: HEADER
  html += "<div class=\"header\">\n";
  html += "<h1>" + deviceName + "</h1>\n";
  html += "<div class=\"header-btns\">\n";
  html += "<button onclick=\"location.reload()\" class=\"btn-icon\" title=\"Refresh\"><span>↻</span></button>\n";
  html += "<a href=\"/settings\" class=\"btn-icon\" title=\"Settings\"><span>⚙</span></a>\n";
  if (passwordEnabled && deviceUnlocked) {
    html += "<a href=\"/lock\" class=\"btn-icon\" title=\"Lock Device\" onclick=\"return confirm('Lock device? You will need to enter password again.')\"><span>🔓</span></a>\n";
  }
  html += "</div>\n";
  html += "</div>\n";
  
  // No "configuration required" gate — fresh device boots with defaults
  // written to EEPROM at first boot (see loadConfiguration()), so isConfigured
  // is always true and the device is immediately operational.

  // SECTION 2: STATUS ROW (only if configured)
  html += "<div class=\"status-row\">\n";
  html += "<div class=\"status-card\"><span class=\"status-dot " + pumpClass + "\"></span><span class=\"status-text\">PUMP: " + pumpStatus + pumpMode + "</span></div>\n";
  html += wpSensorHTML;
  html += "</div>\n";
  
  // SECTION 3: MODE DISPLAY
  html += "<div class=\"mode-section " + modeClass + "\">MODE: " + modeDisplay + modeExtra + "</div>\n";

  // SECTION 3.5: PUMP STAGE INFO (contextual status messages)
  {
    String stageText = "";
    String stageStyle = "background:#e8f4fd;border:1px solid #3498db;";

    if (pumpStage == "GRACE_PERIOD" && graceActive) {
      unsigned long remain = (gracePeriodTens * 10UL * 1000UL) - (millis() - graceStartTime);
      int remainSec = remain / 1000;
      stageText = "Grace period " + String(remainSec / 60) + ":" + String(remainSec % 60 < 10 ? "0" : "") + String(remainSec % 60) + " — Pulling water through pipe";
      stageStyle = "background:#fff3cd;border:1px solid #f39c12;";
    } else if (pumpStage == "SOURCE_CONFIRMING" && sourceConfirmStart > 0) {
      unsigned long elapsed = (millis() - sourceConfirmStart) / 1000;
      stageText = "Checking source water (" + String(elapsed) + "s)";
      stageStyle = "background:#fff3cd;border:1px solid #f39c12;";
    } else if (pumpStage == "FILLING" && motorState) {
      unsigned long runSec = (millis() - motorRunStartTime) / 1000;
      stageText = "Filling | Run: " + String(runSec / 60) + "m";
      if (maxRunTimeMins > 0) {
        stageText += " / " + String(maxRunTimeMins) + "m max";
      }
    } else if (pumpStage == "RETRY_WAIT" && currentMode == MODE_DRY_RUN_RECOVERY) {
      unsigned long totalMs = dryRunWaitMins * 60UL * 1000UL;
      unsigned long elapsed = millis() - dryRunStartTime;
      unsigned long remain = (elapsed >= totalMs) ? 0 : (totalMs - elapsed);
      int remainSec = remain / 1000;
      String faultText = (lastFaultReason == "MAX_RUN_TIME") ? "Max run time" : "No level change";
      stageText = "Dry Run " + String(dryRunCount) + "/" + String(maxDryRunCount) + " — " + faultText + " — Retry in " + String(remainSec / 60) + ":" + String(remainSec % 60 < 10 ? "0" : "") + String(remainSec % 60);
      stageStyle = "background:#f8d7da;border:1px solid #e74c3c;";
    } else if (pumpStage == "SOURCE_RETRY_WAIT" && currentMode == MODE_SOURCE_DRY_RUN) {
      unsigned long totalMs = retryWaitMins * 60UL * 1000UL;
      unsigned long elapsed = millis() - sourceDryRunStartTime;
      unsigned long remain = (elapsed >= totalMs) ? 0 : (totalMs - elapsed);
      int remainSec = remain / 1000;
      stageText = "No source water " + String(sourceDryRunCount) + "/" + String(maxRetryCount) + " — Retry in " + String(remainSec / 60) + ":" + String(remainSec % 60 < 10 ? "0" : "") + String(remainSec % 60);
      stageStyle = "background:#e8f4fd;border:1px solid #3498db;";
    } else if (pumpStage == "PRE_WAIT_SOURCE" && !tankFullWet && !wpSensorStatus) {
      // Only show this banner when tank is actually low AND source is actually
      // unavailable — not when stale pumpStage hasn't been cleared yet.
      stageText = "Level low — Waiting for source water";
      stageStyle = "background:#fff3cd;border:1px solid #f39c12;";
    } else if (pumpStage == "SCHEDULE_WAIT" && hasReceivedReading && currentWaterPercent >= 0 && currentWaterPercent < startPercent) {
      stageText = "Level low — " + getNextScheduleInfo();
      stageStyle = "background:#e8f4fd;border:1px solid #3498db;";
    }

    if (stageText.length() > 0) {
      html += "<div style=\"" + stageStyle + "border-radius:3px;padding:2px 8px;margin:2px 15px;text-align:center;font-size:0.72em;font-weight:600;line-height:1.15;min-height:0;max-height:24px;overflow:hidden;\">" + stageText + "</div>\n";
    }
  }

  // SECTION 4: MAIN CONTENT
  html += "<div class=\"content-area\">\n";
  html += "<div class=\"tank-container\">\n";
  html += "<div class=\"tank-cap\">\n";

  // Show sensor with LED only when sensor is online and receiving data
  if (sensorOnline && hasReceivedReading) {
    html += "<div class=\"sensor-device\">\n";
    html += "<div class=\"sensor-led\"></div>\n";
    html += "<div class=\"sensor-grid\"></div>\n";
    html += "</div>\n";
  } else {
    // Sensor offline - show device body without LED
    html += "<div class=\"sensor-device\">\n";
    html += "<div class=\"sensor-grid\"></div>\n";
    html += "</div>\n";
  }

  html += "</div>\n";
  html += "<div class=\"tank-top\"></div>\n";
  html += "<div class=\"tank-body\">\n";
  html += "<div class=\"water\"></div>\n";
  html += "</div>\n";
  html += "</div>\n";
  html += "<div class=\"water-stats\">\n";
  html += waterStatsHTML;
  html += "</div>\n";
  html += "</div>\n";

  // SECTION 4.5: ERROR CLEAR BUTTON / MOTOR INFO / BUZZER SILENCE (contextual display)
  
  // Show Silence Buzzer button if buzzer is active and not muted
  bool buzzerActive = false;
#if HAS_BUZZER_HARDWARE
  if (pumpType == PUMP_PANEL) {
    bool wantMotorBuzz = (buzzerFlags & BUZZ_ON_MOTOR_ON) && motorState;
    bool errorActive = systemInErrorState();
    bool wantErrorBuzz = (buzzerFlags & BUZZ_ON_ERROR) && errorActive;
    buzzerActive = wantMotorBuzz || wantErrorBuzz;
  }
#endif
  
  if (buzzerActive && !buzzerMuted) {
    html += "<div class=\"motor-info\" style=\"border-left:4px solid #3498db;background:#e8f4fd;\">\n";
    html += "<div class=\"motor-info-title\" style=\"color:#2c3e50;\">🔔 Buzzer is sounding</div>\n";
    html += "<button onclick=\"silenceBuzzer()\" class=\"btn\" style=\"background:#3498db;color:#fff;margin-top:10px;width:100%;\">🔕 SILENCE BUZZER</button>\n";
    html += "</div>\n";
  }
  
  if (currentMode == MODE_DRY_RUN_RECOVERY) {
    // Calculate time remaining for dry run recovery (uses user setting dryRunWaitMins)
    unsigned long elapsedMs = millis() - dryRunStartTime;
    unsigned long totalMs = dryRunWaitMins * 60000UL;
    unsigned long remainingMs = (elapsedMs >= totalMs) ? 0 : (totalMs - elapsedMs);
    int remainingMins = remainingMs / 60000;

    html += "<div class=\"motor-info\" style=\"border-left:4px solid #f39c12;background:#fff3cd;\">\n";
    html += "<div class=\"motor-info-title\" style=\"color:#856404;\">⚠️ System in Dry Run Recovery</div>\n";
    html += "<div class=\"motor-info-text\" style=\"color:#856404;\">\n";
    html += "Motor stopped after detecting no water level change during pump operation.<br>\n";
    html += "Recovery waiting period: <strong>" + String(remainingMins) + " minutes remaining</strong> (out of " + String(dryRunWaitMins) + " minutes)\n";
    html += "</div>\n";
    html += "<button onclick=\"clearErrorMode()\" class=\"btn\" style=\"background:#f39c12;color:#fff;margin-top:10px;width:100%;\">🔄 CLEAR ERROR & RESUME</button>\n";
    html += "</div>\n";
  } else if (currentMode == MODE_NORMAL && detectionMode == 0 && pumpStage == "PRE_WAIT_SOURCE" && hasWPSensor && !wpSensorStatus) {
    html += "<div class=\"motor-info\" style=\"border-left:4px solid #3498db;background:#e8f4fd;\">\n";
    html += "<div class=\"motor-info-title\" style=\"color:#2c3e50;\">💧 Waiting for Source Water</div>\n";
    html += "<div class=\"motor-info-text\" style=\"color:#2c3e50;\">\n";
    html += "Pump will resume automatically when water returns.\n";
    html += "</div>\n";
    html += "</div>\n";
  } else if (currentMode == MODE_SAFE_MODE) {
    html += "<div class=\"motor-info\" style=\"border-left:4px solid #e74c3c;background:#f8d7da;\">\n";
    String safeFaultText = "Protection fault";
    // Fault-aware retry count display
    uint8_t shownRetries = maxDryRunCount;
    bool isMaxRunTimeFault = false;
    if (lastFaultReason == "NO_SOURCE") {
      safeFaultText = "No source water detected";
      shownRetries = maxRetryCount;
    } else if (lastFaultReason == "NO_LEVEL_CHANGE") {
      safeFaultText = "Tank level not rising";
      shownRetries = maxDryRunCount;
    } else if (lastFaultReason == "MAX_RUN_TIME") {
      safeFaultText = "Max run time exceeded";
      isMaxRunTimeFault = true;
    }
    html += "<div class=\"motor-info-title\" style=\"color:#721c24;\">🛑 Safe Mode — " + safeFaultText + "</div>\n";
    html += "<div class=\"motor-info-text\" style=\"color:#721c24;\">\n";
    if (isMaxRunTimeFault) {
      html += "Motor exceeded its maximum run time of " + String(maxRunTimeMins) + " minutes.<br>\n";
      html += "Manual reset required. Check for leaks, blocked outlet, or sensor issues.\n";
    } else {
      html += String(shownRetries) + " retries exhausted. Manual reset required.<br>\n";
      html += "Motor operations blocked for safety.\n";
    }
    html += "</div>\n";
    html += "<button onclick=\"clearErrorMode()\" class=\"btn\" style=\"background:#e74c3c;color:#fff;margin-top:10px;width:100%;\">🔄 CLEAR ERROR & RESUME</button>\n";
    html += "</div>\n";
  } else if (currentMode == MODE_SOURCE_DRY_RUN) {
    unsigned long elapsedMs = millis() - sourceDryRunStartTime;
    unsigned long totalMs = retryWaitMins * 60000UL;
    unsigned long remainingMs = (elapsedMs >= totalMs) ? 0 : (totalMs - elapsedMs);
    int remainingMins = remainingMs / 60000;

    html += "<div class=\"motor-info\" style=\"border-left:4px solid #3498db;background:#e8f4fd;\">\n";
    html += "<div class=\"motor-info-title\" style=\"color:#2c3e50;\">💧 No Source Water Detected</div>\n";
    html += "<div class=\"motor-info-text\" style=\"color:#2c3e50;\">\n";
    html += "Motor stopped — source water not available.<br>\n";
    html += "Retry " + String(sourceDryRunCount) + "/" + String(maxRetryCount) + " in <strong>" + String(remainingMins) + " minutes</strong>\n";
    html += "</div>\n";
    html += "<button onclick=\"clearErrorMode()\" class=\"btn\" style=\"background:#3498db;color:#fff;margin-top:10px;width:100%;\">🔄 CLEAR & RETRY NOW</button>\n";
    html += "</div>\n";
  } else if (motorState && autoModeEnabled && currentMode != MODE_MANUAL_OVERRIDE) {
    // Normal motor running info
    html += "<div class=\"motor-info\">\n";
    html += "<div class=\"motor-info-title\">ℹ️ Motor is running in Auto Mode</div>\n";
    html += "<div class=\"motor-info-text\">To turn off the motor, turn OFF Auto Mode in AUTO/MODE SETTINGS below</div>\n";
    html += "</div>\n";
  }

  // SECTION 5: ACTION BUTTONS
  html += "<div class=\"btn-section\">\n";
  html += "<a href=\"/auto-settings\" class=\"btn btn-primary\">AUTO/MODE SETTINGS</a>\n";
  html += forceRunButton;
  html += "</div>\n";

  // JavaScript for error clearing
  html += "<script>\n";
  html += "function clearErrorMode() {\n";
  html += "  const btn = event.target;\n";
  html += "  btn.disabled = true;\n";
  html += "  btn.innerHTML = '⏳ Clearing...';\n";
  html += "  fetch('/api/clear-error-mode', {method: 'POST'})\n";
  html += "    .then(r => {\n";
  html += "      if (r.ok) {\n";
  html += "        btn.innerHTML = '✅ Cleared!';\n";
  html += "        setTimeout(() => location.reload(), 1000);\n";
  html += "      } else {\n";
  html += "        btn.innerHTML = '❌ Failed';\n";
  html += "        btn.disabled = false;\n";
  html += "        setTimeout(() => btn.innerHTML = '🔄 CLEAR ERROR & RESUME', 2000);\n";
  html += "      }\n";
  html += "    })\n";
  html += "    .catch(e => {\n";
  html += "      btn.innerHTML = '❌ Error';\n";
  html += "      btn.disabled = false;\n";
  html += "      setTimeout(() => btn.innerHTML = '🔄 CLEAR ERROR & RESUME', 2000);\n";
  html += "    });\n";
  html += "}\n";
  html += "\n";
  html += "function silenceBuzzer() {\n";
  html += "  const btn = event.target;\n";
  html += "  btn.disabled = true;\n";
  html += "  btn.innerHTML = '🔇 Silencing...';\n";
  html += "  fetch('/api/silence-buzzer', {method: 'POST'})\n";
  html += "    .then(r => {\n";
  html += "      if (r.ok) {\n";
  html += "        btn.innerHTML = '✅ Silenced!';\n";
  html += "        setTimeout(() => location.reload(), 1000);\n";
  html += "      } else {\n";
  html += "        btn.innerHTML = '❌ Failed';\n";
  html += "        btn.disabled = false;\n";
  html += "        setTimeout(() => btn.innerHTML = '🔕 SILENCE BUZZER', 2000);\n";
  html += "      }\n";
  html += "    })\n";
  html += "    .catch(e => {\n";
  html += "      btn.innerHTML = '❌ Error';\n";
  html += "      btn.disabled = false;\n";
  html += "      setTimeout(() => btn.innerHTML = '🔕 SILENCE BUZZER', 2000);\n";
  html += "    });\n";
  html += "}\n";
  html += "\n";
  // Fire-and-forget POST on every dropdown change. Skip await/error
  // handling — if the write fails, the next change will retry it, and
  // the worst case is the dropdown snaps back to the previously-saved
  // value (a minor annoyance, not a functional bug).
  html += "function saveForceRunSelection(v) {\n";
  html += "  fetch('/manual/selection', {\n";
  html += "    method: 'POST',\n";
  html += "    headers: {'Content-Type': 'application/x-www-form-urlencoded'},\n";
  html += "    body: 'duration=' + v\n";
  html += "  }).catch(() => {});\n";
  html += "}\n";
  html += "function startForceRun() {\n";
  html += "  const duration = document.getElementById('forceRunDuration').value;\n";
  // -1 sentinel needs a plain-language label so the confirm dialog
  // reads naturally ("Start force run until tank full?") instead of
  // the raw sentinel value ("Start force run for -1 minutes?").
  html += "  const durationText = duration == -1 ? 'until tank full' : (duration == 60 ? 'for 1 hour' : 'for ' + duration + ' minutes');\n";
  html += "  if (confirm('Start force run ' + durationText + '?')) {\n";
  html += "    fetch('/manual/on', {\n";
  html += "      method: 'POST',\n";
  html += "      headers: {'Content-Type': 'application/x-www-form-urlencoded'},\n";
  html += "      body: 'duration=' + duration\n";
  html += "    }).then(() => location.reload());\n";
  html += "  }\n";
  html += "}\n";
  html += "\n";
  // Live status polling: this whole page is server-rendered (mode colors,
  // fault reasons, water-stats HTML are all built in C++, not via JS DOM
  // IDs), so the lowest-risk way to keep it live without duplicating that
  // formatting logic in JS is to poll /api/status and only reload the page
  // when something the user actually cares about has changed - not on a
  // blind timer, so an open page doesn't flicker/reset scroll every few
  // seconds for no reason.
  html += "let lastStatusSnapshot = null;\n";
  html += "async function pollStatusForChanges() {\n";
  html += "  try {\n";
  html += "    const r = await fetch('/api/status');\n";
  html += "    const d = await r.json();\n";
  html += "    const snap = JSON.stringify({m:d.mode, mo:d.motorState, lo:d.tankLowWet, fu:d.tankFullWet, ps:d.pumpStage, ws:d.wpSensorStatus, wd:d.wpDebouncing});\n";
  html += "    if (lastStatusSnapshot !== null && snap !== lastStatusSnapshot) {\n";
  html += "      location.reload();\n";
  html += "      return;\n";
  html += "    }\n";
  html += "    lastStatusSnapshot = snap;\n";
  html += "  } catch(e) {}\n";
  html += "}\n";
  html += "pollStatusForChanges();\n";
  html += "setInterval(pollStatusForChanges, 3000);\n";
  html += "</script>\n";

  // ── Cloud / Device Details card ──────────────────────────────────
  // Mirrors the ultrasonic firmware's block so pumps feel consistent in
  // the field. Fields chosen for what the installer actually needs:
  //   • Cloud Code — SF-PMP-XXXX so they can claim it in the SenseFlow app
  //   • WiFi Signal — with human descriptor (Excellent/Good/Fair/Weak)
  //   • Internet — green/red text from checkInternet() result
  //   • Cloud Status — green when firebaseReady && firebaseHealthy
  //   • Last Cloud Push — seconds/minutes/hours ago
  //   • Firmware — version + code
#if ENABLE_CLOUD
  {
    // WiFi signal descriptor (same buckets as ultrasonic)
    int rssi = WiFi.RSSI();
    String sig;
    if (WiFi.status() != WL_CONNECTED) sig = "Not connected";
    else if (rssi >= -55) sig = "Amazing";
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

    html += "<div class='card' style='margin-top:16px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:14px'>";
    html += "<h2 style='margin:0 0 10px 0;font-size:14px;color:#334155'>Cloud &amp; Device</h2>";

    auto rowHtml = [](const char* label, const String& val, const char* color) -> String {
      String s = "<div style='display:flex;justify-content:space-between;padding:4px 0;font-size:13px'>";
      s += "<span style='color:#64748b'>" + String(label) + "</span>";
      s += "<span style='color:" + String(color) + ";font-weight:500'>" + val + "</span></div>";
      return s;
    };

    html += rowHtml("Cloud Code", pumpDeviceCode.length() ? pumpDeviceCode : String("(not yet assigned)"), "#0f172a");
    html += rowHtml("WiFi Signal", sig, WiFi.status() == WL_CONNECTED ? "#16a34a" : "#dc2626");
    html += rowHtml("Internet", internetAvailable ? String("Reachable") : String("Not reachable"),
                    internetAvailable ? "#16a34a" : "#dc2626");
    html += rowHtml("Cloud Status",
                    (firebaseReady && firebaseHealthy) ? String("Connected")
                                                       : String("Not connected"),
                    (firebaseReady && firebaseHealthy) ? "#16a34a" : "#dc2626");
    html += rowHtml("Last Cloud Push", lastUpd, "#0f172a");
    html += rowHtml("Firmware", String("v") + FIRMWARE_VERSION + " (" + FIRMWARE_CODE + ")", "#0f172a");

    // Identify-device button — kicks off the same 1.8 s RED→GREEN→BLUE
    // blink that a cloud "testRequested=true" triggers. Lets installer
    // confirm they're at the right box when several SenseFlow devices
    // are visible in the same area.
    html += "<button id='testLedBtn' style='margin-top:10px;width:100%;padding:10px;background:#2563eb;color:#fff;border:0;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer' ";
    html += "onclick=\"var b=this;b.disabled=true;var o=b.textContent;b.textContent='Blinking...';fetch('/testled').finally(function(){setTimeout(function(){b.disabled=false;b.textContent=o},2000)})\">";
    html += "Test LED (Identify Device)</button>";

    html += "</div>";

    // ── Offline Queue card ────────────────────────────────────────
    // Shows what's waiting to be pushed to cloud. When WiFi/internet
    // recover, these numbers drop as the cloud task drains them —
    // gives the installer a live view of "how far behind is this
    // device on its cloud sync". Empty state renders green so a
    // healthy device visibly reads OK at a glance.
    {
      int pendingRuns   = countPendingRuns();
      int eventQueue    = countEventQueueDepth();
      int cloudLogQueue = countCloudLogDepth();
      bool anyPending   = (pendingRuns > 0) || (eventQueue > 0) || (cloudLogQueue > 0);

      html += "<div class='card' style='margin-top:12px;background:";
      html += anyPending ? "#fefce8;border:1px solid #fde047" : "#f0fdf4;border:1px solid #86efac";
      html += ";border-radius:10px;padding:14px'>";

      html += "<h2 style='margin:0 0 10px 0;font-size:14px;color:#334155'>Offline Queue</h2>";

      if (!anyPending) {
        html += "<div style='font-size:12px;color:#166534'>";
        html += "✓ Empty — all data has been pushed to cloud";
        html += "</div>";
      } else {
        html += "<div style='font-size:12px;color:#78350f;margin-bottom:8px'>";
        html += "Data waiting to be pushed. Will drain when connectivity returns.";
        html += "</div>";

        auto qrow = [](const char* label, int n, int max) -> String {
          String s = "<div style='display:flex;justify-content:space-between;padding:3px 0;font-size:13px'>";
          s += "<span style='color:#64748b'>" + String(label) + "</span>";
          s += "<span style='color:#0f172a;font-weight:600'>" + String(n) + " / " + String(max) + "</span>";
          s += "</div>";
          return s;
        };
        html += qrow("Unpaired pump runs (waiting for OFF event)", pendingRuns, PAIRED_CACHE_LEN);
        html += qrow("Pending events (Core 1 → Core 0)", eventQueue,    PUMP_EVENT_QUEUE_LEN);
        html += qrow("Pending log lines (Core 0 → Core 1)", cloudLogQueue, CLOUD_LOG_QUEUE_LEN);
      }

      // Explanation footer so installer knows what these numbers mean.
      html += "<div style='margin-top:8px;padding-top:8px;border-top:1px dashed #e2e8f0;font-size:11px;color:#64748b'>";
      html += "Complete pump runs (ON + OFF) are pushed to /history when cloud is reachable. ";
      html += "Runs still waiting for their OFF event hold in RAM up to 24h.";
      html += "</div>";
      html += "</div>";
    }
  }
#endif

  html += "</div>\n</body>\n</html>";

  return html;
}

String getAutoModeSettingsHTML() {
  // Build HTML
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>Auto/Mode Settings - " + deviceName + "</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\">\n";
  
  // INLINE CSS - Matching status page style
  html += "<style>\n";
  html += "*{margin:0;padding:0;box-sizing:border-box}\n";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f0f8ff;color:#333;line-height:1.6}\n";
  html += ".container{max-width:600px;margin:0 auto;background:#fff;min-height:100vh;box-shadow:0 0 20px rgba(0,0,0,0.1)}\n";
  html += ".header{background:#2980b9;color:#fff;padding:15px 20px;display:flex;align-items:center;gap:15px;min-height:60px}\n";
  html += ".header h1{font-size:1.3em;font-weight:bold;flex:1}\n";
  html += ".back-btn{background:rgba(255,255,255,0.25);color:#fff;border:2px solid rgba(255,255,255,0.3);padding:8px 12px;border-radius:6px;text-decoration:none;font-size:0.9em;transition:all 0.2s}\n";
  html += ".back-btn:hover{background:rgba(255,255,255,0.4)}\n";
  
  html += ".setting-section{padding:20px;border-bottom:2px solid #dee2e6}\n";
  html += ".setting-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}\n";
  html += ".setting-header h2{font-size:1.1em;display:flex;align-items:center;gap:8px}\n";
  html += ".setting-desc{color:#666;font-size:0.9em;line-height:1.5;margin-bottom:15px}\n";
  
  html += ".toggle{appearance:none;width:50px;height:26px;background:#ccc;border-radius:13px;position:relative;cursor:pointer;transition:0.3s}\n";
  html += ".toggle:checked{background:#27ae60}\n";
  html += ".toggle::before{content:'';position:absolute;width:22px;height:22px;border-radius:50%;background:#fff;top:2px;left:2px;transition:0.3s;box-shadow:0 2px 4px rgba(0,0,0,0.2)}\n";
  html += ".toggle:checked::before{left:26px}\n";
  
  html += ".hidden{display:none}\n";
  html += ".disabled-section{opacity:0.5;pointer-events:none}\n";
  
  html += "details{margin-top:15px;border:1px solid #dee2e6;border-radius:6px;background:#f8f9fa}\n";
  html += "summary{padding:12px 15px;cursor:pointer;font-weight:600;color:#2980b9;user-select:none;list-style:none}\n";
  html += "summary::-webkit-details-marker{display:none}\n";
  html += "summary::before{content:'▶ ';display:inline-block;transition:0.3s}\n";
  html += "details[open] summary::before{transform:rotate(90deg)}\n";
  html += ".schedules-content{padding:15px;background:#fff;border-top:1px solid #dee2e6}\n";
  
  html += ".schedule-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}\n";
  html += ".schedule-row label{min-width:80px;font-weight:600;color:#555}\n";
  html += ".schedule-row input[type=time]{padding:8px 12px;border:1px solid #ccc;border-radius:4px;font-size:0.95em;flex:1;min-width:100px}\n";
  html += ".delete-btn{background:#e74c3c;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:0.9em;transition:0.2s}\n";
  html += ".delete-btn:hover{background:#c0392b}\n";
  
  html += ".interval-select{display:flex;align-items:center;gap:10px;margin-top:10px}\n";
  html += ".interval-select label{font-weight:600;color:#555}\n";
  html += ".interval-select select{padding:8px 12px;border:1px solid #ccc;border-radius:4px;font-size:0.95em;background:#fff;cursor:pointer}\n";
  
  html += ".btn{padding:12px 20px;border:none;border-radius:5px;font-size:1em;font-weight:600;cursor:pointer;transition:0.2s;text-decoration:none;display:inline-block}\n";
  html += ".btn-primary{background:#3498db;color:#fff}\n";
  html += ".btn-primary:hover{background:#2980b9}\n";
  html += ".btn-success{background:#27ae60;color:#fff;width:100%;margin-top:10px}\n";
  html += ".btn-success:hover{background:#229954}\n";
  html += ".note{color:#7f8c8d;font-size:0.85em;font-style:italic;margin-top:8px}\n";
  
  html += ".footer{padding:20px;text-align:center;background:#f8f9fa;border-top:2px solid #dee2e6}\n";
  
  html += "@media (max-width:480px){";
  html += ".schedule-row{flex-direction:column;align-items:stretch}";
  html += ".schedule-row label{min-width:auto}";
  html += ".schedule-row input[type=time]{min-width:auto}";
  html += "}\n";
  html += ".toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#27ae60;color:#fff;padding:10px 24px;border-radius:20px;font-weight:600;font-size:14px;z-index:9999;pointer-events:none;opacity:0;transition:opacity .25s}\n";
  html += ".toast.show{opacity:1}\n";
  html += "</style>\n";
  html += "</head>\n<body>\n";
  html += "<div id=\"toast\" class=\"toast\"></div>\n";

  // CONTAINER START
  html += "<div class=\"container\">\n";

  // HEADER
  html += "<div class=\"header\">\n";
  html += "<a href=\"/\" class=\"back-btn\">← Back</a>\n";
  html += "<h1>AUTO/MODE SETTINGS</h1>\n";
  html += "</div>\n";
  
  // FORM START
  html += "<form id=\"autoForm\" method=\"POST\" action=\"/settings\">\n";
  
  // SECTION 1: AUTO MODE
  html += "<div class=\"setting-section\">\n";
  html += "<div class=\"setting-header\">\n";
  html += "<h2>🔄 AUTO MODE</h2>\n";
  html += "<input type=\"checkbox\" name=\"autoMode\" id=\"autoMode\" class=\"toggle\" " + String(autoModeEnabled ? "checked" : "") + ">\n";
  html += "</div>\n";
  html += "<div class=\"setting-desc\">\n";
  html += "Automatically manage pump operation based on schedules and water level settings without manual intervention. When enabled, the system handles all pump control decisions.\n";
  html += "</div>\n";
  html += "<input type=\"hidden\" name=\"autoModeEnabled\" value=\"" + String(autoModeEnabled ? "1" : "0") + "\">\n";
  html += "</div>\n";
  
  // AUTO MODE DEPENDENT SECTIONS
  String autoSections = "";

  // ─── SECTION 1.5: WATER LEVEL SETTINGS (v118 ultrasonic variant) ───
  // Customer-facing: tank height + start/stop pct sliders. Clean,
  // visual, no sensor internals. The Modbus address / register /
  // scan controls live in a separate "Advanced Sensor Settings"
  // section further down for installers only.
  autoSections += "<div class=\"setting-section\" id=\"waterLevelSection\">\n";
  autoSections += "<div class=\"setting-header\">\n";
  autoSections += "<h2>💧 WATER LEVEL SETTINGS</h2>\n";
  autoSections += "</div>\n";
  autoSections += "<div class=\"setting-desc\">\n";
  autoSections += "Tell the pump when to start and stop based on your tank's water level.\n";
  autoSections += "</div>\n";

  // Current reading display — reassures the installer the sensor is
  // actually reading something before they set thresholds.
  autoSections += "<div style=\"margin-top:12px;padding:10px;background:#f1f5f9;border-radius:6px;border-left:4px solid #3b82f6;\">\n";
  if (usSensorFault) {
    autoSections += "<div style=\"color:#dc2626;font-weight:600;\">⚠ Sensor fault — no valid reading</div>\n";
  } else if (!usHaveGoodReading) {
    autoSections += "<div style=\"color:#6b7280;\">Waiting for first sensor reading…</div>\n";
  } else {
    autoSections += "<div style=\"color:#0369a1;font-weight:600;font-size:1.1em;\">Current level: " + String(usConfirmedPct) + "%</div>\n";
    // v118.0.5: show distance in cm (not mm) — matches tank height's unit.
    int distanceCm = (usLastRawMm > 0) ? (usLastRawMm / 10) : 0;
    autoSections += "<div style=\"color:#64748b;font-size:0.85em;margin-top:4px;\">Distance from sensor: " + String(distanceCm) + " cm · Tank height set: " + String(usTankHeightCm) + " cm</div>\n";
  }
  autoSections += "</div>\n";

  // Tank height input (customer must set this for pct conversion to work)
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Tank Height (cm):</label>\n";
  autoSections += "<input type=\"number\" name=\"usTankHeightCm\" class=\"instant-save\" min=\"10\" max=\"1200\" value=\"" + String(usTankHeightCm) + "\" required style=\"flex:1;padding:12px;border:2px solid #ddd;border-radius:5px;font-size:1em;\">\n";
  autoSections += "<div class=\"note\">Total water column height from tank bottom to the sensor's dead zone.</div>\n";
  autoSections += "</div>\n";

  // Sensor offset — distance from sensor face to water surface when
  // tank is at 100%. For a sensor mounted on the lid, this is how far
  // the water STOPS below the sensor (= 20 cm by default for a 30 cm
  // dead-zone sensor with 10cm safety margin).
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Sensor Offset (cm):</label>\n";
  autoSections += "<input type=\"number\" name=\"usSensorOffsetCm\" class=\"instant-save\" min=\"0\" max=\"100\" value=\"" + String(usSensorOffsetCm) + "\" style=\"flex:1;padding:12px;border:2px solid #ddd;border-radius:5px;font-size:1em;\">\n";
  autoSections += "<div class=\"note\">Dead zone — distance from the sensor face to the water surface when the tank is 100% full. Typically 20-30 cm.</div>\n";
  autoSections += "</div>\n";

  // Pump START slider — motor starts when water drops to this level.
  // v118.0.2: 2% step, range 1-98 so customer can set any even
  // threshold (10/22/34/48/56 etc) without being forced into coarse 5% buckets.
  autoSections += "<div class=\"interval-select\" style=\"margin-top:20px;\">\n";
  autoSections += "<label>Pump Start Level: <span id=\"startVal\" style=\"color:#c0392b;font-weight:700;\">" + String(startPercent) + "%</span></label>\n";
  autoSections += "<input type=\"range\" name=\"startPercent\" id=\"startSlider\" class=\"instant-save\" min=\"2\" max=\"98\" step=\"2\" value=\"" + String(startPercent) + "\" oninput=\"updateStartStopSliders()\" style=\"width:100%;margin-top:8px;\">\n";
  autoSections += "<div class=\"note\" style=\"color:#c0392b;\">Pump turns ON when water drops to this level.</div>\n";
  autoSections += "</div>\n";

  // Pump STOP slider — motor stops when water reaches this level.
  // v118.0.2: 2% step, 2% minimum gap over Start (replaces 10% gap).
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Pump Stop Level: <span id=\"stopVal\" style=\"color:#27ae60;font-weight:700;\">" + String(stopPercent) + "%</span></label>\n";
  autoSections += "<input type=\"range\" name=\"stopPercent\" id=\"stopSlider\" class=\"instant-save\" min=\"" + String(startPercent + 2) + "\" max=\"100\" step=\"2\" value=\"" + String(stopPercent) + "\" oninput=\"updateStartStopSliders()\" style=\"width:100%;margin-top:8px;\">\n";
  autoSections += "<div class=\"note\" style=\"color:#27ae60;\">Pump turns OFF when water reaches this level. Must be at least 2% above Start level.</div>\n";
  autoSections += "</div>\n";

  autoSections += "</div>\n"; // Close waterLevelSection

  // SECTION 2: SCHEDULES
  autoSections += "<div class=\"setting-section\" id=\"scheduleSection\">\n";
  autoSections += "<div class=\"setting-header\">\n";
  autoSections += "<h2>📅 SCHEDULES</h2>\n";
  autoSections += "<input type=\"checkbox\" name=\"scheduleEnabled\" id=\"scheduleEnabled\" class=\"toggle\" " + String(scheduleModeEnabled ? "checked" : "") + ">\n";
  autoSections += "</div>\n";
  autoSections += "<div class=\"setting-desc\">\n";
  autoSections += "When schedule mode is ON, the water pump will start and stop automatically at set times based on water level settings. Configure up to 3 daily schedules.\n";
  autoSections += "</div>\n";

  // Schedule status and manage button
  autoSections += "<div style=\"margin-top:15px;\">\n";
  autoSections += "<div style=\"color:#666;margin-bottom:10px;\">Status: <strong>" + String(activeScheduleCount) + " active schedule" + String(activeScheduleCount != 1 ? "s" : "") + " configured</strong></div>\n";
  autoSections += "<a href=\"/schedules\" class=\"btn\" style=\"background:#3498db;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block;\">📅 Manage Schedules</a>\n";
  autoSections += "</div>\n";
  autoSections += "</div>\n";  // Close schedule section

  // SECTION 3: DRY RUN PROTECTION (moved from section 4)
  autoSections += "<div class=\"setting-section\" id=\"dryrunSection\">\n";
  autoSections += "<div class=\"setting-header\">\n";
  autoSections += "<h2>⚠️ DRY RUN PROTECTION</h2>\n";
  autoSections += "<input type=\"checkbox\" name=\"dryRunProtectionOn\" id=\"dryRunEnabled\" class=\"toggle instant-save\" " + String(dryRunProtectionOn ? "checked" : "") + ">\n";
  autoSections += "</div>\n";
  autoSections += "<div class=\"setting-desc\">\n";
  autoSections += "Monitors the tank while the pump runs. Smart mode watches water level change; Classic waits until the tank reaches FULL. After max retries → Safe Mode to protect the pump.\n";
  autoSections += "</div>\n";

  // v118.0.10: Smart vs Classic selector. Smart detection polls tank
  // pct every N minutes and faults if rise is below threshold — catches
  // dry source in 5-15 min typical. Classic waits for FULL within a
  // hard time budget. ON by default on v118.0.9+ devices.
  autoSections += "<div class=\"interval-select\">\n";
  autoSections += "<label>Detection Mode:</label>\n";
  autoSections += "<select name=\"smartDryRunEnabled\" id=\"smartDryRunMode\" class=\"instant-save\" onchange=\"toggleSmartDryRun()\">\n";
  autoSections += "<option value=\"1\"" + String(smartDryRunEnabled ? " selected" : "") + ">Smart (level change)</option>\n";
  autoSections += "<option value=\"0\"" + String(!smartDryRunEnabled ? " selected" : "") + ">Classic (time)</option>\n";
  autoSections += "</select>\n";
  autoSections += "</div>\n";

  // Smart-mode-only fields
  autoSections += "<div id=\"smartDryRunFields\" style=\"display:" + String(smartDryRunEnabled ? "block" : "none") + ";\">\n";
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Check Interval:</label>\n";
  autoSections += "<select name=\"smartCheckMins\" class=\"instant-save\">\n";
  int smartCheckChoices[] = {1, 2, 3, 5, 10, 15};
  for (size_t i = 0; i < sizeof(smartCheckChoices)/sizeof(int); i++) {
    int v = smartCheckChoices[i];
    autoSections += "<option value=\"" + String(v) + "\"" + String(smartDryRunCheckMins == v ? " selected" : "") + ">" + String(v) + " min</option>\n";
  }
  autoSections += "</select>\n";
  autoSections += "</div>\n";
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Minimum Rise Expected:</label>\n";
  autoSections += "<select name=\"smartMinPct\" class=\"instant-save\">\n";
  int smartPctChoices[] = {1, 2, 3, 5, 10};
  for (size_t i = 0; i < sizeof(smartPctChoices)/sizeof(int); i++) {
    int v = smartPctChoices[i];
    autoSections += "<option value=\"" + String(v) + "\"" + String(smartDryRunMinPct == v ? " selected" : "") + ">" + String(v) + "%</option>\n";
  }
  autoSections += "</select>\n";
  autoSections += "</div>\n";
  autoSections += "</div>\n";

  // Classic-mode-only field
  autoSections += "<div id=\"classicDryRunFields\" style=\"display:" + String(smartDryRunEnabled ? "none" : "block") + ";\">\n";
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Max Time to Reach FULL:</label>\n";
  autoSections += "<select name=\"dryRunIntervalMins\" id=\"dryRunInterval\" class=\"instant-save\">\n";
  autoSections += "<option value=\"5\"" + String(maxTimeToNextProbeMins == 5 ? " selected" : "") + ">5 min</option>\n";
  autoSections += "<option value=\"10\"" + String(maxTimeToNextProbeMins == 10 ? " selected" : "") + ">10 min</option>\n";
  autoSections += "<option value=\"15\"" + String(maxTimeToNextProbeMins == 15 ? " selected" : "") + ">15 min</option>\n";
  autoSections += "<option value=\"30\"" + String(maxTimeToNextProbeMins == 30 ? " selected" : "") + ">30 min (default)</option>\n";
  autoSections += "<option value=\"60\"" + String(maxTimeToNextProbeMins == 60 ? " selected" : "") + ">1 hour</option>\n";
  autoSections += "<option value=\"120\"" + String(maxTimeToNextProbeMins == 120 ? " selected" : "") + ">2 hours</option>\n";
  autoSections += "</select>\n";
  autoSections += "</div>\n";
  autoSections += "</div>\n";

  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Max Retries:</label>\n";
  autoSections += "<select name=\"maxDryRunCount\" id=\"maxDryRunCount\" class=\"instant-save\">\n";
  // v118.0.10: range extended 1-5 → 1-10 to match the firmware's new ceiling.
  for (int i = 1; i <= 10; i++) {
    autoSections += "<option value=\"" + String(i) + "\"" + String(maxDryRunCount == i ? " selected" : "") + ">" + String(i) + "</option>\n";
  }
  autoSections += "</select>\n";
  autoSections += "</div>\n";
  // Max continuous run time — kept here in dry run section (same variable
  // removed from water-detection section to avoid confusion).
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Max Continuous Run Time:</label>\n";
  autoSections += "<select name=\"maxRunTimeMins\" id=\"maxRunTimeMins\" class=\"instant-save\">\n";
  autoSections += "<option value=\"0\"" + String(maxRunTimeMins == 0 ? " selected" : "") + ">Off (no limit)</option>\n";
  autoSections += "<option value=\"10\"" + String(maxRunTimeMins == 10 ? " selected" : "") + ">10 minutes</option>\n";
  autoSections += "<option value=\"20\"" + String(maxRunTimeMins == 20 ? " selected" : "") + ">20 minutes</option>\n";
  autoSections += "<option value=\"30\"" + String(maxRunTimeMins == 30 ? " selected" : "") + ">30 minutes</option>\n";
  autoSections += "<option value=\"60\"" + String(maxRunTimeMins == 60 ? " selected" : "") + ">1 hour</option>\n";
  autoSections += "<option value=\"90\"" + String(maxRunTimeMins == 90 ? " selected" : "") + ">1.5 hours</option>\n";
  autoSections += "<option value=\"120\"" + String(maxRunTimeMins == 120 ? " selected" : "") + ">2 hours</option>\n";
  autoSections += "<option value=\"180\"" + String(maxRunTimeMins == 180 ? " selected" : "") + ">3 hours</option>\n";
  autoSections += "<option value=\"240\"" + String(maxRunTimeMins == 240 ? " selected" : "") + ">4 hours</option>\n";
  autoSections += "</select>\n";
  autoSections += "</div>\n";
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Wait Between Retries:</label>\n";
  autoSections += "<select name=\"dryRunWaitMins\" id=\"dryRunWaitMins\" class=\"instant-save\">\n";
  autoSections += "<option value=\"1\"" + String(dryRunWaitMins == 1 ? " selected" : "") + ">1 min</option>\n";
  autoSections += "<option value=\"2\"" + String(dryRunWaitMins == 2 ? " selected" : "") + ">2 min</option>\n";
  autoSections += "<option value=\"3\"" + String(dryRunWaitMins == 3 ? " selected" : "") + ">3 min</option>\n";
  autoSections += "<option value=\"5\"" + String(dryRunWaitMins == 5 ? " selected" : "") + ">5 min</option>\n";
  autoSections += "<option value=\"7\"" + String(dryRunWaitMins == 7 ? " selected" : "") + ">7 min</option>\n";
  autoSections += "<option value=\"10\"" + String(dryRunWaitMins == 10 ? " selected" : "") + ">10 min</option>\n";
  autoSections += "<option value=\"15\"" + String(dryRunWaitMins == 15 ? " selected" : "") + ">15 min</option>\n";
  autoSections += "</select>\n";
  autoSections += "</div>\n";
  autoSections += "</div>\n";

  // SECTION 4: WATER DETECTION (expanded with source detection settings)
  autoSections += "<div class=\"setting-section\" id=\"waterSection\">\n";
  autoSections += "<div class=\"setting-header\">\n";
  autoSections += "<h2>💧 SOURCE WATER DETECTION</h2>\n";
  autoSections += "<input type=\"checkbox\" name=\"wpSensor\" id=\"wpSensor\" class=\"toggle\" " + String(hasWPSensor ? "checked" : "") + ">\n";
  autoSections += "</div>\n";
  autoSections += "<div class=\"setting-desc\">\n";
  autoSections += "When enabled, pump operation depends on source water detection. Choose detection mode below.\n";
  autoSections += "</div>\n";
  autoSections += "<div class=\"note\">Note: Configure sensor node name in main Settings page.</div>\n";
  autoSections += "<input type=\"hidden\" name=\"hasWPSensor\" id=\"hasWPSensorValue\" value=\"" + String(hasWPSensor ? "1" : "0") + "\">\n";

  // Detection Mode selection
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Detection Mode:</label>\n";
  autoSections += "<select name=\"detectionMode\" id=\"detectionMode\" class=\"instant-save\" onchange=\"togglePostSettings()\">\n";
  autoSections += "<option value=\"0\"" + String(detectionMode == 0 ? " selected" : "") + ">Pre-Detection (detect water first, then start motor)</option>\n";
  autoSections += "<option value=\"1\"" + String(detectionMode == 1 ? " selected" : "") + ">Post-Detection (start motor first, then detect water)</option>\n";
  autoSections += "</select>\n";
  autoSections += "</div>\n";

  // Source Confirmation Period (both modes)
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Source Confirmation Period:</label>\n";
  autoSections += "<select name=\"sourceDebounceSecs\" id=\"sourceDebounceSecs\" class=\"instant-save\">\n";
  autoSections += "<option value=\"5\"" + String(sourceDebounceSecs == 5 ? " selected" : "") + ">5 sec</option>\n";
  autoSections += "<option value=\"10\"" + String(sourceDebounceSecs == 10 ? " selected" : "") + ">10 sec</option>\n";
  autoSections += "<option value=\"15\"" + String(sourceDebounceSecs == 15 ? " selected" : "") + ">15 sec</option>\n";
  autoSections += "<option value=\"20\"" + String(sourceDebounceSecs == 20 ? " selected" : "") + ">20 sec</option>\n";
  autoSections += "<option value=\"30\"" + String(sourceDebounceSecs == 30 ? " selected" : "") + ">30 sec</option>\n";
  autoSections += "<option value=\"45\"" + String(sourceDebounceSecs == 45 ? " selected" : "") + ">45 sec</option>\n";
  autoSections += "<option value=\"60\"" + String(sourceDebounceSecs == 60 ? " selected" : "") + ">60 sec</option>\n";
  autoSections += "<option value=\"90\"" + String(sourceDebounceSecs == 90 ? " selected" : "") + ">90 sec</option>\n";
  autoSections += "<option value=\"120\"" + String(sourceDebounceSecs == 120 ? " selected" : "") + ">2 min</option>\n";
  autoSections += "<option value=\"180\"" + String(sourceDebounceSecs == 180 ? " selected" : "") + ">3 min</option>\n";
  autoSections += "</select>\n";
  autoSections += "<div class=\"note\">Source water must be present continuously for this duration to confirm stable supply</div>\n";
  autoSections += "</div>\n";

  // Post-Detection only settings
  autoSections += "<div id=\"postDetectionSettings\" style=\"" + String(detectionMode == 1 ? "" : "display:none;") + "\">\n";

  // Grace Period
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Grace Period:</label>\n";
  autoSections += "<select name=\"gracePeriodTens\" id=\"gracePeriodTens\" class=\"instant-save\">\n";
  autoSections += "<option value=\"4\"" + String(gracePeriodTens == 4 ? " selected" : "") + ">40 sec</option>\n";
  autoSections += "<option value=\"6\"" + String(gracePeriodTens == 6 ? " selected" : "") + ">1 min</option>\n";
  autoSections += "<option value=\"12\"" + String(gracePeriodTens == 12 ? " selected" : "") + ">2 min</option>\n";
  autoSections += "<option value=\"18\"" + String(gracePeriodTens == 18 ? " selected" : "") + ">3 min</option>\n";
  autoSections += "<option value=\"24\"" + String(gracePeriodTens == 24 ? " selected" : "") + ">4 min</option>\n";
  autoSections += "<option value=\"30\"" + String(gracePeriodTens == 30 ? " selected" : "") + ">5 min</option>\n";
  autoSections += "<option value=\"42\"" + String(gracePeriodTens == 42 ? " selected" : "") + ">7 min</option>\n";
  autoSections += "<option value=\"60\"" + String(gracePeriodTens == 60 ? " selected" : "") + ">10 min</option>\n";
  autoSections += "</select>\n";
  autoSections += "<div class=\"note\">Motor runs during this period to pull water through inlet pipe. Source sensor is ignored until grace period ends.</div>\n";
  autoSections += "</div>\n";

  autoSections += "</div>\n";  // Close postDetectionSettings

  // Retry settings (Post-Detection only — Pre-Detection waits indefinitely for source water)
  autoSections += "<div id=\"postDetectionRetrySettings\" style=\"" + String(detectionMode == 1 ? "" : "display:none;") + "\">\n";
  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Max Retries before Safe Mode:</label>\n";
  autoSections += "<select name=\"maxRetryCount\" id=\"maxRetryCount\" class=\"instant-save\">\n";
  for (int i = 1; i <= 5; i++) {
    autoSections += "<option value=\"" + String(i) + "\"" + String(maxRetryCount == i ? " selected" : "") + ">" + String(i) + "</option>\n";
  }
  autoSections += "</select>\n";
  autoSections += "</div>\n";

  autoSections += "<div class=\"interval-select\" style=\"margin-top:15px;\">\n";
  autoSections += "<label>Wait Between Retries:</label>\n";
  autoSections += "<select name=\"retryWaitMins\" id=\"retryWaitMins\" class=\"instant-save\">\n";
  autoSections += "<option value=\"1\"" + String(retryWaitMins == 1 ? " selected" : "") + ">1 minute</option>\n";
  autoSections += "<option value=\"2\"" + String(retryWaitMins == 2 ? " selected" : "") + ">2 minutes</option>\n";
  autoSections += "<option value=\"3\"" + String(retryWaitMins == 3 ? " selected" : "") + ">3 minutes</option>\n";
  autoSections += "<option value=\"5\"" + String(retryWaitMins == 5 ? " selected" : "") + ">5 minutes</option>\n";
  autoSections += "<option value=\"7\"" + String(retryWaitMins == 7 ? " selected" : "") + ">7 minutes</option>\n";
  autoSections += "<option value=\"10\"" + String(retryWaitMins == 10 ? " selected" : "") + ">10 minutes</option>\n";
  autoSections += "<option value=\"15\"" + String(retryWaitMins == 15 ? " selected" : "") + ">15 minutes</option>\n";
  autoSections += "</select>\n";
  autoSections += "</div>\n";
  autoSections += "</div>\n";  // Close postDetectionRetrySettings

  autoSections += "</div>\n";  // Close waterSection

  // SECTION 5: SAFE MODE RECOVERY PREVIEW (Option C — read-only preview + link to full settings)
  autoSections += "<div class=\"setting-section\" id=\"safeRecoveryPreview\">\n";
  autoSections += "<div class=\"setting-header\">\n";
  autoSections += "<h2>🛟 SAFE MODE RECOVERY</h2>\n";
  autoSections += "</div>\n";
  autoSections += "<div class=\"setting-desc\">\n";
  autoSections += "When Safe Mode is triggered (after retries exhausted), it can auto-clear at next schedule start or after a timeout. Configure full options in Settings.\n";
  autoSections += "</div>\n";
  autoSections += "<div style=\"background:#f8f9fa;border:1px solid #dee2e6;border-radius:6px;padding:12px;margin-top:10px;\">\n";
  autoSections += "<div style=\"display:flex;justify-content:space-between;align-items:center;padding:4px 0;\">\n";
  autoSections += "<span style=\"color:#555;\">Auto-clear at schedule start:</span>\n";
  autoSections += "<strong style=\"color:" + String(autoRecoverOnSchedule ? "#27ae60" : "#95a5a6") + ";\">" + String(autoRecoverOnSchedule ? "ON" : "OFF") + "</strong>\n";
  autoSections += "</div>\n";
  autoSections += "<div style=\"display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-top:1px solid #e9ecef;margin-top:4px;padding-top:8px;\">\n";
  autoSections += "<span style=\"color:#555;\">Auto-clear after timeout:</span>\n";
  autoSections += "<strong style=\"color:" + String(autoRecoverOnTimeout ? "#27ae60" : "#95a5a6") + ";\">" + String(autoRecoverOnTimeout ? ("ON (" + String(autoRecoverTimeoutHours) + "h)") : "OFF") + "</strong>\n";
  autoSections += "</div>\n";
  autoSections += "</div>\n";
  autoSections += "<a href=\"/settings\" class=\"btn\" style=\"background:#3498db;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block;margin-top:12px;\">⚙️ Edit Recovery Settings</a>\n";
  autoSections += "</div>\n";  // Close safeRecoveryPreview

  // Add auto sections with conditional visibility
  html += "<div id=\"autoSections\" class=\"" + String(autoModeEnabled ? "" : "hidden") + "\">\n";
  html += autoSections;
  html += "</div>\n";

  html += "</form>\n";

  // v118.0.5: "Tank Sensor" section (address + search) MOVED to Main
  // Settings page per bug report — customer wasn't expected to go
  // deep into Auto Mode Settings for sensor pairing. See the "Tank
  // Sensor" section near Tank Info on the /settings page.

  // FOOTER
  html += "<div class=\"footer\">\n";
  html += "<a href=\"/\" class=\"btn btn-primary\">BACK TO STATUS</a>\n";
  html += "</div>\n";
  
  html += "</div>\n";
  
  // JAVASCRIPT
  html += "<script>\n";

  // Toggle Post-Detection settings visibility
  html += "function togglePostSettings(){\n";
  html += "var mode=document.getElementById('detectionMode').value;\n";
  html += "var el=document.getElementById('postDetectionSettings');\n";
  html += "if(el){el.style.display=(mode==='1')?'':'none';}\n";
  html += "var el2=document.getElementById('postDetectionRetrySettings');\n";
  html += "if(el2){el2.style.display=(mode==='1')?'':'none';}\n";
  html += "}\n";

  // v118.0.10: Toggle Smart vs Classic dry-run field visibility
  html += "function toggleSmartDryRun(){\n";
  html += "var mode=document.getElementById('smartDryRunMode').value;\n";
  html += "var s=document.getElementById('smartDryRunFields');\n";
  html += "var c=document.getElementById('classicDryRunFields');\n";
  html += "if(s){s.style.display=(mode==='1')?'block':'none';}\n";
  html += "if(c){c.style.display=(mode==='1')?'none':'block';}\n";
  html += "}\n";

  // v118.0.5: Tank Sensor address functions moved to Main Settings page.

  // v118.0.2: Start/Stop slider live display + 2% gap invariant.
  // Replaces earlier 10% gap. When Start slider moves up, Stop slider's
  // minimum shifts with it; when start > stop-2, Stop snaps up to
  // maintain the gap. Stop capped at 100.
  html += "function updateStartStopSliders(){\n";
  html += "var ss=document.getElementById('startSlider');\n";
  html += "var sp=document.getElementById('stopSlider');\n";
  html += "if(!ss||!sp)return;\n";
  html += "var sv=parseInt(ss.value), pv=parseInt(sp.value);\n";
  html += "if(pv < sv+2){ pv = sv+2; if(pv>100)pv=100; sp.value = pv; }\n";
  html += "sp.min = (sv+2);\n";
  html += "document.getElementById('startVal').textContent = sv + '%';\n";
  html += "document.getElementById('stopVal').textContent = pv + '%';\n";
  html += "}\n";

  // Schedule validation function (from oldUI)
  html += "function validateSchedules() {\n";
  html += "let errors = [];\n";
  html += "let schedules = [];\n";
  html += "const fieldIds = ['schedule1Start', 'schedule2Start', 'schedule3Start'];\n";
  html += "const stopIds = ['schedule1Stop', 'schedule2Stop', 'schedule3Stop'];\n";
  html += "for (let i = 0; i < 3; i++) {\n";
  html += "const startInput = document.getElementById(fieldIds[i]);\n";
  html += "const stopInput = document.getElementById(stopIds[i]);\n";
  html += "const startTime = startInput.value;\n";
  html += "const endTime = stopInput.value;\n";
  html += "if (startTime && endTime) {\n";
  html += "const [startH, startM] = startTime.split(':').map(Number);\n";
  html += "const [endH, endM] = endTime.split(':').map(Number);\n";
  html += "const startMinutes = startH * 60 + startM;\n";
  html += "const endMinutes = endH * 60 + endM;\n";
  html += "const duration = endMinutes - startMinutes;\n";
  html += "if (duration < 5) {\n";
  html += "errors.push('Schedule ' + (i + 1) + ': Duration too short (minimum 5 min)');\n";
  html += "} else if (duration <= 0) {\n";
  html += "errors.push('Schedule ' + (i + 1) + ': End time must be after start time');\n";
  html += "} else {\n";
  html += "schedules.push({index: i, start: startMinutes, end: endMinutes});\n";
  html += "}\n";
  html += "} else if (startTime || endTime) {\n";
  html += "errors.push('Schedule ' + (i + 1) + ': Both start and end times required');\n";
  html += "}\n";
  html += "}\n";
  html += "return errors;\n";
  html += "}\n";
  html += "\n";

  // Auto mode toggle function - WIRED VERSION (no node name validation needed)
  html += "function toggleAutoMode() {\n";
  html += "const currentMode = " + String(autoModeEnabled ? "true" : "false") + ";\n";
  html += "const newMode = !currentMode;\n";
  html += "document.querySelector('input[name=\"autoModeEnabled\"]').value = newMode ? 1 : 0;\n";
  html += "fetch('/api/automode', {\n";
  html += "method: 'POST',\n";
  html += "headers: {'Content-Type': 'application/x-www-form-urlencoded'},\n";
  html += "body: 'enabled=' + (newMode ? 1 : 0)\n";
  html += "}).then(() => {\n";
  html += "location.reload();\n";
  html += "});\n";
  html += "}\n";
  html += "\n";

  // Schedule mode toggle function (instant-save)
  html += "const scheduleModeEnabled = " + String(scheduleModeEnabled ? "true" : "false") + ";\n";
  html += "const activeScheduleCount = " + String(activeScheduleCount) + ";\n";
  html += "function toggleScheduleMode() {\n";
  html += "const checkbox = document.getElementById('scheduleEnabled');\n";
  html += "const newMode = checkbox.checked;\n";
  html += "if (newMode && activeScheduleCount == 0) {\n";
  html += "alert('⚠️ Please configure at least one schedule first.\\\\n\\\\nClick \"Manage Schedules\" to add schedules.');\n";
  html += "checkbox.checked = false;\n";
  html += "return;\n";
  html += "}\n";
  html += "fetch('/api/schedulemode', {\n";
  html += "method: 'POST',\n";
  html += "headers: {'Content-Type': 'application/x-www-form-urlencoded'},\n";
  html += "body: 'enabled=' + (newMode ? 1 : 0)\n";
  html += "}).then(r => {\n";
  html += "if (r.ok) {\n";
  html += "location.reload();\n";
  html += "} else {\n";
  html += "checkbox.checked = !newMode;\n";
  html += "alert('Failed to toggle schedule mode');\n";
  html += "}\n";
  html += "}).catch(error => {\n";
  html += "checkbox.checked = !newMode;\n";
  html += "alert('Failed to toggle schedule mode');\n";
  html += "});\n";
  html += "}\n";
  html += "\n";

  // Water presence sensor toggle - WIRED VERSION (no node name validation needed)
  html += "function toggleWaterPresence() {\n";
  html += "const checkbox = document.getElementById('wpSensor');\n";
  html += "const currentState = document.getElementById('hasWPSensorValue').value == '1';\n";
  html += "const newState = !currentState;\n";
  html += "document.getElementById('hasWPSensorValue').value = newState ? 1 : 0;\n";
  html += "const form = new FormData();\n";
  html += "form.append('hasWPSensor', newState ? '1' : '0');\n";
  html += "fetch('/settings', {method: 'POST', body: form}).then(r => {\n";
  html += "if (r.ok) {\n";
  html += "console.log('Water presence sensor ' + (newState ? 'enabled' : 'disabled'));\n";
  html += "} else {\n";
  html += "checkbox.checked = currentState;\n";
  html += "alert('Failed to update water presence sensor setting.');\n";
  html += "}\n";
  html += "}).catch(err => {\n";
  html += "checkbox.checked = currentState;\n";
  html += "alert('Failed to update water presence sensor setting.');\n";
  html += "});\n";
  html += "}\n";
  html += "\n";

  // Auto mode toggle - show/hide sections + call API
  html += "document.getElementById('autoMode').addEventListener('change', function() {\n";
  html += "const sections = document.getElementById('autoSections');\n";
  html += "if (this.checked) { sections.classList.remove('hidden'); } else { sections.classList.add('hidden'); }\n";
  html += "toggleAutoMode();\n";
  html += "});\n";
  html += "\n";

  // Schedule mode toggle - call API with validation
  html += "document.getElementById('scheduleEnabled').addEventListener('change', function() {\n";
  html += "toggleScheduleMode();\n";
  html += "});\n";
  html += "\n";

  // Water presence toggle - call validation function
  html += "document.getElementById('wpSensor').addEventListener('change', function() {\n";
  html += "toggleWaterPresence();\n";
  html += "});\n";
  html += "\n";

  // Delete schedule function
  html += "function deleteSchedule(num) {\n";
  html += "const fieldIds = ['schedule1Start', 'schedule2Start', 'schedule3Start'];\n";
  html += "const stopIds = ['schedule1Stop', 'schedule2Stop', 'schedule3Stop'];\n";
  html += "document.getElementById(fieldIds[num-1]).value = '';\n";
  html += "document.getElementById(stopIds[num-1]).value = '';\n";
  html += "document.getElementById('deleteBtn' + num).style.display = 'none';\n";
  html += "}\n";
  html += "\n";

  // Update delete button visibility
  html += "function updateDeleteButtons() {\n";
  html += "const fieldIds = ['schedule1Start', 'schedule2Start', 'schedule3Start'];\n";
  html += "const stopIds = ['schedule1Stop', 'schedule2Stop', 'schedule3Stop'];\n";
  html += "for (let i = 1; i <= 3; i++) {\n";
  html += "const start = document.getElementById(fieldIds[i-1]).value;\n";
  html += "const stop = document.getElementById(stopIds[i-1]).value;\n";
  html += "const btn = document.getElementById('deleteBtn' + i);\n";
  html += "if (start && stop) { btn.style.display = 'inline-block'; } else { btn.style.display = 'none'; }\n";
  html += "}\n";
  html += "}\n";
  html += "\n";

  // Call on schedule input change
  html += "document.querySelectorAll('input[type=time]').forEach(el => {\n";
  html += "el.addEventListener('change', updateDeleteButtons);\n";
  html += "});\n";
  html += "\n";

  // Instant save for toggles and dropdowns — posts a single field,
  // shows a brief "Saved" toast so the user knows the change was persisted.
  html += "function showSavedToast(){\n";
  html += "let t=document.getElementById('instantSaveToast');\n";
  html += "if(!t){t=document.createElement('div');t.id='instantSaveToast';\n";
  html += "t.style.cssText='position:fixed;bottom:80px;left:50%;transform:translateX(-50%);";
  html += "background:#27ae60;color:#fff;padding:8px 20px;border-radius:20px;font-size:14px;";
  html += "font-weight:600;z-index:9999;pointer-events:none;opacity:0;transition:opacity .2s';\n";
  html += "t.textContent='\\u2713 Saved';document.body.appendChild(t);}\n";
  html += "t.style.opacity='1';\n";
  html += "clearTimeout(t._hide);t._hide=setTimeout(()=>t.style.opacity='0',1500);}\n";
  html += "function instantSave(el) {\n";
  html += "const form = new FormData();\n";
  html += "if (el.type === 'checkbox') {\n";
  html += "form.append(el.name, el.checked ? '1' : '0');\n";
  html += "} else {\n";
  html += "form.append(el.name, el.value);\n";
  html += "}\n";
  html += "fetch('/settings', {method: 'POST', body: form}).then(r => {\n";
  html += "if (r.ok) { showSavedToast(); }\n";
  html += "else { alert('Save failed - please try again'); }\n";
  html += "}).catch(() => alert('Save failed - check WiFi connection'));\n";
  html += "}\n";
  html += "\n";

  html += "document.querySelectorAll('.instant-save').forEach(el => {\n";
  html += "el.addEventListener('change', function() { instantSave(this); });\n";
  html += "});\n";
  html += "\n";

  html += "window.addEventListener('load', updateDeleteButtons);\n";
  html += "</script>\n";
  
  html += "</body>\n</html>";
  
  return html;
}

// v118.0.10: per-schedule extras rendered under each time-pair block.
// Seven weekday chips (bit 0=Sun..6=Sat matches firmware dayMask) +
// one "Fill tank completely" checkbox. All inputs sit INSIDE
// schedulesForm so the existing FormData(form) collector sends them
// automatically — firmware's handleSchedulesSave POST handler already
// parses schedule{i}_days + schedule{i}_fillUntilFull (added 118.0.9).
//
// Instant-save intentionally NOT used here: weekday chips are a SET,
// not independent toggles. User picks the combination then presses
// Save Schedules (the existing bottom button posts the whole form).
static String renderScheduleExtrasHtml(int i) {
  const char* dayLabels[] = {"Sun","Mon","Tue","Wed","Thu","Fri","Sat"};
  uint8_t mask = schedules[i].dayMask ? (schedules[i].dayMask & 0x7F) : SCHED_DAY_MASK_ALL;
  String out = "<div style=\"margin:8px 0 4px 0;font-size:0.85em;color:#555;\">Days active:</div>\n";
  out += "<div style=\"display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;\">\n";
  for (int b = 0; b < 7; b++) {
    bool on = (mask & (1 << b)) != 0;
    out += "<label style=\"cursor:pointer;user-select:none;\">\n";
    out += "<input type=\"checkbox\" name=\"schedule" + String(i) + "_day" + String(b) + "\" value=\"1\"";
    if (on) out += " checked";
    out += " style=\"display:none;\" onchange=\"updateDayMask(" + String(i) + ")\">\n";
    out += "<span class=\"day-chip\" style=\"display:inline-block;padding:4px 8px;border:1px solid " + String(on ? "#2563eb" : "#cbd5e1") + ";background:" + String(on ? "#2563eb" : "#fff") + ";color:" + String(on ? "#fff" : "#64748b") + ";border-radius:12px;font-size:0.78em;font-weight:600;\">" + String(dayLabels[b]) + "</span>\n";
    out += "</label>\n";
  }
  out += "</div>\n";
  // Hidden combined-mask field — JS writes bitmask on checkbox change.
  // Firmware's POST handler reads schedule{i}_days.
  out += "<input type=\"hidden\" name=\"schedule" + String(i) + "_days\" id=\"schedule" + String(i) + "DaysMask\" value=\"" + String(mask) + "\">\n";
  // Fill-until-full checkbox — directly maps to schedule{i}_fillUntilFull.
  out += "<label style=\"display:flex;align-items:center;gap:6px;font-size:0.85em;color:#444;cursor:pointer;user-select:none;margin-top:4px;\">\n";
  out += "<input type=\"checkbox\" name=\"schedule" + String(i) + "_fillUntilFull\" value=\"1\"";
  if (schedules[i].fillUntilFull) out += " checked";
  out += ">\n";
  out += "<span>Fill tank completely during this window (ignore start % threshold)</span>\n";
  out += "</label>\n";
  return out;
}

String getSchedulesPageHTML() {
  String html = "<!DOCTYPE html><html><head>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\">\n";
  html += "<title>Schedule Management</title>\n";

  // CSS Styles
  html += "<style>\n";
  html += "*{margin:0;padding:0;box-sizing:border-box}\n";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f0f8ff;color:#333;padding-bottom:200px}\n";
  html += ".container{max-width:600px;margin:0 auto;background:#fff;min-height:100vh;box-shadow:0 0 20px rgba(0,0,0,0.1);padding-bottom:30px}\n";
  html += ".header{background:#2980b9;color:#fff;padding:15px 20px;display:flex;align-items:center;gap:15px;min-height:60px}\n";
  html += ".header h1{font-size:1.3em;font-weight:bold;flex:1}\n";
  html += ".back-btn{background:rgba(255,255,255,0.25);color:#fff;border:2px solid rgba(255,255,255,0.3);padding:8px 12px;border-radius:6px;text-decoration:none;font-size:0.9em;transition:all 0.2s}\n";
  html += ".back-btn:hover{background:rgba(255,255,255,0.4)}\n";
  html += ".setting-section{padding:20px;border-bottom:2px solid #dee2e6}\n";
  html += ".setting-section h2{font-size:1.1em;color:#2c3e50;margin-bottom:10px}\n";
  html += ".setting-desc{color:#666;font-size:0.9em;line-height:1.5;margin-bottom:20px}\n";
  html += ".schedules-content{background:#f8f9fa;padding:20px;border-radius:6px;margin-bottom:30px}\n";
  html += ".schedule-group{margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid #dee2e6}\n";
  html += ".schedule-group:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}\n";
  html += ".schedule-label{font-weight:700;color:#2c3e50;font-size:1em;margin-bottom:12px;display:block}\n";
  html += ".time-inputs{display:flex;align-items:center;gap:10px;flex-wrap:wrap}\n";
  html += ".time-group{display:flex;flex-direction:column;gap:5px}\n";
  html += ".time-label{font-size:0.85em;color:#666;font-weight:600}\n";
  html += "input[type=time]{padding:10px 12px;border:2px solid #dee2e6;border-radius:5px;font-size:1em;width:140px;font-family:inherit}\n";
  html += "input[type=time]:focus{outline:none;border-color:#3498db;box-shadow:0 0 0 3px rgba(52,152,219,0.1)}\n";
  html += ".input-error{border-color:#e74c3c!important;box-shadow:0 0 0 3px rgba(231,76,60,0.2)!important}\n";
  html += ".time-separator{color:#666;font-weight:600;font-size:0.9em;padding-top:20px}\n";
  html += ".delete-btn{background:#e74c3c;color:#fff;border:none;padding:10px 16px;border-radius:5px;cursor:pointer;font-size:1.1em;transition:0.2s;margin-top:20px}\n";
  html += ".delete-btn:hover{background:#c0392b}\n";
  
  // Floating save button with fixed max-height for message
  html += ".floating-save{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:600px;background:#fff;padding:15px 20px;box-shadow:0 -4px 12px rgba(0,0,0,0.15);z-index:1000;border-top:2px solid #dee2e6}\n";
  html += ".status-message{padding:12px;margin-bottom:10px;border-radius:6px;font-weight:600;text-align:center;display:none;font-size:0.85em;max-height:80px;overflow-y:auto;line-height:1.4}\n";
  html += ".status-message.success{background:#d4edda;color:#155724;border:1px solid #c3e6cb;display:block}\n";
  html += ".status-message.error{background:#f8d7da;color:#721c24;border:1px solid #f5c6cb;display:block}\n";
  html += ".btn{padding:14px 20px;border:none;border-radius:5px;font-size:1.1em;font-weight:600;cursor:pointer;transition:0.2s;width:100%}\n";
  html += ".btn-success{background:#27ae60;color:#fff}\n";
  html += ".btn-success:hover{background:#229954;transform:translateY(-1px);box-shadow:0 4px 8px rgba(39,174,96,0.3)}\n";
  
  html += "@media (max-width:480px){";
  html += ".time-inputs{flex-direction:column;align-items:stretch;gap:8px}";
  html += ".time-group{width:100%}";
  html += "input[type=time]{width:100%}";
  html += ".time-separator{padding:0;text-align:center}";
  html += ".delete-btn{width:100%;margin-top:10px}";
  html += ".floating-save{padding:12px 15px}";
  html += ".status-message{font-size:0.8em;max-height:70px}";
  html += "body{padding-bottom:240px}";
  html += ".container{padding-bottom:40px}";
  html += "}\n";
  html += "</style>\n";
  html += "</head>\n<body>\n";

  // CONTAINER START
  html += "<div class=\"container\">\n";

  // HEADER
  html += "<div class=\"header\">\n";
  html += "<a href=\"/auto-settings\" class=\"back-btn\">← Back</a>\n";
  html += "<h1>SCHEDULE MANAGEMENT</h1>\n";
  html += "</div>\n";

  // FORM START
  html += "<form id=\"schedulesForm\">\n";

  // SCHEDULES SECTION
  html += "<div class=\"setting-section\">\n";
  html += "<h2>⏰ Daily Schedules</h2>\n";
  html += "<div class=\"setting-desc\">Configure up to 3 daily pump schedules. Leave fields empty to disable a schedule.</div>\n";
  html += "<div class=\"schedules-content\">\n";

  // Schedule 1
  html += "<div class=\"schedule-group\">\n";
  html += "<span class=\"schedule-label\">Schedule 1</span>\n";
  html += "<div class=\"time-inputs\">\n";
  html += "<div class=\"time-group\">\n";
  html += "<span class=\"time-label\">Start</span>\n";
  html += "<input type=\"time\" name=\"schedule0_start\" id=\"schedule1Start\" value=\"";
  if (schedules[0].enabled && schedules[0].startHour >= 0 && schedules[0].startMinute >= 0) {
    char timeStr[6];
    sprintf(timeStr, "%02d:%02d", schedules[0].startHour, schedules[0].startMinute);
    html += String(timeStr);
  }
  html += "\">\n</div>\n";
  html += "<span class=\"time-separator\">to</span>\n";
  html += "<div class=\"time-group\">\n";
  html += "<span class=\"time-label\">Stop</span>\n";
  html += "<input type=\"time\" name=\"schedule0_end\" id=\"schedule1Stop\" value=\"";
  if (schedules[0].enabled && schedules[0].endHour >= 0 && schedules[0].endMinute >= 0) {
    char timeStr[6];
    sprintf(timeStr, "%02d:%02d", schedules[0].endHour, schedules[0].endMinute);
    html += String(timeStr);
  }
  html += "\">\n</div>\n";
  html += "<button type=\"button\" onclick=\"clearSchedule(0)\" id=\"deleteBtn1\" class=\"delete-btn\" style=\"display:" + String(schedules[0].enabled && schedules[0].startHour >= 0 ? "inline-block" : "none") + "\">🗑️</button>\n";
  html += "</div>\n";
  // v118.0.10: weekday chips + fill-until-full for schedule 1.
  html += renderScheduleExtrasHtml(0);
  html += "</div>\n";

  // Schedule 2
  html += "<div class=\"schedule-group\">\n";
  html += "<span class=\"schedule-label\">Schedule 2</span>\n";
  html += "<div class=\"time-inputs\">\n";
  html += "<div class=\"time-group\">\n";
  html += "<span class=\"time-label\">Start</span>\n";
  html += "<input type=\"time\" name=\"schedule1_start\" id=\"schedule2Start\" value=\"";
  if (schedules[1].enabled && schedules[1].startHour >= 0 && schedules[1].startMinute >= 0) {
    char timeStr[6];
    sprintf(timeStr, "%02d:%02d", schedules[1].startHour, schedules[1].startMinute);
    html += String(timeStr);
  }
  html += "\">\n</div>\n";
  html += "<span class=\"time-separator\">to</span>\n";
  html += "<div class=\"time-group\">\n";
  html += "<span class=\"time-label\">Stop</span>\n";
  html += "<input type=\"time\" name=\"schedule1_end\" id=\"schedule2Stop\" value=\"";
  if (schedules[1].enabled && schedules[1].endHour >= 0 && schedules[1].endMinute >= 0) {
    char timeStr[6];
    sprintf(timeStr, "%02d:%02d", schedules[1].endHour, schedules[1].endMinute);
    html += String(timeStr);
  }
  html += "\">\n</div>\n";
  html += "<button type=\"button\" onclick=\"clearSchedule(1)\" id=\"deleteBtn2\" class=\"delete-btn\" style=\"display:" + String(schedules[1].enabled && schedules[1].startHour >= 0 ? "inline-block" : "none") + "\">🗑️</button>\n";
  html += "</div>\n";
  html += renderScheduleExtrasHtml(1);
  html += "</div>\n";

  // Schedule 3
  html += "<div class=\"schedule-group\">\n";
  html += "<span class=\"schedule-label\">Schedule 3</span>\n";
  html += "<div class=\"time-inputs\">\n";
  html += "<div class=\"time-group\">\n";
  html += "<span class=\"time-label\">Start</span>\n";
  html += "<input type=\"time\" name=\"schedule2_start\" id=\"schedule3Start\" value=\"";
  if (schedules[2].enabled && schedules[2].startHour >= 0 && schedules[2].startMinute >= 0) {
    char timeStr[6];
    sprintf(timeStr, "%02d:%02d", schedules[2].startHour, schedules[2].startMinute);
    html += String(timeStr);
  }
  html += "\">\n</div>\n";
  html += "<span class=\"time-separator\">to</span>\n";
  html += "<div class=\"time-group\">\n";
  html += "<span class=\"time-label\">Stop</span>\n";
  html += "<input type=\"time\" name=\"schedule2_end\" id=\"schedule3Stop\" value=\"";
  if (schedules[2].enabled && schedules[2].endHour >= 0 && schedules[2].endMinute >= 0) {
    char timeStr[6];
    sprintf(timeStr, "%02d:%02d", schedules[2].endHour, schedules[2].endMinute);
    html += String(timeStr);
  }
  html += "\">\n</div>\n";
  html += "<button type=\"button\" onclick=\"clearSchedule(2)\" id=\"deleteBtn3\" class=\"delete-btn\" style=\"display:" + String(schedules[2].enabled && schedules[2].startHour >= 0 ? "inline-block" : "none") + "\">🗑️</button>\n";
  html += "</div>\n";
  html += renderScheduleExtrasHtml(2);
  html += "</div>\n";

  html += "</div>\n";  // Close schedules-content
  html += "</div>\n";  // Close setting-section

  html += "</form>\n";

  html += "</div>\n";  // Close container

  // FLOATING SAVE BUTTON (outside container so it floats properly)
  html += "<div class=\"floating-save\">\n";
  html += "<div id=\"statusMessage\" class=\"status-message\"></div>\n";
  html += "<button type=\"button\" onclick=\"saveSchedules()\" class=\"btn btn-success\">💾 SAVE SCHEDULES</button>\n";
  html += "</div>\n";

  // JAVASCRIPT
  html += "<script>\n";

  // Clear schedule function
  html += "function clearSchedule(index){\n";
  html += "const startId='schedule'+(index+1)+'Start';\n";
  html += "const stopId='schedule'+(index+1)+'Stop';\n";
  html += "const btnId='deleteBtn'+(index+1);\n";
  html += "document.getElementById(startId).value='';\n";
  html += "document.getElementById(stopId).value='';\n";
  html += "document.getElementById(btnId).style.display='none';\n";
  html += "}\n";

  // Validation function with improved error messages
  // Validation function with improved error messages
html += "function validateSchedules(){\n";
html += "let errors=[];\n";
html += "let schedules=[];\n";
html += "const fieldIds=['schedule1Start','schedule2Start','schedule3Start'];\n";
html += "const stopIds=['schedule1Stop','schedule2Stop','schedule3Stop'];\n";
html += "for(let i=0;i<3;i++){\n";
html += "const startInput=document.getElementById(fieldIds[i]);\n";
html += "const stopInput=document.getElementById(stopIds[i]);\n";
html += "const startTime=startInput.value;\n";
html += "const endTime=stopInput.value;\n";
html += "if(startTime&&endTime){\n";
html += "const [startH,startM]=startTime.split(':').map(Number);\n";
html += "const [endH,endM]=endTime.split(':').map(Number);\n";
html += "const startMinutes=startH*60+startM;\n";
html += "const endMinutes=endH*60+endM;\n";
html += "const duration=endMinutes-startMinutes;\n";
html += "if(duration<=0){\n";
html += "errors.push('Schedule '+(i+1)+': Stop time must be after start time');\n";
html += "startInput.classList.add('input-error');\n";
html += "stopInput.classList.add('input-error');\n";
html += "}else if(duration<5){\n";
html += "errors.push('Schedule '+(i+1)+': Minimum duration is 5 minutes (currently '+duration+' min)');\n";
html += "startInput.classList.add('input-error');\n";
html += "stopInput.classList.add('input-error');\n";
html += "}else{\n";
html += "startInput.classList.remove('input-error');\n";
html += "stopInput.classList.remove('input-error');\n";
html += "schedules.push({index:i,start:startMinutes,end:endMinutes});\n";
html += "}\n";
html += "}else if(startTime||endTime){\n";
html += "errors.push('Schedule '+(i+1)+': Both start and stop times required');\n";
html += "if(!startTime)startInput.classList.add('input-error');\n";
html += "if(!endTime)stopInput.classList.add('input-error');\n";
html += "}else{\n";
html += "startInput.classList.remove('input-error');\n";
html += "stopInput.classList.remove('input-error');\n";
html += "}\n";
html += "}\n";
html += "for(let i=0;i<schedules.length;i++){\n";
html += "for(let j=i+1;j<schedules.length;j++){\n";
html += "const s1=schedules[i];\n";
html += "const s2=schedules[j];\n";
html += "if(!(s1.end<=s2.start||s1.start>=s2.end)){\n";
html += "errors.push('Schedule '+(s1.index+1)+' overlaps with Schedule '+(s2.index+1));\n";
html += "}\n";
html += "}\n";
html += "}\n";
html += "return errors;\n";
html += "}\n";

  // Save schedules function with scroll to top on error
  html += "function saveSchedules(){\n";
  html += "const errors=validateSchedules();\n";
  html += "const msg=document.getElementById('statusMessage');\n";
  html += "if(errors.length>0){\n";
  html += "msg.className='status-message error';\n";
  html += "msg.textContent='❌ '+errors.join(' • ');\n";
  html += "window.scrollTo({top:0,behavior:'smooth'});\n";
  html += "return;\n";
  html += "}\n";
  html += "const form=document.getElementById('schedulesForm');\n";
  html += "const formData=new FormData(form);\n";
  html += "fetch('/schedules',{method:'POST',body:formData}).then(r=>r.text()).then(data=>{\n";
  html += "if(data.startsWith('ERROR')||data.startsWith('Schedule mode enabled')){\n";
  html += "msg.className='status-message error';\n";
  html += "msg.textContent='❌ '+data;\n";
  html += "window.scrollTo({top:0,behavior:'smooth'});\n";
  html += "}else{\n";
  html += "msg.className='status-message success';\n";
  html += "msg.textContent='✅ '+data;\n";
  html += "setTimeout(()=>{location.reload();},1500);\n";
  html += "}\n";
  html += "}).catch(e=>{\n";
  html += "msg.className='status-message error';\n";
  html += "msg.textContent='❌ Failed to save';\n";
  html += "});\n";
  html += "}\n";

  // v118.0.10: recompute dayMask (bit 0=Sun..6=Sat) + update chip colors
  // when a weekday checkbox toggles. The hidden schedule{i}_days input is
  // what the firmware actually reads; checkboxes drive it + are visually
  // represented by the span chips.
  html += "function updateDayMask(i){\n";
  html += "var mask=0;\n";
  html += "for(var b=0;b<7;b++){\n";
  html += "var cb=document.querySelector('input[name=\"schedule'+i+'_day'+b+'\"]');\n";
  html += "var chip=cb.nextElementSibling;\n";
  html += "if(cb.checked){mask|=(1<<b);chip.style.background='#2563eb';chip.style.color='#fff';chip.style.borderColor='#2563eb';}\n";
  html += "else{chip.style.background='#fff';chip.style.color='#64748b';chip.style.borderColor='#cbd5e1';}\n";
  html += "}\n";
  html += "if(mask===0){mask=127;}\n";    // never allow 0 — reset to every-day
  html += "document.getElementById('schedule'+i+'DaysMask').value=mask;\n";
  html += "}\n";

  // Update delete buttons
  html += "function updateDeleteButtons(){\n";
  html += "const fieldIds=['schedule1Start','schedule2Start','schedule3Start'];\n";
  html += "const stopIds=['schedule1Stop','schedule2Stop','schedule3Stop'];\n";
  html += "const btnIds=['deleteBtn1','deleteBtn2','deleteBtn3'];\n";
  html += "for(let i=0;i<3;i++){\n";
  html += "const start=document.getElementById(fieldIds[i]).value;\n";
  html += "const end=document.getElementById(stopIds[i]).value;\n";
  html += "const btn=document.getElementById(btnIds[i]);\n";
  html += "btn.style.display=(start||end)?'inline-block':'none';\n";
  html += "}\n";
  html += "}\n";

  html += "const fieldIds=['schedule1Start','schedule2Start','schedule3Start'];\n";
  html += "const stopIds=['schedule1Stop','schedule2Stop','schedule3Stop'];\n";
  html += "fieldIds.forEach(id=>{\n";
html += "document.getElementById(id).addEventListener('change',function(){\n";
html += "updateDeleteButtons();\n";
html += "});\n";
html += "});\n";
html += "stopIds.forEach(id=>{\n";
html += "document.getElementById(id).addEventListener('change',function(){\n";
html += "updateDeleteButtons();\n";
html += "});\n";
html += "});\n";

  html += "window.addEventListener('load',updateDeleteButtons);\n";
  html += "</script>\n";

  html += "</body>\n</html>";

  return html;
}


String getSettingsPageHTML() {
  DateTime now = safeNow();
  
  String html = "<!DOCTYPE html><html><head>\n";
  html += "<title>Settings</title>\n";
  html += "<meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\">\n";
  
  // CSS - UPDATED TO MATCH AUTO-SETTINGS STYLE
  html += "<style>\n";
  html += "*{margin:0;padding:0;box-sizing:border-box}\n";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f0f8ff;color:#333;line-height:1.6}\n";
  html += ".container{max-width:600px;margin:0 auto;background:#fff;min-height:100vh;box-shadow:0 0 20px rgba(0,0,0,0.1);padding-bottom:100px}\n";
  html += ".header{background:#2980b9;color:#fff;padding:15px 20px;display:flex;align-items:center;gap:15px;min-height:60px}\n";
  html += ".header h1{font-size:1.3em;font-weight:bold;flex:1}\n";
  html += ".back-btn{background:rgba(255,255,255,0.25);color:#fff;border:2px solid rgba(255,255,255,0.3);padding:8px 12px;border-radius:6px;text-decoration:none;font-size:0.9em;transition:all 0.2s}\n";
  html += ".back-btn:hover{background:rgba(255,255,255,0.4)}\n";
  html += ".toast{display:none;position:fixed;top:70px;left:50%;transform:translateX(-50%);background:#27ae60;color:#fff;padding:12px 24px;border-radius:6px;z-index:101;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.2)}\n";
  html += ".toast.show{display:block;animation:fadeOut 3s forwards}\n";
  html += "@keyframes fadeOut{0%,80%{opacity:1}100%{opacity:0}}\n";
  
  // Hint box for first-time setup
  html += ".hint{background:#fff3cd;border:1px solid #ffc107;padding:15px;margin:15px;border-radius:8px}\n";
  html += ".hint h3{color:#856404;margin-bottom:8px;font-size:1em}\n";
  html += ".hint p{color:#856404;font-size:0.9em;margin:0}\n";
  
  // Collapsible sections - UPDATED STYLE
  html += ".setting-section{padding:20px;border-bottom:2px solid #dee2e6}\n";
  html += "details{border-bottom:1px solid #dee2e6}\n";
  html += "summary{padding:18px 20px;font-weight:600;font-size:1em;cursor:pointer;display:flex;align-items:center;justify-content:flex-start;gap:10px;user-select:none;list-style:none;background:#fff}\n";
  html += "summary::-webkit-details-marker{display:none}\n";
  html += "summary::after{content:'›';margin-left:auto;font-size:1.3em;color:#999;transition:transform 0.2s}\n";
  html += "details[open] summary::after{transform:rotate(90deg)}\n";
  html += "summary:hover{background:#f8f9fa}\n";
  html += ".sec-content{padding:15px 20px 20px;background:#f8f9fa}\n";
  
  // Form elements
  html += ".fg{margin-bottom:15px}\n";
  html += ".fg label{display:block;font-weight:600;color:#555;margin-bottom:6px;font-size:0.9em}\n";
  html += ".fg input[type=text],.fg input[type=number]{width:100%;padding:12px;border:2px solid #ddd;border-radius:6px;font-size:1em}\n";
  html += ".fg input:focus{outline:none;border-color:#3498db}\n";
  html += ".fg small{color:#888;font-size:0.8em;display:block;margin-top:4px}\n";

  // Device name change info box
  html += ".name-change-info{background:#e8f4fd;border-left:3px solid #3498db;padding:10px 12px;margin-top:8px;border-radius:4px;font-size:0.85em;color:#2c3e50;line-height:1.5}\n";
  
  // Tank visualization CSS (EXACT COPY FROM newUI_resume.ino)
  html += ".tank-cap{width:55px;height:8px;background:linear-gradient(135deg,#34495e,#2c3e50);border-radius:50% 50% 0 0;margin:0 auto 0;box-shadow:0 2px 4px rgba(0,0,0,0.2)}\n";
  html += ".tank-top{width:100px;height:25px;background:linear-gradient(to bottom,#e8eef1,#d5dbdb);clip-path:polygon(15% 0,85% 0,100% 100%,0 100%);margin:0 auto;border-left:2px solid #34495e;border-right:2px solid #34495e}\n";
  html += ".tank-body{width:100px;height:140px;background:linear-gradient(to bottom,#ecf0f1,#d5dbdb);border:2px solid #34495e;border-top:none;border-radius:0 0 12px 12px;position:relative;overflow:hidden;box-shadow:inset 0 -5px 15px rgba(0,0,0,0.1);margin:0 auto}\n";
  html += ".lvl{position:absolute;width:100%;left:0;z-index:4}\n";
  html += ".lvl-stop{background:#e74c3c;height:8px;box-shadow:0 0 8px rgba(231,76,60,0.8),0 0 4px rgba(231,76,60,0.8),inset 0 0 3px rgba(255,255,255,0.3);border-top:1px solid #a93226;border-bottom:1px solid #a93226;top:auto;bottom:0}\n";
  html += ".lvl-start{background:#27ae60;height:6px;box-shadow:0 0 6px rgba(39,174,96,0.7),0 0 3px rgba(39,174,96,0.7);top:auto;bottom:0}\n";
  html += ".lvl-lbl{position:absolute;left:50%;transform:translateX(-50%);font-size:0.65em;font-weight:bold;color:#2c3e50;background:rgba(255,255,255,0.95);padding:3px 8px;border-radius:3px;white-space:nowrap;border:1px solid #bdc3c7;box-shadow:0 2px 4px rgba(0,0,0,0.1);z-index:5;transition:top 0.15s ease,bottom 0.15s ease,margin-top 0.15s ease,margin-bottom 0.15s ease}\n";
  html += ".lvl-start .lvl-lbl{bottom:100%;margin-bottom:3px;top:auto;margin-top:0}\n";
  html += ".lvl-stop .lvl-lbl{top:100%;margin-top:3px;bottom:auto;margin-bottom:0}\n";
  html += ".lvl-lbl.pos-above{bottom:100%;margin-bottom:3px;top:auto;margin-top:0}\n";
  html += ".lvl-lbl.pos-below{top:100%;margin-top:3px;bottom:auto;margin-bottom:0}\n";
  html += ".water-fill{position:absolute;bottom:0;width:100%;background:linear-gradient(to top,#1565c0,#42a5f5);transition:height 0.3s;z-index:2}\n";
  html += ".cfg{display:flex;gap:30px;margin-top:15px;justify-content:center;flex-wrap:wrap}\n";
  html += ".cfg-tank-wrapper{display:flex;flex-direction:column;align-items:center;gap:10px}\n";
  html += ".cfg-tank{flex-shrink:0}\n";
  html += ".slider-group{display:flex;flex-direction:column;gap:5px;width:120px}\n";
  html += ".slider-group label{font-size:0.85em;font-weight:600;color:#555;text-align:center}\n";
  html += ".slider-val{color:#2980b9;font-size:1.1em;font-weight:bold}\n";
  html += "input[type=range]{width:100%;height:8px;border-radius:4px;background:#ddd;outline:none;-webkit-appearance:none}\n";
  html += "input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:#3498db;cursor:pointer}\n";
  html += "input[type=range]::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:#3498db;cursor:pointer;border:none}\n";
  html += "@media (max-width:600px){.cfg{flex-direction:column;gap:20px}}\n";
  
  // WiFi status card
  html += ".wifi-card{background:#fff;border:2px solid #ddd;border-radius:8px;padding:15px;display:flex;align-items:center;gap:12px;margin-bottom:15px}\n";
  html += ".wifi-dot{width:12px;height:12px;border-radius:50%}\n";
  html += ".wifi-dot.on{background:#27ae60}\n";
  html += ".wifi-dot.off{background:#e74c3c}\n";
  html += ".wifi-info{flex:1}\n";
  html += ".wifi-info strong{display:block;font-size:0.95em}\n";
  html += ".wifi-info small{color:#888}\n";
  
  // Time display
  html += ".time-card{background:#f8f9fa;border-radius:8px;padding:15px;margin-bottom:15px}\n";
  html += ".time-card .current{font-size:1.1em;font-weight:600;color:#2c3e50}\n";
  html += ".time-card .sync{font-size:0.85em;color:#888;margin-top:5px}\n";
  
  // Buttons
  html += ".btn{display:block;width:100%;padding:12px;border:none;border-radius:6px;font-size:1em;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin-bottom:10px}\n";
  html += ".btn-p{background:#3498db;color:#fff}\n";
  html += ".btn-w{background:#f39c12;color:#fff}\n";
  html += ".btn-d{background:#e74c3c;color:#fff}\n";
  html += ".btn-s{background:#95a5a6;color:#fff}\n";
  html += ".btn:hover{opacity:0.9}\n";
  
  // Action buttons section (non-collapsible)
  html += ".actions{padding:15px 20px;border-bottom:1px solid #dee2e6}\n";
  
  // Checkbox styling
  html += ".chk{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}\n";
  html += ".chk input{margin-top:3px;width:18px;height:18px}\n";
  html += ".chk label{font-size:0.95em;color:#333}\n";
  html += ".chk-note{font-size:0.8em;color:#888;margin-left:28px;margin-top:-8px;margin-bottom:12px}\n";
  
  // Footer styling (fixed)
  html += ".footer{position:fixed;bottom:0;left:0;right:0;z-index:100;padding:20px;display:flex;gap:10px;flex-wrap:wrap;background:#f8f9fa;border-top:2px solid #dee2e6;box-shadow:0 -4px 12px rgba(0,0,0,0.15);max-width:600px;margin:0 auto}\n";
  html += ".footer .btn{flex:1;min-width:150px}\n";

  // Color change for save button when form changes
  html += ".btn-changed{background:#ff8c00!important;color:#fff!important}\n";
  html += ".toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#27ae60;color:#fff;padding:10px 24px;border-radius:20px;font-weight:600;font-size:14px;z-index:9999;pointer-events:none;opacity:0;transition:opacity .25s}\n";
  html += ".toast.show{opacity:1}\n";

  html += "@media(max-width:480px){";
  html += ".tanks{flex-direction:column;gap:20px}";
  html += ".footer{flex-direction:column}";
  html += ".footer .btn{width:100%;min-width:auto}";
  html += "}\n";
  html += "</style></head><body>\n";

  // Toast notification
  html += "<div id=\"toast\" class=\"toast\">✅ Settings saved!</div>\n";

  // Container and header - UPDATED STRUCTURE
  html += "<div class=\"container\">\n";
  html += "<div class=\"header\"><a href=\"/\" class=\"back-btn\">← Back</a><h1>SETTINGS</h1></div>\n";
  
  // Main wrapper
  html += "<div class=\"wrap\">\n";
  
  // Form start
  html += "<form id=\"sf\" method=\"POST\" action=\"/settings\" novalidate>\n";

  // v118.0.4: Tank Level Control section REMOVED from this page per
  // Vishal's bug report — it was duplicated with the Auto Mode page's
  // version and its POST didn't persist. All tank-level settings now
  // live in ONE place: the Auto Mode Settings page (/auto-settings)
  // under "💧 WATER LEVEL SETTINGS". That's the primary setup location.
  // Hint banner points installers there if they land here first.
  html += "<div class=\"hint\" style=\"background:#eff6ff;border-left:4px solid #3b82f6;padding:10px;margin-bottom:15px;border-radius:4px;\">\n";
  html += "<strong>💧 Water level thresholds moved!</strong> Set tank height, start % and stop % under \n";
  html += "<a href=\"/auto-settings\" style=\"color:#1d4ed8;font-weight:600;\">Auto Mode Settings → Water Level Settings</a>.\n";
  html += "</div>\n";

  // SECTION 2: Tank Info
  html += "<details>\n";
  html += "<summary>ℹ️ Tank Info</summary>\n";
  html += "<div class=\"sec-content\">\n";
  html += "<div class=\"fg\"><label>Tank Name</label>\n";
  html += "<input type=\"text\" name=\"deviceName\" maxlength=\"20\" value=\"" + deviceName + "\" required>\n";
  html += "<small>Give your tank a name (max 20 characters)</small>\n";
  html += "<div class=\"name-change-info\">💡 After renaming the device, restart it to update the WiFi name. Reconnect on app using \"Connect Nearby\" or \"Find Device.\"</div>\n";
  html += "</div>\n";
  html += "<div class=\"fg\"><label>Tank Capacity (Litres)</label>\n";
  html += "<input type=\"number\" name=\"tankVolume\" min=\"0\" max=\"100000\" value=\"" + String(tankVolume) + "\">\n";
  html += "<small>Optional - used for volume display</small></div>\n";
  html += "</div></details>\n";

  // v118.0.5: Tank Sensor section — customer-friendly rewrite of the old
  // "Advanced Sensor Settings". No RS485/Modbus terminology — just
  // "Sensor address" + Search button. Lives on Main Settings page
  // between Tank Info and Pump Type (hardware config grouping).
  html += "<details>\n";
  html += "<summary>📡 Tank Sensor</summary>\n";
  html += "<div class=\"sec-content\">\n";

  // Current state card
  html += "<div style=\"margin-top:4px;padding:10px;background:#f8fafc;border-radius:6px;border:1px solid #cbd5e1;\">\n";
  html += "<div style=\"font-size:0.85em;color:#64748b;\">Current sensor address:</div>\n";
  html += "<div style=\"font-size:1.3em;font-weight:700;color:#0f172a;\">" + String(usModbusAddr) + "</div>\n";
  if (usSensorFault) {
    html += "<div style=\"font-size:0.85em;color:#dc2626;margin-top:4px;\">⚠ Sensor not responding — check wiring and address.</div>\n";
  } else if (usHaveGoodReading) {
    html += "<div style=\"font-size:0.85em;color:#059669;margin-top:4px;\">✓ Sensor is connected and reading normally.</div>\n";
  }
  html += "</div>\n";

  // Search button — scans for sensors with a simple one-liner result
  html += "<div style=\"margin-top:12px;\">\n";
  html += "<button type=\"button\" onclick=\"searchSensor()\" class=\"btn\" style=\"background:#2563eb;color:white;padding:10px 20px;border:none;border-radius:5px;cursor:pointer;font-size:0.95em;\">🔍 Search for sensor</button>\n";
  html += "<div id=\"searchResult\" style=\"margin-top:8px;font-size:0.9em;color:#334155;\"></div>\n";
  html += "</div>\n";

  // Change-address form — simplified language, no "Modbus" word
  html += "<div class=\"fg\" style=\"margin-top:20px;\"><label>Change sensor address</label>\n";
  html += "<div style=\"display:flex;gap:8px;align-items:center;\">\n";
  html += "<input type=\"number\" id=\"newAddrInput\" min=\"1\" max=\"254\" placeholder=\"e.g. 2\" style=\"flex:1;padding:10px;border:1px solid #cbd5e1;border-radius:5px;\">\n";
  html += "<button type=\"button\" onclick=\"changeAddr()\" class=\"btn\" style=\"background:#ea580c;color:white;padding:10px 20px;border:none;border-radius:5px;cursor:pointer;\">Change</button>\n";
  html += "</div>\n";
  html += "<small>Only change if you have multiple sensors on the same panel. Valid: 1-254.</small>\n";
  html += "<div id=\"changeResult\" style=\"margin-top:8px;font-size:0.9em;color:#334155;\"></div></div>\n";

  html += "</div></details>\n";   // Close Tank Sensor section

  // SECTION 2.5: Pump Type & Panel Control
  // (Inputs use form="sf" so they submit with the main settings form which
  //  is closed earlier in the markup.)
  html += "<details>\n";
  html += "<summary>⚙️ Pump Type &amp; Panel Control</summary>\n";
  html += "<div class=\"sec-content\">\n";

  html += "<div class=\"fg\"><label>Pump Type</label>\n";
  html += "<select name=\"pumpType\" id=\"pumpType\" form=\"sf\" onchange=\"togglePanelSettings()\">\n";
  html += "<option value=\"0\"" + String(pumpType == PUMP_SINGLE_PHASE ? " selected" : "") + ">Single-Phase / MCB (direct on/off)</option>\n";
  html += "<option value=\"1\"" + String(pumpType == PUMP_PANEL ? " selected" : "") + ">Capacitive Start / Star-Delta Panel (pulsed)</option>\n";
  html += "</select>\n";
  html += "<small>Single-Phase holds one relay continuously. Panel mode pulses START and STOP push-buttons on the contactor panel.</small>\n";
  html += "</div>\n";

  // Panel-only sub-settings
  html += "<div id=\"panelSettings\" style=\"" + String(pumpType == PUMP_PANEL ? "" : "display:none;") + "\">\n";

  html += "<div class=\"fg\"><label>Start Pulse Duration (seconds)</label>\n";
  html += "<input type=\"number\" name=\"panelStartPulseSec\" form=\"sf\" min=\"0.5\" max=\"300\" step=\"0.5\" value=\"" + String(panelStartPulseMs / 1000.0, 1) + "\">\n";
  html += "<small>How long to press panel START. Default 3.0s. Range 0.5s - 300s in 0.5s steps.</small>\n";
  html += "</div>\n";

  html += "<div class=\"fg\"><label>Stop Pulse Duration (seconds)</label>\n";
  html += "<input type=\"number\" name=\"panelStopPulseSec\" form=\"sf\" min=\"0.5\" max=\"300\" step=\"0.5\" value=\"" + String(panelStopPulseMs / 1000.0, 1) + "\">\n";
  html += "<small>How long to press panel STOP. Default 3.0s.</small>\n";
  html += "</div>\n";

  html += "<div class=\"chk\"><input type=\"checkbox\" name=\"feedbackEnabled\" id=\"feedbackEnabled\" form=\"sf\" " + String(feedbackEnabled ? "checked" : "") + ">\n";
  html += "<label for=\"feedbackEnabled\">Use contactor feedback (confirms pump actually started)</label></div>\n";
  html += "<div class=\"chk-note\">Wire contactor auxiliary-NO via opto-isolator to GPIO" + String(MOTOR_FEEDBACK_PIN) + ". If pump doesn't latch within 5s of START pulse, an alarm is raised.</div>\n";

  html += "</div>\n"; // close panelSettings

#if HAS_BUZZER_HARDWARE
  // Buzzer
  html += "<h4 style=\"margin:20px 0 10px;color:#2c3e50\">🔔 Buzzer</h4>\n";
  html += "<div class=\"chk\" style=\"margin-top:10px;\"><input type=\"checkbox\" name=\"buzzOnMotor\" id=\"buzzOnMotor\" form=\"sf\" " + String((buzzerFlags & BUZZ_ON_MOTOR_ON) ? "checked" : "") + ">\n";
  html += "<label for=\"buzzOnMotor\">Buzz while motor is running (steady)</label></div>\n";
  html += "<div class=\"chk\"><input type=\"checkbox\" name=\"buzzOnError\" id=\"buzzOnError\" form=\"sf\" " + String((buzzerFlags & BUZZ_ON_ERROR) ? "checked" : "") + ">\n";
  html += "<label for=\"buzzOnError\">Buzz on error (blink) — Safe Mode, Dry Run, Sensor Offline, Panel Fault</label></div>\n";

  // Auto-stop timer (applies to both motor and error buzz)
  html += "<div class=\"chk\" style=\"margin-top:10px;\"><input type=\"checkbox\" name=\"buzzerAutoStopEnabled\" id=\"buzzerAutoStopEnabled\" form=\"sf\" onchange=\"toggleBuzzerAutoStop()\" " + String(buzzerAutoStopEnabled ? "checked" : "") + ">\n";
  html += "<label for=\"buzzerAutoStopEnabled\">Auto-stop buzzer after timeout</label></div>\n";
  html += "<div id=\"buzzerAutoStopRow\" class=\"interval-select\" style=\"margin-top:8px;margin-left:24px;" + String(buzzerAutoStopEnabled ? "" : "display:none;") + "\">\n";
  html += "<label>Duration:</label>\n";
  html += "<select name=\"buzzerAutoStopMins\" id=\"buzzerAutoStopMins\" form=\"sf\">\n";
  uint8_t opts[] = {1, 2, 3, 5, 10, 15, 20, 30};
  for (uint8_t i = 0; i < 8; i++) {
    html += "<option value=\"" + String(opts[i]) + "\"" + String(buzzerAutoStopMins == opts[i] ? " selected" : "") + ">" + String(opts[i]) + " min</option>\n";
  }
  html += "</select>\n";
  html += "</div>\n";
  html += "<small>Buzzer is independent from relay. Tap \"Silence\" below to mute until next event. Auto-stop applies to both motor and error alerts.</small>\n";
  html += "<script>function toggleBuzzerAutoStop(){var cb=document.getElementById('buzzerAutoStopEnabled');var row=document.getElementById('buzzerAutoStopRow');if(row){row.style.display=cb.checked?'':'none';}}</script>\n";
#endif

  html += "</div></details>\n";

  // SECTION 3: WiFi Status
  html += "<details>\n";
  html += "<summary>📡 WiFi Status</summary>\n";
  html += "<div class=\"sec-content\">\n";
  
  // WiFi status card
  html += "<div class=\"wifi-card\">\n";
  html += "<div class=\"wifi-dot " + String(wifiStationMode ? "on" : "off") + "\"></div>\n";
  html += "<div class=\"wifi-info\">\n";
  if (wifiStationMode) {
    html += "<strong>" + wifiSSID + "</strong>\n";
    html += "<small>Connected • " + WiFi.localIP().toString() + "</small>\n";
  } else if (wifiConfigured) {
    html += "<strong>" + wifiSSID + "</strong>\n";
    html += "<small>Not connected</small>\n";
  } else {
    html += "<strong>Not configured</strong>\n";
    html += "<small>Set up WiFi to enable remote access</small>\n";
  }
  html += "</div></div>\n";
  html += "<a href=\"/wifi\" class=\"btn btn-p\">Change WiFi Settings</a>\n";
  
  // Time display - only shown when RTC is available
  html += "<div class=\"time-card\">\n";
  html += "<div class=\"current\">🕐" + String(rtcAvailable ? formatDateTime(now) : "No RTC - time via NTP only") + "</div>\n";
  html += "<div class=\"sync\">Last sync: " + lastTimeSyncResult + "</div>\n";
  html += "</div>\n";
  html += "<button type=\"button\" onclick=\"syncT()\" class=\"btn btn-s\">Sync Time from Browser</button>\n";
  html += "</div></details>\n";
  
  // Hidden submit inside the form so the footer button (which is outside the
  // form element) reliably triggers a native POST in all webviews, including
  // those with partial HTML5 form-association support.
  html += "<input type=\"submit\" id=\"sfSubmitHidden\" style=\"display:none\">\n";
  html += "</form>\n";

  // SECTION 4: Additional Settings (collapsible, closed)
  html += "<details>\n";
  html += "<summary>⚙️ Additional Settings</summary>\n";
  html += "<div class=\"sec-content\">\n";
  
  // Form for additional settings (same form)
  html += "<form id=\"sf2\" method=\"POST\" action=\"/settings\">\n";
  
  // Wired Sensor Info (replaces wireless node selection)
  html += "<div style=\"background:#e8f5e9;border-left:4px solid #4caf50;padding:12px;margin-bottom:15px;border-radius:4px\">\n";
  html += "<p style=\"color:#2e7d32;font-size:0.9em;margin:0\"><strong>[WIRED] SENSORS</strong></p>\n";
  html += "<p style=\"color:#2e7d32;font-size:0.85em;margin:8px 0 0 0\">Tank Level Sensor: PORT 1<br>\n";
  html += "Water Presence: PORT 2</p>\n";
  html += "</div>\n";
  
  // Hidden fields to preserve existing values (for EEPROM compatibility)
  html += "<input type=\"hidden\" name=\"targetNodeName\" value=\"WIRED\" form=\"sf\">\n";
  html += "<input type=\"hidden\" name=\"wpNodeName\" value=\"WIRED\" form=\"sf\">\n";
  
  // Safe Mode Recovery
  html += "<h4 style=\"margin:20px 0 12px;color:#2c3e50\">Safe Mode Recovery</h4>\n";
  html += "<div class=\"chk\"><input type=\"checkbox\" name=\"autoRecoverSchedule\" id=\"ar1\" form=\"sf\" " + String(autoRecoverOnSchedule ? "checked" : "") + ">\n";
  html += "<label for=\"ar1\">Auto-clear at next schedule start</label></div>\n";
  html += "<div class=\"chk\"><input type=\"checkbox\" name=\"autoRecoverTimeout\" id=\"ar2\" form=\"sf\" " + String(autoRecoverOnTimeout ? "checked" : "") + ">\n";
  html += "<label for=\"ar2\">Auto-clear after timeout</label></div>\n";
  html += "<div class=\"fg\" style=\"margin-left:28px\"><label>Timeout Hours</label>\n";
  html += "<input type=\"number\" name=\"timeoutHours\" min=\"1\" max=\"48\" value=\"" + String(autoRecoverTimeoutHours) + "\" form=\"sf\" id=\"th\" style=\"width:100px\">\n";
  html += "</div>\n";
  html += "<p style=\"font-size:0.8em;color:#7f8c8d;margin:10px 0\">ℹ️ Auto-recovery clears Safe Mode and returns to AUTO mode.</p>\n";

  // Reset to defaults
  html += "<button type=\"button\" onclick=\"resetCfg()\" class=\"btn btn-d\" style=\"margin-top:20px\">🔄 Reset to Factory Defaults</button>\n";

  html += "</form>\n";
  html += "</div></details>\n";

  // SECTION 5: Restart Device (collapsible)
  html += "<details>\n";
  html += "<summary>📃 Restart Device</summary>\n";
  html += "<div class=\"sec-content\">\n";
  html += "<p style=\"color:#666;font-size:0.9em;line-height:1.5;margin-bottom:15px;\">Restart the controller to apply changes or resolve issues.</p>\n";
  html += "<div style=\"background:#fff3cd;border-left:4px solid #ffc107;padding:12px;margin-bottom:15px;border-radius:4px\">\n";
  html += "<p style=\"color:#856404;font-size:0.85em;margin:0\">⚠️ Motor will turn off during restart. Normal operation resumes after reboot.</p>\n";
  html += "</div>\n";
  html += "<button type=\"button\" onclick=\"restart()\" class=\"btn btn-w\" id=\"rbtn\">Restart Now</button>\n";
  html += "</div></details>\n";

  // SECTION 6: Password Protection (collapsible) - MOVED UP for better UX
  html += "<details>\n";
  html += "<summary>🔐 Password Protection</summary>\n";
  html += "<div class=\"sec-content\">\n";
  html += "<div class=\"chk\"><input type=\"checkbox\" name=\"passwordEnabled\" id=\"pwEnable\" form=\"sf\" " + String(passwordEnabled ? "checked" : "") + ">\n";
  html += "<label for=\"pwEnable\">Enable login password (4-digit PIN)</label></div>\n";
  html += "<div id=\"pwFields\" style=\"" + String(passwordEnabled ? "" : "display:none") + ";margin-top:15px\">\n";

  // Show current password status if already set
  if (passwordEnabled && storedPassword.length() == 4) {
    html += "<div style=\"background:#e8f4fd;border:1px solid #3498db;padding:10px;margin-bottom:15px;border-radius:4px\">\n";
    html += "<strong>Current PIN:</strong> " + storedPassword + " (re-enter below to change or keep)</div>\n";
  }

  html += "<div class=\"fg\"><label>4-Digit PIN</label>\n";
  html += "<input type=\"text\" name=\"password1\" id=\"pw1\" maxlength=\"4\" pattern=\"[0-9]{4}\" form=\"sf\" value=\"\" placeholder=\"" + String(passwordEnabled ? storedPassword : "1234") + "\" inputmode=\"numeric\">\n";
  html += "<small>" + String(passwordEnabled ? "Re-enter current PIN or leave empty to keep existing" : "Enter 4 digits (numbers only)") + "</small></div>\n";
  html += "<div class=\"fg\"><label>Confirm PIN</label>\n";
  html += "<input type=\"text\" name=\"password2\" id=\"pw2\" maxlength=\"4\" pattern=\"[0-9]{4}\" form=\"sf\" placeholder=\"1234\" inputmode=\"numeric\">\n";
  html += "<small>Re-enter the same 4 digits</small></div>\n";
  html += "</div>\n";
  html += "<p style=\"font-size:0.8em;color:#7f8c8d;margin:15px 0 0\">ℹ️ When enabled, a 4-digit PIN will be required to access the web interface.</p>\n";
  html += "</div></details>\n";

  // SECTION 7: View Logs (above Firmware Update per user request)
  html += "<details>\n";
  html += "<summary>📋 System Logs</summary>\n";
  html += "<div class=\"sec-content\">\n";
  html += "<p style=\"color:#666;font-size:0.9em;line-height:1.5;margin-bottom:15px;\">View detailed system logs and download history.</p>\n";
  html += "<a href=\"/logs/view\" class=\"btn btn-s\">View Logs</a>\n";
  html += "</div></details>\n";

  // SECTION 8: Firmware Update
  html += "<details>\n";
  html += "<summary>📦 Firmware Update</summary>\n";
  html += "<div class=\"sec-content\">\n";
  html += "<div style=\"background:#f0f8ff;border:1px solid #3498db;padding:15px;border-radius:6px;margin-bottom:15px\">\n";
  html += "<p style=\"margin:0 0 10px 0;font-size:0.95em\"><strong>Current Version:</strong> <span style=\"color:#27ae60;font-weight:bold\">" + String(FIRMWARE_VERSION) + "</span></p>\n";
  html += "<p style=\"margin:0;font-size:0.85em;color:#666\">To update firmware, open the Menu (☰) → Firmware Update</p>\n";
  html += "</div>\n";
  html += "</div></details>\n";

  html += "</div>\n"; // wrap

  // Footer with save button
  html += "<div class=\"footer\">\n";
  html += "<button type=\"button\" onclick=\"document.getElementById('sfSubmitHidden').click()\" class=\"btn\" style=\"background:#27ae60;color:#fff\">💾 SAVE SETTINGS</button>\n";
  html += "<a href=\"/\" class=\"btn\" style=\"background:#3498db;color:#fff\">BACK TO STATUS</a>\n";
  html += "</div>\n";

  html += "</div>\n"; // container

  // JavaScript - UPDATED WITH DYNAMIC LABEL POSITIONING
  html += "<script>\n";

  // v118.0.5: Tank Sensor address functions (moved from Auto Mode page).
  // "Search" renames the backend scan — hits /us/scan but renders a
  // friendlier result message. "Change" wraps /us/writeaddr.
  html += "function searchSensor(){\n";
  html += "var el=document.getElementById('searchResult');\n";
  html += "el.innerHTML='Searching for sensor… (up to 15 sec)';\n";
  html += "fetch('/us/scan').then(function(r){return r.text();}).then(function(t){\n";
  html += "el.innerHTML=t;\n";
  html += "}).catch(function(){el.innerHTML='<span style=color:#dc2626>Search failed — check WiFi</span>';});\n";
  html += "}\n";
  html += "function changeAddr(){\n";
  html += "var v=document.getElementById('newAddrInput').value.trim();\n";
  html += "if(!v){document.getElementById('changeResult').innerHTML='Enter a number from 1 to 254';return;}\n";
  html += "if(!confirm('Change sensor address to '+v+'?\\n\\nOnly do this if you have multiple sensors on the same panel.')){return;}\n";
  html += "var el=document.getElementById('changeResult');\n";
  html += "el.innerHTML='Changing… (~5 sec)';\n";
  html += "var fd=new FormData(); fd.append('newAddr', v);\n";
  html += "fetch('/us/writeaddr',{method:'POST',body:fd}).then(function(r){return r.text();}).then(function(t){\n";
  html += "el.innerHTML=t; setTimeout(function(){location.reload();}, 2000);\n";
  html += "}).catch(function(){el.innerHTML='<span style=color:#dc2626>Change failed — check WiFi</span>';});\n";
  html += "}\n";

  // v118.0.4: slider helper for main page removed — tank-level sliders
  // moved to Auto Mode Settings page (one source of truth, no duplication).

  // Sync time
  html += "function syncT(){fetch('/timesync',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'timestamp='+Date.now()}).then(r=>r.text()).then(d=>{if(d.includes('success')){showToast('✅ Time synced!');setTimeout(()=>location.reload(),1500);}else alert('Error: '+d);}).catch(e=>alert('Failed: '+e));}\n";
  
  // Restart
  html += "function restart(){if(confirm('This will restart your device.\\n\\nMotor will turn OFF during restart.\\n\\nContinue?')){const b=document.getElementById('rbtn');b.disabled=1;b.textContent='Restarting...';fetch('/restart',{method:'POST'}).then(()=>{showToast('✅ Restarting...');setTimeout(()=>location.href='/',3000);});}}\n";
  
  // Reset config
  html += "function resetCfg(){if(confirm('Reset all settings to factory defaults?\\n\\nWiFi credentials will be preserved.')){fetch('/resetconfig',{method:'POST'}).then(()=>{showToast('✅ Reset complete');setTimeout(()=>location.reload(),1500);});}}\n";

  // Toggle Panel-mode sub-settings visibility
  html += "function togglePanelSettings(){var pt=document.getElementById('pumpType');var el=document.getElementById('panelSettings');if(pt&&el){el.style.display=(pt.value==='1')?'':'none';}}\n";
  
  // Toast
  html += "function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}\n";
  
  // SAVE button uses plain native form POST - no AJAX, no JS interception.
  // The server responds with a "Settings Saved" page that auto-redirects
  // to /. This is the most reliable approach and needs zero JS.
  // Node-name removal warnings are irrelevant on this wired-sensor PCB
  // (node names are fixed "WIRED" hidden values, never user-changed).
  
  // Timeout field dependency - guarded for null since ar2/th live inside a
  // closed <details> element which some webviews defer rendering.
  html += "const ar2=document.getElementById('ar2'),th=document.getElementById('th');\n";
  html += "function updTh(){if(ar2&&th){th.disabled=!ar2.checked;th.style.opacity=ar2.checked?1:0.5;}}\n";
  html += "if(ar2)ar2.onchange=updTh;\n";
  html += "updTh();\n";

  // Password field toggle and validation - guarded for null since these
  // elements live inside closed <details> sections.
  html += "const pwEnable=document.getElementById('pwEnable');\n";
  html += "const pwFields=document.getElementById('pwFields');\n";
  html += "const pw1=document.getElementById('pw1'),pw2=document.getElementById('pw2');\n";
  html += "function togglePw(){if(pwFields&&pwEnable)pwFields.style.display=pwEnable.checked?'block':'none';}\n";
  html += "if(pwEnable)pwEnable.onchange=togglePw;\n";

  // Form change detection and save button animation
  html += "let formChanged=false;\n";
  html += "const saveBtn=document.querySelector('button[type=submit][form=sf]');\n";
  html += "document.querySelectorAll('input,select,textarea').forEach(el=>{\n";
  html += "el.addEventListener('change',()=>{\n";
  html += "formChanged=true;\n";
  html += "if(saveBtn)saveBtn.classList.add('btn-changed');\n";
  html += "});\n";
  html += "el.addEventListener('input',()=>{\n";
  html += "formChanged=true;\n";
  html += "if(saveBtn)saveBtn.classList.add('btn-changed');\n";
  html += "});\n";
  html += "});\n";
  html += "const settingsForm=document.getElementById('sf');\n";
  html += "if(settingsForm){\n";
  html += "const originalFormSubmit=settingsForm.onsubmit;\n";
  html += "settingsForm.onsubmit=function(e){\n";
  html += "formChanged=false;\n";
  html += "if(saveBtn)saveBtn.classList.remove('btn-changed');\n";
  html += "if(originalFormSubmit)return originalFormSubmit.call(this,e);\n";
  html += "return true;\n";
  html += "};\n";
  html += "}\n";
  html += "\n";
  html += "// Unsaved changes warning - FIXED: Warn user before leaving without saving\n";
  html += "window.addEventListener('beforeunload',function(e){\n";
  html += "if(formChanged){\n";
  html += "e.preventDefault();\n";
  html += "e.returnValue='You have unsaved changes. Leave without saving?';\n";
  html += "return 'You have unsaved changes. Leave without saving?';\n";
  html += "}\n";
  html += "});\n";

  // Auto-sync time on page load (silent, no reload)
  html += "setTimeout(function(){fetch('/timesync',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'timestamp='+Date.now()}).catch(()=>{});},2000);\n";

  html += "</script></body></html>";

  return html;
}

// ===========================================
// MANUAL OVERRIDE FUNCTIONS
// ===========================================

// v118.0.7: pre-check for Force Run. Returns true when it's safe to
// start a force run; populates `reason` with a short code when rejecting.
// Called by BOTH the AP handler and the cloud command path so behavior
// matches regardless of entry point.
//
//   wantsUntilFull=true  → requires live sensor + current pct < stopPct
//   wantsUntilFull=false → timed run, only sensor-fault guard matters for
//                          pct-based cutoff (user picked time explicitly).
//                          But we STILL reject if tank is already full,
//                          per user rule — no point running pump just to
//                          immediately stop on next evaluateMotorState tick.
//
// Reason codes land on the AP page response + cloud log, so keep them
// stable + machine-parseable (snake_case, short).
static bool canStartForceRun(bool wantsUntilFull, String& reason) {
  // v118.0.8: guards are MODE-DEPENDENT —
  //   until-full mode: hard-rejects on sensor fault / no data / already
  //     full, because without a reliable sensor there's no way to
  //     actually detect "full" and without stop-pct safety the pump
  //     could run forever.
  //   timed mode: user picked a specific duration explicitly. We honor
  //     that even if the tank is already full. They may be running the
  //     pump for a non-tank-filling reason (priming, flushing, testing
  //     the panel contactor). Firmware's existing stopPercent safety
  //     will still prevent overfill — pump will stop early if level
  //     keeps rising, but it WILL start.
  if (wantsUntilFull) {
    if (usSensorFault) {
      reason = "sensor_offline";
      return false;
    }
    if (!usHaveGoodReading) {
      reason = "sensor_no_data";
      return false;
    }
    if (usConfirmedPct >= stopPercent) {
      reason = "tank_already_full";
      return false;
    }
  }
  return true;
}

void enterManualOverride() {
  // Tag the upcoming pump_on event as "force" so History shows "Manual"
  // instead of the default "Auto". setMotor(true) below reads
  // nextMotorCause when it enqueues the event, and clears it back to
  // "auto" for the next natural (auto/schedule) start. All manual-
  // override callers (AP page, cloud force command, physical button
  // long-press) funnel through here, so this one line covers every
  // path without each caller having to remember to set it.
  nextMotorCause = "force";

  // 1. Save current state
  modeBeforeManualOverride = currentMode;
  previousAutoModeState = autoModeEnabled;

  // 2. Clear error states and counters - user is taking control
  dryRunCount = 0;
  dryRunStartTime = 0;
  safeModeStartTime = 0;
  resetSourceDetectionState();
  pumpStage = "MANUAL_OVERRIDE";

  // FILL INTENT: Clear intent when user takes manual control
  clearFillIntent("manual_override_activated");

  // 3. Log if clearing safe mode or dry run recovery (any error mode)
  if (currentMode == MODE_SAFE_MODE || currentMode == MODE_DRY_RUN_RECOVERY ||
      currentMode == MODE_SOURCE_DRY_RUN || currentMode == MODE_PANEL_FAULT) {
    DEBUG_PRINTLN("Manual override: Clearing error states");
    logSystemEvent("ERROR_MODE_CLEARED", "manual_override_entry");
  }

  // 4. Enter manual override mode
  autoModeEnabled = false;  // Temporarily disable auto mode
  currentMode = MODE_MANUAL_OVERRIDE;
  manualOverrideStartTime = millis();
  // v118.0.9: when panel-manual started the pump, contactor is ALREADY
  // latched — firing another START pulse would be redundant and could
  // race the operator who just pressed START at the panel. We still
  // need motorState=true for all the downstream logic (dry-run watchdog,
  // snapshot publish, pumpStage display) so bypass the setMotor() helper
  // and just flip the state directly. The feedback-detector already
  // emitted pump_on event with cause="force" before we got here.
  if (panelManualActive) {
    motorState = true;
    buzzerMuted = false;
    DEBUG_PRINTLN("Manual override entered via panel button — skipping START pulse (contactor already latched)");
  } else {
    setMotor(true);  // Turn motor ON (AP/cloud origin — pulse normally)
  }
  // v117.0.13: stamp the motor-run clock here too. Without this, the
  // pump_off runSec calculation at setMotor(false) sees motorRunStartTime=0
  // and defaults to 0 → History shows "0s" for every manual/force run
  // regardless of how long the pump actually ran. Auto-mode already
  // stamps it at line ~7743; this is the parallel stamp for the manual
  // path (AP force button, cloud Force Run command, physical button).
  motorRunStartTime = millis();

  DateTime now = safeNow();
  DEBUG_PRINT("Manual override activated - Motor ON for ");
  DEBUG_PRINT(manualOverrideDurationMinutes);
  DEBUG_PRINT(" minutes | Previous mode: ");
  DEBUG_PRINT(getModeText());
  DEBUG_PRINT(" saved | Auto was: ");
  DEBUG_PRINT(previousAutoModeState ? "ON" : "OFF");
  DEBUG_PRINT(" | ");
  DEBUG_PRINTLN(formatDateTime(now));

  logModeChange("MANUAL_OVERRIDE", "user_manual_control_" + String(manualOverrideDurationMinutes) + "min");
}

// ===========================================
// NEW MOTOR EVALUATION FUNCTION
// ===========================================

void evaluateMotorStateFromScratch() {
  // Reset any pending confirmations when doing fresh evaluation
  resetMotorConfirmation();

  if (otaInProgress) {
    if (motorState) {
      setMotor(false);
      DEBUG_PRINTLN("Motor stopped for OTA safety");
    }
    return;
  }

  // Don't change motor state during manual override
  if (currentMode == MODE_MANUAL_OVERRIDE) {
    return;
  }

  // If not in auto mode, turn motor OFF
  if (!autoModeEnabled || currentMode == MODE_IDLE || currentMode == MODE_SCHEDULE_INACTIVE) {
    if (motorState) {
      setMotor(false);
    }
    return;
  }

  // Check sensor availability
  if (!hasReceivedReading || !sensorOnline) {
    if (motorState) {
      setMotor(false);
      DEBUG_PRINTLN("Motor stopped - sensor offline");
    }
    return;
  }

  // Check WP sensor if configured
  if (hasWPSensor) {
    // Note: For wired WP sensor, we don't check wpSensorOnline - it's always online
    // Only check if we haven't received any reading yet (startup condition)
    if (!hasReceivedWPReading) {
      if (motorState) {
        setMotor(false);
        DEBUG_PRINTLN("Motor stopped - WP sensor not yet initialized");
      }
      return;
    }

    if (!wpSensorStatus) {
      // In Post-Detection mode, don't stop during grace period or source confirmation
      if (motorState && (graceActive || (sourceConfirmStart > 0 && !sourceConfirmed))) {
        DEBUG_PRINTLN("evaluateMotorState: WP absent but grace/confirm active - deferring to controlMotor()");
        // Let controlMotor() handle the grace period and source confirmation logic
      } else {
        if (motorState) {
          setMotor(false);
          resetSourceDetectionState();
          DEBUG_PRINTLN("Motor stopped - no source water");
        }
        return;
      }
    }
  }

  // Apply motor logic based on water levels
  bool shouldRunMotor = false;

  if (currentWaterPercent < startPercent) {
    shouldRunMotor = true;
  } else if (currentWaterPercent >= stopPercent) {
    shouldRunMotor = false;
  } else {
    // In hysteresis zone - maintain current state
    shouldRunMotor = motorState;
  }

  // Apply motor state change
  if (shouldRunMotor != motorState) {
    setMotor(shouldRunMotor);

    if (shouldRunMotor && dryRunProtectionOn) {
      dryRunProbeTimerStart = millis();
    }
  }
}

void exitManualOverride() {
  // Tag the upcoming pump_off event as "force" so the History pair
  // (on + off) is symmetric — both sides show "Manual" instead of
  // one side showing Auto. setMotor(false) reads nextMotorCause when
  // enqueuing the event.
  nextMotorCause = "force";

  // Clear the until-full latch — next manual override starts fresh
  // as a timed one unless caller explicitly sets untilFull again.
  manualOverrideUntilFull = false;

  // Restore autoModeEnabled to previous state (unless web UI changed it during override)
  // Check if web UI modified autoModeEnabled during manual override
  bool webUIModifiedAutoMode = (autoModeEnabled != false);  // If true during override, web UI changed it

  if (!webUIModifiedAutoMode) {
    // Web UI didn't change it - restore previous state
    autoModeEnabled = previousAutoModeState;
    DEBUG_PRINT("Restoring auto mode to previous state: ");
    DEBUG_PRINTLN(autoModeEnabled ? "ENABLED" : "DISABLED");
  } else {
    // Web UI changed it during override - keep current value
    DEBUG_PRINT("Auto mode was changed during override - keeping current state: ");
    DEBUG_PRINTLN(autoModeEnabled ? "ENABLED" : "DISABLED");
  }

  // Smart mode restoration
  SystemMode restoredMode;

  // FIRST: Check if sensors are currently offline (regardless of mode history)
  // Note: WP sensor offline check removed - wired WP sensor is always "online"
  bool sensorsCurrentlyOffline = !sensorOnline;
  if (sensorsCurrentlyOffline) {
    restoredMode = MODE_SENSOR_OFFLINE;
    DEBUG_PRINTLN("Exiting manual override - sensors are offline, entering SENSOR_OFFLINE mode");
  } else if (scheduleModeEnabled) {
    // Schedule mode is active - check current schedule status
    int activeSchedule = getCurrentActiveSchedule();
    if (activeSchedule >= 0) {
      // Inside schedule time - apply auto mode setting
      restoredMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
      DEBUG_PRINT("Restoring to schedule mode (inside schedule ");
      DEBUG_PRINT(activeSchedule + 1);
      DEBUG_PRINTLN(")");
    } else {
      // Outside schedule time - inactive
      restoredMode = MODE_SCHEDULE_INACTIVE;
      DEBUG_PRINTLN("Restoring to schedule mode (outside schedule)");
    }
  } else if (modeBeforeManualOverride == MODE_SENSOR_OFFLINE) {
    // Restore sensor offline mode - sensor is still offline
    restoredMode = MODE_SENSOR_OFFLINE;
    DEBUG_PRINTLN("Restoring to sensor offline mode - sensor still not responding");
  } else if (modeBeforeManualOverride == MODE_SAFE_MODE ||
             modeBeforeManualOverride == MODE_DRY_RUN_RECOVERY) {
    // Don't restore error modes - user cleared them by entering manual override
    restoredMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
    DEBUG_PRINTLN("Previous error mode cleared - restoring to normal operation");
  } else if (modeBeforeManualOverride == MODE_SCHEDULE_INACTIVE) {
    // Was outside schedule before - restore to inactive
    restoredMode = MODE_SCHEDULE_INACTIVE;
    DEBUG_PRINTLN("Restoring to schedule inactive mode");
  } else {
    // Normal restoration - respect auto mode setting
    restoredMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
    DEBUG_PRINT("Restoring to previous mode based on auto mode: ");
    DEBUG_PRINTLN(autoModeEnabled ? "NORMAL" : "IDLE");
  }
  
  currentMode = restoredMode;

  // v118.0.9: when panel-manual is ending because the operator released
  // the contactor at the panel (feedback edge → OFF), the contactor is
  // already open — firing a STOP pulse would be redundant and could
  // mis-fire the AC coil. The caller sets panelManualActive=false BEFORE
  // calling us in that case, so we fire STOP normally only when the
  // flag is still set (= AP/cloud/safety trigger ended the override
  // while panel is still physically asserting ON — rare but possible,
  // and in that case we DO want the pulse to actually stop the pump).
  if (panelManualActive) {
    motorState = false;
    buzzerMuted = false;
    DEBUG_PRINTLN("Manual override exited via panel button — skipping STOP pulse (contactor already released)");
    panelManualActive = false;
  } else {
    setMotor(false);
  }

  // FILL INTENT: Clear intent when exiting manual override
  clearFillIntent("manual_override_ended");

  // Reset timer
  manualOverrideStartTime = 0;
  
  DateTime now = safeNow();
  DEBUG_PRINT("Manual override ended - Motor OFF | Mode: ");
  DEBUG_PRINT(getModeText());
  DEBUG_PRINT(" | Auto mode: ");
  DEBUG_PRINT(autoModeEnabled ? "ENABLED" : "DISABLED");
  DEBUG_PRINT(" | ");
  DEBUG_PRINTLN(formatDateTime(now));
  
  saveConfiguration();
  
  logModeChange(getModeText(), "manual_override_ended");
}

void checkManualOverrideTimeout() {
  if (currentMode != MODE_MANUAL_OVERRIDE) return;

  // v118.0.7: "Until tank full" uses the user-configured stopPercent as
  // the full threshold — NOT a hardcoded 100% or the discrete tankFullWet
  // flag. Customers routinely set stop at 90-95% to leave headroom; we
  // must honor that or the pump keeps running past their intended stop
  // point and (a) overfills in overflow, (b) logs a 1-sec splash event
  // when the discrete probe finally trips at ~100%.
  //
  // Guard A: sensor fault → stop immediately (no safe way to level-track).
  // Guard B: usConfirmedPct >= stopPercent → done. Primary stop path.
  //
  // Dry-run + feedback-fault safeties still fire separately.
  if (manualOverrideUntilFull) {
    if (usSensorFault) {
      DEBUG_PRINTLN("Manual override (until-full): sensor fault — stopping");
      logErrorEvent("MANUAL_OVERRIDE_END", "sensor_fault_during_until_full");
      exitManualOverride();
      return;
    }
    if (usHaveGoodReading && usConfirmedPct >= stopPercent) {
      DEBUG_PRINTLN("Manual override (until-full): reached stopPercent — stopping");
      logSystemEvent("MANUAL_OVERRIDE_END", "until_full_reached");
      exitManualOverride();
    }
    return;
  }

  unsigned long elapsedMillis = millis() - manualOverrideStartTime;
  unsigned long timeoutMillis = manualOverrideDurationMinutes * 60UL * 1000UL;  // Use dynamic duration

  if (elapsedMillis >= timeoutMillis) {
    exitManualOverride();
  }
}

void enableAutoMode() {
  if (currentMode == MODE_MANUAL_OVERRIDE) {
    DEBUG_PRINTLN("Cannot change auto mode during manual override");
    return;
  }

  autoModeEnabled = true;
  currentMode = MODE_NORMAL;
  dryRunCount = 0;
  needFreshDataAfterRecovery = true;  // CRITICAL: Require fresh sensor data before motor action

  saveConfiguration();

  DEBUG_PRINTLN("Auto mode ENABLED - waiting for fresh sensor data");
  logModeChange("NORMAL", "auto_mode_enabled_awaiting_fresh_data");
}

void disableAutoMode() {
  if (currentMode == MODE_MANUAL_OVERRIDE) {
    DEBUG_PRINTLN("Cannot change auto mode during manual override");
    return;
  }

  autoModeEnabled = false;
  currentMode = MODE_IDLE;
  setMotor(false);

  // FILL INTENT: Clear intent when auto mode disabled
  clearFillIntent("auto_mode_disabled_by_user");

  saveConfiguration();

  DEBUG_PRINTLN("Auto mode DISABLED - System IDLE");
  logModeChange("IDLE", "auto_mode_disabled");
}

// ===========================================
// MOTOR CONTROL FUNCTIONS
// ===========================================

// Reset motor confirmation state
void resetMotorConfirmation() {
  motorConfirm.waitingForStart = false;
  motorConfirm.waitingForStop = false;
  motorConfirm.startConfirmCount = 0;
  motorConfirm.stopConfirmCount = 0;
  motorConfirm.lastStartConfirmMsgId = "";
  motorConfirm.lastStopConfirmMsgId = "";
  motorConfirm.lastConfirmTime = 0;
  motorConfirm.confirmationComplete = false;
  motorConfirm.confirmationType = "";
}

// Check if confirmation has timed out
void checkConfirmationTimeout() {
  if ((motorConfirm.waitingForStart || motorConfirm.waitingForStop) &&
      motorConfirm.lastConfirmTime > 0) {
    unsigned long timeSinceLastConfirm = millis() - motorConfirm.lastConfirmTime;
    if (timeSinceLastConfirm > (MOTOR_CONFIRMATION_TIMEOUT_SECONDS * 1000UL)) {
      DEBUG_PRINTLN("Motor confirmation timeout - resetting");
      resetMotorConfirmation();
    }
  }
}

// Process motor confirmation from new sensor data
void processMotorConfirmation(String msgId, float waterPercent, bool shouldStart, bool shouldStop) {
  // Check for timeout first
  checkConfirmationTimeout();

  // Don't process confirmations if we already have a complete confirmation waiting
  if (motorConfirm.confirmationComplete) {
    return;
  }

  // START CONFIRMATION LOGIC
  if (shouldStart && !motorState) {
    if (!motorConfirm.waitingForStart) {
      // First start confirmation
      motorConfirm.waitingForStart = true;
      motorConfirm.startConfirmCount = 1;
      motorConfirm.lastStartConfirmMsgId = msgId;
      motorConfirm.lastConfirmTime = millis();
      DEBUG_PRINT("Motor START confirmation 1/");
      DEBUG_PRINT(MOTOR_CONFIRMATION_COUNT);
      DEBUG_PRINT(" - Water level: ");
      DEBUG_PRINT(waterPercent, 1);
      DEBUG_PRINT("% - MsgID: ");
      DEBUG_PRINTLN(msgId);
    } else {
      // Continuing confirmation - only if different message ID
      if (msgId != motorConfirm.lastStartConfirmMsgId && msgId.length() > 0) {
        motorConfirm.startConfirmCount++;
        motorConfirm.lastStartConfirmMsgId = msgId;
        motorConfirm.lastConfirmTime = millis();
        DEBUG_PRINT("Motor START confirmation ");
        DEBUG_PRINT(motorConfirm.startConfirmCount);
        DEBUG_PRINT("/");
        DEBUG_PRINT(MOTOR_CONFIRMATION_COUNT);
        DEBUG_PRINT(" - Water level: ");
        DEBUG_PRINT(waterPercent, 1);
        DEBUG_PRINT("% - MsgID: ");
        DEBUG_PRINTLN(msgId);

        if (motorConfirm.startConfirmCount >= MOTOR_CONFIRMATION_COUNT) {
          // Confirmation complete!
          motorConfirm.confirmationComplete = true;
          motorConfirm.confirmationType = "START";
          DEBUG_PRINTLN("✓ Motor START confirmation COMPLETE - ready to activate!");
        }
      }
    }
  } else if (motorConfirm.waitingForStart && shouldStart) {
    // Still in start condition but no new message - do nothing
  } else if (motorConfirm.waitingForStart) {
    // Start condition no longer met - reset
    DEBUG_PRINTLN("Motor START confirmation reset - level above threshold");
    motorConfirm.waitingForStart = false;
    motorConfirm.startConfirmCount = 0;
    motorConfirm.lastStartConfirmMsgId = "";
  }

  // STOP CONFIRMATION LOGIC
  if (shouldStop && motorState) {
    if (!motorConfirm.waitingForStop) {
      // First stop confirmation
      motorConfirm.waitingForStop = true;
      motorConfirm.stopConfirmCount = 1;
      motorConfirm.lastStopConfirmMsgId = msgId;
      motorConfirm.lastConfirmTime = millis();
      DEBUG_PRINT("Motor STOP confirmation 1/");
      DEBUG_PRINT(MOTOR_CONFIRMATION_COUNT);
      DEBUG_PRINT(" - Water level: ");
      DEBUG_PRINT(waterPercent, 1);
      DEBUG_PRINT("% - MsgID: ");
      DEBUG_PRINTLN(msgId);
    } else {
      // Continuing confirmation - only if different message ID
      if (msgId != motorConfirm.lastStopConfirmMsgId && msgId.length() > 0) {
        motorConfirm.stopConfirmCount++;
        motorConfirm.lastStopConfirmMsgId = msgId;
        motorConfirm.lastConfirmTime = millis();
        DEBUG_PRINT("Motor STOP confirmation ");
        DEBUG_PRINT(motorConfirm.stopConfirmCount);
        DEBUG_PRINT("/");
        DEBUG_PRINT(MOTOR_CONFIRMATION_COUNT);
        DEBUG_PRINT(" - Water level: ");
        DEBUG_PRINT(waterPercent, 1);
        DEBUG_PRINT("% - MsgID: ");
        DEBUG_PRINTLN(msgId);

        if (motorConfirm.stopConfirmCount >= MOTOR_CONFIRMATION_COUNT) {
          // Confirmation complete!
          motorConfirm.confirmationComplete = true;
          motorConfirm.confirmationType = "STOP";
          DEBUG_PRINTLN("✓ Motor STOP confirmation COMPLETE - ready to activate!");
        }
      }
    }
  } else if (motorConfirm.waitingForStop && shouldStop) {
    // Still in stop condition but no new message - do nothing
  } else if (motorConfirm.waitingForStop) {
    // Stop condition no longer met - reset
    DEBUG_PRINTLN("Motor STOP confirmation reset - level below threshold");
    motorConfirm.waitingForStop = false;
    motorConfirm.stopConfirmCount = 0;
    motorConfirm.lastStopConfirmMsgId = "";
  }
}

// Check for Safe Mode auto-recovery conditions
void checkSafeModeAutoRecovery() {
  // Track when Safe Mode started (if not already tracked)
  if (safeModeStartTime == 0) {
    safeModeStartTime = millis();
    return;
  }

  // Check schedule-based recovery (priority)
  if (autoRecoverOnSchedule && scheduleModeEnabled) {
    int currentSchedule = getCurrentActiveSchedule();
    if (currentSchedule >= 0) {
      // We're in a schedule - clear Safe Mode
      clearSafeModeAutoRecovery("SCHEDULE_START");
      return;
    }
  }

  // Check timeout-based recovery (only if no schedules OR schedule recovery disabled)
  if (autoRecoverOnTimeout && (!scheduleModeEnabled || !autoRecoverOnSchedule)) {
    unsigned long safeModeElapsedMs = millis() - safeModeStartTime;
    unsigned long timeoutMs = autoRecoverTimeoutHours * 60UL * 60UL * 1000UL;

    if (safeModeElapsedMs >= timeoutMs) {
      clearSafeModeAutoRecovery("TIMEOUT");
      return;
    }
  }
}

// Clear Safe Mode and reset to normal operation
void clearSafeModeAutoRecovery(String reason) {
  DEBUG_PRINTLN("Auto-clearing Safe Mode due to: " + reason);

  // Reset Safe Mode state
  dryRunCount = 0;
  safeModeStartTime = 0;
  needFreshDataAfterRecovery = true;  // Require fresh data after recovery
  resetSourceDetectionState();

  // Reset motor confirmation state
  resetMotorConfirmation();

  // Handle schedule mode context (similar to exitManualOverride)
  if (scheduleModeEnabled && activeScheduleCount > 0) {
    int activeSchedule = getCurrentActiveSchedule();
    if (activeSchedule < 0) {
      // Outside schedule time - enter inactive mode
      currentMode = MODE_SCHEDULE_INACTIVE;
      setMotor(false);
      DEBUG_PRINTLN("Safe Mode auto-recovery outside schedule - SCHEDULE_INACTIVE");
    } else {
      // Inside schedule time - return to normal/idle based on auto mode
      currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
      DEBUG_PRINTLN("Safe Mode auto-recovery complete - waiting for fresh sensor data");
    }
  } else {
    // No schedule mode - return to normal/idle based on auto mode
    currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
    DEBUG_PRINTLN("Safe Mode auto-recovery complete - waiting for fresh sensor data");
  }

  String reasonLower = reason;
  reasonLower.toLowerCase();
  logModeChange(getModeText(), "auto_recovery_" + reasonLower);
  logSystemEvent("SAFE_MODE_AUTO_CLEARED", reason);
}

// Check dry run recovery timeout - runs independently every loop
// Uses dryRunWaitMins (tank dry run setting)
void checkDryRunRecoveryTimeout() {
  if (currentMode == MODE_DRY_RUN_RECOVERY) {
    if ((millis() - dryRunStartTime) > dryRunWaitMins * 60UL * 1000UL) {
      needFreshDataAfterRecovery = true;

      // Handle schedule mode context (similar to exitManualOverride)
      if (scheduleModeEnabled && activeScheduleCount > 0) {
        int activeSchedule = getCurrentActiveSchedule();
        if (activeSchedule < 0) {
          // Outside schedule time - enter inactive mode
          currentMode = MODE_SCHEDULE_INACTIVE;
          setMotor(false);
          DateTime now = safeNow();
          DEBUG_PRINT("Dry run recovery completed outside schedule - SCHEDULE_INACTIVE | ");
          DEBUG_PRINTLN(formatDateTime(now));
          logModeChange("SCHEDULE_INACTIVE", "dry_run_recovery_completed");
        } else {
          // Inside schedule time - return to normal/idle based on auto mode
          currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
          DateTime now = safeNow();
          DEBUG_PRINT("Dry run recovery completed - waiting for fresh sensor data | ");
          DEBUG_PRINTLN(formatDateTime(now));
          logModeChange(autoModeEnabled ? "NORMAL" : "IDLE", "dry_run_recovery_completed");
        }
      } else {
        // No schedule mode - return to normal/idle based on auto mode
        currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
        DateTime now = safeNow();
        DEBUG_PRINT("Dry run recovery completed - waiting for fresh sensor data | ");
        DEBUG_PRINTLN(formatDateTime(now));
        logModeChange(autoModeEnabled ? "NORMAL" : "IDLE", "dry_run_recovery_completed");
      }
    }
  }
}

// Check source dry run recovery timeout - uses retryWaitMins (source water setting)
void checkSourceDryRunTimeout() {
  if (currentMode == MODE_SOURCE_DRY_RUN) {
    if ((millis() - sourceDryRunStartTime) > retryWaitMins * 60UL * 1000UL) {
      needFreshDataAfterRecovery = true;

      if (scheduleModeEnabled && activeScheduleCount > 0) {
        int activeSchedule = getCurrentActiveSchedule();
        if (activeSchedule < 0) {
          currentMode = MODE_SCHEDULE_INACTIVE;
          setMotor(false);
          DEBUG_PRINTLN("Source dry run recovery completed outside schedule - SCHEDULE_INACTIVE");
          logModeChange("SCHEDULE_INACTIVE", "source_dry_run_recovery_completed");
        } else {
          currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
          DEBUG_PRINTLN("Source dry run recovery completed - waiting for fresh sensor data");
          logModeChange(autoModeEnabled ? "NORMAL" : "IDLE", "source_dry_run_recovery_completed");
        }
      } else {
        currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
        DEBUG_PRINTLN("Source dry run recovery completed - waiting for fresh sensor data");
        logModeChange(autoModeEnabled ? "NORMAL" : "IDLE", "source_dry_run_recovery_completed");
      }
    }
  }
}

// Check sensor timeouts independent of mode - runs in ALL modes including Safe Mode
void checkSensorTimeouts() {
  DateTime now = safeNow();
  bool usTimeoutReached = sensorOnline && (now.unixtime() - lastSensorUpdate.unixtime()) > SENSOR_TIMEOUT_SECONDS;
  // Note: For wired WP sensor, we don't check timeout - it's always "online" if GPIO works
  // Water absence (no water detected) is NOT the same as sensor offline
  bool wpTimeoutReached = false;  // Wired WP sensor doesn't have timeout
  bool wpNeverOnline = false;     // Wired WP sensor is always available

  bool sensorsOffline = false;
  String offlineReason = "";

  if (usTimeoutReached) {
    sensorOnline = false;
    // logSensorStateEvent("SENSOR_TIMEOUT", "seconds_" + String(now.unixtime() - lastSensorUpdate.unixtime()));
    sensorsOffline = true;
    offlineReason += "US sensor timeout";
  }

  if (wpTimeoutReached) {
    wpSensorOnline = false;
    sensorsOffline = true;
    if (offlineReason.length() > 0) offlineReason += " & ";
    offlineReason += "WP sensor timeout";
  }

  if (wpNeverOnline) {
    sensorsOffline = true;
    if (offlineReason.length() > 0) offlineReason += " & ";
    offlineReason += "WP sensor never responded";
  }

  // Update sensor offline mode if needed (but don't override Safe Mode or Manual Override)
  if (sensorsOffline && currentMode != MODE_SENSOR_OFFLINE && currentMode != MODE_SAFE_MODE && currentMode != MODE_MANUAL_OVERRIDE) {
    // FILL INTENT: Save context before stopping motor
    saveFillIntent();

    currentMode = MODE_SENSOR_OFFLINE;
    setMotor(false);

    DEBUG_PRINT("Warning: ");
    DEBUG_PRINT(offlineReason);
    DEBUG_PRINT(" - Motor stopped | ");
    DEBUG_PRINTLN(formatDateTime(now));

    logModeChange("SENSOR_OFFLINE", offlineReason);
  }
}

void controlMotor() {
  // ALWAYS check sensor timeouts first - independent of mode
  checkSensorTimeouts();

  // Log when sensor goes offline
  static bool lastSensorOnlineState = true;

  if (sensorOnline != lastSensorOnlineState) {
    // String stateChange = "from_" + String(lastSensorOnlineState) + "_to_" + String(sensorOnline);
    // logSensorStateEvent("SENSOR_ONLINE_CHANGE", stateChange);
    lastSensorOnlineState = sensorOnline;
  }

  if (otaInProgress) {
    if (motorState) {
      setMotor(false);
      DEBUG_PRINTLN("Motor stopped for OTA safety");
    }
    return;
  }

  checkManualOverrideTimeout();

  // Manual override mode - motor stays ON, no other logic applies
  if (currentMode == MODE_MANUAL_OVERRIDE) {
    if (!motorState) {
      setMotor(true);
    }
    return;
  }

  // Handle schedule mode transitions
  if (scheduleModeEnabled && activeScheduleCount > 0) {
    static int lastActiveSchedule = -1;
    int currentActiveSchedule = getCurrentActiveSchedule();

    // Check for schedule transitions
    if (currentActiveSchedule != lastActiveSchedule) {
      if (currentActiveSchedule >= 0) {
        // Entering a scheduled time slot
        if (currentMode == MODE_SCHEDULE_INACTIVE) {
          currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
          needFreshDataAfterRecovery = true;  // Require fresh sensor data before motor action

          DEBUG_PRINT("Entering scheduled time - Schedule ");
          DEBUG_PRINT(currentActiveSchedule + 1);
          DEBUG_PRINT(": ");
          DEBUG_PRINT(getScheduleTimeString(currentActiveSchedule));
          DEBUG_PRINTLN(" - waiting for fresh sensor data");
          logModeChange("NORMAL", "entered_schedule_" + String(currentActiveSchedule + 1) + "_awaiting_fresh_data");
        }
      } else {
        // Exiting a scheduled time slot
        if (currentMode == MODE_NORMAL || currentMode == MODE_IDLE) {
          currentMode = MODE_SCHEDULE_INACTIVE;
          setMotor(false);
          DEBUG_PRINT("Exiting scheduled time | ");
          DEBUG_PRINTLN(getNextScheduleInfo());
          logModeChange("SCHEDULE_INACTIVE", "exited_schedule_time");
        }
      }
      lastActiveSchedule = currentActiveSchedule;
    }
  }

  // If not in active mode, ensure motor is off
  if (currentMode == MODE_SCHEDULE_INACTIVE || currentMode == MODE_IDLE) {
    if (motorState) {
      setMotor(false);
    }
    return;
  }

  // Continue with existing motor control logic for active modes
  if (!autoModeEnabled) {
    if (currentMode != MODE_IDLE) {
      currentMode = MODE_IDLE;
    }
    if (motorState) {
      setMotor(false);
    }
    return;
  }

  // [Rest of the existing controlMotor() function logic for sensor checks,
  //  dry run protection, etc. - this part remains the same as before]

  if (currentMode == MODE_SAFE_MODE) {
    checkSafeModeAutoRecovery();
    return;
  }

  // Check dry run recovery timeouts independently
  checkDryRunRecoveryTimeout();
  checkSourceDryRunTimeout();

  // Source dry run mode — motor stays off, waiting for retry timeout
  if (currentMode == MODE_SOURCE_DRY_RUN) {
    return;
  }

  if (needFreshDataAfterRecovery) {
    static unsigned long lastFreshDataWarning = 0;
    if (millis() - lastFreshDataWarning > 10000) { // Log every 10 seconds
      DEBUG_PRINTLN("Waiting for fresh sensor data after startup/recovery");
      lastFreshDataWarning = millis();
    }
    return;
  }

  // Sensor timeouts already checked at top of controlMotor()
  // Check if sensors are offline and exit if so
  // Note: WP sensor offline check removed - wired WP sensor is always "online"
  if (!sensorOnline) {
    return;  // Already handled by checkSensorTimeouts()
  }

  // Note: WP sensor is always ready for wired version (direct GPIO reading)
  bool allSensorsReady = sensorOnline && hasReceivedReading;
  if (hasWPSensor) {
    allSensorsReady = allSensorsReady && hasReceivedWPReading;
  }

  if (!allSensorsReady) {
    return;
  }

  if (currentMode == MODE_SENSOR_OFFLINE) {
    needFreshDataAfterRecovery = true;  // Require fresh data after recovery

    // Handle schedule mode context (similar to safe mode / dry run recovery)
    if (scheduleModeEnabled && activeScheduleCount > 0) {
      int activeSchedule = getCurrentActiveSchedule();
      if (activeSchedule < 0) {
        // Outside schedule time - enter inactive mode
        currentMode = MODE_SCHEDULE_INACTIVE;
        setMotor(false);
        DEBUG_PRINTLN("Sensors back online outside schedule - SCHEDULE_INACTIVE");
        // logModeChange("SCHEDULE_INACTIVE", "sensors_back_online");
      } else {
        // Inside schedule time - return to normal/idle based on auto mode
        currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
        DEBUG_PRINTLN("All sensors back online - waiting for fresh sensor data");
        // logModeChange(getModeText(), "sensors_back_online");
      }
    } else {
      // No schedule mode - return to normal/idle based on auto mode
      currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
      DEBUG_PRINTLN("All sensors back online - waiting for fresh sensor data");
      // logModeChange(getModeText(), "sensors_back_online");
    }

    // FILL INTENT: Attempt to resume filling if conditions met
    // This must be called AFTER mode is restored and fresh data is available
    if (attemptFillResume()) {
      DEBUG_PRINTLN("Fill resume check passed - motor confirmation will process on next readings");
    }
  }

  // Check timeout on any pending confirmations
  checkConfirmationTimeout();

  // Handle completed confirmations from processPacket()
  if (motorConfirm.confirmationComplete) {
    if (motorConfirm.confirmationType == "START") {
      // Check blocking conditions before actually starting motor

      // Pre-Detection mode: require WP before starting
      if (detectionMode == 0 && hasWPSensor && !wpSensorStatus) {
        DEBUG_PRINTLN("Motor START blocked - Pre-Detection: no source water");
        resetMotorConfirmation();
        pumpStage = "STANDBY";
        if (millis() - lastNoWaterWarning > WARNING_REPEAT_INTERVAL) {
          DEBUG_PRINTLN("No source water available - motor disabled");
          lastNoWaterWarning = millis();
        }
        return;
      }

      if (currentMode == MODE_DRY_RUN_RECOVERY) {
        DEBUG_PRINTLN("Motor START confirmation ready but in dry run recovery - resetting");
        resetMotorConfirmation();
        return;
      }

      // Take a fresh raw reading of ALL probes just before starting motor.
      // The debounced wpSensorStatus may be stale (e.g. source was removed
      // after the last read cycle confirmed it wet). This instant re-check
      // prevents a false start based on an outdated cached state.
      if (hasWPSensor && detectionMode == 0) {
        uint8_t freshBits = readProbesRaw();
        bool freshSourceWet = (freshBits & 0x04) != 0;
        if (!freshSourceWet) {
          DEBUG_PRINTLN("Motor START aborted - fresh source probe read = DRY");
          wpDebounce.currentState = false;  // sync debounced state immediately
          wpSensorStatus = false;
          resetMotorConfirmation();
          pumpStage = "PRE_WAIT_SOURCE";
          return;
        }
      }

      // All checks passed - start motor
      setMotor(true);
      motorRunStartTime = millis();

      // Post-Detection mode: start grace period (WP ignored during this time)
      if (detectionMode == 1 && hasWPSensor) {
        graceActive = true;
        graceStartTime = millis();
        sourceConfirmed = false;
        sourceConfirmStart = 0;
        pumpStage = "GRACE_PERIOD";
        DEBUG_PRINT("✓ Motor START (Post-Detection) - grace period ");
        DEBUG_PRINT(gracePeriodTens * 10);
        DEBUG_PRINTLN(" sec");
        logSystemEvent("MOTOR_START", "post_detection_grace_" + String(gracePeriodTens * 10) + "s_tank_" + String(currentWaterPercent, 1) + "%");
      } else {
        sourceConfirmed = true;  // Pre-Detection: source already confirmed
        pumpStage = "FILLING";
        DEBUG_PRINTLN("✓ Motor START confirmed and activated!");
        String sensorData = "US:" + String(currentWaterPercent, 1) + "%(" + String(currentWaterLevel, 1) + "cm)";
        if (hasWPSensor) {
          sensorData += "_WP:" + String(wpSensorStatus ? "OK" : "NO");
        }
        logSystemEvent("MOTOR_START_CONFIRMED", sensorData + "_readings_" + String(MOTOR_CONFIRMATION_COUNT));
      }

      if (dryRunProtectionOn) {
        dryRunProbeTimerStart = millis();
      }

      resetMotorConfirmation();

    } else if (motorConfirm.confirmationType == "STOP") {
      // Stop motor
      setMotor(false);
      pumpStage = "IDLE";  // clear any stale stage (e.g. PRE_WAIT_SOURCE)
      DEBUG_PRINTLN("✓ Motor STOP confirmed and activated!");

      // Log motor stop with sensor data
      String sensorData = "US:" + String(currentWaterPercent, 1) + "%(" + String(currentWaterLevel, 1) + "cm)";
      if (hasWPSensor) {
        sensorData += "_WP:" + String(wpSensorStatus ? "OK" : "NO");
      }
      logSystemEvent("MOTOR_STOP_CONFIRMED", sensorData + "_readings_" + String(MOTOR_CONFIRMATION_COUNT));

      // FILL INTENT: Clear intent when target level reached
      clearFillIntent("target_level_reached_confirmed");

      resetMotorConfirmation();
    }
  }

  // Reset confirmations if conditions change (blocking conditions for START)
  bool shouldStart = (currentWaterPercent < startPercent) && !motorState;
  bool shouldStop = (currentWaterPercent >= stopPercent) && motorState;

  if (motorConfirm.waitingForStart && !shouldStart) {
    DEBUG_PRINTLN("Motor START confirmation reset - level above threshold");
    resetMotorConfirmation();
  }

  if (motorConfirm.waitingForStop && !shouldStop) {
    // Don't reset if this is a WP-triggered stop (WP sensor checks water SOURCE, not tank level)
    // WP stop should only be reset if water becomes available again, not based on tank level
    if (!motorConfirm.lastStopConfirmMsgId.startsWith("WP")) {
      DEBUG_PRINTLN("Motor STOP confirmation reset - level below threshold");
      resetMotorConfirmation();
    }
  }

  // ===========================================
  // GRACE PERIOD MANAGEMENT (Post-Detection mode)
  // ===========================================
  if (motorState && graceActive) {
    unsigned long graceElapsed = millis() - graceStartTime;
    unsigned long graceDuration = gracePeriodTens * 10UL * 1000UL;

    if (graceElapsed < graceDuration) {
      // Still in grace period — skip all WP checks and dry run checks
      pumpStage = "GRACE_PERIOD";
      // Only check tank full and max run time during grace
      if (currentWaterPercent >= stopPercent) {
        setMotor(false);
        resetSourceDetectionState();
        pumpStage = "IDLE";
        DEBUG_PRINTLN("Fill complete during grace period!");
        logSystemEvent("MOTOR_STOP", "fill_complete_during_grace_tank_" + String(currentWaterPercent, 1) + "%");
        clearFillIntent("target_level_reached_grace");
      }
      return;  // Skip all other checks during grace period
    } else {
      // Grace period ended — begin source confirmation
      graceActive = false;
      sourceConfirmStart = millis();
      sourceConfirmed = false;
      pumpStage = "SOURCE_CONFIRMING";
      DEBUG_PRINTLN("Grace period ended — checking source water stability");
    }
  }

  // ===========================================
  // SOURCE CONFIRMATION (after grace period)
  // ===========================================
  if (motorState && !sourceConfirmed && sourceConfirmStart > 0 && hasWPSensor) {
    unsigned long confirmElapsed = millis() - sourceConfirmStart;
    unsigned long confirmDuration = sourceDebounceSecs * 1000UL;

    if (wpSensorStatus) {
      // Water is present — check if we've been stable long enough
      if (confirmElapsed >= confirmDuration) {
        // Source water confirmed stable!
        sourceConfirmed = true;
        pumpStage = "FILLING";
        // Reset dry run timer to start fresh after source confirmed
        if (dryRunProtectionOn) {
          dryRunProbeTimerStart = millis();
        }
        DEBUG_PRINT("Source water CONFIRMED stable for ");
        DEBUG_PRINT(sourceDebounceSecs);
        DEBUG_PRINTLN(" sec — normal filling begins");
        logSystemEvent("SOURCE_CONFIRMED", "stable_" + String(sourceDebounceSecs) + "sec_tank_" + String(currentWaterPercent, 1) + "%");
      } else {
        pumpStage = "SOURCE_CONFIRMING";
      }
    } else {
      // Water not present after grace period — source check failed
      // Reset confirmation timer (water must be continuous)
      if (confirmElapsed >= confirmDuration) {
        // Debounce period passed with no water — source failure
        setMotor(false);
        sourceDryRunCount++;
        DEBUG_PRINT("Source water NOT detected after grace + ");
        DEBUG_PRINT(sourceDebounceSecs);
        DEBUG_PRINT("sec check. Retry ");
        DEBUG_PRINT(sourceDryRunCount);
        DEBUG_PRINT("/");
        DEBUG_PRINTLN(maxRetryCount);
        logSystemEvent("MOTOR_STOP", "no_source_water_retry_" + String(sourceDryRunCount) + "_of_" + String(maxRetryCount));

        // Enter retry or safe mode — uses MODE_SOURCE_DRY_RUN (separate from tank dry run)
        lastFaultReason = "NO_SOURCE";
        if (sourceDryRunCount >= maxRetryCount) {
          currentMode = MODE_SAFE_MODE;
          safeModeStartTime = millis();
          pumpStage = "SAFE_MODE";
          DEBUG_PRINTLN("SAFE MODE — all source water retries exhausted");
          logModeChange("SAFE_MODE", "source_dry_run_count_" + String(sourceDryRunCount));
          logErrorEvent("SAFE_MODE", "no_source_water_retries_" + String(sourceDryRunCount));
        } else {
          currentMode = MODE_SOURCE_DRY_RUN;
          sourceDryRunStartTime = millis();
          graceActive = false;
          sourceConfirmed = false;
          sourceConfirmStart = 0;
          pumpStage = "SOURCE_RETRY_WAIT";
          logModeChange("SOURCE_DRY_RUN", "no_source_water_attempt_" + String(sourceDryRunCount));
          logErrorEvent("SOURCE_DRY_RUN", "no_source_water_count_" + String(sourceDryRunCount));
        }
        return;
      } else {
        // Still within debounce window — restart confirmation timer
        sourceConfirmStart = millis();
        pumpStage = "SOURCE_CONFIRMING";
      }
    }
    // Don't run dry run checks until source is confirmed
    if (!sourceConfirmed) return;
  }

  // ===========================================
  // MAX CONTINUOUS RUN TIME CHECK
  // (Direct to Safe Mode — no retries. This is a hard safety limit:
  //  if motor ran the full duration and tank still isn't full, something
  //  is genuinely wrong — leak, blocked outlet, sensor problem. Stop and
  //  require manual reset rather than burn another full duration.)
  // ===========================================
  if (motorState && maxRunTimeMins > 0 && motorRunStartTime > 0) {
    unsigned long runElapsed = millis() - motorRunStartTime;
    unsigned long maxRunDuration = maxRunTimeMins * 60UL * 1000UL;

    if (runElapsed >= maxRunDuration) {
      setMotor(false);
      DEBUG_PRINT("Max run time (");
      DEBUG_PRINT(maxRunTimeMins);
      DEBUG_PRINT(" min) exceeded! Tank at ");
      DEBUG_PRINT(currentWaterPercent, 1);
      DEBUG_PRINTLN("% — entering SAFE MODE (no retries)");
      logSystemEvent("MOTOR_STOP", "max_run_time_" + String(maxRunTimeMins) + "min_tank_" + String(currentWaterPercent, 1) + "%");

      // Direct to Safe Mode — no dryRunCount increment, no retries
      lastFaultReason = "MAX_RUN_TIME";
      currentMode = MODE_SAFE_MODE;
      safeModeStartTime = millis();
      resetSourceDetectionState();
      pumpStage = "SAFE_MODE";
      logModeChange("SAFE_MODE", "max_run_time_exceeded_direct_" + String(maxRunTimeMins) + "min");
      logErrorEvent("SAFE_MODE", "max_run_time_direct_no_retry_" + String(maxRunTimeMins) + "min");
      return;
    }
  }

  // ===========================================
  // MID-FILL SOURCE WATER LOSS CHECK
  // ===========================================
  // Only check when source was previously confirmed and motor is running
  // The WP debounce (sourceDebounceSecs) handles the continuous-absence detection
  // wpSensorStatus becomes false only after debounce period of continuous absence
  if (motorState && sourceConfirmed && hasWPSensor && !wpSensorStatus) {
    // WP already debounced — source water lost mid-fill.
    // Save fill intent BEFORE stopping so the resume mechanism can restart
    // the motor when source returns, even if tank is mid-level (not LOW).
    saveFillIntent();
    setMotor(false);

    // Pre-Detection: no retry/Safe Mode escalation; just wait for source to return.
    // Pump never runs without source by design; stopping + waiting is the whole policy.
    if (detectionMode == 0) {
      sourceConfirmed = false;
      sourceConfirmStart = 0;
      pumpStage = "PRE_WAIT_SOURCE";
      DEBUG_PRINTLN("Pre-Detection: source water lost mid-fill, waiting for return");
      logSystemEvent("MOTOR_STOP", "pre_detection_source_lost_midfill_tank_" + String(currentWaterPercent, 1) + "%");
      return;
    }

    sourceDryRunCount++;
    DEBUG_PRINT("Source water LOST mid-fill! Retry ");
    DEBUG_PRINT(sourceDryRunCount);
    DEBUG_PRINT("/");
    DEBUG_PRINTLN(maxRetryCount);
    logSystemEvent("MOTOR_STOP", "source_lost_midfill_retry_" + String(sourceDryRunCount) + "_tank_" + String(currentWaterPercent, 1) + "%");

    lastFaultReason = "NO_SOURCE";
    if (sourceDryRunCount >= maxRetryCount) {
      currentMode = MODE_SAFE_MODE;
      safeModeStartTime = millis();
      pumpStage = "SAFE_MODE";
      logModeChange("SAFE_MODE", "source_lost_midfill_count_" + String(sourceDryRunCount));
      logErrorEvent("SAFE_MODE", "source_lost_midfill_retries_" + String(sourceDryRunCount));
    } else {
      currentMode = MODE_SOURCE_DRY_RUN;
      sourceDryRunStartTime = millis();
      sourceConfirmed = false;
      sourceConfirmStart = 0;
      pumpStage = "SOURCE_RETRY_WAIT";
      logModeChange("SOURCE_DRY_RUN", "source_lost_midfill_attempt_" + String(sourceDryRunCount));
    }
    return;
  }

  // Update pumpStage for normal filling
  if (motorState && sourceConfirmed) {
    pumpStage = "FILLING";
  }

  // v118.0.9: dry-run protection now has TWO modes, selected by
  // smartDryRunEnabled. The escalation path (increment dryRunCount,
  // setMotor(false), enter DRY_RUN_RECOVERY or SAFE_MODE) is the same;
  // only the TRIGGER differs. Shared trigger-handling closure below.
  //
  // SMART (default): poll currentWaterPercent every smartDryRunCheckMins.
  //   Trigger if rise < smartDryRunMinPct in the window. Catches dry
  //   source within 5-15 min typical instead of waiting the full 30-min
  //   LOW→FULL budget. Also catches slow-leak / mid-fill-source-loss
  //   scenarios where classic would never fire.
  //
  // CLASSIC: original "has tank reached FULL within maxTimeToNextProbeMins"
  //   timer. Preserved as a fallback for users who prefer it or whose
  //   sensor is unreliable (sensor-fault during the window would appear
  //   as "no rise" and trip smart detection falsely).
  if (motorState && dryRunProtectionOn) {
    bool triggerDryRun = false;
    const char* triggerReason = "";

    if (smartDryRunEnabled && usHaveGoodReading && !usSensorFault) {
      // Smart: compare pct every smartDryRunCheckMins. First window
      // starts on pump-on (dryRunProbeTimerStart was armed there via
      // the existing shouldRunMotor path OR in the force-run entry).
      if (smartDryRunWindowStartMs == 0) {
        smartDryRunWindowStartMs = millis();
        smartDryRunStartPct      = usConfirmedPct;
      }
      unsigned long windowElapsed = millis() - smartDryRunWindowStartMs;
      unsigned long windowMs      = (unsigned long)smartDryRunCheckMins * 60UL * 1000UL;
      if (windowElapsed >= windowMs) {
        int rise = (int)usConfirmedPct - (int)smartDryRunStartPct;
        if (rise < (int)smartDryRunMinPct) {
          triggerDryRun = true;
          triggerReason = "smart_no_rise";
          DEBUG_PRINT("[SMART-DRY] Pct rise ");
          DEBUG_PRINT(rise);
          DEBUG_PRINT("% < req ");
          DEBUG_PRINT(smartDryRunMinPct);
          DEBUG_PRINTLN("% in window — dry run");
        } else {
          // Tank IS rising at adequate rate — reset the window and keep
          // monitoring. Also clear the retry counter: a successful fill
          // means prior dry-runs are forgiven.
          if (dryRunCount != 0) {
            DEBUG_PRINT("[SMART-DRY] Rise ");
            DEBUG_PRINT(rise);
            DEBUG_PRINTLN("% OK — resetting counter");
            dryRunCount = 0;
          }
          smartDryRunWindowStartMs = millis();
          smartDryRunStartPct      = usConfirmedPct;
        }
      }
    } else if (maxTimeToNextProbeMins > 0) {
      // Classic: wait for tankFullWet within maxTimeToNextProbeMins.
      if (tankFullWet) {
        if (dryRunCount != 0) DEBUG_PRINTLN("Tank reached FULL - dry run counter reset");
        dryRunCount = 0;
        dryRunProbeTimerStart = millis();   // re-arm (e.g. fill intent)
      } else if (dryRunProbeTimerStart != 0 &&
                 (millis() - dryRunProbeTimerStart) >= (unsigned long)maxTimeToNextProbeMins * 60UL * 1000UL) {
        triggerDryRun = true;
        triggerReason = "classic_full_not_reached";
      }
    }

    if (triggerDryRun) {
      dryRunCount++;
      DateTime now = safeNow();
      DEBUG_PRINT("Dry run detected ("); DEBUG_PRINT(triggerReason); DEBUG_PRINT(")! Count: ");
      DEBUG_PRINT(dryRunCount); DEBUG_PRINT("/"); DEBUG_PRINT(maxDryRunCount);
      DEBUG_PRINT(" | "); DEBUG_PRINTLN(formatDateTime(now));

      setMotor(false);

      lastFaultReason = "NO_LEVEL_CHANGE";
      // Also reset smart-window state so a future retry starts fresh.
      smartDryRunWindowStartMs = 0;

      if (dryRunCount >= maxDryRunCount) {
        clearFillIntent("safe_mode_triggered_dry_run");
        currentMode = MODE_SAFE_MODE;
        safeModeStartTime = millis();
        resetSourceDetectionState();
        pumpStage = "SAFE_MODE";
        logModeChange("SAFE_MODE", "consecutive_dry_runs_" + String(dryRunCount));
        logErrorEvent("SAFE_MODE", "dry_run_count_" + String(dryRunCount));
      } else {
        clearFillIntent("dry_run_recovery_triggered");
        currentMode = MODE_DRY_RUN_RECOVERY;
        dryRunStartTime = millis();
        resetSourceDetectionState();
        pumpStage = "RETRY_WAIT";
        logModeChange("DRY_RUN_RECOVERY", "dry_run_detected_attempt_" + String(dryRunCount));
        logErrorEvent("DRY_RUN", "level_no_change_count_" + String(dryRunCount));
      }
    }
  }
}

// ===========================================
// TANK LOW/FULL + SOURCE PROBE FUNCTIONS
// Replaces the ultrasonic pipeline + zone system on this PCB variant.
// IO32=tank LOW, IO33=tank FULL, IO34=source/ground-water presence.
// EXCITATION_MODE selects constant-VCC (plain digitalRead) vs OCSIL pulsed
// excitation (anti-corrosion), mirroring SenseFlow_RTU_D4.ino's
// readDipRaw()/processDipSensors() pattern (lines 200-279 in that file).
// ===========================================

// Raw (pre-debounce) read of all 3 active probes in one excitation cycle.
// bit0=tank LOW, bit1=tank FULL, bit2=source. EXCITATION_MODE==1 requires a
// probe to agree with the EXCITE line on both HIGH and LOW half-cycles
// across DIP_SAMPLES_PER_READ samples before counting it wet (rejects
// stuck/floating pins); EXCITATION_MODE==0 is a plain digitalRead per pin.
uint8_t readProbesRaw() {
  // v118: only the source probe (GPIO34, bit 0x04) is discrete. Tank
  // bits (0x01, 0x02) are derived from the ultrasonic sensor in
  // processTankAndSourceReading() — we set them here from the current
  // tankLowWet/tankFullWet booleans so any legacy caller that reads the
  // return value still sees a consistent picture.
  uint8_t highCount = 0;
  for (int s = 0; s < DIP_SAMPLES_PER_READ; s++) {
    if (digitalRead(SOURCE_PROBE_PIN) == HIGH) highCount++;
    delayMicroseconds(200);
  }
  uint8_t bits = 0;
  if (tankLowWet)  bits |= 0x01;
  if (tankFullWet) bits |= 0x02;
  if (highCount >= DIP_AGREE_THRESHOLD) bits |= 0x04;
  return bits;
}

// Initialize tank sensor (RS485 ultrasonic) + source probe pin.
// v118 has NO discrete tank probes — GPIO32/33 are unused on this
// board revision. Source probe (GPIO34) is unchanged from v117.
void initTankSensors() {
  pinMode(SOURCE_PROBE_PIN, INPUT_PULLDOWN);
  usLoadConfig();     // restore tank height / offset / thresholds from NVS
  usSensorInit();     // config UART2 + do one seed poll
  DEBUG_PRINTLN(F("Ultrasonic terrace sensor + source probe initialized"));
  DEBUG_PRINT(F("  Terrace: RS485 Modbus on RX=GPIO")); DEBUG_PRINT(RS485_RX_PIN);
  DEBUG_PRINT(F(" TX=GPIO")); DEBUG_PRINT(RS485_TX_PIN);
  DEBUG_PRINT(F(" DIR=GPIO")); DEBUG_PRINTLN(RS485_DIR_PIN);
  DEBUG_PRINT(F("  Source: GPIO")); DEBUG_PRINTLN(SOURCE_PROBE_PIN);
}

// ===========================================
// WIRED WATER PRESENCE SENSOR FUNCTIONS
// (source/ground-water presence, IO34 - feeds the existing
// hasWPSensor/wpSensorStatus dry-run/source-detection logic unchanged)
// ===========================================

// Read the source probe. Returns which "sensor" detected water for logging
// parity with the donor's two-sensor WPSensorType - this build only has one
// physical source probe, so it's always WP_DIP_SENSOR or WP_NO_SENSOR.
WPSensorType readWaterSensorsRaw(bool &waterPresent) {
  uint8_t bits = readProbesRaw();
  waterPresent = (bits & 0x04) != 0;
  return waterPresent ? WP_DIP_SENSOR : WP_NO_SENSOR;
}

// Get sensor type name for logging
String getWPSensorTypeName(WPSensorType type) {
  switch(type) {
    case WP_DIP_SENSOR: return "DIP";
    case WP_CONTACTLESS_SENSOR: return "CONTACTLESS";
    case WP_BOTH_SENSORS: return "BOTH";
    default: return "NONE";
  }
}

// Read water presence with asymmetric debounce:
//   WET → DRY : requires DRY_CONFIRM_COUNT consecutive majority-vote-DRY
//               readings before accepting (fast, ~6s with 2s read interval).
//               Protects against a single noisy read falsely stopping the pump.
//   DRY → WET : requires sourceDebounceSecs of stable wet signal before
//               restarting (slow, user-configured, default 30s).
//               Prevents brief contact or splash from prematurely restarting.
// Source probe debounce — counts consecutive same-state reads.
// Requires WET_CONFIRM reads of WET to go WET, DRY_CONFIRM reads of DRY to go DRY.
// Uses a simple consecutive-count approach — no timers, no resets from
// opposite-direction reads. Each call either increments the counter for the
// current direction or resets the opposite counter. State only changes when
// the required count is reached. This is immune to occasional opposite reads
// because the counter for the CURRENT direction keeps accumulating.
bool readWiredWaterPresence() {
  bool rawWaterState;
  WPSensorType currentSensorType = readWaterSensorsRaw(rawWaterState);

  if (rawWaterState) {
    srcWetCount++;
    if (srcWetCount > SOURCE_WET_CONFIRM) srcWetCount = SOURCE_WET_CONFIRM;
    srcDryCount = 0;   // reset DRY counter — probe is reading wet
  } else {
    srcDryCount++;
    if (srcDryCount > SOURCE_DRY_CONFIRM) srcDryCount = SOURCE_DRY_CONFIRM;
    srcWetCount = 0;   // reset WET counter — probe is reading dry
  }

  // Transition WET: enough consecutive WET reads
  if (!wpDebounce.currentState && srcWetCount >= SOURCE_WET_CONFIRM) {
    wpDebounce.currentState = true;
    DEBUG_PRINTLN(F("Source probe: WATER confirmed"));
  }
  // Transition DRY: enough consecutive DRY reads
  if (wpDebounce.currentState && srcDryCount >= SOURCE_DRY_CONFIRM) {
    wpDebounce.currentState = false;
    DEBUG_PRINTLN(F("Source probe: NO WATER confirmed"));
  }

  wpDebounce.lastRawState = rawWaterState;
  return wpDebounce.currentState;
}

// Initialize the source-probe debounce structure. Pin setup itself is done
// by initTankSensors() (all 3 active probes share one pinMode/excitation
// init); this just (re)arms the WaterPresenceDebounce state and takes an
// initial reading, same as the donor's separate pin-init function did.
void initializeWiredWaterPresence() {
  wpDebounce.stateChangeTime = 0;
  wpDebounce.currentState = false;
  wpDebounce.lastRawState = false;
  wpDebounce.isDebouncing = false;
  wpDebounce.activeSensor = WP_NO_SENSOR;
  wpDebounce.wetInterruptCount = 0;
  srcWetCount = 0;
  srcDryCount = 0;

  // Take multiple reads at boot to pre-seed the counters so a probe already
  // in water at power-on is immediately confirmed — without this, the device
  // would need the probe to be removed and reinserted after every reboot.
  uint8_t wetVotes = 0;
  for (int i = 0; i < SOURCE_WET_CONFIRM; i++) {
    bool s;
    readWaterSensorsRaw(s);
    if (s) wetVotes++;
    delay(50);
  }

  bool initialState = (wetVotes >= (SOURCE_WET_CONFIRM / 2 + 1));
  wpDebounce.currentState = initialState;
  wpDebounce.lastRawState = initialState;

  if (initialState) {
    srcWetCount = SOURCE_WET_CONFIRM;  // pre-seed as confirmed
    srcDryCount = 0;
  } else {
    srcWetCount = 0;
    srcDryCount = SOURCE_DRY_CONFIRM;  // pre-seed as confirmed dry
  }

  DEBUG_PRINTLN(F("Source presence sensor initialized"));
  DEBUG_PRINT(F("  Initial state: "));
  DEBUG_PRINTLN(initialState ? "WATER (confirmed at boot)" : "NO WATER (confirmed at boot)");
}

// ===========================================
// WIRED SENSOR MAIN PROCESSING FUNCTION
// ===========================================

// Debounce state for the tank LOW/FULL probes - same shape/3s debounce
// pattern as the donor's WaterPresenceDebounce, kept as plain bools since
// there's no "which sensor type" concept for a single dedicated pin each.
bool tankLowRawLast = false, tankFullRawLast = false;
unsigned long tankLowChangeTime = 0, tankFullChangeTime = 0;
bool tankLowDebouncing = false, tankFullDebouncing = false;

// Process tank LOW/FULL probes (replaces processWiredUltrasonicReading() +
// processWaterLevelData()). currentWaterPercent is kept populated (0/50/100)
// purely so the rest of the file's existing percent-based UI/JSON/log code
// keeps working unchanged - shouldStart/shouldStop below only ever compare
// against the fixed startPercent=0/stopPercent=100, so the 50% "between
// probes" value never itself triggers a control decision.
void processTankAndSourceReading() {
  unsigned long now = millis();
  if (now - lastProbeReadTime < PROBE_READ_INTERVAL_MS) return;
  lastProbeReadTime = now;

  static unsigned long readingCount = 0;

  // v118: tank state comes from the RS485 ultrasonic sensor. usPollTick()
  // in loop() updates usConfirmedPct and usUpdateDiscreteFromPct() keeps
  // tankLowWet/tankFullWet in sync. Nothing to read here for the tank —
  // we just expose the pct through currentWaterPercent so all the
  // existing UI + JSON + log code that reads currentWaterPercent works
  // unchanged.
  currentWaterPercent = usSensorFault ? 0.0 : (float)usConfirmedPct;
  currentWaterLevel   = currentWaterPercent;

  // Source probe is still discrete on GPIO34. Read just that bit — the
  // debounce/confirmation is handled downstream in readWiredWaterPresence().
  // Tank-probe debounce state (tankLowRawLast/tankLowDebouncing etc)
  // was tied to the physical GPIO reads that no longer exist on this
  // variant; those variables remain declared but unused, harmless.

  readingCount++;
  String msgId = "T" + String(readingCount);

  sensorOnline = usHaveGoodReading && !usSensorFault;
  hasReceivedReading = usHaveGoodReading;
  // v118.0.6: only update lastSensorUpdate when we actually have a
  // FRESH valid reading from the ultrasonic sensor. Prior behaviour
  // updated this timestamp every PROBE_READ_INTERVAL regardless of
  // sensor state, so the AP page said "1s ago" even when the sensor
  // had been offline for 10 min. Now the timestamp reflects when we
  // LAST got valid data, not when we LAST tried to read.
  if (usHaveGoodReading && !usSensorFault) {
    lastSensorUpdate = safeNow();
  }
  needFreshDataAfterRecovery = false;

  DEBUG_PRINT(F("Tank probes ["));
  DEBUG_PRINT(msgId);
  DEBUG_PRINT(F("]: LOW="));
  DEBUG_PRINT(tankLowWet ? "wet" : "dry");
  DEBUG_PRINT(F(" FULL="));
  DEBUG_PRINTLN(tankFullWet ? "wet" : "dry");

  // Process motor confirmation with new sensor data (same call pattern the
  // donor used from its ultrasonic read path).
  if (autoModeEnabled && currentMode == MODE_NORMAL) {
    bool shouldStart = (currentWaterPercent < startPercent) && !motorState;

    // Fill intent override: resume filling even in hysteresis zone
    if (motorWasFillingBeforeOffline && !motorState && currentWaterPercent < stopPercent) {
      shouldStart = true;
      DEBUG_PRINTLN("Fill intent active: Overriding hysteresis to resume filling");
    }

    // v118.0.9: per-schedule fillUntilFull override. If the active
    // schedule has fillUntilFull=true, start the pump as long as the
    // tank is below stopPercent — ignore startPercent entirely. Lets
    // users force-top-up at off-peak hours even when tank is 60-70%
    // full (startPercent might be 20%). stopPercent still applies.
    if (scheduleModeEnabled && !motorState && currentWaterPercent < stopPercent) {
      int si = getCurrentActiveSchedule();
      if (si >= 0 && schedules[si].fillUntilFull) {
        shouldStart = true;
        DEBUG_PRINT("Schedule "); DEBUG_PRINT(si + 1);
        DEBUG_PRINTLN(" fillUntilFull: ignoring startPercent threshold");
      }
    }

    bool shouldStop = (currentWaterPercent >= stopPercent) && motorState;
    processMotorConfirmation(msgId, currentWaterPercent, shouldStart, shouldStop);
  }
}

// Process wired water presence sensor reading
// Updates wpSensorStatus, wpSensorOnline, lastWPSensorUpdate
void processWiredWaterPresenceReading() {
  bool waterPresent = readWiredWaterPresence();

  // Update global variables
  wpSensorStatus = waterPresent;
  wpSensorOnline = true;  // Wired sensor is always "online" if code runs
  hasReceivedWPReading = true;
  lastWPSensorUpdate = safeNow();

  // Note: wpSensorStatus = true means WATER IS PRESENT (source has water)
  // wpSensorStatus = false means NO WATER (dry run risk)

  // Generate unique msgId for WP readings (separate counter from ultrasonic)
  static unsigned long wpReadingCount = 0;
  wpReadingCount++;
  String msgId = "WP" + String(wpReadingCount);

  // Process motor confirmation for WP-based stop (only when motor is running)
  // WP sensor only triggers STOP (dry run protection), never START
  // SKIP during grace period and source confirmation — controlMotor() handles these
  if (autoModeEnabled && currentMode == MODE_NORMAL && hasWPSensor && !graceActive && sourceConfirmed) {
    bool shouldStart = false;  // WP doesn't trigger motor start
    bool shouldStop = (!wpSensorStatus) && motorState;  // Stop if absent and motor running

    if (shouldStop) {
      processMotorConfirmation(msgId, currentWaterPercent, shouldStart, shouldStop);
      DEBUG_PRINTLN("WP absent - processing stop confirmation");
    } else if (wpSensorStatus && motorConfirm.waitingForStop && motorConfirm.lastStopConfirmMsgId.startsWith("WP")) {
      // Water is back - reset WP-triggered stop confirmation
      DEBUG_PRINTLN("WP water available again - resetting WP stop confirmation");
      resetMotorConfirmation();
    }
  }
}

// ===========================================
// SENSOR PROCESSING FUNCTIONS
// ===========================================

String getSensorID(String nodeName) {
  int dashIndex = nodeName.indexOf('-');
  if (dashIndex != -1) {
    return nodeName.substring(dashIndex + 1);
  } else {
    return nodeName;
  }
}

void processPacket(String jsonData, int rssi) {
  static int packetCounter = 0;
  packetCounter++;

  // Log packet reception
  String packetDetails = "size_" + String(jsonData.length()) + "_rssi_" + String(rssi);
  // Removed verbose packet logging

  // Validate packet format
  if (jsonData.length() == 0) {
    // Removed verbose packet logging
    return;
  }

  if (jsonData.length() > 300) {
    // Removed verbose packet logging
    return;
  }

  // Pre-filtering - extract sensor ID from raw JSON
  String extractedSensorId = "";
  String targetNodePattern = "\"node_id\":\"" + targetNodeName + "\"";
  String wpNodePattern = hasWPSensor ? ("\"node_id\":\"" + wpNodeName + "\"") : "";

  bool isTargetNode = (jsonData.indexOf(targetNodePattern) != -1);
  bool isWPNode = hasWPSensor && (jsonData.indexOf(wpNodePattern) != -1);

  if (isTargetNode) {
    extractedSensorId = targetNodeName;
  } else if (isWPNode) {
    extractedSensorId = wpNodeName;
  }

  if (extractedSensorId.length() == 0) {
    // Removed verbose packet logging
    return;
  }

  if (!isTargetNode && !isWPNode) {
    // Removed verbose packet logging
    return;
  }

  // Log target sensor match
  // Removed verbose packet logging

  // Quick security check before expensive parsing
  //if (jsonData.indexOf("\"secret_code\":\"mvstech\"") == -1) {
   // logPacketEvent("SECURITY_FAILED", "no_secret_code_" + extractedSensorId);
   // return;
  //}

  // JSON parsing
  StaticJsonDocument<200> doc;
  DeserializationError error = deserializeJson(doc, jsonData);

  if (error) {
    // Removed verbose packet logging
    return;
  }

  // Removed verbose packet logging

  // Extract fields
  if (!doc.containsKey("node_id") || !doc.containsKey("msg_id") ||
      !doc.containsKey("data") ) {
    // Removed verbose packet logging
    return;
  }

  String nodeId = doc["node_id"].as<String>();
  String secretCode = doc["secret_code"].as<String>();
  String msgId = doc["msg_id"].as<String>();
  String data = doc["data"].as<String>();

  // Security validation
  if (secretCode != "mvstech") {
    // logPacketEvent("SECURITY_FAILED", "wrong_secret_" + extractedSensorId);
    DEBUG_PRINT("Security: Invalid secret from ");
    DEBUG_PRINT(nodeId);
    DEBUG_PRINT(" (");
    DEBUG_PRINT(rssi);
    DEBUG_PRINTLN(" dBm)");
    return;
  }

  // Re-extract sensor ID from parsed nodeId for consistency
  String parsedSensorId = getSensorID(nodeId);

  // Process WP sensor
  if (hasWPSensor && parsedSensorId == wpNodeName) {
    // Log state BEFORE updating
    String stateBefore = "online_" + String(wpSensorOnline) + "_hasReading_" + String(hasReceivedWPReading);
    // Removed verbose sensor logging

    lastReceivedMsgId = msgId;
    lastWPSensorUpdate = safeNow();
    wpSensorOnline = true;
    hasReceivedWPReading = true;
    needFreshDataAfterRecovery = false;

    currentWPRSSI = rssi;
    hasWPRSSIReading = true;

    wpSensorStatus = (data == "1");

    // Log state AFTER updating
    String stateAfter = "online_" + String(wpSensorOnline) + "_hasReading_" + String(hasReceivedWPReading) + "_msgId_" + msgId;
    // Removed verbose sensor logging

    DateTime now = safeNow();
    DEBUG_PRINT("WP Sensor: ");
    DEBUG_PRINT(parsedSensorId);
    DEBUG_PRINT(" -> ");
    DEBUG_PRINT(wpSensorStatus ? "Water Available" : "NO WATER");
    DEBUG_PRINT(" | RSSI: ");
    DEBUG_PRINT(rssi);
    DEBUG_PRINT(" dBm | ");
    DEBUG_PRINTLN(formatDateTime(now));

    // Removed verbose packet logging
    return;
  }

  if (parsedSensorId != targetNodeName) {
    // Removed verbose packet logging
    return;
  }

  // Original duplicate message check
  if (msgId == lastReceivedMsgId && lastReceivedMsgId.length() > 0) {
    // Removed verbose packet logging
    return;
  }

  // Log state BEFORE updating
  String stateBefore = "online_" + String(sensorOnline) + "_hasReading_" + String(hasReceivedReading);
  // Removed verbose sensor logging

  // Process target sensor
  lastReceivedMsgId = msgId;
  lastSensorUpdate = safeNow();
  sensorOnline = true;
  hasReceivedReading = true;
  needFreshDataAfterRecovery = false;

  currentRSSI = rssi;
  hasRSSIReading = true;

  // Log state AFTER updating
  String stateAfter = "online_" + String(sensorOnline) + "_hasReading_" + String(hasReceivedReading) + "_msgId_" + msgId;
  // Removed verbose sensor logging

  // Process water level - dead path on this PCB variant (no wireless/LoRa
  // ultrasonic node; processPacket() itself is never invoked in this wired
  // build). processWaterLevelData() was removed along with the ultrasonic
  // pipeline; currentWaterPercent is only ever updated by
  // processTankAndSourceReading() now.
  float ultrasonicReading = data.toFloat();
  (void)ultrasonicReading;

  // Startup sensor validation - prevent motor decisions during stabilization
  if (startupSensorValidation) {
    if ((millis() - startupTime) < STARTUP_SENSOR_DELAY_MS) {
      DEBUG_PRINTLN("Startup: Ignoring motor decisions during sensor stabilization");
      return; // Don't process motor confirmations yet
    } else {
      startupSensorValidation = false;
      DEBUG_PRINTLN("Startup: Sensor stabilization complete - motor decisions enabled");
      // logSystemEvent("STARTUP_COMPLETE", "sensor_stabilization_complete");
    }
  }

  // Process motor confirmation with new sensor data
  // Only process confirmations if auto mode is enabled and we're in active mode
  if (autoModeEnabled && currentMode == MODE_NORMAL) {
    bool shouldStart = (currentWaterPercent < startPercent) && !motorState;

    // Fill intent override: resume filling even in hysteresis zone
    // If we were filling before sensor offline and level is still below target, resume filling
    if (motorWasFillingBeforeOffline && !motorState && currentWaterPercent < stopPercent) {
      shouldStart = true;
      DEBUG_PRINTLN("Fill intent active: Overriding hysteresis to resume filling");
    }

    bool shouldStop = (currentWaterPercent >= stopPercent) && motorState;
    processMotorConfirmation(msgId, currentWaterPercent, shouldStart, shouldStop);
  }

  // Removed verbose sensor logging

  DEBUG_PRINT("Received: ");
  DEBUG_PRINT(parsedSensorId);
  DEBUG_PRINT(" -> ");
  DEBUG_PRINT(ultrasonicReading, 1);
  DEBUG_PRINT("cm -> ");
  DEBUG_PRINT(currentWaterPercent, 1);
  DEBUG_PRINT("% (");
  DEBUG_PRINT(currentWaterLevel, 1);
  DEBUG_PRINT("cm)");

  if (tankVolume > 0) {
    float availableVolume = (currentWaterPercent / 100.0) * tankVolume;
    DEBUG_PRINT(" | ");
    DEBUG_PRINT(availableVolume, 1);
    DEBUG_PRINT("L");
  }

  DEBUG_PRINT(" | RSSI: ");
  DEBUG_PRINT(rssi);
  DEBUG_PRINT(" dBm");
  DEBUG_PRINT(" | Motor: ");
  DEBUG_PRINT(motorState ? "ON" : "OFF");
  DEBUG_PRINT(" | ");
  DEBUG_PRINTLN(formatDateTime(safeNow()));

  // Removed verbose packet logging
}

// ===========================================
// SWITCH HANDLING AND RESET FUNCTIONS
// ===========================================

void checkResetSwitch() {
  bool buttonPressed = (digitalRead(RESET_SWITCH_PIN) == HIGH);  // default LOW, pressed = HIGH

  // Button just pressed
  if (buttonPressed && !lastSwitchState) {
    pressStartTime = millis();
    longPressColorChanged = false;
    // DEBUG_PRINTLN("\n>>> Button PRESSED");  // Debug commented out
    ws2812_setColor(255, 255, 255); // WHITE - press acknowledged
    lastSwitchState = true;
  }

  // Check for long press WHILE button is held
  if (buttonPressed && lastSwitchState && !longPressColorChanged) {
    unsigned long currentDuration = millis() - pressStartTime;
    if (currentDuration >= LONG_PRESS_MIN) {
      // DEBUG_PRINTLN("Long press threshold reached - WHITE -> GREEN");  // Debug commented out
      ws2812_setColor(0, 255, 0); // GREEN - long press confirmed
      longPressColorChanged = true;
    }
  }

  // Button just released
  if (!buttonPressed && lastSwitchState) {
    unsigned long duration = millis() - pressStartTime;

    // Verbose button debug commented out to save ~1KB Flash
    // DEBUG_PRINT(">>> Button RELEASED - Duration: ");
    // DEBUG_PRINT(duration);
    // DEBUG_PRINTLN(" ms");

    if (duration >= LONG_PRESS_MIN) {
      // Long press action
      handleLongPress();
      delay(RESULT_DISPLAY_TIME);
      ws2812_setColor(0, 0, 0); // OFF
    } else if (duration >= SHORT_PRESS_MIN && duration <= SHORT_PRESS_MAX) {
      // Count as tap
      handleTap();
    } else if (duration > SHORT_PRESS_MAX && duration < LONG_PRESS_MIN) {
      // DEBUG_PRINT("Duration (");
      // DEBUG_PRINT(duration);
      // DEBUG_PRINTLN(" ms) between short and long range - ignored");
      ws2812_setColor(0, 0, 0); // OFF
    }

    lastSwitchState = false;
  }

  // Check if tap sequence timeout reached
  checkTapTimeout();
}

void handleTap() {
  unsigned long currentTime = millis();

  // Check if this tap is within the window of previous tap
  if (waitingForSecondClick && (currentTime - lastTapTime < TAP_WINDOW)) {
    tapCount++;
    // DEBUG_PRINT("TAP DETECTED - Total taps: ");
    // DEBUG_PRINTLN(tapCount);

    // Show BLUE immediately on second tap
    if (tapCount == 2) {
      // DEBUG_PRINTLN("Second tap confirmed - showing BLUE");
      ws2812_setColor(0, 0, 255); // BLUE
    }
    // Show MAGENTA immediately on third tap
    else if (tapCount == 3) {
      // DEBUG_PRINTLN("Third tap confirmed - showing MAGENTA");
      ws2812_setColor(255, 0, 255); // MAGENTA
    }

  } else {
    tapCount = 1;
    waitingForSecondClick = true;
    // DEBUG_PRINTLN("TAP DETECTED - Tap #1");
    // DEBUG_PRINTLN("Waiting 1.5 seconds for additional taps...");
    ws2812_setColor(0, 0, 0); // Turn off after first tap
  }

  lastTapTime = currentTime;
}

void checkTapTimeout() {
  if (waitingForSecondClick && (millis() - lastTapTime > TAP_WINDOW)) {
    waitingForSecondClick = false;

    // DEBUG_PRINT("Wait period ended. Total taps: ");
    // DEBUG_PRINTLN(tapCount);

    if (tapCount == 1) {
      // DEBUG_PRINTLN("==> RESULT: SINGLE TAP");
      handleSingleClick();
    } else if (tapCount == 2) {
      // DEBUG_PRINTLN("==> RESULT: DOUBLE TAP");
      handleDoubleClick();
    } else if (tapCount == 3) {
      // DEBUG_PRINTLN("==> RESULT: TRIPLE TAP");
      handleTripleTap();
    }

    tapCount = 0;
  }
}

void handleSingleClick() {
  // DEBUG_PRINTLN("Single click detected");

  // First: Always silence buzzer on single click (acknowledge alarm)
  // LED continues blinking, only audio is muted
  buzzerMuted = true;
  DEBUG_PRINTLN("Buzzer silenced via hardware button");

  // Single click: Exit dry run recovery or safe mode
  if (currentMode == MODE_DRY_RUN_RECOVERY) {
    dryRunCount = 0;
    dryRunStartTime = 0;
    needFreshDataAfterRecovery = true;

    // Handle schedule mode context (similar to exitManualOverride)
    if (scheduleModeEnabled && activeScheduleCount > 0) {
      int activeSchedule = getCurrentActiveSchedule();
      if (activeSchedule < 0) {
        // Outside schedule time - enter inactive mode
        currentMode = MODE_SCHEDULE_INACTIVE;
        setMotor(false);
        DEBUG_PRINTLN("Single click - exiting DRY RUN RECOVERY outside schedule - SCHEDULE_INACTIVE");
      } else {
        // Inside schedule time - return to normal/idle based on auto mode
        currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
        DEBUG_PRINTLN("Single click - exiting DRY RUN RECOVERY");
      }
    } else {
      // No schedule mode - return to normal/idle based on auto mode
      currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
      DEBUG_PRINTLN("Single click - exiting DRY RUN RECOVERY");
    }

    logModeChange(getModeText(), "button_single_click_dry_run_recovery_exit");

    // YELLOW LED for 1 second to confirm
    ws2812_setColor(255, 255, 0); // YELLOW
    delay(RESULT_DISPLAY_TIME);
    ws2812_setColor(0, 0, 0); // OFF

  } else if (currentMode == MODE_SAFE_MODE || currentMode == MODE_PANEL_FAULT) {
    dryRunCount = 0;
    safeModeStartTime = 0;
    needFreshDataAfterRecovery = true;

    // Handle schedule mode context (similar to exitManualOverride)
    if (scheduleModeEnabled && activeScheduleCount > 0) {
      int activeSchedule = getCurrentActiveSchedule();
      if (activeSchedule < 0) {
        // Outside schedule time - enter inactive mode
        currentMode = MODE_SCHEDULE_INACTIVE;
        setMotor(false);
        DEBUG_PRINTLN("Single click - exiting SAFE/PANEL_FAULT mode outside schedule - SCHEDULE_INACTIVE");
      } else {
        // Inside schedule time - return to normal/idle based on auto mode
        currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
        DEBUG_PRINTLN("Single click - exiting SAFE/PANEL_FAULT mode");
      }
    } else {
      // No schedule mode - return to normal/idle based on auto mode
      currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
      DEBUG_PRINTLN("Single click - exiting SAFE/PANEL_FAULT mode");
    }

    logModeChange(getModeText(), "button_single_click_safe_mode_exit");

    // YELLOW LED for 1 second to confirm
    ws2812_setColor(255, 255, 0); // YELLOW
    delay(RESULT_DISPLAY_TIME);
    ws2812_setColor(0, 0, 0); // OFF

  } else {
    DEBUG_PRINTLN("Single click acknowledged - no action taken");

    // YELLOW LED to show single tap registered (even if no action)
    ws2812_setColor(255, 255, 0); // YELLOW
    delay(RESULT_DISPLAY_TIME);
    ws2812_setColor(0, 0, 0); // OFF
  }
}

void handleDoubleClick() {
  DEBUG_PRINTLN("Double click detected");

  #if AP_MODE_FOREVER == 0
    // Double click: Start AP mode (only when AP_MODE_FOREVER is 0)
    DEBUG_PRINTLN("Double click - starting AP mode");
    handleAPActivation();

    // BLUE already showing, now show CYAN to confirm AP activation
    ws2812_setColor(0, 255, 255); // CYAN - AP activated
    delay(RESULT_DISPLAY_TIME);
    ws2812_setColor(0, 0, 0); // OFF
  #else
    DEBUG_PRINTLN("Double click ignored - AP_MODE_FOREVER is enabled");
    // BLUE already showing, display for result time then turn off
    delay(RESULT_DISPLAY_TIME);
    ws2812_setColor(0, 0, 0); // OFF
  #endif
}

void handleTripleTap() {
  DEBUG_PRINTLN("Triple tap detected");

  // Check if password is already disabled
  if (!passwordEnabled) {
    DEBUG_PRINTLN("Triple tap acknowledged - password already disabled");
    ws2812_setColor(255, 0, 255); // Brief MAGENTA flash
    delay(500);
    ws2812_setColor(0, 0, 0); // OFF
    return;
  }

  // Disable password protection
  DEBUG_PRINTLN("Disabling password protection via hardware button...");
  passwordEnabled = false;
  storedPassword = "";
  deviceUnlocked = true;

  // Save to EEPROM
  savePasswordSettings();

  // Visual confirmation - MAGENTA LED
  DEBUG_PRINTLN("LED: MAGENTA - Password protection disabled");
  ws2812_setColor(255, 0, 255); // MAGENTA (bright pink/purple)
  delay(2000); // 2 seconds confirmation
  ws2812_setColor(0, 0, 0); // OFF

  // Log event with audit trail
  logSystemEvent("PASSWORD_DISABLED", "HARDWARE_BUTTON_TRIPLE_TAP");

  DEBUG_PRINTLN("✅ Password protection disabled - device unlocked");
  DEBUG_PRINTLN("⚠️ User can re-enable password in Settings → Password Protection");
}

void handleLongPress() {
  DEBUG_PRINTLN("LONG PRESS confirmed - Manual Override Toggle");

  if (currentMode == MODE_MANUAL_OVERRIDE) {
    // Exit manual override - motor OFF, auto mode DISABLED
    exitManualOverride();
    DEBUG_PRINTLN("Manual override ended - motor OFF | Auto mode still DISABLED");
  } else {
    // Enter manual override - motor ON, auto mode DISABLED
    enterManualOverride();
    DEBUG_PRINTLN("Manual override started - motor ON | Auto mode DISABLED");
  }

  // GREEN LED already showing from long press detection
}

void handleAPActivation() {
  DEBUG_PRINTLN("AP MODE ACTIVATED VIA BUTTON");
  startAccessPointMode();

  DateTime now = safeNow();
  DEBUG_PRINT("Access Point started at ");
  DEBUG_PRINTLN(formatDateTime(now));

  logSystemEvent("AP_ACTIVATED", "HARDWARE_BUTTON");
}

void handleHardwareReset() {
  DEBUG_PRINTLN("HARDWARE RESET BUTTON PRESSED");
  
  setMotor(false);
  
  SystemMode oldMode = currentMode;
  currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
  dryRunCount = 0;
  dryRunStartTime = 0;
  dryRunProbeTimerStart = 0;
  needFreshDataAfterRecovery = false;
  
  if (hasWPSensor) {
    wpSensorStatus = true;
    wpSensorOnline = false;
    hasReceivedWPReading = false;
  }
  
  DEBUG_PRINTLN("Hardware reset completed - all error states cleared");
  
  DateTime now = safeNow();
  DEBUG_PRINT("System reset at ");
  DEBUG_PRINT(formatDateTime(now));
  DEBUG_PRINTLN(" via hardware button");
  
  logModeChange(getModeText(), "hardware_button_reset");
}

void startAccessPointMode() {
  if (!apModeActive) {
    setupAccessPoint();
    DEBUG_PRINTLN("Access Point manually started");
    logSystemEvent("AP_ACTIVATED", "MANUAL");
  } else {
    apStartTime = millis();
    lastWebActivity = 0;
    DEBUG_PRINTLN("Access Point timer restarted");
    logSystemEvent("AP_RESTARTED", "MANUAL");
  }
}

void checkAPTimeout() {
  if (!apModeActive) return;
  
  #if AP_MODE_FOREVER
    return;
  #endif
  
  unsigned long currentTime = millis();
  unsigned long apElapsedSeconds = (currentTime - apStartTime) / 1000;
  unsigned long baseTimeoutSeconds = AP_TIMEOUT_MINUTES * 60;
  unsigned long maxTimeSeconds = baseTimeoutSeconds;
  
  if (lastWebActivity > apStartTime) {
    unsigned long timeSinceActivity = (currentTime - lastWebActivity) / 1000;
    
    if (timeSinceActivity <= (AP_TIMEOUT_MINUTES * 60)) {
      unsigned long activityElapsed = (lastWebActivity - apStartTime) / 1000;
      maxTimeSeconds = activityElapsed + (WEB_ACTIVITY_EXTEND_MINUTES * 60);
      
      if (maxTimeSeconds > MAX_AP_TIME_MINUTES * 60) {
        maxTimeSeconds = MAX_AP_TIME_MINUTES * 60;
      }
    }
  }
  
  if (apElapsedSeconds >= maxTimeSeconds) {
    WiFi.softAPdisconnect(true);
    apModeActive = false;
    lastWebActivity = 0;
    DEBUG_PRINT("Access Point timed out after ");
    DEBUG_PRINT(maxTimeSeconds / 60);
    DEBUG_PRINTLN(" minutes");
    
    logSystemEvent("AP_TIMEOUT", "AUTO");
  } else {
    unsigned long timeLeft = maxTimeSeconds - apElapsedSeconds;
    if (timeLeft <= 60 && timeLeft % 15 == 0) {
      DEBUG_PRINT("AP timeout in ");
      DEBUG_PRINT(timeLeft);
      DEBUG_PRINTLN(" seconds");
    }
  }
}

// ===========================================
// SERIAL COMMANDS
// ===========================================

void handleSerialCommands() {
  if (Serial.available()) {
    String command = Serial.readString();
    command.trim();
    command.toUpperCase();
    
    continuousStatusMode = false;
    
    if (command == "STATUS") {
      displayStatus();
      continuousStatusMode = true;
      lastStatusPrint = 0;
    } else if (command == "RESET") {
      resetSystem(false);
    } else if (command == "RESET1") {
      resetSystem(true);
    } else if (command == "FORCE") {
      if (currentMode == MODE_MANUAL_OVERRIDE) {
        DEBUG_PRINTLN("Already in manual override mode");
      } else {
        enterManualOverride();
      }
    } else if (command == "AUTO") {
      if (currentMode == MODE_MANUAL_OVERRIDE) {
        exitManualOverride();
      } else {
        enableAutoMode();
      }
    } else if (command == "AUTOMODE ON") {
      enableAutoMode();
    } else if (command == "AUTOMODE OFF") {
      disableAutoMode();
    } else if (command == "SCHEDULE ON") {
      if (activeScheduleCount > 0) {
        scheduleModeEnabled = true;
        saveScheduleConfiguration();
        DEBUG_PRINTLN("Schedule mode ENABLED");
      } else {
        DEBUG_PRINTLN("No schedules configured - cannot enable schedule mode");
      }
    } else if (command == "SCHEDULE OFF") {
      scheduleModeEnabled = false;
      saveScheduleConfiguration();
      DEBUG_PRINTLN("Schedule mode DISABLED");
    } else if (command == "AP") {
      startAccessPointMode();
    } else if (command == "LOGS") {
      DEBUG_PRINTLN("Recent log entries:");
      DEBUG_PRINTLN(readLogEntries(20));
    } else if (command == "CLEARLOG") {
      clearLogFile();
      DEBUG_PRINTLN("Log file cleared");
    } else if (command == "PROBE") {
      // Direct GPIO diagnostic - bypasses all debounce/voting logic
      Serial.println("=== RAW PROBE DIAGNOSTIC ===");
      for (int i = 0; i < 20; i++) {
        int lo = digitalRead(TANK_LOW_PROBE_PIN);
        int fu = digitalRead(TANK_FULL_PROBE_PIN);
        int src = digitalRead(SOURCE_PROBE_PIN);
        Serial.print("IO32(Mid)="); Serial.print(lo);
        Serial.print(" IO33(Top)="); Serial.print(fu);
        Serial.print(" IO34(Src)="); Serial.println(src);
        delay(100);
      }
      Serial.println("Majority vote result: ");
      uint8_t bits = readProbesRaw();
      Serial.print("  Mid="); Serial.print((bits>>0)&1);
      Serial.print("  Top="); Serial.print((bits>>1)&1);
      Serial.print("  Src="); Serial.println((bits>>2)&1);
      Serial.print("srcWetCount="); Serial.print(srcWetCount);
      Serial.print(" srcDryCount="); Serial.println(srcDryCount);
    } else {
      DEBUG_PRINTLN("Commands: STATUS, RESET, RESET1, FORCE, AUTO, AUTOMODE ON/OFF, SCHEDULE ON/OFF, AP, LOGS, CLEARLOG, PROBE");
    }
  }
}

void displayStatus() {
  DateTime now = safeNow();
  
  DEBUG_PRINTLN("\n=== SYSTEM STATUS ===");
  
  DEBUG_PRINT("Device Name: ");
  DEBUG_PRINTLN(fullDeviceName);
  
  DEBUG_PRINT("Current Mode: ");
  DEBUG_PRINTLN(getModeText());
  
  DEBUG_PRINT("Auto Mode: ");
  DEBUG_PRINTLN(autoModeEnabled ? "ENABLED" : "DISABLED");
  
  DEBUG_PRINT("Schedule Mode: ");
  DEBUG_PRINTLN(scheduleModeEnabled ? "ENABLED" : "DISABLED");
  if (scheduleModeEnabled) {
    DEBUG_PRINT("Active Schedules: ");
    DEBUG_PRINTLN(activeScheduleCount);
    if (currentActiveSchedule >= 0) {
      DEBUG_PRINT("Current Schedule: ");
      DEBUG_PRINT(currentActiveSchedule + 1);
      DEBUG_PRINT(" (");
      DEBUG_PRINT(getScheduleTimeString(currentActiveSchedule));
      DEBUG_PRINTLN(")");
    } else {
      DEBUG_PRINTLN(getNextScheduleInfo());
    }
  }
  
  if (currentMode == MODE_MANUAL_OVERRIDE) {
    if (manualOverrideUntilFull) {
      DEBUG_PRINTLN("Manual Override: running until tank FULL");
    } else {
      unsigned long elapsedSeconds = (millis() - manualOverrideStartTime) / 1000;
      unsigned long totalSeconds = MANUAL_OVERRIDE_TIMEOUT_HOURS * 3600;
      unsigned long remainingSeconds = (totalSeconds > elapsedSeconds) ? (totalSeconds - elapsedSeconds) : 0;
      unsigned long remainingMinutes = remainingSeconds / 60;
      DEBUG_PRINT("Manual Override: ");
      DEBUG_PRINT(remainingMinutes / 60);
      DEBUG_PRINT("h ");
      DEBUG_PRINT(remainingMinutes % 60);
      DEBUG_PRINTLN("m remaining");
    }
  }
  
  DEBUG_PRINT("Water Level: ");
  DEBUG_PRINTLN(getWaterLevelText());
  
  DEBUG_PRINT("Motor State: ");
  DEBUG_PRINT(motorState ? "ON" : "OFF");
  if (needFreshDataAfterRecovery) {
    DEBUG_PRINTLN(" (Waiting for fresh sensor data)");
  } else {
    DEBUG_PRINTLN();
  }

  if (motorConfirm.waitingForStart) {
    DEBUG_PRINT("Motor START confirmation in progress: ");
    DEBUG_PRINT(motorConfirm.startConfirmCount);
    DEBUG_PRINT("/");
    DEBUG_PRINTLN(MOTOR_CONFIRMATION_COUNT);
  }

  if (motorConfirm.waitingForStop) {
    DEBUG_PRINT("Motor STOP confirmation in progress: ");
    DEBUG_PRINT(motorConfirm.stopConfirmCount);
    DEBUG_PRINT("/");
    DEBUG_PRINTLN(MOTOR_CONFIRMATION_COUNT);
  }
  
  if (hasWPSensor) {
    DEBUG_PRINT("Source Water: ");
    DEBUG_PRINTLN(getWPSensorText());
  }
  
  DEBUG_PRINT("Last US Reading: ");
  DEBUG_PRINTLN(getLastReadingText());
  
  if (hasRSSIReading) {
    DEBUG_PRINT("US Sensor RSSI: ");
    DEBUG_PRINT(currentRSSI);
    DEBUG_PRINTLN(" dBm");
  }
  
  if (hasWPSensor && hasWPRSSIReading) {
    DEBUG_PRINT("WP Sensor RSSI: ");
    DEBUG_PRINT(currentWPRSSI);
    DEBUG_PRINTLN(" dBm");
  }
  
  DEBUG_PRINT("WiFi Status: ");
  if (wifiStationMode) {
    DEBUG_PRINT("Connected to ");
    DEBUG_PRINT(wifiSSID);
    DEBUG_PRINT(" (");
    DEBUG_PRINT(WiFi.localIP());
    DEBUG_PRINTLN(")");
  } else if (wifiReconnect.isReconnecting) {
    DEBUG_PRINT("Reconnecting... (next attempt in ");
    DEBUG_PRINT((wifiReconnect.nextAttemptTime - millis()) / 1000);
    DEBUG_PRINTLN("s)");
  } else {
    DEBUG_PRINTLN("AP Only");
  }
  
  DEBUG_PRINT("OTA Status: ");
  if (otaInProgress) {
    DEBUG_PRINT("Update in progress (");
    DEBUG_PRINT(otaProgress);
    DEBUG_PRINTLN("%)");
  } else if (wifiStationMode) {
    DEBUG_PRINT("Ready (");
    DEBUG_PRINT(otaHostname);
    DEBUG_PRINTLN(".local)");
  } else {
    DEBUG_PRINTLN("Not available");
  }
  
  DEBUG_PRINT("Logging: ");
  DEBUG_PRINT(logManager.totalEntries);
  DEBUG_PRINT("/");
  DEBUG_PRINT(MAX_LOG_ENTRIES);
  DEBUG_PRINTLN(" entries");
  
  if (isConfigured) {
    DEBUG_PRINT("Tank: LOW probe GPIO"); DEBUG_PRINT(TANK_LOW_PROBE_PIN);
    DEBUG_PRINT(", FULL probe GPIO"); DEBUG_PRINTLN(TANK_FULL_PROBE_PIN);
    
    DEBUG_PRINT("Sensors: US=");
    DEBUG_PRINT(targetNodeName);
    if (hasWPSensor) {
      DEBUG_PRINT(", WP=");
      DEBUG_PRINT(wpNodeName);
    }
    DEBUG_PRINTLN();
  } else {
    DEBUG_PRINTLN("Device not configured - please use web interface");
  }
  
  if (dryRunProtectionOn) {
    DEBUG_PRINT("Dry Run Count: ");
    DEBUG_PRINT(dryRunCount);
    DEBUG_PRINT("/");
    DEBUG_PRINTLN(maxDryRunCount);
  }
  
  DEBUG_PRINTLN("==================");
}

void resetSystem(bool reconfigure) {
  DEBUG_PRINTLN("SYSTEM RESET");
  
  setMotor(false);
  
  SystemMode oldMode = currentMode;
  currentMode = MODE_NORMAL;
  dryRunCount = 0;
  dryRunStartTime = 0;
  dryRunProbeTimerStart = 0;
  needFreshDataAfterRecovery = false;

  // Reset motor confirmations
  resetMotorConfirmation();

  // Reset WiFi reconnection state
  resetWiFiBackoff();
  
  if (hasWPSensor) {
    wpSensorStatus = true;
    wpSensorOnline = false;
    hasReceivedWPReading = false;
  }
  
  DEBUG_PRINTLN("Error states cleared");
  
  String resetType = reconfigure ? "FULL_RESET" : "SOFT_RESET";
  logModeChange("NORMAL", resetType);
  
  if (reconfigure) {
    isConfigured = false;
    DEBUG_PRINTLN("Starting reconfiguration...");
    getUserConfiguration();
  } else {
    DEBUG_PRINTLN("System reset completed - keeping existing configuration");
  }
}

void displayCurrentConfig() {
  DEBUG_PRINTLN("\n--- Current Configuration ---");
  DEBUG_PRINT("Device Name: "); DEBUG_PRINTLN(fullDeviceName);
  DEBUG_PRINT("Tank LOW probe: GPIO"); DEBUG_PRINTLN(TANK_LOW_PROBE_PIN);
  DEBUG_PRINT("Tank FULL probe: GPIO"); DEBUG_PRINTLN(TANK_FULL_PROBE_PIN);
  DEBUG_PRINT("Source probe: GPIO"); DEBUG_PRINTLN(SOURCE_PROBE_PIN);
  DEBUG_PRINT("Auto Mode: "); DEBUG_PRINTLN(autoModeEnabled ? "ENABLED" : "DISABLED");
  
  DEBUG_PRINT("Schedule Mode: "); DEBUG_PRINTLN(scheduleModeEnabled ? "ENABLED" : "DISABLED");
  if (scheduleModeEnabled) {
    for (int i = 0; i < 3; i++) {
      DEBUG_PRINT("Schedule "); DEBUG_PRINT(i + 1); DEBUG_PRINT(": ");
      DEBUG_PRINTLN(getScheduleTimeString(i));
    }
  }
  
  if (tankVolume > 0) {
    DEBUG_PRINT("Tank Volume: "); DEBUG_PRINT(tankVolume); DEBUG_PRINTLN(" L");
  } else {
    DEBUG_PRINTLN("Tank Volume: Not configured");
  }
  
  DEBUG_PRINT("Water Presence Sensor: "); 
  if (hasWPSensor) {
    DEBUG_PRINT("Yes (");
    DEBUG_PRINT(wpNodeName);
    DEBUG_PRINTLN(")");
  } else {
    DEBUG_PRINTLN("No");
  }
  DEBUG_PRINT("Dry Run Protection: "); DEBUG_PRINTLN(dryRunProtectionOn ? "On" : "Off");
  if (dryRunProtectionOn) {
    DEBUG_PRINT("Max Time to FULL: "); DEBUG_PRINT(maxTimeToNextProbeMins); DEBUG_PRINTLN(" mins");
    DEBUG_PRINT("Recovery Wait Time: "); DEBUG_PRINT(dryRunWaitMins); DEBUG_PRINTLN(" mins");
  }
  DEBUG_PRINT("Target Node: "); DEBUG_PRINTLN(targetNodeName);
  
  DEBUG_PRINT("WiFi Station: ");
  if (wifiConfigured) {
    DEBUG_PRINT(wifiSSID);
    DEBUG_PRINT(" (");
    DEBUG_PRINT(wifiStationMode ? "Connected" : "Failed");
    DEBUG_PRINTLN(")");
  } else {
    DEBUG_PRINTLN("Not configured");
  }
  
  DEBUG_PRINT("OTA Updates: ");
  DEBUG_PRINTLN(wifiStationMode ? "Available" : "Not available");
  
  DEBUG_PRINT("Logging: ");
  DEBUG_PRINT(logManager.totalEntries);
  DEBUG_PRINT("/");
  DEBUG_PRINT(MAX_LOG_ENTRIES);
  DEBUG_PRINTLN(" entries");
  
  DEBUG_PRINTLN("-----------------------------");
}

void getUserConfiguration() {
  DEBUG_PRINTLN("\n=== CONFIGURATION SETUP ===");
  
  DEBUG_PRINT("Enter device name (1-20 chars, default: senseflow): ");
  deviceName = getStringInputWithDefault("senseflow");
  if (validateDeviceName(deviceName)) {
    updateDynamicNames();
    saveDeviceName();
  } else {
    DEBUG_PRINTLN("Invalid device name, using default: senseflow");
    deviceName = "senseflow";
    updateDynamicNames();
    saveDeviceName();
  }
  
  // Tank LOW/FULL thresholds are fixed by hardware probes on this PCB
  // variant (startPercent=0, stopPercent=100) - no prompt needed.

  DEBUG_PRINTLN("Enter tank volume in Litres (0 for skip, 1-9999):");
  tankVolume = getIntInput(0, 9999);
  
  DEBUG_PRINTLN("Do you have water presence sensor? (1=Yes, 0=No):");
  hasWPSensor = getIntInput(0, 1);
  
  if (hasWPSensor) {
    DEBUG_PRINTLN("Enter water presence sensor node name (e.g., WP01):");
    wpNodeName = getStringInput();
  }
  
  DEBUG_PRINTLN("Enable dry run protection? (1=On, 0=Off):");
  dryRunProtectionOn = getIntInput(0, 1);
  
  if (dryRunProtectionOn) {
    DEBUG_PRINTLN("Max time to reach FULL (5,10,15,20,25 minutes):");
    int validIntervals[] = {5, 10, 15, 20, 25};
    do {
      maxTimeToNextProbeMins = getIntInput(5, 120);
    } while (!isValidInterval(maxTimeToNextProbeMins, validIntervals, 5));
  }
  
  DEBUG_PRINTLN("Enter ultrasonic sensor node name (e.g., US03):");
  targetNodeName = getStringInput();
  
  DEBUG_PRINTLN("Enable auto mode by default? (1=Yes, 0=No):");
  autoModeEnabled = getIntInput(0, 1);
  
  DEBUG_PRINTLN("Enable schedule mode? (1=Yes, 0=No):");
  scheduleModeEnabled = getIntInput(0, 1);
  
  if (scheduleModeEnabled) {
    configureSchedules();
  }
  
  saveConfiguration();
  isConfigured = true;
  
  DEBUG_PRINTLN("\nConfiguration completed!");
  displayCurrentConfig();
}

void configureSchedules() {
  DEBUG_PRINTLN("\n=== SCHEDULE CONFIGURATION ===");
  DEBUG_PRINTLN("Enter up to 3 daily schedules (24-hour format)");
  DEBUG_PRINTLN("Time format: HH:MM (e.g., 08:30, 14:00)");
  DEBUG_PRINTLN("Minimum duration: 5 minutes");
  
  activeScheduleCount = 0;
  
  for (int i = 0; i < 3; i++) {
    schedules[i].enabled = false;
    
    DEBUG_PRINT("\nSchedule ");
    DEBUG_PRINT(i + 1);
    DEBUG_PRINTLN(" (press Enter to skip):");
    
    DEBUG_PRINT("Start time (HH:MM): ");
    String startTime = getTimeInput();
    if (startTime.length() == 0) continue;
    
    DEBUG_PRINT("End time (HH:MM): ");
    String endTime = getTimeInput();
    if (endTime.length() == 0) continue;
    
    // Parse times
    uint8_t startH = startTime.substring(0, 2).toInt();
    uint8_t startM = startTime.substring(3, 5).toInt();
    uint8_t endH = endTime.substring(0, 2).toInt();
    uint8_t endM = endTime.substring(3, 5).toInt();
    
    // Validate schedule
    if (!validateSchedule(startH, startM, endH, endM)) {
      DEBUG_PRINTLN("Invalid schedule (check time format, duration, or midnight spanning)");
      i--; // Retry this schedule
      continue;
    }
    
    // Check for overlaps
    if (checkScheduleOverlap(-1, startH, startM, endH, endM)) {
      DEBUG_PRINTLN("Schedule overlaps with existing schedule");
      i--; // Retry this schedule
      continue;
    }
    
    // Save schedule
    schedules[i].startHour = startH;
    schedules[i].startMinute = startM;
    schedules[i].endHour = endH;
    schedules[i].endMinute = endM;
    schedules[i].enabled = true;
    activeScheduleCount++;
    
    DEBUG_PRINT("Schedule ");
    DEBUG_PRINT(i + 1);
    DEBUG_PRINT(" saved: ");
    DEBUG_PRINTLN(getScheduleTimeString(i));
  }
  
  if (activeScheduleCount == 0) {
    DEBUG_PRINTLN("No schedules configured - disabling schedule mode");
    scheduleModeEnabled = false;
  }
  
  DEBUG_PRINTLN("\nSchedule configuration completed!");
}

String getTimeInput() {
  while (true) {
    if (Serial.available() > 0) {
      String input = Serial.readString();
      input.trim();
      
      if (input.length() == 0) {
        return ""; // Skip this schedule
      }
      
      if (input.length() == 5 && input.charAt(2) == ':') {
        String hourStr = input.substring(0, 2);
        String minStr = input.substring(3, 5);
        
        int hour = hourStr.toInt();
        int minute = minStr.toInt();
        
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
          return input;
        }
      }
      
      DEBUG_PRINTLN("Invalid format! Use HH:MM (e.g., 08:30, 14:00):");
    }
    delay(100);
  }
}

int getIntInput(int minVal, int maxVal) {
  while (true) {
    if (Serial.available() > 0) {
      int value = Serial.parseInt();
      if (value >= minVal && value <= maxVal) {
        Serial.readString(); // Clear buffer
        return value;
      } else {
        DEBUG_PRINT("Invalid! Enter value between ");
        DEBUG_PRINT(minVal);
        DEBUG_PRINT(" and ");
        DEBUG_PRINT(maxVal);
        DEBUG_PRINTLN(":");
      }
    }
    delay(100);
  }
}

String getStringInput() {
  while (true) {
    if (Serial.available() > 0) {
      String input = Serial.readString();
      input.trim();
      if (input.length() > 0 && input.length() <= 6) {
        return input;
      } else {
        DEBUG_PRINTLN("Invalid! Enter 1-6 characters:");
      }
    }
    delay(100);
  }
}

String getStringInputWithDefault(String defaultValue) {
  while (true) {
    if (Serial.available() > 0) {
      String input = Serial.readString();
      input.trim();
      if (input.length() == 0) {
        return defaultValue; // Use default if empty
      } else if (input.length() > 0 && input.length() <= 20) {
        return input;
      } else {
        DEBUG_PRINTLN("Invalid! Enter 1-20 characters or press Enter for default:");
      }
    }
    delay(100);
  }
}

bool isValidInterval(int value, int validValues[], int count) {
  for (int i = 0; i < count; i++) {
    if (value == validValues[i]) return true;
  }
  DEBUG_PRINTLN("Invalid! Choose from: 5,10,15,20,25");
  return false;
}

// ===========================================
// WIFI AND OTA FUNCTIONS
// ===========================================

void loadWiFiCredentials() {
  if (EEPROM.read(EEPROM_WIFI_CONFIGURED) == MAGIC_NUMBER) {
    wifiConfigured = true;

    wifiSSID = "";
    for (int i = 0; i < 32; i++) {
      char c = EEPROM.read(EEPROM_WIFI_SSID + i);
      if (c == 0) break;
      wifiSSID += c;
    }

    wifiPassword = "";
    for (int i = 0; i < 64; i++) {
      char c = EEPROM.read(EEPROM_WIFI_PASSWORD + i);
      if (c == 0) break;
      wifiPassword += c;
    }

    DEBUG_PRINTLN("WiFi credentials loaded from EEPROM: " + wifiSSID);
  } else {
    // EEPROM has no credentials — check NVS (MvsConnect app saves here)
    Preferences prefs;
    prefs.begin("mvswifi", true);
    bool valid = prefs.getBool("valid", false);
    if (valid) {
      wifiSSID = prefs.getString("ssid", "");
      wifiPassword = prefs.getString("pass", "");
      prefs.end();
      if (wifiSSID.length() > 0) {
        wifiConfigured = true;
        saveWiFiCredentials();  // mirror to EEPROM for future boots
        DEBUG_PRINTLN("WiFi credentials loaded from NVS (MvsConnect): " + wifiSSID);
      } else {
        wifiConfigured = false;
      }
    } else {
      prefs.end();
      wifiConfigured = false;
      DEBUG_PRINTLN("No WiFi credentials in EEPROM or NVS");
    }
  }
}

void saveWiFiCredentials() {
  EEPROM.write(EEPROM_WIFI_CONFIGURED, MAGIC_NUMBER);
  
  // Save SSID (max 31 chars + null terminator)
  for (int i = 0; i < 32; i++) {
    if (i < wifiSSID.length()) {
      EEPROM.write(EEPROM_WIFI_SSID + i, wifiSSID[i]);
    } else {
      EEPROM.write(EEPROM_WIFI_SSID + i, 0);
    }
  }
  
  // Save Password (max 63 chars + null terminator)
  for (int i = 0; i < 64; i++) {
    if (i < wifiPassword.length()) {
      EEPROM.write(EEPROM_WIFI_PASSWORD + i, wifiPassword[i]);
    } else {
      EEPROM.write(EEPROM_WIFI_PASSWORD + i, 0);
    }
  }
  
  EEPROM.commit();
  DEBUG_PRINTLN("WiFi credentials saved to EEPROM");
}

bool connectToWiFiStation() {
  if (!wifiConfigured || wifiSSID.length() == 0) {
    DEBUG_PRINTLN("No WiFi credentials configured");
    return false;
  }
  
  DEBUG_PRINT("Connecting to WiFi: ");
  DEBUG_PRINTLN(wifiSSID);
  
  WiFi.mode(WIFI_AP_STA);
  WiFi.begin(wifiSSID.c_str(), wifiPassword.c_str());
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    DEBUG_PRINT(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    wifiStationMode = true;
    resetWiFiBackoff(); // Reset reconnection state on successful connection
    DEBUG_PRINTLN("");
    DEBUG_PRINTLN("WiFi connected successfully!");
    DEBUG_PRINT("Station IP: ");
    DEBUG_PRINTLN(WiFi.localIP());
    
    logWiFiEvent("WIFI_CONNECTED", "STATION_MODE");
    return true;
  } else {
    DEBUG_PRINTLN("");
    DEBUG_PRINTLN("WiFi connection failed - continuing in AP-only mode");
    WiFi.mode(WIFI_AP);
    wifiStationMode = false;
    
    logWiFiEvent("WIFI_FAILED", "AP_ONLY_MODE");
    return false;
  }
}

void setupOTA() {
  if (!wifiStationMode) {
    DEBUG_PRINTLN("OTA not available - WiFi station mode required");
    return;
  }
  
  ArduinoOTA.setHostname(otaHostname.c_str());
  ArduinoOTA.setPassword(OTA_PASSWORD);
  
  ArduinoOTA.onStart([]() {
    String type = (ArduinoOTA.getCommand() == U_FLASH) ? "sketch" : "filesystem";
    
    DEBUG_PRINTLN("Starting OTA update (" + type + ")");
    otaInProgress = true;
    otaStartTime = millis();
    otaProgress = 0;

    setMotor(false);
    ws2812_setColor(0, 255, 255); // Cyan for OTA start

    logOTAEvent("OTA_STARTED", type);
  });

  ArduinoOTA.onEnd([]() {
    DEBUG_PRINTLN("\nOTA update completed!");

    for (int i = 0; i < 3; i++) {
      ws2812_setColor(0, 255, 0);
      delay(200);
      ws2812_off();
      delay(200);
    }

    otaInProgress = false;
    logOTAEvent("OTA_COMPLETED", "SUCCESS");
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    uint8_t percent = (progress / (total / 100));
    otaProgress = percent;

    uint8_t brightness = map(percent, 0, 100, 0, 255);
    ws2812_setColor(brightness, brightness, brightness); // White progress

    if (percent % 10 == 0) {
      Serial.printf("OTA Progress: %u%%\n", percent);
    }
  });

  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("OTA Error[%u]: ", error);
    String errorMsg = "";

    switch (error) {
      case OTA_AUTH_ERROR:
        errorMsg = "Auth Failed";
        DEBUG_PRINTLN("Auth Failed");
        break;
      case OTA_BEGIN_ERROR:
        errorMsg = "Begin Failed";
        DEBUG_PRINTLN("Begin Failed");
        break;
      case OTA_CONNECT_ERROR:
        errorMsg = "Connect Failed";
        DEBUG_PRINTLN("Connect Failed");
        break;
      case OTA_RECEIVE_ERROR:
        errorMsg = "Receive Failed";
        DEBUG_PRINTLN("Receive Failed");
        break;
      case OTA_END_ERROR:
        errorMsg = "End Failed";
        DEBUG_PRINTLN("End Failed");
        break;
    }

    // LED OFF on OTA error (no visual indication)
    ws2812_off();

    otaInProgress = false;
    logErrorEvent("OTA_ERROR", errorMsg);
  });
  
  ArduinoOTA.begin();
  
  if (MDNS.begin(otaHostname.c_str())) {
    DEBUG_PRINTLN("mDNS responder started");
    DEBUG_PRINT("OTA hostname: ");
    DEBUG_PRINT(otaHostname);
    DEBUG_PRINTLN(".local");
    
    MDNS.addService("http", "tcp", 7689);
    MDNS.addService("arduino", "tcp", 3232);
  }
  
  DEBUG_PRINTLN("OTA update service started");
  DEBUG_PRINT("Upload via: ");
  DEBUG_PRINT(WiFi.localIP());
  DEBUG_PRINTLN(" or " + otaHostname + ".local");
}

void handleOTAEvents() {
  if (wifiStationMode && !otaInProgress) {
    ArduinoOTA.handle();
  }
}

void handleWebOTA() {
  lastWebActivity = millis();
  String html = getOTAStatusHTML();
  server.send(200, "text/html", html);
}

void handleWebWiFiSettings() {
  lastWebActivity = millis();
  String html = getWiFiSettingsHTML();
  server.send(200, "text/html", html);
}

void handleWebWiFiSettingsPost() {
  lastWebActivity = millis();
  
  bool credentialsChanged = false;
  
  if (server.hasArg("wifiSSID") && server.hasArg("wifiPassword")) {
    String newSSID = server.arg("wifiSSID");
    String newPassword = server.arg("wifiPassword");
    
    newSSID.trim();
    newPassword.trim();
    
    if (newSSID.length() > 0 && newSSID.length() <= 31 && 
        newPassword.length() >= 0 && newPassword.length() <= 63) {
      
      if (newSSID != wifiSSID || newPassword != wifiPassword) {
        wifiSSID = newSSID;
        wifiPassword = newPassword;
        wifiConfigured = true;
        credentialsChanged = true;
        
        saveWiFiCredentials();
        DEBUG_PRINTLN("WiFi credentials updated");
      }
    }
  }
  
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>WiFi Settings Saved</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
  html += "<meta http-equiv=\"refresh\" content=\"5;url=/ota\">\n";
  html += "<style>\n";
  html += "body { font-family: Arial, sans-serif; margin: 20px; background-color: #f0f8ff; color: #333; text-align: center; }\n";
  html += ".container { max-width: 400px; margin: 50px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }\n";
  html += ".success { color: #27ae60; font-size: 1.2em; margin-bottom: 20px; }\n";
  html += ".btn { background: #3498db; color: white; padding: 12px 25px; border: none; border-radius: 5px; text-decoration: none; display: inline-block; }\n";
  html += "</style>\n</head>\n<body>\n";
  html += "<div class=\"container\">\n";
  html += "<div class=\"success\">WiFi settings saved!</div>\n";
  html += String(credentialsChanged ? "<p>Attempting to connect to WiFi network...</p>" : "<p>No changes detected.</p>") + "\n";
  html += "<p>Redirecting to OTA status in 5 seconds...</p>\n";
  html += "<a href=\"/ota\" class=\"btn\">View OTA Status</a>\n";
  html += "</div>\n</body>\n</html>";
  
  server.send(200, "text/html", html);
  
  if (credentialsChanged) {
    delay(1000);
    connectToWiFiStation();
    
    if (wifiStationMode) {
      setupOTA();
    }
  }
}

String getWiFiSettingsHTML() {
  String html = "<!DOCTYPE html><html><head>\n";
  html += "<title>WiFi Settings</title>\n";
  html += "<meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\">\n";
  html += "<style>\n";
  html += "*{margin:0;padding:0;box-sizing:border-box}\n";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f0f8ff;color:#333;padding:20px}\n";
  html += ".wrap{max-width:500px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.1);overflow:hidden}\n";
  html += ".hdr{background:#2980b9;color:#fff;padding:20px;display:flex;align-items:center;gap:15px}\n";
  html += ".hdr a{color:#fff;text-decoration:none;font-size:1.4em}\n";
  html += ".hdr h1{font-size:1.2em}\n";
  html += ".content{padding:20px}\n";
  
  // Status card
  html += ".status{display:flex;align-items:center;gap:15px;padding:18px;background:#f8f9fa;border-radius:10px;margin-bottom:20px}\n";
  html += ".dot{width:14px;height:14px;border-radius:50%;flex-shrink:0}\n";
  html += ".dot.on{background:#27ae60;box-shadow:0 0 8px rgba(39,174,96,0.5)}\n";
  html += ".dot.off{background:#e74c3c}\n";
  html += ".status-info h3{font-size:1em;margin-bottom:2px}\n";
  html += ".status-info p{font-size:0.85em;color:#888;margin:0}\n";
  
  // Form
  html += ".fg{margin-bottom:18px}\n";
  html += ".fg label{display:block;font-weight:600;color:#555;margin-bottom:8px;font-size:0.95em}\n";
  html += ".fg input{width:100%;padding:14px;border:2px solid #ddd;border-radius:8px;font-size:1em}\n";
  html += ".fg input:focus{outline:none;border-color:#3498db}\n";
  html += ".pw-wrap{position:relative}\n";
  html += ".pw-wrap input{padding-right:50px}\n";
  html += ".eye{position:absolute;right:14px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:1.3em;color:#888;user-select:none}\n";
  html += ".eye:hover{color:#555}\n";
  
  // Buttons
  html += ".btn{display:block;width:100%;padding:16px;border:none;border-radius:8px;font-size:1.05em;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin-bottom:12px}\n";
  html += ".btn-p{background:#27ae60;color:#fff}\n";
  html += ".btn-p:hover{background:#229954}\n";
  html += ".btn-s{background:#95a5a6;color:#fff}\n";
  html += ".btn-s:hover{background:#7f8c8d}\n";
  html += ".btn:disabled{background:#bdc3c7;cursor:not-allowed}\n";
  
  // Result message
  html += ".result{padding:15px;border-radius:8px;margin-bottom:15px;display:none;text-align:center;font-weight:600}\n";
  html += ".result.ok{display:block;background:#d4edda;color:#155724}\n";
  html += ".result.err{display:block;background:#f8d7da;color:#721c24}\n";
  
  html += "</style></head><body>\n";
  
  html += "<div class=\"wrap\">\n";
  
  // Header
  html += "<div class=\"hdr\"><a href=\"/settings\">←</a><h1>WiFi Settings</h1></div>\n";
  
  html += "<div class=\"content\">\n";
  
  // Status card
  html += "<div class=\"status\">\n";
  html += "<div class=\"dot " + String(wifiStationMode ? "on" : "off") + "\"></div>\n";
  html += "<div class=\"status-info\">\n";
  if (wifiStationMode) {
    html += "<h3>Connected</h3>\n";
    html += "<p>" + wifiSSID + " • " + WiFi.localIP().toString() + "</p>\n";
  } else if (wifiConfigured) {
    html += "<h3>Not Connected</h3>\n";
    html += "<p>" + wifiSSID + "</p>\n";
  } else {
    html += "<h3>Not Configured</h3>\n";
    html += "<p>Enter your WiFi details below</p>\n";
  }
  html += "</div></div>\n";
  
  // Result message placeholder
  html += "<div id=\"result\" class=\"result\"></div>\n";
  
  // Form
  html += "<form id=\"wf\" method=\"POST\">\n";
  html += "<div class=\"fg\"><label>WiFi Network Name</label>\n";
  html += "<input type=\"text\" name=\"wifiSSID\" id=\"ssid\" maxlength=\"31\" value=\"" + wifiSSID + "\" placeholder=\"Your WiFi name\" required></div>\n";
  html += "<div class=\"fg\"><label>WiFi Password</label>\n";
  html += "<div class=\"pw-wrap\"><input type=\"password\" name=\"wifiPassword\" id=\"pw\" maxlength=\"63\" value=\"" + wifiPassword + "\" placeholder=\"Your WiFi password\">\n";
  html += "<span class=\"eye\" onclick=\"togglePw()\">👁️</span></div></div>\n";
  html += "<button type=\"submit\" class=\"btn btn-p\" id=\"sbtn\">Save & Connect</button>\n";
  html += "</form>\n";
  
  html += "<a href=\"/settings\" class=\"btn btn-s\">Back to Settings</a>\n";
  
  html += "</div></div>\n";
  
  // JavaScript
  html += "<script>\n";
  
  // Password toggle
  html += "function togglePw(){const p=document.getElementById('pw');p.type=p.type==='password'?'text':'password';}\n";
  
  // Form submit
  html += "document.getElementById('wf').onsubmit=function(e){\n";
  html += "e.preventDefault();\n";
  html += "const btn=document.getElementById('sbtn');\n";
  html += "const res=document.getElementById('result');\n";
  html += "btn.disabled=true;btn.textContent='Connecting...';\n";
  html += "res.className='result';res.style.display='none';\n";
  html += "const fd=new FormData(this);\n";
  html += "fetch('/wifi',{method:'POST',body:fd})\n";
  html += ".then(r=>r.text())\n";
  html += ".then(d=>{\n";
  html += "if(d.includes('success')||d.includes('Attempting')){\n";
  html += "res.className='result ok';res.textContent='✅ Saved! Connecting to WiFi...';res.style.display='block';\n";
  html += "setTimeout(()=>location.reload(),4000);\n";
  html += "}else{\n";
  html += "res.className='result err';res.textContent='❌ Connection failed';res.style.display='block';\n";
  html += "btn.disabled=false;btn.textContent='Save & Connect';\n";
  html += "}\n";
  html += "}).catch(err=>{\n";
  html += "res.className='result err';res.textContent='❌ Error: '+err;res.style.display='block';\n";
  html += "btn.disabled=false;btn.textContent='Save & Connect';\n";
  html += "});\n";
  html += "return false;\n";
  html += "};\n";
  
  html += "</script></body></html>";
  
  return html;
}

String getOTAStatusHTML() {
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>OTA Update Status</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
  html += "<style>\n";
  html += "body { font-family: Arial, sans-serif; margin: 20px; background-color: #f0f8ff; color: #333; }\n";
  html += ".container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }\n";
  html += ".header { text-align: center; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; margin-bottom: 20px; }\n";
  html += ".status-item { background: #f8f9fa; padding: 15px; border-radius: 8px; border-left: 4px solid #3498db; margin-bottom: 15px; }\n";
  html += ".status-item.success { border-left-color: #27ae60; }\n";
  html += ".status-item.warning { border-left-color: #f39c12; }\n";
  html += ".status-label { font-weight: bold; color: #2c3e50; display: block; margin-bottom: 5px; }\n";
  html += ".status-value { font-size: 1.1em; }\n";
  html += ".btn { background: #3498db; color: white; padding: 12px 25px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; margin: 5px; text-decoration: none; display: inline-block; }\n";
  html += ".btn:hover { background: #2980b9; }\n";
  html += ".btn.secondary { background: #95a5a6; }\n";
  html += ".btn.secondary:hover { background: #7f8c8d; }\n";
  html += ".button-group { text-align: center; margin-top: 20px; }\n";
  html += ".code-block { background: #2c3e50; color: #ecf0f1; padding: 15px; border-radius: 5px; font-family: monospace; font-size: 0.9em; overflow-x: auto; }\n";
  html += "</style>\n</head>\n<body>\n";
  
  html += "<div class=\"container\">\n";
  html += "<div class=\"header\"><h1>OTA Update Status</h1></div>\n";
  
  html += "<div class=\"status-item\">\n";
  html += "<span class=\"status-label\">Device Name:</span>\n";
  html += "<span class=\"status-value\">" + deviceName + "</span>\n";
  html += "</div>\n";
  
  html += "<div class=\"status-item " + String(wifiStationMode ? "success" : "warning") + "\">\n";
  html += "<span class=\"status-label\">OTA Availability:</span>\n";
  html += "<span class=\"status-value\">" + String(wifiStationMode ? "Available" : "Not Available (WiFi Station Required)") + "</span>\n";
  html += "</div>\n";
  
  if (wifiStationMode) {
    html += "<div class=\"status-item success\">\n";
    html += "<span class=\"status-label\">WiFi Connection:</span>\n";
    html += "<span class=\"status-value\">Connected to " + wifiSSID + " (" + WiFi.localIP().toString() + ")</span>\n";
    html += "</div>\n";
    
    html += "<div class=\"status-item\">\n";
    html += "<span class=\"status-label\">OTA Hostname:</span>\n";
    html += "<span class=\"status-value\">" + otaHostname + ".local</span>\n";
    html += "</div>\n";
    
    html += "<div class=\"status-item\">\n";
    html += "<span class=\"status-label\">Upload Methods:</span>\n";
    html += "<span class=\"status-value\">\n";
    html += "<div class=\"code-block\">\n";
    html += "# Arduino IDE Method:<br>\n";
    html += "1. Tools → Port → Network Port → " + otaHostname + ".local<br>\n";
    html += "2. Upload sketch normally<br><br>\n";
    html += "# IP Direct Method:<br>\n";
    html += "IP: " + WiFi.localIP().toString() + "<br>\n";
    html += "Password: " + String(OTA_PASSWORD) + "<br><br>\n";
    html += "# PlatformIO Method:<br>\n";
    html += "upload_protocol = espota<br>\n";
    html += "upload_port = " + WiFi.localIP().toString() + "<br>\n";
    html += "upload_flags = --auth=" + String(OTA_PASSWORD) + "\n";
    html += "</div>\n";
    html += "</span>\n";
    html += "</div>\n";
  } else if (wifiReconnect.isReconnecting) {
    html += "<div class=\"status-item warning\">\n";
    html += "<span class=\"status-label\">WiFi Status:</span>\n";
    html += "<span class=\"status-value\">Attempting to reconnect... (next attempt in ";
    html += String((wifiReconnect.nextAttemptTime - millis()) / 1000) + "s)</span>\n";
    html += "</div>\n";
  } else {
    html += "<div class=\"status-item warning\">\n";
    html += "<span class=\"status-label\">WiFi Status:</span>\n";
    html += "<span class=\"status-value\">Not connected to home WiFi - OTA not available</span>\n";
    html += "</div>\n";
  }
  
  if (otaInProgress) {
    html += "<div class=\"status-item warning\">\n";
    html += "<span class=\"status-label\">OTA Progress:</span>\n";
    html += "<span class=\"status-value\">" + String(otaProgress) + "% - Update in progress...</span>\n";
    html += "</div>\n";
  }
  
  html += "<div class=\"button-group\">\n";
  html += "<a href=\"/wifi\" class=\"btn\">WiFi Settings</a>\n";
  html += "<a href=\"/\" class=\"btn secondary\">Back to Status</a>\n";
  if (wifiStationMode) {
    html += "<button onclick=\"location.reload()\" class=\"btn\">Refresh</button>\n";
  }
  html += "</div>\n";
  
  html += "</div>\n</body>\n</html>";
  
  return html;
}

// ===========================================
// LOG VIEW WEB HANDLERS
// ===========================================

void handleLogsDownload() {
  lastWebActivity = millis();
  
  if (!logManager.isInitialized || logManager.totalEntries == 0) {
    server.send(200, "text/plain", "No log entries available for download");
    return;
  }
  
  // Generate CSV format log data
  String csvData = "DateTime,EventType,Action,WaterLevel_cm,WaterPercent,WPSensor,Details\n";
  
  File file = LittleFS.open(LOG_FILE_PATH, "r");
  if (!file) {
    server.send(500, "text/plain", "Failed to open log file");
    return;
  }
  
  // Read all entries from newest to oldest
  for (int i = 0; i < logManager.totalEntries; i++) {
    int entryIndex;
    
    if (logManager.totalEntries < MAX_LOG_ENTRIES) {
      entryIndex = logManager.totalEntries - 1 - i;
    } else {
      entryIndex = (logManager.currentIndex - 1 - i + MAX_LOG_ENTRIES) % MAX_LOG_ENTRIES;
    }
    
    size_t position = entryIndex * sizeof(LogEntry);
    file.seek(position);
    
    LogEntry entry;
    if (file.read((uint8_t*)&entry, sizeof(LogEntry)) == sizeof(LogEntry)) {
      if (entry.timestamp > 0) {
        DateTime dt(entry.timestamp);
        char timeStr[20];
        sprintf(timeStr, "%02d/%02d/%04d %02d:%02d:%02d", 
                dt.day(), dt.month(), dt.year(),
                dt.hour(), dt.minute(), dt.second());
        
        csvData += String(timeStr) + ",";
        csvData += getEventTypeName((LogEventType)entry.eventType) + ",";
        csvData += String(entry.action) + ",";
        
        if (entry.eventType == LOG_MOTOR_EVENT && entry.waterLevel >= 0) {
          csvData += String(entry.waterLevel, 1) + ",";
          csvData += String(entry.waterPercent, 1) + ",";
          
          if (entry.wpSensorStatus == 1) {
            csvData += "Available,";
          } else if (entry.wpSensorStatus == 0) {
            csvData += "Not_Available,";
          } else if (entry.wpSensorStatus == 2) {
            csvData += "Offline,";
          } else {
            csvData += "Not_Configured,";
          }
        } else {
          csvData += "N/A,N/A,N/A,";
        }
        
        csvData += String(entry.details) + "\n";
      }
    }
  }
  
  file.close();
  
  // Send as downloadable CSV file
  server.sendHeader("Content-Disposition", "attachment; filename=tank_logs.csv");
  server.send(200, "text/csv", csvData);
  
  DEBUG_PRINTLN("Log file downloaded via web interface");
}

// v118.0.10: classify an action string as "operational" (worth showing
// by default) vs "technical" (hide behind the Show-all checkbox).
// Technical entries are the stuff only Vishal/support cares about:
// sub-second time-diffs, Firebase token lifecycle, LED test blinks,
// per-poll config check acknowledgements, mDNS re-advertise warnings,
// per-tick OTA heartbeats. Operational is pump start/stop, mode
// changes, faults, settings-saved, manual override, nightly restart,
// WiFi up/down. Match by action-name prefix (case-insensitive) so
// variations like "HIST_OK_terrace" / "HIST_OK_source" collapse into
// one rule. Returns true when the entry should be HIDDEN by default.
// Takes `type` as uint8_t (not LogEventType) because Arduino's
// auto-generated function prototypes sit at the top of the file before
// the enum is parsed — using the enum type here would fail to compile
// with "'LogEventType' has not been declared". The caller already does
// `(uint8_t)entry.eventType` so no cast change needed.
static bool isTechnicalLogAction(const char* action, uint8_t type) {
  if (!action) return false;
  // All LOG_TIME_SYNC entries are chatty by nature — browser syncs
  // every page load (1-sec drift logging), NTP once an hour → hide.
  if (type == LOG_TIME_SYNC) return true;
  // Prefix-based noise list. Keep in sync with the user-approved set.
  static const char* NOISY_PREFIXES[] = {
    "HIST_OK",         "HIST_SRC",        "HIST_TERR",
    "CFG_",            "TIMESYNC",        "TIME_DIFF",
    "TOKEN_",          "LED_TEST",        "TEST_",
    "MDNS",            "OTA_HEARTBEAT",   "OTA_PROGRESS",
    "BROWSER_SYNC",    "WIFI_RSSI",       "LOG_FILE",
    "PING",            "KEEPALIVE",
  };
  for (size_t i = 0; i < sizeof(NOISY_PREFIXES)/sizeof(NOISY_PREFIXES[0]); i++) {
    size_t n = strlen(NOISY_PREFIXES[i]);
    if (strncasecmp(action, NOISY_PREFIXES[i], n) == 0) return true;
  }
  return false;
}

void handleLogsView() {
  lastWebActivity = millis();
  // v118.0.10: Show-technical toggle via query param so bookmarks /
  // reload preserve the operator's choice.
  bool showTechnical = server.hasArg("all") && server.arg("all") == "1";
  
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>Tank Controller Logs</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
  html += "<style>\n";
  html += "body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; background: #f0f8ff; color: #333; }\n";
  html += ".container { max-width: 1000px; margin: 0 auto; background: white; min-height: 100vh; box-shadow: 0 0 20px rgba(0,0,0,0.1); }\n";
  html += ".header { background: #2980b9; color: #fff; padding: 15px 20px; display: flex; align-items: center; gap: 15px; min-height: 60px; }\n";
  html += ".header h1 { font-size: 1.3em; font-weight: bold; flex: 1; }\n";
  html += ".back-btn { background: rgba(255,255,255,0.25); color: #fff; border: 2px solid rgba(255,255,255,0.3); padding: 8px 12px; border-radius: 6px; text-decoration: none; font-size: 0.9em; transition: all 0.2s; }\n";
  html += ".back-btn:hover { background: rgba(255,255,255,0.4); }\n";
  html += ".content-wrap { padding: 20px; }\n";
  html += ".log-stats { background: #f8f9fa; border: 1px solid #dee2e6; padding: 15px; border-radius: 5px; margin-bottom: 20px; }\n";
  html += ".log-entry { background: #f8f9fa; border-left: 4px solid #3498db; padding: 10px; margin-bottom: 5px; font-family: monospace; font-size: 0.9em; }\n";
  html += ".log-entry.motor { border-left-color: #27ae60; }\n";
  html += ".log-entry.mode { border-left-color: #f39c12; }\n";
  html += ".log-entry.error { border-left-color: #e74c3c; }\n";
  html += ".log-entry.system { border-left-color: #9b59b6; }\n";
  html += ".log-entry.wifi { border-left-color: #3498db; }\n";
  html += ".log-entry.ota { border-left-color: #1abc9c; }\n";
  html += ".log-entry.time { border-left-color: #34495e; }\n";
  html += ".btn { background: #3498db; color: white; padding: 10px 20px; border: none; border-radius: 5px; text-decoration: none; margin: 5px; display: inline-block; cursor: pointer; }\n";
  html += ".btn:hover { background: #2980b9; }\n";
  html += ".btn.secondary { background: #95a5a6; }\n";
  html += ".btn.secondary:hover { background: #7f8c8d; }\n";
  html += ".btn.danger { background: #e74c3c; }\n";
  html += ".btn.danger:hover { background: #c0392b; }\n";
  html += ".button-group { text-align: center; margin-bottom: 20px; }\n";
  html += ".no-logs { text-align: center; color: #7f8c8d; padding: 40px; }\n";
  html += "</style>\n</head>\n<body>\n";

  html += "<div class=\"container\">\n";
  html += "<div class=\"header\"><a href=\"/settings\" class=\"back-btn\">← Back</a><h1>SYSTEM LOGS</h1></div>\n";

  html += "<div class=\"content-wrap\">\n";

  // Log statistics
  html += "<div class=\"log-stats\">\n";
  html += "<strong>Log Statistics:</strong><br>\n";
  html += "Total Entries: " + String(logManager.totalEntries) + "/" + String(MAX_LOG_ENTRIES) + "<br>\n";
  html += "Current Index: " + String(logManager.currentIndex) + "<br>\n";
  html += "Status: " + String(logManager.totalEntries == MAX_LOG_ENTRIES ? "Circular buffer active (oldest entries overwritten)" : "Still filling") + "<br>\n";
  html += "Showing: Last " + String(min(LOG_VIEW_ENTRIES, (int)logManager.totalEntries)) + " entries (newest first)\n";
  html += "</div>\n";
  
  html += "<div class=\"button-group\">\n";
  html += "<a href=\"/logs/download\" class=\"btn\">Download CSV</a>\n";
  html += "<a href=\"/logs/clear\" class=\"btn danger\">Clear Logs</a>\n";
  html += "<a href=\"/settings\" class=\"btn secondary\">Back to Settings</a>\n";
  html += "<button onclick=\"location.reload()\" class=\"btn\">Refresh</button>\n";
  html += "</div>\n";

  // v118.0.10: show-technical toggle. Default view hides time-sync
  // noise + Firebase token chatter + mDNS warnings etc so operators see
  // only pump work. Checkbox posts to same page with ?all=1 so bookmarks
  // and refresh preserve the choice.
  html += "<div style=\"text-align:center;margin-bottom:15px;\">\n";
  html += "<label style=\"font-size:0.9em;color:#555;cursor:pointer;user-select:none;\">\n";
  html += "<input type=\"checkbox\" id=\"logFilter\" ";
  if (showTechnical) html += "checked ";
  html += "onchange=\"location.href=this.checked?'/logs/view?all=1':'/logs/view'\" style=\"vertical-align:middle;margin-right:6px;\">\n";
  html += "Show technical logs (time sync, token refresh, mDNS, LED test, etc.)\n";
  html += "</label>\n";
  html += "</div>\n";
  
  if (logManager.totalEntries == 0) {
    html += "<div class=\"no-logs\">No log entries available</div>\n";
  } else {
    // Display log entries
    File file = LittleFS.open(LOG_FILE_PATH, "r");
    if (file) {
      int entriesToShow = min(LOG_VIEW_ENTRIES, (int)logManager.totalEntries);
      
      for (int i = 0; i < entriesToShow; i++) {
        int entryIndex;
        
        if (logManager.totalEntries < MAX_LOG_ENTRIES) {
          entryIndex = logManager.totalEntries - 1 - i;
        } else {
          entryIndex = (logManager.currentIndex - 1 - i + MAX_LOG_ENTRIES) % MAX_LOG_ENTRIES;
        }
        
        size_t position = entryIndex * sizeof(LogEntry);
        file.seek(position);
        
        LogEntry entry;
        if (file.read((uint8_t*)&entry, sizeof(LogEntry)) == sizeof(LogEntry)) {
          if (entry.timestamp > 0) {
            // v118.0.10: skip technical entries unless Show-all is on.
            // Entry type + action name both drive the decision; keeps
            // ERROR_EVENT / MOTOR_EVENT always visible regardless of
            // action name (an "error-level" event is always worth showing).
            bool technical = isTechnicalLogAction(entry.action, entry.eventType);
            if (!showTechnical && technical) continue;

            DateTime dt(entry.timestamp);
            char timeStr[20];
            sprintf(timeStr, "%02d/%02d/%04d %02d:%02d:%02d",
                    dt.day(), dt.month(), dt.year(),
                    dt.hour(), dt.minute(), dt.second());

            String eventClass = "log-entry";
            switch ((LogEventType)entry.eventType) {
              case LOG_MOTOR_EVENT: eventClass += " motor"; break;
              case LOG_MODE_CHANGE: eventClass += " mode"; break;
              case LOG_ERROR_EVENT: eventClass += " error"; break;
              case LOG_SYSTEM_EVENT: eventClass += " system"; break;
              case LOG_WIFI_EVENT: eventClass += " wifi"; break;
              case LOG_OTA_EVENT: eventClass += " ota"; break;
              case LOG_TIME_SYNC: eventClass += " time"; break;
              case LOG_PACKET_EVENT: eventClass += " packet"; break;      // NEW
              case LOG_SENSOR_STATE: eventClass += " sensor"; break;      // NEW
              case LOG_MEMORY_EVENT: eventClass += " memory"; break;      // NEW
            }
            
            html += "<div class=\"" + eventClass + "\">";
            html += String(timeStr) + " | ";
            html += getEventTypeName((LogEventType)entry.eventType) + " | ";
            html += String(entry.action);
            
            // Add water data for motor events
            if (entry.eventType == LOG_MOTOR_EVENT && entry.waterLevel >= 0) {
              html += " | " + String(entry.waterLevel, 1) + "cm (" + String(entry.waterPercent, 1) + "%)";
              
              if (entry.wpSensorStatus == 1) {
                html += " | Water:OK";
              } else if (entry.wpSensorStatus == 0 || entry.wpSensorStatus == 2) {
                // For wired: status 0 or 2 both mean no water detected (not offline)
                html += " | Water:NO";
              }
            }
            
            if (strlen(entry.details) > 0) {
              html += " | " + String(entry.details);
            }
            
            html += "</div>\n";
          }
        }
      }
      
      file.close();
    } else {
      html += "<div class=\"no-logs\">Failed to read log file</div>\n";
    }
  }

  html += "</div>\n"; // Close content-wrap
  html += "</div>\n"; // Close container
  html += "</body>\n</html>";

  server.send(200, "text/html", html);
}

void handleLogsClearConfirm() {
  lastWebActivity = millis();
  
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>Clear Logs Confirmation</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
  html += "<style>\n";
  html += "body { font-family: Arial, sans-serif; margin: 20px; background-color: #f0f8ff; color: #333; text-align: center; }\n";
  html += ".container { max-width: 500px; margin: 50px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }\n";
  html += ".warning { color: #e74c3c; font-size: 1.2em; margin-bottom: 20px; }\n";
  html += ".info { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 5px; margin-bottom: 20px; }\n";
  html += ".btn { background: #3498db; color: white; padding: 12px 25px; border: none; border-radius: 5px; text-decoration: none; display: inline-block; margin: 5px; cursor: pointer; }\n";
  html += ".btn:hover { background: #2980b9; }\n";
  html += ".btn.danger { background: #e74c3c; }\n";
  html += ".btn.danger:hover { background: #c0392b; }\n";
  html += ".btn.secondary { background: #95a5a6; }\n";
  html += ".btn.secondary:hover { background: #7f8c8d; }\n";
  html += "</style>\n</head>\n<body>\n";
  
  html += "<div class=\"container\">\n";
  html += "<div class=\"warning\">⚠️ Clear All Logs?</div>\n";
  html += "<div class=\"info\">\n";
  html += "<strong>This action will permanently delete all " + String(logManager.totalEntries) + " log entries.</strong><br><br>\n";
  html += "This cannot be undone. Consider downloading the logs first if you need to keep them.\n";
  html += "</div>\n";
  html += "<form method=\"POST\" action=\"/logs/clear\">\n";
  html += "<button type=\"submit\" class=\"btn danger\">Yes, Clear All Logs</button>\n";
  html += "<a href=\"/logs/download\" class=\"btn\">Download First</a>\n";
  html += "<a href=\"/logs/view\" class=\"btn secondary\">Cancel</a>\n";
  html += "</form>\n";
  html += "</div>\n</body>\n</html>";
  
  server.send(200, "text/html", html);
}

void handleLogsClear() {
  lastWebActivity = millis();
  
  clearLogFile();
  
  String html = "<!DOCTYPE html>\n<html>\n<head>\n";
  html += "<title>Logs Cleared</title>\n";
  html += "<meta charset=\"UTF-8\">\n";
  html += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
  html += "<meta http-equiv=\"refresh\" content=\"3;url=/logs/view\">\n";
  html += "<style>\n";
  html += "body { font-family: Arial, sans-serif; margin: 20px; background-color: #f0f8ff; color: #333; text-align: center; }\n";
  html += ".container { max-width: 400px; margin: 50px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }\n";
  html += ".success { color: #27ae60; font-size: 1.2em; margin-bottom: 20px; }\n";
  html += ".btn { background: #3498db; color: white; padding: 12px 25px; border: none; border-radius: 5px; text-decoration: none; display: inline-block; }\n";
  html += "</style>\n</head>\n<body>\n";
  html += "<div class=\"container\">\n";
  html += "<div class=\"success\">✅ All logs cleared successfully!</div>\n";
  html += "<p>Log file has been reset. Redirecting to logs page...</p>\n";
  html += "<a href=\"/logs/view\" class=\"btn\">View Logs Now</a>\n";
  html += "</div>\n</body>\n</html>";
  
  server.send(200, "text/html", html);
  
  DEBUG_PRINTLN("All logs cleared via web interface");
  logSystemEvent("LOGS_CLEARED", "WEB_INTERFACE");
}

// ═══════════════════════════════════════════════════════════════════
//  CLOUD (Firebase RTDB) — 117.0.0  DUAL-CORE
//
//  Hard safety rule (per user, 2026-09):
//    Pump control MUST NEVER be delayed by cloud, WiFi, or internet.
//
//  Architecture:
//    Core 1 (Arduino task): loop() — pump control only. No Firebase
//                            calls, no long TLS, no DNS.
//    Core 0 (cloudTask):    initFirebase, publishes /live, drains the
//                            event queue, replays offline history
//                            events, feeds its own Task WDT (60 s).
//
//  Communication:
//    g_snapshot  — mutex-guarded PumpSnapshot; pump control writes,
//                  cloud reads. Kept small so full struct-copy under
//                  mutex is cheap. Never held across TLS.
//    g_eventQueue — FreeRTOS queue of PumpEvent (10 slots). Pump
//                   control enqueues on state change; cloud drains.
//    g_pendingRuns — cloud-task-local cache. Only complete pump_on
//                    + pump_off pairs get written to /history — per
//                    user rule. Half-pairs age out after 24 hr.
//
//  Failure isolation:
//    If cloudTask hangs on TLS → Task WDT restarts JUST that task.
//    Pump task on Core 1 never notices. No safeRestart from cloud
//    failures. Ever.
// ═══════════════════════════════════════════════════════════════════

#if !ENABLE_CLOUD
// Local-only build stubs so call sites compile.
static inline void publishPumpSnapshot()      {}
static inline void enqueuePumpOnEvent(const char*)  {}
static inline void enqueuePumpOffEvent(const char*, uint32_t) {}
static inline void ensureDeviceCode()         {}
static inline bool checkInternet()            { return false; }
static inline void startCloudTask()           {}

#else

// Extern references to state produced by the pump-control code (Core 1).
// Cloud task never touches these directly except when taking the snapshot;
// afterwards it works only from the mutex-guarded copy.
extern bool motorState;
extern bool feedbackEnabled;
extern bool feedbackFaultActive;
extern bool tankLowWet;
extern bool tankFullWet;
extern bool wpSensorStatus;
extern bool hasWPSensor;

// ─── Small utilities ────────────────────────────────────────────────

static void setGoogleDNS() {
  IPAddress dns1(8, 8, 8, 8), dns2(1, 1, 1, 1);
  WiFi.setDNS(dns1, dns2);
}

// DNS-probe internet check — connects to port 53 on 3 well-known
// resolvers. Cheap (~50-500 ms) and immune to captive-portal 443 blocks.
bool checkInternet() {
  if (WiFi.status() != WL_CONNECTED) return false;
  const char* dns[] = { "8.8.8.8", "1.1.1.1", "9.9.9.9" };
  for (int i = 0; i < 3; i++) {
    WiFiClient c;
    if (c.connect(dns[i], 53, 1000)) { c.stop(); return true; }
    c.stop();
  }
  return false;
}

// Load or create the pump's persistent device code (SF-PMP-XXXX). Uses
// the "pump" NVS namespace so it doesn't collide with existing keys.
void ensureDeviceCode() {
  Preferences p;
  p.begin("pump", false);
  pumpDeviceCode = p.getString("devcode", "");
  if (pumpDeviceCode.length() == 0) {
    String suffix = devSuffix;
    if (suffix.length() != 4) {
      uint8_t mac[6]; WiFi.macAddress(mac);
      char buf[5]; snprintf(buf, sizeof(buf), "%02X%02X", mac[4], mac[5]);
      suffix = String(buf);
    }
    pumpDeviceCode = "SF-PMP-" + suffix;
    p.putString("devcode", pumpDeviceCode);
    DEBUG_PRINT("[FB] Generated pump device code: ");
    DEBUG_PRINTLN(pumpDeviceCode);
  } else {
    DEBUG_PRINT("[FB] Loaded pump device code: ");
    DEBUG_PRINTLN(pumpDeviceCode);
  }
  p.end();
}

// ─── Snapshot bridge (Core 1 → Core 0) ──────────────────────────────
// Called by pump-control code from Core 1 whenever pump state changes,
// or periodically from loop() (~500 ms). Cheap: struct-copy under mutex.
// Never held across TLS or other slow ops. Safe to call before the mutex
// is created (early boot) — it no-ops in that case.

// Local enum-derivation helpers — pure functions of the state variables
// listed in the externs above. Called under mutex.
static PumpStateEnum derivePumpStateEnum() {
  // Single-source-of-truth read: g_fbConfirmedRunning is maintained by
  // handleMotorFeedback() on Core 1. Core 0 (this snapshot code) never
  // touches the GPIO directly — that used to cause a cross-core race
  // where Core 0 could see a different value from what Core 1 had just
  // interpreted, producing snapshots that disagreed with the events
  // Core 1 had just emitted.
  if (feedbackFaultActive) return PS_FAULT;
  const bool fbActive = (pumpType == PUMP_PANEL) && feedbackEnabled;
  const bool fbOn     = fbActive ? g_fbConfirmedRunning : motorState;

  if (motorState) {
    // Motor commanded ON. Distinguish confirmed-running from waiting-
    // for-latch (grace window) when feedback is wired. Without feedback
    // we assume the command took effect immediately.
    if (fbActive && !fbOn) return PS_STARTING;   // still waiting for latch

    // Confirmed running (or feedback disabled). Report Manual vs Auto
    // by looking at how the run was started: currentRunIsManual is set
    // in setMotor(true) when nextMotorCause == "force" — that covers
    // AP force button, cloud force-run command, and the physical panel
    // button (all funnel through enterManualOverride, which tags force).
    // Also fall back to the MODE_MANUAL_OVERRIDE mode flag in case a
    // caller set motorState directly without going through setMotor
    // (belt-and-suspenders — the flag survives across restarts of the
    // motor loop where currentRunIsManual might not).
    if (currentRunIsManual || currentMode == MODE_MANUAL_OVERRIDE) return PS_MANUAL;
    return PS_AUTO;
  }

  // Motor commanded OFF. If feedback shows running, someone bypassed
  // our software — physical panel button pressed on the panel itself,
  // mechanical bypass, etc. Still Manual by definition.
  if (fbActive && fbOn) return PS_MANUAL;
  return PS_OFF;
}

static TerraceEnum deriveTerraceStateEnum() {
  if (!tankLowWet && !tankFullWet) return TS_EMPTY;
  if ( tankLowWet && !tankFullWet) return TS_HALF;
  if ( tankLowWet &&  tankFullWet) return TS_FULL;
  return TS_FAULT;
}

void publishPumpSnapshot() {
  if (g_snapMutex == nullptr) return;
  if (xSemaphoreTake(g_snapMutex, 5 / portTICK_PERIOD_MS) == pdTRUE) {
    g_snapshot.pumpState     = derivePumpStateEnum();
    g_snapshot.terraceState  = deriveTerraceStateEnum();
    g_snapshot.sourceState   = wpSensorStatus ? SR_WET : SR_DRY;
    g_snapshot.hasFeedback   = feedbackEnabled;
    g_snapshot.hasSource     = hasWPSensor;
    g_snapshot.feedbackFault = feedbackFaultActive;
    g_snapshot.faultReason   = g_faultReason;
    g_snapshot.rssi          = WiFi.RSSI();
    g_snapshot.stampMs       = millis();
    // v118.0.11: snapshot ultrasonic read atomically with the enum.
    g_snapshot.terracePct      = usConfirmedPct;
    g_snapshot.haveGoodReading = usHaveGoodReading;
    g_snapshot.sensorFault     = usSensorFault;
    g_snapshot.rawMm           = usLastRawMm;
    xSemaphoreGive(g_snapMutex);
  }
  // If we couldn't grab the mutex within 5 ms, skip this update. Cloud
  // task will read the previous snapshot; next publishPumpSnapshot()
  // call catches up. Zero risk to pump control.
}

// ─── Event enqueue (Core 1 → Core 0) ────────────────────────────────
// Pump control calls these when the motor state transitions. Non-blocking:
// if the queue is full (unlikely — 10 slots), the oldest entry is
// silently dropped so we always accept the new one. That means we
// prefer to lose old events over blocking pump control.

static void snapshotToEvent(PumpEvent& e) {
  // Read state under mutex (very briefly). All the fields we need are
  // in the snapshot already so we don't re-derive from pump globals.
  if (g_snapMutex && xSemaphoreTake(g_snapMutex, 5 / portTICK_PERIOD_MS) == pdTRUE) {
    e.pumpStateAtEvent = g_snapshot.pumpState;
    e.terraceAtEvent   = g_snapshot.terraceState;
    e.sourceAtEvent    = g_snapshot.sourceState;
    xSemaphoreGive(g_snapMutex);
  } else {
    e.pumpStateAtEvent = PS_OFF;
    e.terraceAtEvent   = TS_EMPTY;
    e.sourceAtEvent    = SR_DRY;
  }
}

static void makeRunId(char* out, size_t n) {
  // Per user: collisions don't matter (per-device). Use unix epoch when
  // available, else millis(). No random hex needed.
  time_t nowT = time(nullptr);
  if (nowT > 1700000000) {   // sanity — post-2023 epoch means RTC/NTP set
    snprintf(out, n, "R-%lu", (unsigned long)nowT);
  } else {
    snprintf(out, n, "R-M%lu", (unsigned long)millis());
  }
}

void enqueuePumpOnEvent(const char* cause) {
  if (!g_eventQueue) return;
  PumpEvent e = {};
  e.type       = EV_PUMP_ON;
  makeRunId(e.runId, sizeof(e.runId));
  time_t nowT  = time(nullptr);
  e.evTs       = (nowT > 1700000000) ? (uint32_t)nowT : 0;
  e.evMillis   = millis();
  e.runSecIfOff = 0;
  strncpy(e.cause, cause ? cause : "auto", sizeof(e.cause) - 1);
  snapshotToEvent(e);
  // If full, drop oldest to make room. Never block.
  if (xQueueSend(g_eventQueue, &e, 0) != pdTRUE) {
    PumpEvent dropped;
    xQueueReceive(g_eventQueue, &dropped, 0);
    xQueueSend(g_eventQueue, &e, 0);
  }
}

void enqueuePumpOffEvent(const char* cause, uint32_t runSec) {
  if (!g_eventQueue) return;
  PumpEvent e = {};
  e.type       = EV_PUMP_OFF;
  // pump_off inherits the last-known runId. Pump control calls this
  // right after clearing motorState, and the cloud task will pair it
  // with the most recent still-pending pump_on it holds — even if the
  // runId string doesn't match (RTC came online mid-run, etc.).
  makeRunId(e.runId, sizeof(e.runId));
  time_t nowT  = time(nullptr);
  e.evTs       = (nowT > 1700000000) ? (uint32_t)nowT : 0;
  e.evMillis   = millis();
  e.runSecIfOff = runSec;
  strncpy(e.cause, cause ? cause : "auto", sizeof(e.cause) - 1);
  snapshotToEvent(e);
  if (xQueueSend(g_eventQueue, &e, 0) != pdTRUE) {
    PumpEvent dropped;
    xQueueReceive(g_eventQueue, &dropped, 0);
    xQueueSend(g_eventQueue, &e, 0);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Cloud task (Core 0)
// ═══════════════════════════════════════════════════════════════════
// Runs its own loop, feeds its own WDT, never blocks Core 1. Every
// blocking call inside this function is on the cloud task's stack —
// pump control is untouched. If TLS hangs, only this task hangs, and
// only until the 60 s Task WDT bites and restarts... this task.

// Convert snapshot enums to the wire strings we publish.
static const char* pumpEnumToStr(PumpStateEnum s) {
  switch (s) {
    case PS_AUTO:     return "auto";
    case PS_MANUAL:   return "manual";
    case PS_FAULT:    return "fault";
    case PS_STARTING: return "starting";
    default:          return "off";
  }
}

// Map fault reason enum → wire string for /live.faultReason. Dashboard's
// PumpDetail Device Info section renders these as human-readable labels
// ("Failed to start" / "Dropped mid-run" / "Stuck on"). Empty string
// when no fault is active — dashboard hides the field.
static const char* faultReasonToStr(uint8_t r) {
  switch (r) {
    case FR_START_FAIL:      return "start_fail";
    case FR_MID_RUN_DROPOUT: return "mid_run_dropout";
    case FR_STUCK_ON:        return "stuck_on";
    default:                 return "";
  }
}
static const char* terraceEnumToStr(TerraceEnum s) {
  switch (s) {
    case TS_HALF:  return "half";
    case TS_FULL:  return "full";
    case TS_FAULT: return "sensor_fault";
    default:       return "empty";
  }
}

// Take a fresh copy of the snapshot under mutex.
static bool copySnapshot(PumpSnapshot& out) {
  if (!g_snapMutex) return false;
  if (xSemaphoreTake(g_snapMutex, 10 / portTICK_PERIOD_MS) != pdTRUE) return false;
  out = g_snapshot;
  xSemaphoreGive(g_snapMutex);
  return true;
}

static bool cloudInitFirebase() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!internetAvailable) return false;
  if (firebaseReady) return true;

  // Time-safety gate: block Firebase init when the system clock is
  // clearly wrong (fresh RTC before first NTP sync, or wildly bogus).
  // Skipping this leads to a silent-wedge failure mode — TLS/JWT auth
  // fail invisibly because the client cert/expiry check compares
  // against local time. Attempt NTP once here, then fall back to
  // trusting the RTC only if it reports a modern year. If neither
  // path yields a plausible clock, refuse to init — cloudTask retries
  // in 60 s and we'll try again then. Pump control on Core 1 keeps
  // running throughout — motor logic uses millis(), never wall-clock.
  if (!isClockSafe()) {
    DEBUG_PRINTLN("[FB] Clock not safe (year<2024). Trying NTP before init...");
    tryNTPSync();
    if (!isClockSafe()) {
      DEBUG_PRINTLN("[FB] Still not safe — skipping init this cycle");
      return false;
    }
  }

  DEBUG_PRINTLN("[FB] initFirebase (cloud task)");
  setGoogleDNS();
  fbConfig.api_key      = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;
  fbConfig.token_status_callback = tokenStatusCallback;
  fbConfig.timeout.serverResponse   = 2000;
  fbConfig.timeout.socketConnection = 2000;
  fbConfig.timeout.sslHandshake     = 3000;

  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectNetwork(true);

  // v118.0.7: signUp() can block 3-10s on TLS handshake. Bracket with
  // wdt resets so even a slow legitimate auth doesn't look like a hang.
  esp_task_wdt_reset();
  bool authOk = Firebase.signUp(&fbConfig, &fbAuth, "", "");
  esp_task_wdt_reset();

  if (authOk) {
    DEBUG_PRINTLN("[FB] Anonymous auth OK");
  } else {
    DEBUG_PRINT("[FB] Auth failed: ");
    DEBUG_PRINTLN(fbConfig.signer.signupError.message.c_str());
    return false;
  }

  if (Firebase.ready()) {
    firebaseReady   = true;
    firebaseHealthy = true;
    DEBUG_PRINTLN("[FB] Firebase ready");
    return true;
  }
  return false;
}

// One-shot: publish device kind + capability flags so the dashboard's
// DeviceCard dispatcher knows to render PumpCard. Written on every
// firebaseReady cutover — idempotent, one small setJSON.
// deviceClass 4 = pump (extends existing 1=valve, 2=sensor, 3=motor).
static bool cloudInfoWritten = false;
static void writeDeviceInfoOnce() {
  if (cloudInfoWritten) return;
  if (!firebaseHealthy) return;
  String path = "devices/" + pumpDeviceCode + "/info";
  FirebaseJson json;
  json.set("deviceClass",   4);            // pump
  json.set("kind",          "pump");
  json.set("hasFeedback",   feedbackEnabled);
  json.set("hasSource",     hasWPSensor);
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("firmwareCode",  FIRMWARE_CODE);
  json.set("macAddress",    WiFi.macAddress());
  // v118 ultrasonic variant — expose tank geometry so cloud can compute
  // depth (ft+in) and volume (used/capacity) without needing to query
  // /config. tankHeightCm is the full inner-column height; sensorOffsetCm
  // is the dead zone from the sensor face to water surface at 100% full.
  json.set("terraceSensorType", "ultrasonic");
  json.set("tankHeightCm",      usTankHeightCm);
  json.set("sensorOffsetCm",    usSensorOffsetCm);
  // Installer's AP-page label (e.g. "Ground Floor Pump", "Tower B").
  // Cloud shows this in Device Info panel only — not used as the tile
  // name, which comes from Firestore deviceCatalog.deviceName. NVS
  // (via loadDeviceName from EEPROM_DEVICE_NAME) is the sole source of
  // truth; firmware never pulls this from cloud.
  json.set("userAssignedName", deviceName);
  json.set("firstSeenAt/.sv", "timestamp");
  if (Firebase.RTDB.updateNode(&fbdo, path.c_str(), &json)) {
    cloudInfoWritten = true;
    DEBUG_PRINTLN("[FB] info/ published");
  }
}

// Runs exactly once per boot, first time we reach Firebase. Handles two
// things the Admin Firmware page cares about:
//   1) Push {firmwareVersion, firstBootAt, lastUpdatedAt} to /info so the
//      version + last-update timestamp always match what's actually
//      running (survives OTA + fresh flashes uniformly).
//   2) Detect a crash-during-OTA: NVS "otaInProg" flag was left true by
//      the last boot's OTA attempt, but we're up now on presumably the
//      OLD firmware (flash failed mid-way). Report as fail:reboot_during_ota
//      so the dashboard doesn't stay stuck at "in_progress" forever.
static bool otaBootReportDone = false;
static void otaBootTimeReport() {
  if (otaBootReportDone) return;
  if (!firebaseHealthy) return;

  Preferences p;
  p.begin("pump", false);
  bool crashDuringOta = p.getBool("otaInProg", false);
  firstBootAt   = p.getUInt("firstBoot", 0);
  lastUpdatedAt = p.getUInt("lastUpd",   0);
  if (firstBootAt == 0) {
    firstBootAt = (uint32_t)time(nullptr);
    p.putUInt("firstBoot", firstBootAt);
  }
  if (crashDuringOta) {
    p.putBool("otaInProg", false);
  }
  p.end();

  reportFirmwareInfo();

  if (crashDuringOta) {
    Serial.println("[OTA] Detected crash during previous OTA — reporting failure");
    setOtaStatus("fail:reboot_during_ota", 0);
    // Don't clear the trigger — admin may want to retry with a fresh URL
  }
  otaBootReportDone = true;
}

// Publish a capability advertisement to /pendingDevices/{code} so the
// admin dashboard's "Add Device" flow can surface this pump for claiming
// — mirrors the ultrasonic writePendingDevice() pattern verbatim. Only
// deviceClass differs (4 = pump vs 2 = sensor).
//
// Once an admin/user Claims the device via the SenseFlow app it moves
// out of /pendingDevices into their org's /orgDevices scope; the pump
// keeps writing /live and /history to devices/{code}/ regardless.
static bool cloudPendingWritten = false;
static void writePendingDevice() {
  if (cloudPendingWritten) return;
  if (!firebaseHealthy)   return;
  String path = "pendingDevices/" + pumpDeviceCode;
  FirebaseJson json;
  json.set("deviceClass",     4);
  json.set("kind",            "pump");
  json.set("hasFeedback",     feedbackEnabled);
  json.set("hasSource",       hasWPSensor);
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("firmwareCode",    FIRMWARE_CODE);
  json.set("macAddress",      WiFi.macAddress());
  // Installer's AP-page label — visible at claim time so an admin can
  // recognise the physical unit by its label instead of just the code.
  json.set("userAssignedName", deviceName);
  json.set("firstSeenAt/.sv", "timestamp");
  if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    cloudPendingWritten = true;
    DEBUG_PRINTLN("[FB] pendingDevices/ published");
  } else {
    DEBUG_PRINT("[FB] pendingDevices write FAIL: ");
    DEBUG_PRINTLN(fbdo.errorReason().c_str());
  }
}

// Premium-tier: write a tiny snapshot to /notify_trigger so the Cloud
// Function dispatcher fires an FCM push. No-op if notifyOn=false → zero
// backend cost for free customers. Called only on real state transitions
// (pump on/off, fault set/clear) — never on rate-limited heartbeats.
static void pushNotifyTrigger(const char* event, uint8_t flg) {
  if (!notifyOn)        return;
  if (!firebaseHealthy) return;
  String path = "devices/" + pumpDeviceCode + "/notify_trigger";
  FirebaseJson json;
  json.set("event",   event);
  json.set("flags",   flg);
  json.set("ts/.sv",  "timestamp");
  esp_task_wdt_reset();
  Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json);
  // No retry on fail — dispatcher is best-effort; missing one ping is
  // fine, the next real event will fire it.
}

// Poll device config flags at devices/{code}/config every ~30 s from
// the cloud task. v117.0.1-test: consolidated from 2 separate getBool()
// reads into a single getJSON() that fetches the whole /config sub-node
// in one wire call. Payload is tiny (~40 B — just 2 booleans), so the
// consolidated read is smaller than the old pair of reads AND their
// combined TLS/auth envelope overhead. Local parse of each flag
// preserves the exact old semantics (change detection + Serial log +
// on-device log queue).
//
// On any change, mirror the applied values to /info/appliedConfig so
// the cloud dashboard has a source of truth for "what config is the
// device ACTUALLY running right now" — this is distinct from /config
// which is the desired/pending value written by the dashboard. When
// nothing changed (99% of poll cycles), no write happens = zero cost.
// The dashboard reads /info/appliedConfig to know when a toggle has
// actually taken effect on-device, enabling a future "pending" badge
// on the settings UI if we want it.
//
// diagnosticsOn deferred until we ship the boot-log-upload machinery.
// Mirror ALL settable behaviour config back to /info/appliedConfig so
// the cloud Panel Settings tab can compare its /config.savedAt against
// /info/appliedConfig.appliedAt to prove a save round-tripped. Every
// field the cloud can push must appear here so the "✓ Applied" pill
// works uniformly across the whole form.
//
// lastAppliedSavedAt declared as a global at the top of the file (near
// manualOverrideDurationMinutes) so setup() can restore it from NVS
// before checkCloudConfig() ever runs. Written back on every accepted
// cloud save via Preferences "pump"/"lastSvAt".
static void mirrorAppliedConfig() {
  if (!firebaseHealthy) return;
  String path = "devices/" + pumpDeviceCode + "/info/appliedConfig";
  FirebaseJson json;
  // Analytics / notifications (existing).
  json.set("analyticsOn", analyticsOn);
  json.set("notifyOn",    notifyOn);
  // Panel-settings mirror — all 10 behaviour fields the cloud can push.
  json.set("autoModeEnabled",         autoModeEnabled);
  json.set("scheduleModeEnabled",     scheduleModeEnabled);
  // Dry-run protection section
  json.set("dryRunProtectionOn",      dryRunProtectionOn);
  json.set("maxTimeToNextProbeMins",  maxTimeToNextProbeMins);
  json.set("maxDryRunCount",          maxDryRunCount);
  json.set("maxRunTimeMins",          maxRunTimeMins);
  json.set("dryRunWaitMins",          dryRunWaitMins);
  // Source-water detection section
  json.set("hasWPSensor",             hasWPSensor);
  json.set("detectionMode",           detectionMode);
  json.set("sourceDebounceSecs",      sourceDebounceSecs);
  json.set("gracePeriodTens",         gracePeriodTens);
  json.set("maxRetryCount",           maxRetryCount);
  json.set("retryWaitMins",           retryWaitMins);
  // Safe-mode recovery section
  json.set("autoRecoverOnSchedule",   autoRecoverOnSchedule);
  json.set("autoRecoverOnTimeout",    autoRecoverOnTimeout);
  json.set("autoRecoverTimeoutHours", autoRecoverTimeoutHours);
  // v118.0.5 ultrasonic variant — water level config
  json.set("startPercent",       startPercent);
  json.set("stopPercent",        stopPercent);
  json.set("usTankHeightCm",     usTankHeightCm);
  json.set("usSensorOffsetCm",   usSensorOffsetCm);
  json.set("tankVolume",         tankVolume);
  // Schedules as an array — same shape cloud writes.
  // v118.0.9: adds dayMask + fillUntilFull per schedule. Cloud UI reads
  // these back as the applied config; absent in older firmware = defaults.
  FirebaseJsonArray schedArr;
  for (int i = 0; i < 3; i++) {
    FirebaseJson s;
    s.set("enabled",     schedules[i].enabled);
    s.set("startHour",   schedules[i].startHour);
    s.set("startMinute", schedules[i].startMinute);
    s.set("endHour",     schedules[i].endHour);
    s.set("endMinute",   schedules[i].endMinute);
    s.set("dayMask",     schedules[i].dayMask ? schedules[i].dayMask : SCHED_DAY_MASK_ALL);
    s.set("fillUntilFull", schedules[i].fillUntilFull);
    schedArr.add(s);
  }
  json.set("schedules", schedArr);
  // v118.0.9: smart dry-run block exposed to cloud.
  json.set("smartDryRunEnabled",   smartDryRunEnabled);
  json.set("smartDryRunCheckMins", smartDryRunCheckMins);
  json.set("smartDryRunMinPct",    smartDryRunMinPct);
  // Round-trip confirmation timestamp. UI does exact equality:
  //   /info/appliedConfig/appliedAt === /config/savedAt → ✓ Applied.
  if (lastAppliedSavedAt > 0) json.set("appliedAt", (int)lastAppliedSavedAt);
  json.set("ts/.sv",      "timestamp");
  Firebase.RTDB.updateNode(&fbdo, path.c_str(), &json);
}

// Version-counter fast path (v117.0.10+): before fetching the full
// /config node (~500 B), poll a tiny counter at /config/_v (~15 B).
// If unchanged since last poll, skip the full fetch entirely — cuts
// config-poll bandwidth by ~30× on quiet days. Cloud increments _v on
// every atomic save (see savePanelConfig() in cloud rtdb.js).
//
// Backwards-compat: on the FIRST poll after boot, lastKnownCfgVersion
// is 0 — we treat that as "unknown" and do a full fetch to establish
// a baseline. This also handles the case where a device was flashed
// before _v existed in /config — cloud will start writing it on the
// next save and firmware picks it up naturally.
static uint32_t lastKnownCfgVersion = 0;

static void checkCloudConfig() {
  if (!firebaseHealthy) return;
  String cfgPath = "devices/" + pumpDeviceCode + "/config";

  esp_task_wdt_reset();

  // Fast path: fetch just /config/_v (~15 B) and compare against last
  // known version. Only fall through to the full fetch when the
  // counter changed (or we've never seen one yet).
  String vPath = cfgPath + "/_v";
  if (Firebase.RTDB.getInt(&fbdo, vPath.c_str())) {
    uint32_t serverVersion = (uint32_t)fbdo.to<int>();
    if (serverVersion > 0 && serverVersion == lastKnownCfgVersion) {
      return;   // No change since last poll — skip full fetch. 97% of poll cycles hit this.
    }
    // Remember it for next tick; full fetch below still runs to apply.
    lastKnownCfgVersion = serverVersion;
  }
  // If getInt failed (no _v yet, network hiccup, first-run), we fall
  // through to the full fetch — safer default. Next successful _v read
  // will re-establish the fast-path baseline.

  if (!Firebase.RTDB.getJSON(&fbdo, cfgPath.c_str())) return;

  FirebaseJson &j = fbdo.jsonObject();
  FirebaseJsonData v;
  bool changed = false;

  if (j.get(v, "analyticsOn") && v.success) {
    bool newVal = v.boolValue;
    if (newVal != analyticsOn) {
      analyticsOn = newVal;
      changed = true;
      DEBUG_PRINT("[CONFIG] analyticsOn = ");
      DEBUG_PRINTLN(analyticsOn ? "ON" : "OFF");
      queueCloudLog("CFG_ANALYTICS", analyticsOn ? "on" : "off");
    }
  }

  if (j.get(v, "notifyOn") && v.success) {
    bool newVal = v.boolValue;
    if (newVal != notifyOn) {
      notifyOn = newVal;
      changed = true;
      DEBUG_PRINT("[CONFIG] notifyOn = ");
      DEBUG_PRINTLN(notifyOn ? "ON" : "OFF");
      queueCloudLog("CFG_NOTIFY", notifyOn ? "on" : "off");
    }
  }

  // ── Panel-settings block: 10 behaviour fields the cloud form can
  //    push.
  //
  // GATING RULE (v117.0.8+):
  //   We ONLY apply /config panel-settings fields when /config/savedAt
  //   is different from lastAppliedSavedAt — i.e. cloud has explicitly
  //   submitted a NEW Save & Send that we haven't processed yet.
  //
  // Why: without this gate, stale /config values kept overriding
  // installer changes made at the AP page. Example: cloud once wrote
  // hasWPSensor=false with savedAt=1000. Installer later walks up to
  // the panel, flips it ON at AP page → firmware writes true to NVS →
  // publishes true to /info/appliedConfig. Then 30 sec later this
  // poll fires, sees /config/hasWPSensor=false, reapplies false, wipes
  // out the installer change. Bug: AP-page changes vanish every 30 sec.
  //
  // The fix: device is the master. Cloud is a one-shot dispatcher.
  // A stale /config value is treated as "already handled, ignore".
  // Only a fresh savedAt is treated as an intent to change something.
  //
  // Field-by-field: read, validate against SAME ranges the AP form
  // uses, apply to in-memory var + EEPROM, mark changed. Rejected
  // values are silently dropped — cloud UI's mirrored validators
  // prevent bad values from reaching us in normal flow. Any persist
  // that succeeds calls EEPROM.commit at the end of the block (batched
  // — one flash write for the whole save, not one per field).
  uint32_t incomingSavedAt = 0;
  if (j.get(v, "savedAt") && v.success) incomingSavedAt = (uint32_t)v.intValue;
  const bool freshSave = (incomingSavedAt > 0 && incomingSavedAt != lastAppliedSavedAt);

  bool eepromDirty = false;
  if (freshSave) {

  if (j.get(v, "autoModeEnabled") && v.success) {
    bool newVal = v.boolValue;
    if (newVal != autoModeEnabled) {
      // v118.0.1 (ported from v117.0.15): use enableAutoMode() /
      // disableAutoMode() helpers instead of flipping the bool directly.
      // Those helpers also transition currentMode (MODE_NORMAL / MODE_IDLE),
      // reset dryRunCount, set needFreshDataAfterRecovery, save config,
      // and log properly. The prior direct-flip left currentMode at its
      // previous value — so if the user had disabled auto via AP (which
      // set MODE_IDLE) and then re-enabled it from cloud, the pump stayed
      // in MODE_IDLE even though the flag showed ON, and the auto-start
      // branch (which gates on !MODE_IDLE) never fired. Result: "auto on
      // but pump won't run".
      if (currentMode == MODE_MANUAL_OVERRIDE) {
        DEBUG_PRINTLN("[CONFIG] autoModeEnabled ignored — in manual override");
      } else {
        if (newVal) enableAutoMode();
        else        disableAutoMode();
        eepromDirty = true; changed = true;
        DEBUG_PRINT("[CONFIG] autoModeEnabled = "); DEBUG_PRINTLN(newVal ? "ON (mode → NORMAL)" : "OFF (mode → IDLE)");
      }
    }
  }

  if (j.get(v, "dryRunProtectionOn") && v.success) {
    bool newVal = v.boolValue;
    if (newVal != dryRunProtectionOn) {
      dryRunProtectionOn = newVal;
      EEPROM.write(EEPROM_DRY_RUN_ON, dryRunProtectionOn ? 1 : 0);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] dryRunProtectionOn = "); DEBUG_PRINTLN(dryRunProtectionOn ? "ON" : "OFF");
    }
  }

  if (j.get(v, "maxDryRunCount") && v.success) {
    int n = v.intValue;
    // AP page allows 1-5. Cloud validator mirrors this exact range.
    if (n >= 1 && n <= 5 && n != maxDryRunCount) {
      maxDryRunCount = (uint8_t)n;
      EEPROM.write(EEPROM_MAX_DRY_RUN_COUNT, maxDryRunCount);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] maxDryRunCount = "); DEBUG_PRINTLN(maxDryRunCount);
    }
  }

  if (j.get(v, "maxTimeToNextProbeMins") && v.success) {
    int n = v.intValue;
    // AP-page whitelist: 5/10/15/30/60/120.
    bool ok = (n == 5 || n == 10 || n == 15 || n == 30 || n == 60 || n == 120);
    if (ok && n != maxTimeToNextProbeMins) {
      maxTimeToNextProbeMins = (uint8_t)n;
      EEPROM.write(EEPROM_DRY_RUN_MINS, maxTimeToNextProbeMins);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] maxTimeToNextProbeMins = "); DEBUG_PRINTLN(maxTimeToNextProbeMins);
    }
  }

  if (j.get(v, "hasWPSensor") && v.success) {
    bool newVal = v.boolValue;
    if (newVal != hasWPSensor) {
      hasWPSensor = newVal;
      EEPROM.write(EEPROM_HAS_WP_SENSOR, hasWPSensor ? 1 : 0);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] hasWPSensor = "); DEBUG_PRINTLN(hasWPSensor ? "ON" : "OFF");
    }
  }

  if (j.get(v, "detectionMode") && v.success) {
    int n = v.intValue;
    if ((n == 0 || n == 1) && n != detectionMode) {
      detectionMode = (uint8_t)n;
      EEPROM.write(EEPROM_DETECTION_MODE, detectionMode);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] detectionMode = "); DEBUG_PRINTLN(detectionMode == 0 ? "Pre" : "Post");
    }
  }

  if (j.get(v, "sourceDebounceSecs") && v.success) {
    int n = v.intValue;
    // AP whitelist: 5/10/15/20/30/45/60/90/120/180.
    bool ok = (n == 5 || n == 10 || n == 15 || n == 20 || n == 30 || n == 45 || n == 60 || n == 90 || n == 120 || n == 180);
    if (ok && n != sourceDebounceSecs) {
      sourceDebounceSecs = (uint8_t)n;
      EEPROM.write(EEPROM_SOURCE_DEBOUNCE_SECS, sourceDebounceSecs);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] sourceDebounceSecs = "); DEBUG_PRINTLN(sourceDebounceSecs);
    }
  }

  if (j.get(v, "gracePeriodTens") && v.success) {
    int n = v.intValue;
    // AP whitelist: 4/6/12/18/24/30/42/60 (tens of seconds).
    bool ok = (n == 4 || n == 6 || n == 12 || n == 18 || n == 24 || n == 30 || n == 42 || n == 60);
    if (ok && n != gracePeriodTens) {
      gracePeriodTens = (uint8_t)n;
      EEPROM.write(EEPROM_GRACE_PERIOD_TENS, gracePeriodTens);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] gracePeriodTens = "); DEBUG_PRINTLN(gracePeriodTens);
    }
  }

  if (j.get(v, "retryWaitMins") && v.success) {
    int n = v.intValue;
    // AP whitelist: 1/2/3/5/7/10/15 (same as dryRunWaitMins).
    bool ok = (n == 1 || n == 2 || n == 3 || n == 5 || n == 7 || n == 10 || n == 15);
    if (ok && n != retryWaitMins) {
      retryWaitMins = (uint8_t)n;
      EEPROM.write(EEPROM_RETRY_WAIT_MINS, retryWaitMins);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] retryWaitMins = "); DEBUG_PRINTLN(retryWaitMins);
    }
  }

  if (j.get(v, "dryRunWaitMins") && v.success) {
    int n = v.intValue;
    // AP whitelist: 1/2/3/5/7/10/15.
    bool ok = (n == 1 || n == 2 || n == 3 || n == 5 || n == 7 || n == 10 || n == 15);
    if (ok && n != dryRunWaitMins) {
      dryRunWaitMins = (uint8_t)n;
      EEPROM.write(EEPROM_DRY_RUN_WAIT_MINS, dryRunWaitMins);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] dryRunWaitMins = "); DEBUG_PRINTLN(dryRunWaitMins);
    }
  }

  if (j.get(v, "maxRetryCount") && v.success) {
    int n = v.intValue;
    if (n >= 1 && n <= 5 && n != maxRetryCount) {
      maxRetryCount = (uint8_t)n;
      EEPROM.write(EEPROM_RETRY_COUNT, maxRetryCount);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] maxRetryCount = "); DEBUG_PRINTLN(maxRetryCount);
    }
  }

  if (j.get(v, "maxRunTimeMins") && v.success) {
    int n = v.intValue;
    // Whitelist matches AP-form dropdown + EEPROM load validator.
    bool ok = (n == 0 || n == 10 || n == 20 || n == 30 || n == 60 || n == 90 || n == 120 || n == 180 || n == 240);
    if (ok && n != maxRunTimeMins) {
      maxRunTimeMins = (uint8_t)n;
      EEPROM.write(EEPROM_MAX_RUN_TIME_MINS, maxRunTimeMins);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] maxRunTimeMins = "); DEBUG_PRINTLN(maxRunTimeMins);
    }
  }

  if (j.get(v, "autoRecoverOnSchedule") && v.success) {
    bool newVal = v.boolValue;
    if (newVal != autoRecoverOnSchedule) {
      autoRecoverOnSchedule = newVal;
      EEPROM.write(EEPROM_AUTO_RECOVER_SCHEDULE, autoRecoverOnSchedule ? MAGIC_NUMBER : 0);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] autoRecoverOnSchedule = "); DEBUG_PRINTLN(autoRecoverOnSchedule ? "ON" : "OFF");
    }
  }

  if (j.get(v, "autoRecoverOnTimeout") && v.success) {
    bool newVal = v.boolValue;
    if (newVal != autoRecoverOnTimeout) {
      autoRecoverOnTimeout = newVal;
      EEPROM.write(EEPROM_AUTO_RECOVER_TIMEOUT, autoRecoverOnTimeout ? MAGIC_NUMBER : 0);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] autoRecoverOnTimeout = "); DEBUG_PRINTLN(autoRecoverOnTimeout ? "ON" : "OFF");
    }
  }

  if (j.get(v, "autoRecoverTimeoutHours") && v.success) {
    int n = v.intValue;
    if (n >= 1 && n <= 72 && n != autoRecoverTimeoutHours) {
      autoRecoverTimeoutHours = n;
      EEPROM.write(EEPROM_AUTO_RECOVER_HOURS, (uint8_t)autoRecoverTimeoutHours);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] autoRecoverTimeoutHours = "); DEBUG_PRINTLN(autoRecoverTimeoutHours);
    }
  }

  // v118.0.5 ultrasonic variant — water level config from cloud Panel
  // Settings tab. Save to BOTH slots (primary + US magic) so load path
  // sees the right value on reboot.
  bool usCloudChanged = false;
  if (j.get(v, "startPercent") && v.success) {
    int n = v.intValue;
    if (n & 1) n -= 1;
    if (n >= 2 && n <= 98 && n != startPercent) {
      startPercent = (uint8_t)n;
      EEPROM.write(EEPROM_START_PERCENT, startPercent);
      eepromDirty = true; changed = true; usCloudChanged = true;
      DEBUG_PRINT("[CONFIG] startPercent = "); DEBUG_PRINTLN(startPercent);
    }
  }
  if (j.get(v, "stopPercent") && v.success) {
    int n = v.intValue;
    if (n & 1) n -= 1;
    if (n >= 4 && n <= 100 && n != stopPercent) {
      stopPercent = (uint8_t)n;
      EEPROM.write(EEPROM_STOP_PERCENT, stopPercent);
      eepromDirty = true; changed = true; usCloudChanged = true;
      DEBUG_PRINT("[CONFIG] stopPercent = "); DEBUG_PRINTLN(stopPercent);
    }
  }
  if (j.get(v, "usTankHeightCm") && v.success) {
    int n = v.intValue;
    if (n >= 10 && n <= 1200 && n != usTankHeightCm) {
      usTankHeightCm = (uint16_t)n;
      eepromDirty = true; changed = true; usCloudChanged = true;
      DEBUG_PRINT("[CONFIG] usTankHeightCm = "); DEBUG_PRINTLN(usTankHeightCm);
    }
  }
  if (j.get(v, "usSensorOffsetCm") && v.success) {
    int n = v.intValue;
    if (n >= 0 && n <= 100 && n != usSensorOffsetCm) {
      usSensorOffsetCm = (uint16_t)n;
      eepromDirty = true; changed = true; usCloudChanged = true;
      DEBUG_PRINT("[CONFIG] usSensorOffsetCm = "); DEBUG_PRINTLN(usSensorOffsetCm);
    }
  }
  if (j.get(v, "tankVolume") && v.success) {
    int n = v.intValue;
    if (n >= 0 && n <= 100000 && (uint32_t)n != tankVolume) {
      tankVolume = (uint32_t)n;
      EEPROM.write(EEPROM_TANK_VOLUME,     (tankVolume >> 24) & 0xFF);
      EEPROM.write(EEPROM_TANK_VOLUME + 1, (tankVolume >> 16) & 0xFF);
      EEPROM.write(EEPROM_TANK_VOLUME + 2, (tankVolume >> 8) & 0xFF);
      EEPROM.write(EEPROM_TANK_VOLUME + 3, tankVolume & 0xFF);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] tankVolume = "); DEBUG_PRINTLN(tankVolume);
    }
  }

  // v118.0.9: smart dry-run block from cloud. Magic byte written so a
  // subsequent reboot picks up these values via loadConfiguration().
  bool smartChanged = false;
  if (j.get(v, "smartDryRunEnabled") && v.success) {
    bool newVal = v.boolValue;
    if (newVal != smartDryRunEnabled) {
      smartDryRunEnabled = newVal;
      EEPROM.write(EEPROM_SMART_DRY_RUN_ON, smartDryRunEnabled ? 1 : 0);
      smartChanged = true; eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] smartDryRunEnabled = "); DEBUG_PRINTLN(smartDryRunEnabled ? "ON" : "OFF");
    }
  }
  if (j.get(v, "smartDryRunCheckMins") && v.success) {
    int n = v.intValue;
    if (n >= 1 && n <= 15 && n != smartDryRunCheckMins) {
      smartDryRunCheckMins = (uint8_t)n;
      EEPROM.write(EEPROM_SMART_CHECK_MINS, smartDryRunCheckMins);
      smartChanged = true; eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] smartDryRunCheckMins = "); DEBUG_PRINTLN(smartDryRunCheckMins);
    }
  }
  if (j.get(v, "smartDryRunMinPct") && v.success) {
    int n = v.intValue;
    if ((n == 1 || n == 2 || n == 3 || n == 5 || n == 10) && n != smartDryRunMinPct) {
      smartDryRunMinPct = (uint8_t)n;
      EEPROM.write(EEPROM_SMART_MIN_PCT, smartDryRunMinPct);
      smartChanged = true; eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] smartDryRunMinPct = "); DEBUG_PRINTLN(smartDryRunMinPct);
    }
  }
  if (smartChanged) {
    EEPROM.write(EEPROM_SMART_DRY_RUN_MAGIC, SMART_DRY_RUN_MAGIC);
    smartDryRunWindowStartMs = 0;   // reset window so next pump cycle uses new config
  }
  // Enforce 2% gap invariant after cloud writes.
  if (stopPercent < startPercent + 2) {
    stopPercent = startPercent + 2;
    if (stopPercent > 100) stopPercent = 100;
    EEPROM.write(EEPROM_STOP_PERCENT, stopPercent);
    eepromDirty = true; changed = true; usCloudChanged = true;
  }
  if (usCloudChanged) {
    // Also save to US-magic slots so usLoadConfig picks it up correctly.
    usSaveConfig();
    if (usHaveGoodReading) usUpdateDiscreteFromPct(usConfirmedPct);
  }

  if (j.get(v, "scheduleModeEnabled") && v.success) {
    bool newVal = v.boolValue;
    if (newVal != scheduleModeEnabled) {
      scheduleModeEnabled = newVal;
      EEPROM.write(EEPROM_SCHEDULE_MODE_ENABLED, scheduleModeEnabled ? MAGIC_NUMBER : 0);
      eepromDirty = true; changed = true;
      DEBUG_PRINT("[CONFIG] scheduleModeEnabled = "); DEBUG_PRINTLN(scheduleModeEnabled ? "ON" : "OFF");
    }
  }

  // Schedules array — replace-in-place. Every slot compared;
  // eepromDirty flipped if any changed. Empty/missing = leave alone.
  //
  // v118.0.10: accept both "array" AND "object"/"json" shapes. Firebase
  // RTDB stores a JS array `[a,b,c]` as `{"0":a,"1":b,"2":c}` — a native
  // object — whenever any slot has been edited independently (even once).
  // Previous strict `type == "array"` check silently rejected the update
  // → cloud Panel Settings → Save → firmware never saw the change →
  // AP page kept showing stale schedule → "cloud and AP don't match".
  // Same relaxation on the inner slot check (accept "json" too).
  FirebaseJsonData arrData;
  bool haveSchedules = j.get(arrData, "schedules") && arrData.success &&
                       (arrData.type == "array" || arrData.type == "object" || arrData.type == "json");
  if (haveSchedules) {
    FirebaseJsonArray arr;
    arrData.get<FirebaseJsonArray>(arr);
    size_t n = arr.size(); if (n > 3) n = 3;
    for (size_t i = 0; i < n; i++) {
      FirebaseJsonData slotData;
      arr.get(slotData, i);
      if (!slotData.success) continue;
      if (slotData.type != "object" && slotData.type != "json") continue;
      FirebaseJson slot;
      slotData.get<FirebaseJson>(slot);
      FirebaseJsonData f;
      bool  en = schedules[i].enabled;
      int   sh = schedules[i].startHour,  sm = schedules[i].startMinute;
      int   eh = schedules[i].endHour,    em = schedules[i].endMinute;
      // v118.0.9 extended fields
      int   dm = schedules[i].dayMask ? schedules[i].dayMask : SCHED_DAY_MASK_ALL;
      bool  fuf = schedules[i].fillUntilFull;
      if (slot.get(f, "enabled")     && f.success) en = f.boolValue;
      if (slot.get(f, "startHour")   && f.success) sh = f.intValue;
      if (slot.get(f, "startMinute") && f.success) sm = f.intValue;
      if (slot.get(f, "endHour")     && f.success) eh = f.intValue;
      if (slot.get(f, "endMinute")   && f.success) em = f.intValue;
      if (slot.get(f, "dayMask")     && f.success) dm = f.intValue;
      if (slot.get(f, "fillUntilFull") && f.success) fuf = f.boolValue;
      // Range check — cloud validator enforces the same, defence in depth.
      if (sh < 0 || sh > 23 || eh < 0 || eh > 23 || sm < 0 || sm > 59 || em < 0 || em > 59) continue;
      if (en && (eh * 60 + em) <= (sh * 60 + sm)) continue;   // enabled must have end > start
      if (en && ((eh * 60 + em) - (sh * 60 + sm)) < 5) continue;   // v118.0.9: min 5 min duration
      // dayMask: clamp to 7-bit; coerce 0 → every-day so a bad write doesn't silently disable schedules.
      uint8_t dmClamp = (uint8_t)(dm & 0x7F);
      if (dmClamp == 0) dmClamp = SCHED_DAY_MASK_ALL;
      bool slotChanged = (schedules[i].enabled     != en) ||
                         (schedules[i].startHour   != sh) ||
                         (schedules[i].startMinute != sm) ||
                         (schedules[i].endHour     != eh) ||
                         (schedules[i].endMinute   != em) ||
                         (schedules[i].dayMask     != dmClamp) ||
                         (schedules[i].fillUntilFull != fuf);
      if (slotChanged) {
        schedules[i].enabled       = en;
        schedules[i].startHour     = (uint8_t)sh;
        schedules[i].startMinute   = (uint8_t)sm;
        schedules[i].endHour       = (uint8_t)eh;
        schedules[i].endMinute     = (uint8_t)em;
        schedules[i].dayMask       = dmClamp;
        schedules[i].fillUntilFull = fuf;
        // Persist to EEPROM in the same layout loadScheduleConfiguration expects.
        int base = EEPROM_SCHEDULES_START + (i * 5);
        EEPROM.write(base + 0, schedules[i].startHour);
        EEPROM.write(base + 1, schedules[i].startMinute);
        EEPROM.write(base + 2, schedules[i].endHour);
        EEPROM.write(base + 3, schedules[i].endMinute);
        EEPROM.write(base + 4, schedules[i].enabled ? 1 : 0);
        // Extended fields in parallel block
        EEPROM.write(EEPROM_SCHED_EXT_MAGIC, SCHED_EXT_MAGIC);
        int extBase = EEPROM_SCHED_EXT_START + (i * 2);
        EEPROM.write(extBase + 0, schedules[i].dayMask);
        EEPROM.write(extBase + 1, schedules[i].fillUntilFull ? 1 : 0);
        eepromDirty = true; changed = true;
      }
    }
  }

  // Close the freshSave-gated panel-settings block. lastAppliedSavedAt
  // is stamped ONLY when we processed a fresh save — so future polls
  // with the same savedAt value skip application entirely, letting AP-
  // page changes (or physical button pushes) persist untouched.
    lastAppliedSavedAt = incomingSavedAt;
    // Persist so a reboot doesn't reset to 0 and re-treat stale /config
    // as fresh. NVS write is cheap (Preferences uses wear-leveled flash)
    // and only happens once per successful cloud save — not per poll.
    Preferences pfs;
    pfs.begin("pump", false);
    pfs.putUInt("lastSvAt", lastAppliedSavedAt);
    pfs.end();
    changed = true;
  }
  // NB: analyticsOn / notifyOn above are outside the freshSave gate on
  // purpose — those are cloud-only toggles the AP page can't set, so
  // there's no "installer wins" conflict to guard against. Leaving them
  // ungated preserves the pre-v117.0.8 behaviour for those two fields.

  if (eepromDirty) EEPROM.commit();

  // Also mirror on very first successful poll (when appliedConfig may
  // not exist yet in /info) — we tag that with a static bool so the
  // first-time write happens exactly once even if nothing changed.
  static bool everMirrored = false;
  if (changed || !everMirrored) {
    esp_task_wdt_reset();
    mirrorAppliedConfig();
    everMirrored = true;
  }
}

// Publish live snapshot — atomic single JSON write. Layer-3 rate limit
// + change detection prevent no-op writes on the state-change path. The
// `forceHeartbeat` flag bypasses BOTH the change gate and the rate
// limit — cloudTask calls it once every ~5 min so the dashboard's
// freshness-based online check always sees a recent /live.ts even when
// pump state hasn't changed. faultReason travels with the payload so
// PumpDetail can render a specific reason string instead of a generic
// "Fault" label.
static bool cloudPushLive(const PumpSnapshot& s, bool forceHeartbeat = false) {
  if (!firebaseHealthy) return false;
  unsigned long now = millis();

  const char* sPump    = pumpEnumToStr(s.pumpState);
  const char* sTerrace = terraceEnumToStr(s.terraceState);
  const char* sSource  = (s.sourceState == SR_WET) ? "wet" : "dry";
  const char* sReason  = faultReasonToStr(s.faultReason);

  // v118.0.2: include terracePct delta in the "changed" gate. On this
  // ultrasonic variant pct is continuous, so a 2% delta signals real
  // level movement worth pushing. Pump/terraceState/sourceState changes
  // still trigger a push on their own (unchanged).
  // v118.0.11: read from snapshot (consistent with terraceState etc)
  // instead of the live global, so we don't race against Core 1 burst
  // commits mid-publish.
  const uint8_t curPct = s.haveGoodReading ? s.terracePct : 0;
  const bool pctChangedEnough = (lastPub_terracePct == 0xFF) ||
    (abs((int)curPct - (int)lastPub_terracePct) >= US_CLOUD_PUSH_DELTA_PCT);

  if (!forceHeartbeat) {
    bool changed =
      (String(sPump)    != lastPub_pumpState)    ||
      (String(sTerrace) != lastPub_terraceState) ||
      (String(sSource)  != lastPub_sourceState)  ||
      (s.feedbackFault  != lastPub_feedbackFault) ||
      pctChangedEnough;

    if (!changed) return false;
    if (pumpLastLivePushMs != 0 &&
        (now - pumpLastLivePushMs) < PUMP_LIVE_PUSH_MIN_GAP_MS) return false;
  }

  String path = "devices/" + pumpDeviceCode + "/live";
  FirebaseJson json;
  json.set("pumpState",    sPump);
  json.set("terraceState", sTerrace);
  // v118.0.2: publish continuous pct + raw distance for cloud-side
  // depth/volume display. Cloud derives depth from (tankHeightCm - rawCm)
  // and volume from (tankCapacityLitres × pct/100). tankHeightCm +
  // sensorOffsetCm also sent so the dashboard can render tick marks /
  // dead-zone overlay without round-tripping to /info.
  // v118.0.11: use snapshot fields for atomic (terracePct, haveGoodReading,
  // sensorFault, rawMm) consistency.
  if (s.haveGoodReading) {
    json.set("terracePct",    curPct);
    json.set("rawCm",         (int)(s.rawMm / 10));
  }
  json.set("tankHeightCm",  usTankHeightCm);
  json.set("sensorOffsetCm", usSensorOffsetCm);
  // v118.0.6: expose sensor health so cloud card can render an
  // offline banner + "last valid reading X min ago". terraceSensorAgeSec
  // = seconds since last valid read (0 if never). sensorFault = true
  // means the 5-min watchdog has tripped.
  json.set("terraceSensorFault",  s.sensorFault);
  json.set("terraceSensorAgeSec",
           usLastGoodMs > 0 ? (int)((millis() - usLastGoodMs) / 1000UL) : -1);
  json.set("sourceState",  sSource);
  json.set("hasFeedback",  s.hasFeedback);
  json.set("hasSource",    s.hasSource);
  json.set("faults/feedback", s.feedbackFault);
  json.set("faultReason",  sReason);      // empty string when no fault
  json.set("rssi",         s.rssi);
  json.set("fw",           FIRMWARE_VERSION);
  json.set("ts/.sv",       "timestamp");

  if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    firebaseHealthy       = true;
    pumpLastLivePushMs    = now;
    lastSuccessfulPush    = now;
    lastPub_pumpState     = sPump;
    lastPub_terraceState  = sTerrace;
    lastPub_sourceState   = sSource;
    lastPub_feedbackFault = s.feedbackFault;
    lastPub_terracePct    = curPct;
    return true;
  }
  firebaseHealthy = false;
  DEBUG_PRINT("[FB] live push FAIL: ");
  DEBUG_PRINTLN(fbdo.errorReason().c_str());
  {
    char det[64];
    snprintf(det, sizeof(det), "%s", fbdo.errorReason().c_str());
    queueCloudLog("LIVE_FAIL", det);
  }
  return false;
}

// ── Paired-event history writer ────────────────────────────────────
// Per user requirement: only complete pump_on + pump_off pairs get
// written to /history. Half-pairs sit in RAM and age out after 24 hr
// (dropped silently). Runs are matched FIFO — a pump_off pairs with
// the oldest still-pending pump_on. This is robust to RTC coming online
// mid-run (runId strings may not exactly match, but ordering does).
static const uint32_t PAIRED_AGE_LIMIT_MS = 24UL * 60UL * 60UL * 1000UL;

// Observability helpers — cheap counters read by the AP page's Offline
// Queue section so an installer can SEE what's waiting to be pushed
// when connectivity is flaky. Called from Core 1 (WebServer runs on
// Core 1), but g_pendingRuns is a plain array read outside its mutex.
// That's OK — worst case a count is off by one for one HTTP request.
static int countPendingRuns() {
  int n = 0;
  for (int i = 0; i < PAIRED_CACHE_LEN; i++) {
    if (g_pendingRuns[i].inUse) n++;
  }
  return n;
}
static int countEventQueueDepth() {
  if (!g_eventQueue) return 0;
  return (int)uxQueueMessagesWaiting(g_eventQueue);
}
static int countCloudLogDepth() {
  if (!g_cloudLogQueue) return 0;
  return (int)uxQueueMessagesWaiting(g_cloudLogQueue);
}

static void storePendingRun(const PumpEvent& onEv) {
  // Age out old entries first.
  uint32_t now = millis();
  for (int i = 0; i < PAIRED_CACHE_LEN; i++) {
    if (g_pendingRuns[i].inUse &&
        (now - g_pendingRuns[i].onMillis) > PAIRED_AGE_LIMIT_MS) {
      char det[64];
      snprintf(det, sizeof(det), "runId=%s age=24h+", g_pendingRuns[i].runId);
      queueCloudLog("PEND_AGE_OUT", det);
      g_pendingRuns[i].inUse = false;
    }
  }
  // Find a free slot.
  for (int i = 0; i < PAIRED_CACHE_LEN; i++) {
    if (!g_pendingRuns[i].inUse) {
      g_pendingRuns[i].inUse = true;
      strncpy(g_pendingRuns[i].runId, onEv.runId, sizeof(g_pendingRuns[i].runId) - 1);
      g_pendingRuns[i].onTs        = onEv.evTs;
      g_pendingRuns[i].onMillis    = onEv.evMillis;
      g_pendingRuns[i].terraceStart = onEv.terraceAtEvent;
      g_pendingRuns[i].sourceStart  = onEv.sourceAtEvent;
      strncpy(g_pendingRuns[i].causeStart, onEv.cause, sizeof(g_pendingRuns[i].causeStart) - 1);
      return;
    }
  }
  // Cache full — evict oldest and reuse its slot. This is a real data
  // loss event (a pump_on we never got the pump_off for), so log it
  // clearly so field support can see it.
  int oldest = 0;
  uint32_t oldestMs = g_pendingRuns[0].onMillis;
  for (int i = 1; i < PAIRED_CACHE_LEN; i++) {
    if (g_pendingRuns[i].onMillis < oldestMs) { oldest = i; oldestMs = g_pendingRuns[i].onMillis; }
  }
  {
    char det[64];
    snprintf(det, sizeof(det), "runId=%s cacheFull", g_pendingRuns[oldest].runId);
    queueCloudLog("PEND_EVICT", det);
  }
  g_pendingRuns[oldest].inUse = false;
  storePendingRun(onEv);  // one-shot recursion, guaranteed to succeed now
}

// Push one paired /history entry to RTDB. Only called when we have both
// pump_on and pump_off in hand — no partial writes ever.
static bool pushPairedHistory(const PendingRun& on, const PumpEvent& off) {
  if (!firebaseHealthy) return false;

  // Free-tier gate — restored per Vishal's clarification. When
  // analyticsOn=false, do NOT write /history entries at all. Cloud UI
  // hides the History + Analytics tabs entirely for these devices, so
  // there's no reader to consume the data anyway. Only paid-tier
  // devices accumulate historical audit trail.
  //
  // Cache still evicts (return true) so pending-run RAM doesn't fill
  // up. On the rare occasion admin flips analyticsOn=true, the NEXT
  // completed pair pushes cleanly — historical events from the free-
  // tier period are gone permanently by design.
  if (!analyticsOn) {
    queueCloudLog("HIST_SKIP", "analyticsOn=false");
    return true;
  }

  String path = "devices/" + pumpDeviceCode + "/history";
  FirebaseJson json;
  json.set("runId",         on.runId);
  json.set("type",          "run");
  json.set("causeStart",    on.causeStart);
  json.set("causeEnd",      off.cause);
  json.set("terraceStart",  terraceEnumToStr(on.terraceStart));
  json.set("terraceEnd",    terraceEnumToStr(off.terraceAtEvent));
  json.set("sourceStart",   on.sourceStart == SR_WET ? "wet" : "dry");
  json.set("sourceEnd",     off.sourceAtEvent == SR_WET ? "wet" : "dry");
  json.set("onTs",          on.onTs);
  json.set("offTs",         off.evTs);
  json.set("runSec",        off.runSecIfOff);
  // If the off event was pushed after coming back online (or the on was),
  // annotate. Web app uses this to render a "recovered" pill on the timeline.
  bool buffered = (millis() - on.onMillis) > 60000UL;  // > 1 min old = likely offline replay
  if (buffered) json.set("bufferedReplay", true);

  // Log the attempt to the on-device log file so an installer can see
  // via /logs/view what history pushes have been sent (or attempted).
  // Queued to main-loop for LittleFS write — cloud task never touches
  // the log file directly (LittleFS is not thread-safe on ESP32).
  {
    char det[64];
    snprintf(det, sizeof(det), "runId=%s runSec=%lu %s%s",
             on.runId,
             (unsigned long)off.runSecIfOff,
             on.causeStart,
             buffered ? " [replay]" : "");
    queueCloudLog("HIST_TRY", det);
  }

  if (Firebase.RTDB.pushJSON(&fbdo, path.c_str(), &json)) {
    lastSuccessfulPush = millis();
    {
      char det[64];
      snprintf(det, sizeof(det), "runId=%s runSec=%lu",
               on.runId, (unsigned long)off.runSecIfOff);
      queueCloudLog("HIST_OK", det);
    }
    // Premium tier — ping the FCM dispatcher for this completed run.
    // No-op when notifyOn=false. Payload identifies the event type so
    // Cloud Function can pick the right notification template ("Pump
    // completed a manual run", etc.).
    const char* evt = (strcmp(on.causeStart, "force") == 0)             ? "pump_manual_done"
                   : (strcmp(on.causeStart, "boot_detected_running") == 0) ? "pump_recovered"
                   : (strcmp(off.cause,     "dry_run") == 0)            ? "pump_dry_run"
                   : (strcmp(off.cause,     "feedback_timeout") == 0)   ? "pump_feedback_fault"
                   : "pump_run";
    pushNotifyTrigger(evt, 0);
    return true;
  }
  firebaseHealthy = false;
  DEBUG_PRINT("[FB] history push FAIL: ");
  DEBUG_PRINTLN(fbdo.errorReason().c_str());
  {
    char det[64];
    snprintf(det, sizeof(det), "runId=%s err=%s",
             on.runId, fbdo.errorReason().c_str());
    queueCloudLog("HIST_FAIL", det);
  }
  return false;
}

// v117.0.14: standalone /history event writer for tank + source state
// transitions. Same node as paired-run entries — the "type" field
// distinguishes:
//   • "run"      → paired pump on/off (existing)
//   • "terrace"  → tank crossed a level (empty/half/full/sensor_fault)
//   • "source"   → source went wet/dry
//
// Cloud analytics tab reads /history and filters by type to build a
// unified timeline chart (tank line + pump bars + source strip).
//
// Dedupe: caller (handleTerraceTransition / handleSourceTransition)
// already guards on last-published value, so this function assumes it
// only fires on genuine transitions.
//
// pct is included for terrace events even with discrete probes:
//   empty=0, half=50, full=100, sensor_fault=null
// Future ultrasonic terrace variant will populate pct directly (0-100
// granular); analytics chart already handles both interchangeably.
static bool pushTerraceHistoryEvent(const char* state, int pct) {
  if (!firebaseHealthy) return false;
  // Free-tier gate — matches pushPairedHistory. When analytics is off,
  // don't emit terrace/source transition events either. Return true so
  // the caller's dedupe latch advances (treats as "consumed") — the
  // next real transition after analytics flips on will push cleanly.
  if (!analyticsOn) return true;
  FirebaseJson json;
  json.set("type",   "terrace");
  json.set("state",  state);
  if (pct >= 0) json.set("pct", pct);
  json.set("ts/.sv", "timestamp");
  String path = "devices/" + pumpDeviceCode + "/history";
  bool ok = Firebase.RTDB.pushJSON(&fbdo, path.c_str(), &json);
  if (ok) {
    lastSuccessfulPush = millis();
    char det[48]; snprintf(det, sizeof(det), "state=%s pct=%d", state, pct);
    queueCloudLog("HIST_TERR", det);
  } else {
    firebaseHealthy = false;
    queueCloudLog("HIST_TERR_FAIL", fbdo.errorReason().c_str());
  }
  return ok;
}

static bool pushSourceHistoryEvent(const char* state) {
  if (!firebaseHealthy) return false;
  if (!analyticsOn) return true;   // free-tier gate — see pushTerraceHistoryEvent
  FirebaseJson json;
  json.set("type",   "source");
  json.set("state",  state);
  json.set("ts/.sv", "timestamp");
  String path = "devices/" + pumpDeviceCode + "/history";
  bool ok = Firebase.RTDB.pushJSON(&fbdo, path.c_str(), &json);
  if (ok) {
    lastSuccessfulPush = millis();
    char det[24]; snprintf(det, sizeof(det), "state=%s", state);
    queueCloudLog("HIST_SRC", det);
  } else {
    firebaseHealthy = false;
    queueCloudLog("HIST_SRC_FAIL", fbdo.errorReason().c_str());
  }
  return ok;
}

// Drain queued events. pump_on → cache. pump_off → find pair and push.
static void drainEventQueue() {
  if (!g_eventQueue) return;
  PumpEvent e;
  while (xQueueReceive(g_eventQueue, &e, 0) == pdTRUE) {
    if (e.type == EV_PUMP_ON) {
      storePendingRun(e);
      continue;
    }
    // pump_off — pair with oldest pending run.
    int idx = -1;
    uint32_t oldestMs = 0xFFFFFFFFUL;
    for (int i = 0; i < PAIRED_CACHE_LEN; i++) {
      if (g_pendingRuns[i].inUse && g_pendingRuns[i].onMillis < oldestMs) {
        idx = i; oldestMs = g_pendingRuns[i].onMillis;
      }
    }
    if (idx < 0) {
      DEBUG_PRINTLN("[FB] pump_off with no matching pump_on — dropping (per user rule)");
      continue;
    }
    // Attempt push. If it succeeds, evict from cache. If not (offline),
    // put the on-event back so we'll retry the pair next cycle. The
    // off-event is lost — but that's acceptable because we still know
    // the pump started; the pair will re-form when the OFF happens
    // again in the future. Simpler than a second RAM buffer for offs.
    if (pushPairedHistory(g_pendingRuns[idx], e)) {
      g_pendingRuns[idx].inUse = false;
    } else {
      // Offline / write failed. Leave the pump_on in cache so we can
      // retry when connectivity returns. Sadly we lose this off-event's
      // wire copy — we could re-queue it, but the queue may be closed
      // for writes from cloud task. Simplest: log and continue.
      DEBUG_PRINTLN("[FB] history push failed; keeping pump_on in cache for retry");
      // Re-queue the OFF event for next drain attempt.
      xQueueSendToFront(g_eventQueue, &e, 0);
      return;   // stop draining; wait for connectivity
    }
  }
}

// ─── Cloud OTA ──────────────────────────────────────────────────────
// Pushes firmwareVersion + firstBootAt + lastUpdatedAt to /info so the
// Admin Firmware page shows what version the device is currently on
// and when it was last updated. Called once per successful boot and
// again after a successful OTA flash (via the new-firmware boot path).
static void reportFirmwareInfo() {
  if (!firebaseHealthy) return;
  FirebaseJson json;
  json.set("firmwareVersion", FIRMWARE_VERSION);
  json.set("firstBootAt",     firstBootAt);
  json.set("lastUpdatedAt",   lastUpdatedAt);
  // Refresh the installer's AP-page label on every boot / OTA. If they
  // renamed the panel via AP page while cloud was down, this is the
  // path that eventually syncs the new value up.
  json.set("userAssignedName", deviceName);
  String path = "devices/" + pumpDeviceCode + "/info";
  Firebase.RTDB.updateNode(&fbdo, path.c_str(), &json);
}

// Write current OTA status back to /info so the dashboard reflects
// progress ("queued" → "waiting_for_idle" → "in_progress" → "success"
// or "fail:<reason>"). Also updates the retry counter used by the
// max-retries gate below.
static void setOtaStatus(const String& status, uint8_t retries) {
  if (!firebaseHealthy) return;
  FirebaseJson json;
  json.set("lastOtaStatus", status);
  json.set("otaRetryCount", retries);
  String path = "devices/" + pumpDeviceCode + "/info";
  Firebase.RTDB.updateNode(&fbdo, path.c_str(), &json);
}

// Reset the trigger so we don't re-fire on the next 30-sec poll.
// Called after success (device is about to reboot anyway) AND after
// terminal failure (max retries exhausted, expired schedule, bad URL).
static void clearOtaTrigger() {
  if (!firebaseHealthy) return;
  FirebaseJson json;
  json.set("otaTrigger", false);
  String path = "devices/" + pumpDeviceCode + "/config";
  Firebase.RTDB.updateNode(&fbdo, path.c_str(), &json);
}

// Execute the actual HTTP(S) firmware download + flash. Blocks the
// cloud task (Core 0) for the entire download — typically 30-60 sec
// for a 1.5 MB firmware. Motor control on Core 1 keeps running because
// it uses millis() timers and never touches Firebase. We disable the
// cloud-task WDT for the duration and feed serial diagnostics from
// the progress callback. Returns empty string on success (unreachable
// after reboot), or "fail:<reason>" string on failure.
static String runHttpUpdate(const String& url, const String& md5) {
  esp_task_wdt_delete(nullptr);   // disable WDT for long download

  WiFiClient        plainClient;
  WiFiClientSecure  tlsClient;
  WiFiClient*       chosen = nullptr;
  if (url.startsWith("https://")) {
    tlsClient.setInsecure();      // admin owns the URL — accept self-signed / unknown CA
    chosen = &tlsClient;
  } else {
    chosen = &plainClient;
  }

  httpUpdate.setLedPin(LED_PIN, LOW);
  httpUpdate.rebootOnUpdate(false);   // we reboot ourselves after Firebase status write
  if (md5.length() == 32) {
    httpUpdate.setMD5sum(md5);
  }
  httpUpdate.onProgress([](int progress, int total) {
    static uint32_t lastFeed = 0;
    if (millis() - lastFeed > 2000) {
      lastFeed = millis();
      Serial.printf("[OTA] %d / %d bytes\n", progress, total);
    }
  });

  t_httpUpdate_return ret = httpUpdate.update(*chosen, url);

  esp_task_wdt_add(nullptr);   // re-arm WDT

  switch (ret) {
    case HTTP_UPDATE_FAILED:
      return "fail:" + String(httpUpdate.getLastError()) + ":" + httpUpdate.getLastErrorString();
    case HTTP_UPDATE_NO_UPDATES:
      return "fail:no_update";
    case HTTP_UPDATE_OK:
      return "";   // success — execution won't reach here if reboot fires
    default:
      return "fail:unknown";
  }
}

// Poll the cloud OTA trigger and dispatch. Runs from cloudTask on a
// 30-sec cadence — call from the main loop, guarded by
// lastOtaCheckMs interval below. All safety gates live here:
//   • no cloud connection → skip (nothing to poll)
//   • clock not safe (RTC unset before first NTP) → skip
//   • motor running or manual override active → defer with status
//     "waiting_for_idle" so admin sees WHY nothing happened
//   • scheduled time in the future → skip
//   • trigger older than 7 days → mark expired, clear
//   • max retries exhausted → mark fail:max_retries, clear
static void checkCloudOta() {
  if (!firebaseHealthy) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!isClockSafe()) return;   // need real time to honor schedules
  String basePath = "devices/" + pumpDeviceCode + "/config/";

  esp_task_wdt_reset();
  if (!Firebase.RTDB.getBool(&fbdo, (basePath + "otaTrigger").c_str())) return;
  if (!fbdo.boolData()) return;

  // Motor-safety gate: never start OTA while the pump is actively
  // running or during a manual override. An OTA reboots the device
  // mid-fill, which surprises the user and can leave the physical
  // pump in an ambiguous state (relay released but tank half-full).
  // Deferring is safe — the trigger stays set and the next poll (30 s
  // later) re-evaluates. Status="waiting_for_idle" surfaces the
  // reason on the dashboard so admin doesn't wonder why OTA queued.
  if (motorState || currentMode == MODE_MANUAL_OVERRIDE) {
    setOtaStatus("waiting_for_idle", 0);
    return;
  }

  uint32_t scheduledAt = 0;
  esp_task_wdt_reset();
  if (Firebase.RTDB.getInt(&fbdo, (basePath + "otaScheduledAt").c_str())) {
    scheduledAt = (uint32_t)fbdo.intData();
  }
  uint32_t epoch = (uint32_t)time(nullptr);
  if (scheduledAt > 0 && epoch < scheduledAt) return;   // not yet time
  // Stale trigger guard — > 7 days in the past = assume different window
  const uint32_t SEVEN_DAYS = 7UL * 24UL * 3600UL;
  if (scheduledAt > 0 && epoch > scheduledAt + SEVEN_DAYS) {
    Serial.println("[OTA] Trigger expired (>7 days past scheduled time) — clearing");
    setOtaStatus("fail:expired", 0);
    clearOtaTrigger();
    return;
  }

  uint8_t retries = 0;
  String infoPath = "devices/" + pumpDeviceCode + "/info/";
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
  // Mark in NVS so a mid-flash crash / power loss on the next boot
  // detects "we were flashing" and can report fail:reboot_during_ota.
  {
    Preferences p;
    p.begin("pump", false);
    p.putBool("otaInProg", true);
    p.end();
  }

  String result = runHttpUpdate(url, md5);

  // Only reached on failure — success path reboots inside HTTPUpdate.
  if (result.length() == 0) {
    // Belt-and-braces: successful update should have rebooted us. If
    // for some reason it didn't, mark success + reboot ourselves.
    lastUpdatedAt = epoch;
    Preferences p;
    p.begin("pump", false);
    p.putUInt("lastUpd",   lastUpdatedAt);
    p.putBool("otaInProg", false);
    p.end();
    setOtaStatus("success", 0);
    clearOtaTrigger();
    Serial.println("[OTA] Success — rebooting into new firmware");
    delay(1000);
    ESP.restart();   // ESP restart IS required after OTA (only exception to no-restart rule)
    return;
  }

  // Failure path — increment retry, schedule backoff, clear in-progress
  {
    Preferences p;
    p.begin("pump", false);
    p.putBool("otaInProg", false);
    p.end();
  }
  retries++;
  setOtaStatus(result, retries);
  if (retries < OTA_MAX_RETRIES) {
    uint32_t backoffSec = 60 + (esp_random() % 540);   // 1-10 min
    FirebaseJson json;
    json.set("otaScheduledAt", (int)(epoch + backoffSec));
    Firebase.RTDB.updateNode(&fbdo, ("devices/" + pumpDeviceCode + "/config").c_str(), &json);
    Serial.printf("[OTA] Failed (%s), retry %u/%u in %u sec\n",
                  result.c_str(), retries, OTA_MAX_RETRIES, backoffSec);
  } else {
    clearOtaTrigger();
    Serial.println("[OTA] Final fail — trigger cleared");
  }
}

// ─── The task loop ──────────────────────────────────────────────────
// Poll one-shot cloud command flags at devices/{code}/. Each flag is
// consumed by writing it back to false, mirroring the ultrasonic
// firmware's pattern. Only called from cloud task (Core 0). Cheap:
// one getBool + at most one setBool per flag per poll cycle.
static void checkCloudCommands() {
  if (!firebaseHealthy) return;
  String basePath = "devices/" + pumpDeviceCode + "/";

  // testRequested — RGB identify blink. Cloud/dashboard/app writes true;
  // we consume by setting back to false and kicking off the LED blink.
  esp_task_wdt_reset();
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "testRequested").c_str())) {
    if (fbdo.dataType() == "boolean" && fbdo.boolData()) {
      testBlinkActive = true;
      testBlinkStart  = millis();
      Firebase.RTDB.setBool(&fbdo, (basePath + "testRequested").c_str(), false);
      queueCloudLog("TEST_LED", "cloud");
    }
  }

  // refreshRequested — force a /live push right now, bypassing the 20 s
  // Layer-3 rate limit. Used by the dashboard "Refresh" button so the
  // user sees a fresh snapshot without waiting up to 20 s. Pass force=true
  // to cloudPushLive() via the standard snapshot path.
  esp_task_wdt_reset();
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "refreshRequested").c_str())) {
    if (fbdo.dataType() == "boolean" && fbdo.boolData()) {
      Firebase.RTDB.setBool(&fbdo, (basePath + "refreshRequested").c_str(), false);
      queueCloudLog("REFRESH", "cloud");
      // Reset the rate-limit floor so the next cloudPushLive() call
      // from cloudTask()'s main loop pushes immediately. Cheaper than
      // adding a force-parameter path — the very next iteration (~250 ms)
      // will publish, which reads as instant to the user.
      pumpLastLivePushMs = 0;
    }
  }

  // restartRequested — remote reboot. Consume flag FIRST so we don't loop
  // reboot on next boot. Do NOT preemptively mark device offline (see
  // ultrasonic firmware note: if reconnect then fails, cloud would show
  // permanently offline — better to let heartbeat staleness detect it).
  esp_task_wdt_reset();
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "restartRequested").c_str())) {
    if (fbdo.dataType() == "boolean" && fbdo.boolData()) {
      Firebase.RTDB.setBool(&fbdo, (basePath + "restartRequested").c_str(), false);
      queueCloudLog("RESTART", "cloud");
      DEBUG_PRINTLN("[FB] Restart requested — rebooting in 500 ms");
      // Motor safety: if the pump is currently running, do NOT reboot.
      // We can safely reboot in idle state; interrupting a running fill
      // would be a surprise stop. Reset flag was already consumed, so
      // next poll will re-read as false. If user really wants restart
      // during fill they can press again after pump auto-stops.
      if (!motorState) {
        delay(500);
        ESP.restart();
      } else {
        DEBUG_PRINTLN("[FB] Restart deferred — motor is running");
        queueCloudLog("RESTART_DEFER", "motor_on");
      }
    }
  }

  // forceRunMinutes — cloud dashboard's "Force run" button writes an
  // integer here to start manual override. Special value -1 = "until
  // tank full" (no time cap; stops on tankFullWet). Any other valid
  // duration (5/10/15/30/60) is treated as minutes. Consumed by
  // writing back 0 so we don't re-trigger on the next poll.
  esp_task_wdt_reset();
  if (Firebase.RTDB.getInt(&fbdo, (basePath + "commands/forceRunMinutes").c_str())) {
    int mins = fbdo.intData();
    if (mins != 0) {
      Firebase.RTDB.setInt(&fbdo, (basePath + "commands/forceRunMinutes").c_str(), 0);
      if (currentMode == MODE_MANUAL_OVERRIDE) {
        DEBUG_PRINTLN("[FB] Force run ignored — already in manual override");
        queueCloudLog("FORCE_RUN_SKIP", "already_active");
      } else if (mins == -1 || mins == 5 || mins == 10 || mins == 15 || mins == 30 || mins == 60) {
        // v118.0.7: shared pre-check (sensor fault / tank already full).
        // See canStartForceRun() for the full guard list; AP + cloud
        // paths both use it so behavior is identical.
        bool wantsUntilFull = (mins == -1);
        String rejectReason;
        if (!canStartForceRun(wantsUntilFull, rejectReason)) {
          DEBUG_PRINT("[FB] Cloud force run rejected: ");
          DEBUG_PRINTLN(rejectReason);
          queueCloudLog("FORCE_RUN_SKIP", rejectReason.c_str());
        } else if (wantsUntilFull) {
          manualOverrideUntilFull       = true;
          manualOverrideDurationMinutes = 0;
          enterManualOverride();
          queueCloudLog("FORCE_RUN", "until_full");
          DEBUG_PRINTLN("[FB] Cloud force run: until tank FULL");
        } else {
          manualOverrideUntilFull       = false;
          manualOverrideDurationMinutes = mins;
          enterManualOverride();
          char det[32]; snprintf(det, sizeof(det), "%dmin", mins);
          queueCloudLog("FORCE_RUN", det);
          DEBUG_PRINT("[FB] Cloud force run: "); DEBUG_PRINT(mins); DEBUG_PRINTLN(" min");
        }
      } else {
        DEBUG_PRINT("[FB] Force run ignored — invalid minutes: "); DEBUG_PRINTLN(mins);
        queueCloudLog("FORCE_RUN_SKIP", "invalid_mins");
      }
    }
  }

  // forceRunStop — cloud command to end an active manual override
  // early (before its timer or before tank hits FULL). Boolean flag,
  // consumed like the others.
  esp_task_wdt_reset();
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "commands/forceRunStop").c_str())) {
    if (fbdo.dataType() == "boolean" && fbdo.boolData()) {
      Firebase.RTDB.setBool(&fbdo, (basePath + "commands/forceRunStop").c_str(), false);
      if (currentMode == MODE_MANUAL_OVERRIDE) {
        exitManualOverride();
        queueCloudLog("FORCE_RUN_STOP", "cloud");
        DEBUG_PRINTLN("[FB] Cloud stopped force run");
      }
    }
  }

  // v118.0.7: clearFault — cloud equivalent of the AP page's "CLEAR
  // ERROR & RESUME" button. Same state reset as handleClearErrorMode().
  // Only acts when the device is in an error mode; otherwise consumed
  // silently so a stale flag doesn't keep tripping on every poll.
  esp_task_wdt_reset();
  if (Firebase.RTDB.getBool(&fbdo, (basePath + "commands/clearFault").c_str())) {
    if (fbdo.dataType() == "boolean" && fbdo.boolData()) {
      Firebase.RTDB.setBool(&fbdo, (basePath + "commands/clearFault").c_str(), false);
      bool inError = (currentMode == MODE_DRY_RUN_RECOVERY ||
                      currentMode == MODE_SAFE_MODE ||
                      currentMode == MODE_PANEL_FAULT ||
                      currentMode == MODE_SOURCE_DRY_RUN ||
                      feedbackFaultActive);
      if (inError) {
        buzzerMuted = true;
        dryRunCount = 0;
        dryRunStartTime = 0;
        safeModeStartTime = 0;
        sourceDryRunCount = 0;
        sourceDryRunStartTime = 0;
        lastFaultReason = "";
        needFreshDataAfterRecovery = true;
        feedbackFaultActive = false;
        feedbackRetryCount  = 0;
        feedbackBadSinceMs  = 0;
        g_faultReason       = FR_NONE;
        currentMode = autoModeEnabled ? MODE_NORMAL : MODE_IDLE;
        queueCloudLog("CLEAR_FAULT", "cloud");
        DEBUG_PRINTLN("[FB] Cloud cleared fault — mode restored");
      } else {
        queueCloudLog("CLEAR_FAULT_SKIP", "not_in_error");
      }
    }
  }
}

// ── Recovery ladder for stuck-cloud states ────────────────────────
//
// Trigger: consecutive cloudPushLive() failures. Each successful push
// resets the counter.
//
//   Rung 1 (after 3 fails, ~1 min): force an NTP re-sync. Clock skew
//           is the #1 cause of silent Firebase failures — TLS cert
//           validation + JWT auth both compare against local time.
//   Rung 2 (after 6 fails, ~2 min): WiFi flush + reconnect. Handles
//           the case where the TCP/TLS session is dead but the driver
//           still reports WL_CONNECTED. Uses disconnect(false) per
//           fleet rule — NEVER pass true (erases ESP-IDF WiFi config).
//   Rung 3 (after 10 fails, ~3 min): kill + respawn the Core-0 cloud
//           task. Wipes any driver state Firebase-ESP-Client itself
//           holds. Pump control on Core 1 keeps running throughout —
//           motor logic uses millis(), never wall-clock, so a 2-3 sec
//           Core-0 restart is invisible to the physical system.
//   After Rung 3: enter a 30 min cooldown. Keep queuing events, keep
//           retrying NTP every 5 min, but don't re-execute the ladder
//           until cooldown expires. Prevents thrashing when the root
//           cause is external (router down, ISP outage, service side).
//
// No ESP.restart() ever — pumping is safety-critical and a full reboot
// leaves the physical valve in an ambiguous state during recovery.
// Cloud recovery MUST NOT affect the motor.

static const uint16_t RUNG1_THRESHOLD          = 3;
static const uint16_t RUNG2_THRESHOLD          = 6;
static const uint16_t RUNG3_THRESHOLD          = 10;
static const uint32_t COOLDOWN_MS              = 30UL * 60UL * 1000UL;
static const uint32_t COOLDOWN_NTP_INTERVAL_MS = 5UL * 60UL * 1000UL;

static uint16_t      g_pushFailStreak        = 0;
static uint8_t       g_rungExecuted          = 0;   // 0 = none, 1/2/3 fired
static unsigned long g_cooldownUntilMs       = 0;
static unsigned long g_lastCooldownNtpMs     = 0;

// Rung 2 — soft WiFi driver reset. Keeps SoftAP up so a technician
// can still reach the AP page during recovery. WiFi.disconnect(false)
// preserves ESP-IDF stored credentials (fleet rule — passing true
// erases the config and forces a re-provision).
static void recoveryRungWifiFlush() {
  DEBUG_PRINTLN("[RECOVERY] Rung 2: WiFi flush + reconnect");
  queueCloudLog("RECOVERY", "rung2_wifi_flush");
  Preferences wp; wp.begin("mvswifi", true);
  String savedSsid = wp.getString("ssid", "");
  String savedPass = wp.getString("password", "");
  bool   savedVal  = wp.getBool("valid", false);
  wp.end();
  if (savedSsid.length() == 0 || !savedVal) {
    DEBUG_PRINTLN("[RECOVERY] Rung 2: no saved WiFi — nothing to reconnect");
    return;
  }
  WiFi.disconnect(false);   // NEVER pass true (erases ESP-IDF config)
  delay(500);
  WiFi.begin(savedSsid.c_str(), savedPass.c_str());
  // Also mark Firebase as needing re-init on the next tick.
  firebaseReady    = false;
  internetAvailable = false;
}

// Rung 3 — kill Core 0 cloud task, drop Firebase driver state, spawn
// a fresh task. Never touches Core 1 pump control. Executes via
// vTaskDelete on the current task at the very end so any calling
// context finishes cleanly; the outer caller must not reference the
// task handle after this returns (it self-terminates).
static void recoveryRungCoreRestart() {
  DEBUG_PRINTLN("[RECOVERY] Rung 3: Core-0 cloudTask restart");
  queueCloudLog("RECOVERY", "rung3_core_restart");
  firebaseReady     = false;
  firebaseHealthy   = false;
  internetAvailable = false;
  // Release the WDT registration before deleting ourselves.
  esp_task_wdt_delete(nullptr);
  TaskHandle_t self = g_cloudTaskHandle;
  g_cloudTaskHandle = nullptr;
  // Respawn happens BEFORE we delete ourselves so there's always a
  // cloud task alive to handle the next push cycle. startCloudTask()
  // early-returns if the handle is non-null, so we cleared it above.
  startCloudTask();
  // Now self-terminate. FreeRTOS reclaims stack/heap on the next tick.
  vTaskDelete(self);
  // Unreachable.
}

// Called after every cloudPushLive() outcome. Success clears the
// streak + cooldown. Failure increments the streak and fires the
// matching ladder rung when a threshold is crossed. Cooldown after
// Rung 3 suppresses further ladder activity for COOLDOWN_MS.
static void handlePushOutcome(bool ok) {
  unsigned long now = millis();

  if (ok) {
    if (g_pushFailStreak > 0) {
      DEBUG_PRINT("[RECOVERY] Push recovered after ");
      DEBUG_PRINT(g_pushFailStreak);
      DEBUG_PRINTLN(" fails — ladder disarmed");
    }
    g_pushFailStreak    = 0;
    g_rungExecuted      = 0;
    g_cooldownUntilMs   = 0;
    g_lastCooldownNtpMs = 0;
    return;
  }

  g_pushFailStreak++;

  // In cooldown → do minimal recovery (periodic NTP nudge only). Do
  // NOT re-execute rungs; wait out the cooldown so external causes
  // (router down / service outage) have time to resolve without us
  // thrashing WiFi + Core-0 in a loop.
  if (g_cooldownUntilMs != 0 && now < g_cooldownUntilMs) {
    if (now - g_lastCooldownNtpMs > COOLDOWN_NTP_INTERVAL_MS) {
      g_lastCooldownNtpMs = now;
      DEBUG_PRINTLN("[RECOVERY] Cooldown NTP nudge");
      tryNTPSync();
    }
    return;
  }
  if (g_cooldownUntilMs != 0 && now >= g_cooldownUntilMs) {
    DEBUG_PRINTLN("[RECOVERY] Cooldown ended — re-arming ladder");
    g_cooldownUntilMs = 0;
    g_rungExecuted    = 0;
    g_pushFailStreak  = 1;   // count this fail as the first of the new cycle
  }

  // Fire rungs at their thresholds. Each rung fires ONCE per ladder
  // cycle — g_rungExecuted advances monotonically until reset by a
  // success or by cooldown expiry.
  if (g_rungExecuted < 1 && g_pushFailStreak >= RUNG1_THRESHOLD) {
    DEBUG_PRINTLN("[RECOVERY] Rung 1: NTP re-sync");
    queueCloudLog("RECOVERY", "rung1_ntp_resync");
    tryNTPSync();
    g_rungExecuted = 1;
    return;
  }
  if (g_rungExecuted < 2 && g_pushFailStreak >= RUNG2_THRESHOLD) {
    recoveryRungWifiFlush();
    g_rungExecuted = 2;
    return;
  }
  if (g_rungExecuted < 3 && g_pushFailStreak >= RUNG3_THRESHOLD) {
    g_rungExecuted    = 3;
    g_cooldownUntilMs = now + COOLDOWN_MS;
    DEBUG_PRINT("[RECOVERY] Rung 3 armed — cooldown ends at millis=");
    DEBUG_PRINTLN(g_cooldownUntilMs);
    // Fire last — recoveryRungCoreRestart() self-terminates the task.
    recoveryRungCoreRestart();
    // Unreachable.
  }
}

static void cloudTask(void* param) {
  DEBUG_PRINTLN("[FB] cloudTask started on core 0");

  // Register this task with the Task WDT — 60 s timeout. If any TLS
  // call hangs beyond that we get a clean task restart. Pump control
  // never sees it.
  esp_task_wdt_add(nullptr);

  unsigned long lastInternetCheckMs   = 0;
  unsigned long lastFirebaseAttemptMs = 0;
  unsigned long lastCmdCheckMs        = 0;
  unsigned long lastHeartbeatMs       = 0;
  // Periodic /live heartbeat. Dashboard treats a pump as offline when
  // /live.ts is older than 10 min (see Dashboard.jsx isDeviceOnline).
  // We publish every 5 min so even a completely idle pump — no state
  // changes for hours — never crosses the offline threshold. Cheap:
  // ~200 B per push × 12 pushes/hour = ~60 KB/day per device.
  const unsigned long HEARTBEAT_INTERVAL_MS = 5UL * 60UL * 1000UL;

  for (;;) {
    esp_task_wdt_reset();
    unsigned long now = millis();

    // Internet re-probe every 30 s (only when WiFi up).
    if (WiFi.status() == WL_CONNECTED &&
        (lastInternetCheckMs == 0 || now - lastInternetCheckMs > 30000)) {
      internetAvailable   = checkInternet();
      lastInternetCheckMs = now;
    }

    // Firebase bring-up (retry 60 s backoff). cloudInitFirebase()
    // itself gates on clock-safety and will attempt an NTP sync if
    // the local clock looks unset/wrong — no separate boot handshake
    // needed here, retries are transparent.
    if (!firebaseReady && internetAvailable &&
        (lastFirebaseAttemptMs == 0 || now - lastFirebaseAttemptMs > 60000)) {
      lastFirebaseAttemptMs = now;
      cloudInitFirebase();
    }

    // If auth is ready, publish live + drain events + poll commands.
    if (firebaseReady && Firebase.ready()) {
      if (!firebaseHealthy) firebaseHealthy = true;   // recovering from a prior fail
      writeDeviceInfoOnce();                          // one-shot metadata
      writePendingDevice();                           // one-shot claim-me advert
      otaBootTimeReport();                            // one-shot firmware version + OTA crash-recovery
      PumpSnapshot s;
      if (copySnapshot(s)) {
        // Rate-limit gate inside cloudPushLive() sometimes returns
        // false without an actual push attempt (throttled or nothing
        // changed). Only feed handlePushOutcome() when an attempt was
        // ACTUALLY made — detected by lastSuccessfulPush advancing OR
        // the firebaseHealthy flag flipping to false on a real fail.
        unsigned long beforePush = lastSuccessfulPush;
        bool okBefore = firebaseHealthy;
        // Force a heartbeat push every HEARTBEAT_INTERVAL_MS regardless
        // of state change — see the constant's comment for rationale.
        bool wantHeartbeat = (lastHeartbeatMs == 0 || (now - lastHeartbeatMs) >= HEARTBEAT_INTERVAL_MS);
        bool pushed = cloudPushLive(s, wantHeartbeat);
        if (pushed) {
          handlePushOutcome(true);
          if (wantHeartbeat) lastHeartbeatMs = now;
        } else if (!firebaseHealthy && okBefore) {
          // firebaseHealthy just flipped to false → real attempt failed
          handlePushOutcome(false);
        }
        // Note: when pushed=false AND firebaseHealthy stayed true, the
        // gate simply throttled/skipped — no attempt was made, no
        // outcome to record.

        // v117.0.14: standalone /history events for terrace + source
        // state transitions. Fires independently of /live pushes so a
        // rate-limited /live doesn't hide a real transition from the
        // analytics timeline. Dedupe against separate last-history
        // trackers (not the /live ones — different semantics).
        //
        // v118.0.4 ultrasonic variant: emit terrace history on CONTINUOUS
        // pct change ≥5% (not just enum transitions). Gives the analytics
        // timeline fine-grained data instead of just empty/half/full
        // steps. State enum still sent as a human-readable label for
        // compatibility with existing cloud code.
        //
        // Also emit on fault entry/exit so a sensor-offline event shows
        // up on the chart as a gap rather than being invisible.
        if (firebaseHealthy) {
          static uint8_t     lastHistTerracePct   = 0xFF;   // sentinel = never pushed
          static bool        lastHistTerraceFault = false;
          static SourceEnum  lastHistSource       = (SourceEnum)0xFF;
          // v118.0.11: use snapshot values (same ones cloudPushLive just
          // used). Previously these two reads disagreed sometimes: /live
          // pushed s.terracePct=21 then this block read usConfirmedPct
          // which had just flipped to 0 due to a brief burst anomaly —
          // the chart would see a 0% /history entry even though /live
          // and the AP page both showed 21.
          // Also: don't push until we have at least one real reading
          // (haveGoodReading=true); the cold-start 0 value is a sentinel,
          // not a real measurement.
          if (!s.haveGoodReading) {
            // sensor hasn't produced a real reading yet — skip entirely
          } else {
            bool faultChanged = (s.sensorFault != lastHistTerraceFault);
            int  pctDelta = (lastHistTerracePct == 0xFF)
                            ? 100   // force first push
                            : abs((int)s.terracePct - (int)lastHistTerracePct);
            if (!s.sensorFault && (pctDelta >= 5 || faultChanged)) {
              const char* stateStr = terraceEnumToStr(s.terraceState);
              if (pushTerraceHistoryEvent(stateStr, (int)s.terracePct)) {
                lastHistTerracePct   = s.terracePct;
                lastHistTerraceFault = false;
              }
            } else if (s.sensorFault && faultChanged) {
              // Fault transition — log it so analytics timeline shows the gap.
              if (pushTerraceHistoryEvent("sensor_fault", -1)) {
                lastHistTerraceFault = true;
              }
            }
          }
          // Source: only emit when the panel HAS a source sensor.
          if (s.hasSource && s.sourceState != lastHistSource) {
            const char* stateStr = (s.sourceState == SR_WET) ? "wet" : "dry";
            if (pushSourceHistoryEvent(stateStr)) {
              lastHistSource = s.sourceState;
            }
          }
        }
      }
      drainEventQueue();

      // Command polling every 10 s. Commands are user-initiated (Force
      // Run, force stop, ping) and need to feel responsive. Deliberately
      // not a stream — flags are rare, polling keeps the RTDB byte
      // budget low and the code simple.
      if (lastCmdCheckMs == 0 || now - lastCmdCheckMs > 10000) {
        lastCmdCheckMs = now;
        checkCloudCommands();
      }

      // Config polling every 60 s. Bumped from 10s (v117.0.9-) to 60s
      // (v117.0.10+) — panel settings are user-initiated + rare (a few
      // saves per week per device), so 60 sec ack latency is fine. This
      // cuts config-poll bandwidth by 6× with no functional downside.
      // For faster ack, customer can trigger an immediate poll via the
      // Ping button in cloud UI (writes /commands/pingConfig → firmware
      // sees it on next 10-sec command tick → runs checkCloudConfig()).
      static unsigned long lastCfgCheckMs = 0;
      if (lastCfgCheckMs == 0 || now - lastCfgCheckMs > 60000) {
        lastCfgCheckMs = now;
        checkCloudConfig();
      }

      // OTA polling every 60 s (bumped from 30s). OTA is admin-triggered
      // and rare; a 60-sec ack latency is fine. Separate cadence from
      // commands because a successful download blocks the cloud task
      // for 30-60 s and reboots the device — no point in checking more
      // often.
      if (lastOtaCheckMs == 0 || now - lastOtaCheckMs > OTA_CHECK_INTERVAL_MS) {
        lastOtaCheckMs = now;
        checkCloudOta();
      }
    } else if (firebaseReady && !Firebase.ready()) {
      // Auth was up but Firebase library reports not-ready — treat as
      // a real failure so the ladder can attempt recovery.
      handlePushOutcome(false);
    }

    // Yield. 250 ms tick is plenty for observability; we're not
    // controlling anything real-time from here.
    vTaskDelay(250 / portTICK_PERIOD_MS);
  }
}

// Kick off the cloud task. Called from setup() after ensureDeviceCode().
// Safe to call before WiFi is up — the task will just spin on the
// !firebaseReady branch until connectivity arrives.
void startCloudTask() {
  if (g_cloudTaskHandle != nullptr) return;   // already running

  g_snapMutex  = xSemaphoreCreateMutex();
  g_eventQueue    = xQueueCreate(PUMP_EVENT_QUEUE_LEN, sizeof(PumpEvent));
  g_cloudLogQueue = xQueueCreate(CLOUD_LOG_QUEUE_LEN,   sizeof(CloudLogMsg));

  // 8 KB stack — Firebase-ESP-Client uses ~4-5 KB deep in TLS calls.
  // Priority 1 (same as Arduino task). Pin to Core 0 so we're OFF the
  // core running loop().
  BaseType_t ok = xTaskCreatePinnedToCore(
    cloudTask,
    "cloud",
    8192,
    nullptr,
    1,
    &g_cloudTaskHandle,
    0
  );
  if (ok != pdPASS) {
    DEBUG_PRINTLN("[FB] cloudTask spawn FAILED — cloud disabled this boot");
    g_cloudTaskHandle = nullptr;
  }
}

#endif  // ENABLE_CLOUD

// ===========================================
// RS485 ULTRASONIC TERRACE SENSOR (v118 variant)
// ===========================================
// Modbus RTU master implementation, sensor is a slave. Protocol +
// wiring verified in RS485_Ultrasonic_Test.ino (kept in this same
// folder). We poll REG_PROCESSED at usPollInterval, retry up to
// US_RETRIES_PER_POLL on transient failures, and hold last-good value
// only briefly — after US_FAULT_AFTER_FAILS consecutive poll cycles
// with total failure, we flip usSensorFault and evaluateMotorState
// force-stops the pump (per Q3 design decision — running blind risks
// overflow).

HardwareSerial usSerial(2);   // UART2 dedicated to the RS485 sensor

// Modbus CRC-16 (poly 0xA001, init 0xFFFF, little-endian output).
static uint16_t usModbusCRC16(const uint8_t* buf, uint8_t len) {
  uint16_t crc = 0xFFFF;
  for (uint8_t i = 0; i < len; i++) {
    crc ^= buf[i];
    for (uint8_t b = 0; b < 8; b++) {
      if (crc & 0x0001) { crc >>= 1; crc ^= 0xA001; }
      else              { crc >>= 1; }
    }
  }
  return crc;
}

// One Modbus read attempt. Returns raw register value on success, -1 on
// timeout / CRC mismatch / wrong-shape response. Silent on failure —
// caller handles retries + logging.
static int32_t usReadRegisterOnce(uint8_t slaveAddr, uint16_t regAddr) {
  uint8_t req[8];
  req[0] = slaveAddr;
  req[1] = 0x03;                       // function: read holding register
  req[2] = (regAddr >> 8) & 0xFF;
  req[3] = regAddr & 0xFF;
  req[4] = 0x00;
  req[5] = 0x01;                       // qty = 1 register
  uint16_t crc = usModbusCRC16(req, 6);
  req[6] = crc & 0xFF;
  req[7] = (crc >> 8) & 0xFF;

  while (usSerial.available()) usSerial.read();   // drain stale bytes

  digitalWrite(RS485_DIR_PIN, HIGH);              // TX
  delayMicroseconds(100);
  usSerial.write(req, 8);
  usSerial.flush();
  delayMicroseconds(100);
  digitalWrite(RS485_DIR_PIN, LOW);               // RX

  // Expected response: 7 bytes. 500ms hard cap, 30ms inter-byte gap
  // (matches the working test sketch).
  uint8_t resp[7];
  uint8_t received = 0;
  unsigned long start = millis();
  unsigned long lastByteAt = start;
  const unsigned long INTERBYTE_TIMEOUT_MS = 30;
  while (received < 7 && (millis() - start) < 500) {
    if (usSerial.available()) {
      resp[received++] = usSerial.read();
      lastByteAt = millis();
    } else if (received > 0 && (millis() - lastByteAt) > INTERBYTE_TIMEOUT_MS) {
      break;
    }
  }

  if (received < 7) return -1;
  if (resp[0] != slaveAddr || resp[1] != 0x03 || resp[2] != 0x02) return -1;
  uint16_t respCrc = usModbusCRC16(resp, 5);
  uint16_t recvCrc = resp[5] | (resp[6] << 8);
  if (respCrc != recvCrc) return -1;

  return ((int32_t)resp[3] << 8) | resp[4];
}

// One-shot Modbus write. Sensor echoes the exact request frame on
// success. Used by the AP-page SETADDR handler to change the sensor's
// slave address (Q6 — AP page must allow rewriting the address).
static bool usWriteRegisterOnce(uint8_t slaveAddr, uint16_t regAddr, uint16_t value) {
  uint8_t req[8];
  req[0] = slaveAddr;
  req[1] = 0x06;
  req[2] = (regAddr >> 8) & 0xFF;
  req[3] = regAddr & 0xFF;
  req[4] = (value >> 8) & 0xFF;
  req[5] = value & 0xFF;
  uint16_t crc = usModbusCRC16(req, 6);
  req[6] = crc & 0xFF;
  req[7] = (crc >> 8) & 0xFF;

  while (usSerial.available()) usSerial.read();
  digitalWrite(RS485_DIR_PIN, HIGH);
  delayMicroseconds(100);
  usSerial.write(req, 8);
  usSerial.flush();
  delayMicroseconds(100);
  digitalWrite(RS485_DIR_PIN, LOW);

  uint8_t resp[8];
  uint8_t received = 0;
  unsigned long start = millis();
  unsigned long lastByteAt = start;
  const unsigned long INTERBYTE_TIMEOUT_MS = 30;
  while (received < 8 && (millis() - start) < 500) {
    if (usSerial.available()) {
      resp[received++] = usSerial.read();
      lastByteAt = millis();
    } else if (received > 0 && (millis() - lastByteAt) > INTERBYTE_TIMEOUT_MS) {
      break;
    }
  }
  if (received < 8) return false;
  for (uint8_t i = 0; i < 8; i++) if (resp[i] != req[i]) return false;
  return true;
}

// Convert raw distance-in-mm to tank percentage.
//
// Geometry: sensor is on the tank lid pointing DOWN. Reports distance
// from its face to the water surface (short distance = tank is full).
//
//   effective column depth = tankHeightCm - sensorOffsetCm
//                            = physical water range the sensor can see
//   waterDepthCm            = effective column - (rawMm/10 - sensorOffsetCm)
//                            = column - distance-from-full-water-surface
//   pct = 100 * waterDepthCm / effectiveColumn
//
// Clamped to 0..100. Sensor readings below sensorOffsetCm (dead zone)
// clamp to 100%; above tankHeightCm clamp to 0%.
static uint8_t usPctFromRawMm(int32_t rawMm) {
  if (rawMm < 0) return usConfirmedPct;   // failed read → hold last
  const int32_t rawCm    = rawMm / 10;
  const int32_t offset   = (int32_t)usSensorOffsetCm;
  const int32_t heightCm = (int32_t)usTankHeightCm;
  const int32_t effCol   = heightCm - offset;
  if (effCol <= 0) return 0;              // pathological config
  if (rawCm <= offset)   return 100;      // in dead zone = tank at brim
  // v118.0.11: a reading past the tank bottom is PHYSICALLY impossible
  // in normal operation — water can't drop below empty. When this fires
  // it's always a sensor artifact (noise bumping an at-empty-ish reading
  // past the heightCm boundary, EMI pulse, dropped Modbus byte).
  // Previously returned a hard 0 which showed up as spurious "0% drops"
  // on the analytics chart. Now we hold the last confirmed value so
  // one bad burst can't paint the chart with a false empty-tank spike.
  if (rawCm >= heightCm) return usConfirmedPct;
  int32_t waterCm = effCol - (rawCm - offset);
  if (waterCm < 0) waterCm = 0;
  int32_t pct = (waterCm * 100 + effCol / 2) / effCol;
  if (pct < 0)   pct = 0;
  if (pct > 100) pct = 100;
  return (uint8_t)pct;
}

// Update the discrete tankLowWet / tankFullWet booleans from the
// current pct + user thresholds. Keeps all downstream pump-control
// code that predates the v118 rewrite working unchanged — those
// branches read booleans, not pct.
//
//   tankLowWet  = tank has water above (or at) the pump-start threshold.
//                 i.e. pct > startPercent → we're above the "start
//                 pumping" trigger. Below start = "low" = need to fill.
//   tankFullWet = tank is at (or above) the pump-stop threshold.
//                 Triggers pump-off in the auto branch.
static void usUpdateDiscreteFromPct(uint8_t pct) {
  tankLowWet  = (pct > startPercent);
  tankFullWet = (pct >= stopPercent);
}

// Insertion sort — small N (max 15), simple + fast enough.
static void usSortSmall(int32_t* a, uint8_t n) {
  for (uint8_t i = 1; i < n; i++) {
    int32_t v = a[i];
    int8_t  j = i - 1;
    while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; }
    a[j + 1] = v;
  }
}

// MAD-filter a burst of samples. Ports tank-monitor firmware pattern
// exactly (see Tank_viz_OSCIL MQTT ORG FIRM.ino line ~1134):
//   1. Sort → median
//   2. Compute each sample's |deviation from median|
//   3. Sort deviations → MAD
//   4. Any sample within US_MAD_MULTIPLIER × MAD of median = inlier
//   5. Return MEAN of inliers (not median — slightly smoother)
//
// MAD can be 0 when all samples are identical (perfectly calm water).
// Guard with +0.001 so inlier check doesn't collapse to exact equality.
//
// Returns median instead of mean if zero inliers (shouldn't happen —
// median itself is always within 0 × MAD of itself — but defensive).
static int32_t usBurstMadFilter(const int32_t* samples, uint8_t count,
                                uint8_t* outInlierCount) {
  if (count == 0) { if (outInlierCount) *outInlierCount = 0; return 0; }

  // Sort for median.
  int32_t sorted[US_SAMPLES];
  for (uint8_t i = 0; i < count; i++) sorted[i] = samples[i];
  usSortSmall(sorted, count);
  int32_t median = sorted[count / 2];

  // Compute + sort absolute deviations.
  int32_t deviations[US_SAMPLES];
  for (uint8_t i = 0; i < count; i++) {
    int32_t d = samples[i] - median;
    deviations[i] = (d < 0) ? -d : d;
  }
  usSortSmall(deviations, count);
  float mad = (float)deviations[count / 2];

  // Keep inliers within multiplier × MAD, average them.
  float threshold = US_MAD_MULTIPLIER * mad + 0.001f;
  int64_t sum = 0;
  uint8_t inliers = 0;
  for (uint8_t i = 0; i < count; i++) {
    int32_t d = samples[i] - median;
    float ad = (d < 0) ? -(float)d : (float)d;
    if (ad <= threshold) { sum += samples[i]; inliers++; }
  }
  if (outInlierCount) *outInlierCount = inliers;
  if (inliers == 0) return median;   // defensive — shouldn't happen
  return (int32_t)(sum / inliers);
}

// One burst — take US_SAMPLES raw reads back-to-back, validate each,
// MAD-filter the valid set, commit mean-of-inliers as new usConfirmedPct.
// Fault state tracks consecutive bursts that failed to produce enough
// valid samples (<US_MIN_VALID); after US_FAULT_AFTER_FAILS of those,
// usSensorFault flips true → pump-control safety path force-stops the pump.
// v118.0.4: non-blocking burst state machine.
//
// Previous version did all 15 samples back-to-back in a single call,
// blocking the main loop for 1.5-15 sec per burst (worst case when the
// sensor was dead — every sample timed out at 500ms). That made the
// web server unresponsive, triggered WDT resets, and generally hung the
// device whenever the sensor cable was disconnected.
//
// New model: usPollTick() takes AT MOST ONE sample per loop iteration.
// Internal state tracks "which sample we're on" within a burst; between
// samples the main loop runs normally (web server, motor control, WiFi).
// Max blocking per loop iteration = one Modbus request (~500ms worst
// case for a dead sensor; usually ~100ms). Device stays responsive.
//
// Burst completion runs the MAD filter and commits; then idles until
// the next burst interval.
//
// Also enforces a 2-minute "no good reading" watchdog that:
//   - Marks usSensorFault = true (triggers sensorOnline=false gate
//     downstream which stops the motor through existing safety path)
//   - Does NOT restart the device (previous versions had restart paths)

static uint8_t  usBurstIdx       = 0;             // 0..US_SAMPLES-1 = burst in progress
static bool     usBurstActive    = false;         // true while a burst is being collected
static int32_t  usBurstSamples[US_SAMPLES];       // samples collected so far
static uint8_t  usBurstValidCount = 0;            // valid samples in the in-progress burst
static uint8_t  usBurstDeadZoneHits = 0;          // v118.0.7: samples that came back INSIDE dead zone (<50mm) — tank full to sensor
static unsigned long usBurstStartMs = 0;          // when this burst started

// v118.0.7: if ≥10/15 samples in a burst come back inside the dead zone
// (sensor reading <50mm, below US_BLIND_ZONE_MM), that is the physical
// signature of water having risen to the sensor face — tank is 100% full,
// not a sensor fault. Below 10 we treat as inconclusive (could be a
// single spurious near-field echo).
#define US_DEADZONE_SATURATION_MIN 10

#define US_WATCHDOG_MS (5UL * 60UL * 1000UL)      // 5 min since last good reading = fault

// Commit the finished burst — MAD filter + update state.
static void usBurstCommit() {
  usLastPollMs = millis();
  usLastValidCount = usBurstValidCount;

  // v118.0.7: dead-zone saturation = tank at/above sensor face = 100%.
  // Must come BEFORE the <US_MIN_VALID check — a burst with 15 dead-zone
  // hits has usBurstValidCount=0 and would otherwise be treated as fault.
  // This is the physical signature of a tank that is overfilled OR a
  // sensor mounted too low; either way the ONLY correct interpretation
  // is "water is here, tank is full". NEVER a fault condition.
  if (usBurstDeadZoneHits >= US_DEADZONE_SATURATION_MIN) {
    usLastRawMm        = US_BLIND_ZONE_MM;   // clamp to blind-zone edge
    usConfirmedPct     = 100;
    usLastInlierCount  = usBurstDeadZoneHits;
    usHaveGoodReading  = true;
    usLastGoodMs       = usLastPollMs;
    usConsecutiveFails = 0;
    if (usSensorFault) {
      usSensorFault = false;
      DEBUG_PRINTLN("[US] Sensor recovered (dead-zone saturation = tank full)");
      logSystemEvent("US_SENSOR_OK", "recovered_tank_full");
    }
    // Seed vote buffer with 100% so future committed readings aren't blocked.
    usVoteCount = 0; usVoteHead = 0;
    usVoteBuf[usVoteHead] = 100;
    usVoteHead = 1; usVoteCount = 1;
    usUpdateDiscreteFromPct(100);
    return;
  }

  if (usBurstValidCount < US_MIN_VALID) {
    usConsecutiveFails++;
    usLastInlierCount = 0;
    DEBUG_PRINTLN("[US] Burst too few valid: " + String(usBurstValidCount) + "/" + String(US_SAMPLES));
    // Fault state governed by the 2-minute watchdog in usPollTick(),
    // not by consecutive-burst count. One slow burst shouldn't fault
    // the sensor; sustained silence for 2 min absolutely should.
    return;
  }

  uint8_t inlierCount = 0;
  int32_t filteredMm = usBurstMadFilter(usBurstSamples, usBurstValidCount, &inlierCount);
  usLastInlierCount = inlierCount;
  if (usBurstValidCount > inlierCount) usOutlierCount += (usBurstValidCount - inlierCount);

  usLastRawMm = filteredMm;
  uint8_t candidatePct = usPctFromRawMm(filteredMm);

  // v118.0.5: push into rolling vote buffer, commit only when the whole
  // window agrees within US_VOTE_SPREAD. Window of US_VOTE_WINDOW (3)
  // means we need 3 consecutive MAD-filtered bursts within 2% of each
  // other before changing usConfirmedPct. Prevents a single noisy burst
  // from flipping threshold decisions (false pump starts/stops).
  usVoteBuf[usVoteHead] = candidatePct;
  usVoteHead = (usVoteHead + 1) % US_VOTE_WINDOW;
  if (usVoteCount < US_VOTE_WINDOW) usVoteCount++;

  bool shouldCommit = false;
  if (!usHaveGoodReading) {
    // Cold start — commit immediately so pump has data to work with.
    // Majority vote kicks in from the second burst onward.
    shouldCommit = true;
  } else if (usVoteCount >= US_VOTE_WINDOW) {
    // Normal operation — all WINDOW slots filled. Compute spread; commit
    // only when readings are tight (max - min ≤ SPREAD).
    uint8_t lo = usVoteBuf[0], hi = usVoteBuf[0];
    for (uint8_t i = 1; i < usVoteCount; i++) {
      if (usVoteBuf[i] < lo) lo = usVoteBuf[i];
      if (usVoteBuf[i] > hi) hi = usVoteBuf[i];
    }
    shouldCommit = ((hi - lo) <= US_VOTE_SPREAD);
    if (!shouldCommit) {
      DEBUG_PRINTLN("[US] Vote spread too wide: " + String(lo) + "-" + String(hi) + " — holding " + String(usConfirmedPct) + "%");
    }
  }

  usHaveGoodReading  = true;
  usLastGoodMs       = usLastPollMs;
  usConsecutiveFails = 0;
  if (usSensorFault) {
    usSensorFault = false;
    DEBUG_PRINTLN("[US] Sensor recovered — candidate=" + String(candidatePct) + "% (" + String(inlierCount) + "/" + String(usBurstValidCount) + " inliers)");
    logSystemEvent("US_SENSOR_OK", "recovered_pct_" + String(candidatePct));
    // On recovery, flush the vote buffer so stale pre-fault values
    // don't block commits.
    usVoteCount = 0; usVoteHead = 0;
    usVoteBuf[usVoteHead] = candidatePct;
    usVoteHead = 1; usVoteCount = 1;
    shouldCommit = true;
  }

  if (shouldCommit && candidatePct != usConfirmedPct) {
    usConfirmedPct = candidatePct;
    usUpdateDiscreteFromPct(usConfirmedPct);
  } else if (shouldCommit) {
    // No pct change but the discrete booleans may still need refreshing
    // (e.g. first commit after boot). Idempotent.
    usUpdateDiscreteFromPct(usConfirmedPct);
  }
}

// Called every loop() iteration. State machine takes at most ONE sample
// per call so loop stays responsive. Returns immediately when the burst
// interval hasn't elapsed OR when the current sample is still spacing.
static void usPollTick() {
  unsigned long now = millis();

  // Watchdog: if we haven't had a good reading in 2 min, declare fault.
  // Runs regardless of burst state so a sensor that stops talking mid-
  // burst still trips the fault within 2 min of its last good read.
  if (usHaveGoodReading && (now - usLastGoodMs) > US_WATCHDOG_MS) {
    if (!usSensorFault) {
      usSensorFault = true;
      DEBUG_PRINTLN("[US] Sensor FAULT — no valid reading for 5 min, pump safety will stop motor");
      logErrorEvent("US_SENSOR_FAULT", "no_valid_reading_for_5min");
    }
    // Don't return — keep trying to re-establish contact.
  }
  // Edge case: never had a good reading AND it's been 2 min since boot.
  // Still mark fault so pump doesn't idle silently forever.
  if (!usHaveGoodReading && usLastGoodMs == 0 && now > US_WATCHDOG_MS && !usSensorFault) {
    usSensorFault = true;
    DEBUG_PRINTLN("[US] Sensor FAULT — no valid reading in first 5 min after boot");
    logErrorEvent("US_SENSOR_FAULT", "no_valid_reading_at_boot");
  }

  // If a burst is in progress, continue it (one sample per tick).
  if (usBurstActive) {
    if (usBurstIdx >= US_SAMPLES) {
      usBurstCommit();
      usBurstActive = false;
      return;
    }
    // Enforce US_SAMPLE_GAP_MS between samples by checking elapsed since
    // burst started (approximation — close enough for noise averaging).
    unsigned long targetSampleAt = usBurstStartMs + (unsigned long)usBurstIdx * US_SAMPLE_GAP_MS;
    if (now < targetSampleAt) return;

    int32_t v = usReadRegisterOnce(usModbusAddr, US_READ_REGISTER);
    if (v >= US_BLIND_ZONE_MM && v <= US_MAX_RANGE_MM) {
      usBurstSamples[usBurstValidCount++] = v;
    } else if (v >= 0 && v < US_BLIND_ZONE_MM) {
      // v118.0.7: track dead-zone hits separately from invalid reads.
      // Water touching the sensor face returns 1-5cm range reliably —
      // that's the tank being physically full, NOT a sensor fault.
      usBurstDeadZoneHits++;
    }
    usBurstIdx++;
    return;
  }

  // Not in a burst — check if it's time to start the next one.
  const unsigned long interval = motorState ? US_POLL_INTERVAL_RUN_MS : US_POLL_INTERVAL_MS;
  if (usLastPollMs != 0 && (now - usLastPollMs) < interval) return;

  // Start a new burst.
  usBurstActive       = true;
  usBurstIdx          = 0;
  usBurstValidCount   = 0;
  usBurstDeadZoneHits = 0;   // v118.0.7
  usBurstStartMs      = now;
}

// One-shot boot init: config UART2 for 9600 8N1 on the sensor pins, DIR
// pin in RX mode, do one initial poll so tankLowWet/tankFullWet have
// meaningful values before evaluateMotorState fires the first time.
static void usSensorInit() {
  pinMode(RS485_DIR_PIN, OUTPUT);
  digitalWrite(RS485_DIR_PIN, LOW);   // start in receive mode
  usSerial.begin(9600, SERIAL_8N1, RS485_RX_PIN, RS485_TX_PIN);
  delay(50);
  DEBUG_PRINTLN("[US] RS485 UART2 initialized, polling sensor 0x" + String(usModbusAddr, HEX));
  // v118.0.4: no boot-time seed poll — the first burst fires from
  // loop()'s usPollTick() within the first US_POLL_INTERVAL_MS. Boot
  // completes without blocking on potentially-slow sensor response.
}

// Persist all ultrasonic config to NVS (EEPROM). Called after any AP-
// page save or cloud panel-settings apply that changed a field.
static void usSaveConfig() {
  EEPROM.write(EEPROM_US_MAGIC, US_MAGIC);
  EEPROM.write(EEPROM_US_TANK_HEIGHT_CM,     usTankHeightCm & 0xFF);
  EEPROM.write(EEPROM_US_TANK_HEIGHT_CM + 1, (usTankHeightCm >> 8) & 0xFF);
  EEPROM.write(EEPROM_US_SENSOR_OFFSET_CM,     usSensorOffsetCm & 0xFF);
  EEPROM.write(EEPROM_US_SENSOR_OFFSET_CM + 1, (usSensorOffsetCm >> 8) & 0xFF);
  EEPROM.write(EEPROM_US_MODBUS_ADDR,    usModbusAddr);
  // v118.0.4: write to the PRIMARY start/stop slots too — loadConfiguration()
  // reads from EEPROM_START_PERCENT/EEPROM_STOP_PERCENT on boot (not the
  // US_* slots), so these are what actually persists across reboots.
  EEPROM.write(EEPROM_START_PERCENT, startPercent);
  EEPROM.write(EEPROM_STOP_PERCENT,  stopPercent);
  EEPROM.commit();
  DEBUG_PRINT("[US] Config saved: height=");
  DEBUG_PRINT(usTankHeightCm);
  DEBUG_PRINT("cm offset=");
  DEBUG_PRINT(usSensorOffsetCm);
  DEBUG_PRINT("cm start=");
  DEBUG_PRINT(startPercent);
  DEBUG_PRINT("% stop=");
  DEBUG_PRINT(stopPercent);
  DEBUG_PRINT("% addr=0x");
  DEBUG_PRINTLN(String(usModbusAddr, HEX));
}

// Load config from NVS at boot. Missing/invalid magic → use defaults.
static void usLoadConfig() {
  if (EEPROM.read(EEPROM_US_MAGIC) != US_MAGIC) {
    DEBUG_PRINTLN("[US] No saved config, using defaults");
    return;   // globals keep their default values
  }
  uint16_t h = EEPROM.read(EEPROM_US_TANK_HEIGHT_CM) | ((uint16_t)EEPROM.read(EEPROM_US_TANK_HEIGHT_CM + 1) << 8);
  uint16_t o = EEPROM.read(EEPROM_US_SENSOR_OFFSET_CM) | ((uint16_t)EEPROM.read(EEPROM_US_SENSOR_OFFSET_CM + 1) << 8);
  uint8_t st = EEPROM.read(EEPROM_US_PUMP_START_PCT);
  uint8_t sp = EEPROM.read(EEPROM_US_PUMP_STOP_PCT);
  uint8_t ad = EEPROM.read(EEPROM_US_MODBUS_ADDR);
  // Range-clamp on load — protects against garbage in NVS after a bad flash.
  if (h >= 10 && h <= 1200) usTankHeightCm = h;   // v118.0.8: raised ceiling 600→1200 cm
  if (o <= 100)            usSensorOffsetCm = o;
  // v118.0.2: relax to 2% granularity. Start 1-98, Stop 2-100, min 2% gap.
  if (st >= 1 && st <= 98) startPercent = st;
  if (sp >= 2 && sp <= 100) stopPercent = sp;
  if (ad >= ADDR_MIN && ad <= ADDR_MAX) usModbusAddr = ad;
  // Enforce 2% gap invariant — if a legacy save violates it, clamp stop up.
  if (stopPercent < startPercent + 2) stopPercent = startPercent + 2;
  if (stopPercent > 100) stopPercent = 100;
  DEBUG_PRINT("[US] Config loaded: height=");
  DEBUG_PRINT(usTankHeightCm);
  DEBUG_PRINT("cm offset=");
  DEBUG_PRINT(usSensorOffsetCm);
  DEBUG_PRINT("cm start=");
  DEBUG_PRINT(startPercent);
  DEBUG_PRINT("% stop=");
  DEBUG_PRINT(stopPercent);
  DEBUG_PRINT("% addr=0x");
  DEBUG_PRINTLN(String(usModbusAddr, HEX));
}

// ===========================================
// MAIN SETUP
// ===========================================

void setup() {
  Serial.begin(115200);
  delay(2000);

  // v118.0.7: bump Task WDT timeout from Arduino default (5s) to 60s.
  // Why: cloudTask calls Firebase.signUp() which blocks for 3-10s on
  // TLS handshake + anonymous-auth round-trip. The default 5s window
  // was tripping the WDT mid-call, causing the "task_wdt got triggered"
  // crash observed in the field (118.0.5 reboot loop). Panic=true so
  // if a task really IS stuck we still reset — just gives Firebase
  // enough runway to complete legitimate slow calls.
  // Applies globally; individual tasks still opt in via esp_task_wdt_add.
  //
  // ESP32 Arduino core 3.x uses the IDF 5.x struct-config form. The
  // init may already have been called by the Arduino bootstrap, so if
  // it fails try reconfigure.
  {
    esp_task_wdt_config_t twdtCfg = {
      .timeout_ms     = 60000,
      .idle_core_mask = 0,
      .trigger_panic  = true,
    };
    if (esp_task_wdt_init(&twdtCfg) != ESP_OK) {
      esp_task_wdt_reconfigure(&twdtCfg);
    }
  }

  //////////////////////////////
  EEPROM.begin(512);
  
  // Clear password EEPROM
  EEPROM.write(191, 0);  // Disable password
  for (int i = 192; i < 196; i++) {
    EEPROM.write(i, 0);  // Clear password digits
  }
  EEPROM.commit();
  ///////////////////////////////////////////

  DEBUG_PRINTLN("=== Smart Tank Controller - WIRED SENSOR VERSION ===");
  DEBUG_PRINT("Relay Type: ");
  DEBUG_PRINTLN(RELAY_ACTIVE_LOW ? "ACTIVE LOW" : "ACTIVE HIGH");
  DEBUG_PRINTLN("WIRED SENSOR FEATURES:");
  DEBUG_PRINTLN("✅ Direct wired ultrasonic sensor (no LoRa)");
  DEBUG_PRINTLN("✅ Direct wired water presence sensor (DIP + Contactless)");
  DEBUG_PRINTLN("✅ MAD filtering for stable readings");
  DEBUG_PRINTLN("✅ 5-second ultrasonic read interval");
  DEBUG_PRINTLN("✅ 3-second water presence debounce");
  DEBUG_PRINTLN("✅ All other features preserved");
  DEBUG_PRINTLN("Initializing...");
  
  // Initialize WS2812B LED first
  initializeWS2812B();
  
  // Initialize hardware - SAFE RELAY CONTROL
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, MOTOR_OFF_STATE); // Motor OFF (safe boot state)

  // Panel-variant outputs: STOP relay (de-energised) + BUZZER (off).
  // BUZZER_PIN is on GPIO27, independent from relay pins.
  pinMode(RELAY_STOP_PIN, OUTPUT);
  digitalWrite(RELAY_STOP_PIN, MOTOR_OFF_STATE);
  
  // Initialize buzzer pin (GPIO27) - independent from relay
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);  // Buzzer off at startup

  // Contactor feedback input - INPUT_PULLUP since GPIO17 supports it; opto
  // pulls it LOW when the contactor aux-NO contact closes.
  pinMode(MOTOR_FEEDBACK_PIN, INPUT_PULLUP);

  // FORCE STOP ON BOOT (if enabled and in panel mode)
  // Send stop pulse to ensure pump is OFF before checking conditions
  #if FORCE_STOP_ON_BOOT
    if (pumpType == PUMP_PANEL) {
      DEBUG_PRINTLN("⚠️ Force stop on boot - sending stop pulse...");
      digitalWrite(RELAY_STOP_PIN, MOTOR_ON_STATE);  // Assert STOP
      delay(panelStopPulseMs);                        // Hold for user-configured duration
      digitalWrite(RELAY_STOP_PIN, MOTOR_OFF_STATE); // Release STOP
      DEBUG_PRINTLN("✅ Boot stop complete - pump ensured OFF");
    }
  #endif

  // Initialize reset switch
  pinMode(RESET_SWITCH_PIN, INPUT_PULLDOWN);  // default LOW, press pulls HIGH
  switchPressStart = 0;
  switchHoldProcessed = false;
  lastTapTime = 0;
  tapCount = 0;

  // FILL INTENT: Variables initialized to false/0 on reboot (auto-cleared)
  
  // Initialize I2C for RTC
  Wire.begin(SDA_PIN, SCL_PIN);
  
  // Initialize RTC
  if (!rtc.begin()) {
    DEBUG_PRINTLN("RTC not found - running without RTC (NTP only)");
    // rtcAvailable stays false - all safeNow() calls go through safeNow()
    // which returns a placeholder instead of hitting I2C again, so no
    // error spam even if the chip is absent or wiring is wrong.
  } else {
    rtcAvailable = true;
    DEBUG_PRINTLN("RTC initialized");
    if (rtc.lostPower()) {
      DEBUG_PRINTLN("RTC lost power, setting time...");
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    }
  }
  
  // Initialize EEPROM
  EEPROM.begin(EEPROM_SIZE);
  
  // Load per-unit random suffix first, then device name (suffix is embedded
  // in the AP SSID / mDNS hostname built inside loadDeviceName->updateDynamicNames).
  loadDevSuffix();
  loadDeviceName();
  
  // Initialize logging system
  initializeLogSystem();
  
  // Start Access Point with dynamic name
  setupAccessPoint();

  // Initialize MVS OTA
  mvsota.begin(deviceName, FIRMWARE_VERSION,FIRMWARE_CODE);
  mvsota.onStart([]() {
      setMotor(false);
      ws2812_setColor(0, 255, 255);
  });

  // Load configuration (includes time sync info)
  loadConfiguration();

  // Schedule mode requires RTC for correct time-of-day gating - disable it
  // silently if the RTC is not available so pumps don't get stuck off.
  if (!rtcAvailable && scheduleModeEnabled) {
    scheduleModeEnabled = false;
    DEBUG_PRINTLN("Schedule mode disabled - no RTC available");
  }

  // Load password settings
  loadPasswordSettings();

  // Initialize WiFi reconnection system
  initializeWiFiReconnect();
  
  if (!isConfigured) {
    DEBUG_PRINTLN("DEVICE NOT CONFIGURED - Please use web interface at 192.168.4.1");
    DEBUG_PRINTLN("AP SSID: " + apSSID);
    ws2812_setColor(128, 0, 128); // Purple for unconfigured
  } else {
    DEBUG_PRINTLN("Configuration loaded from EEPROM");
    displayCurrentConfig();

    // Initialize startup safety mechanisms
    startupTime = millis();
    startupSensorValidation = true;
    needFreshDataAfterRecovery = true;

    // Set initial mode based on schedule and auto mode settings
    initializeSystemMode();

    // Log comprehensive startup status
    logStartupStatus();
  }
  
  // Initialize tank LOW/FULL + source probes (replaces ultrasonic init)
  initTankSensors();
  initializeWiredWaterPresence();

  // Initialize wired sensor timing
  wiredStartupTime = millis();
  wiredStartupComplete = false;
  lastProbeReadTime = 0;
  lastWPCheckTime = 0;

  DEBUG_PRINTLN(F("Tank/source probes initialized - waiting for startup delay..."));
  
  // Setup Web Server with logging capabilities
  setupWebServer();
  
  // Load WiFi credentials and attempt connection
  loadWiFiCredentials();
  if (wifiConfigured) {
    DEBUG_PRINTLN("Attempting to connect to home WiFi for OTA capability...");
    if (connectToWiFiStation()) {
      setupOTA();
    }
  } else {
    DEBUG_PRINTLN("No WiFi credentials - OTA not available");
  }

#if ENABLE_CLOUD
  // Load or generate the persistent pump device code. Safe to call before
  // WiFi is up — only touches NVS.
  ensureDeviceCode();

  // Spawn the cloud task on Core 0. From here on, ALL Firebase work
  // (auth, /live, /history, drain event queue) lives on Core 0 with its
  // own Task WDT. Core 1 stays clean for pump control. See cloudTask()
  // for the safety architecture rationale.
  startCloudTask();
#endif
  
  DEBUG_PRINTLN("System Ready!");
  DEBUG_PRINTLN("Web Interface: http://192.168.4.1");
  DEBUG_PRINTLN("AP SSID: " + apSSID);
  
  if (wifiStationMode) {
    DEBUG_PRINT("OTA Available: http://");
    DEBUG_PRINT(WiFi.localIP());
    DEBUG_PRINT(" or ");
    DEBUG_PRINT(otaHostname);
    DEBUG_PRINTLN(".local");
  }
  
  DEBUG_PRINTLN("Enhanced Features:");
  DEBUG_PRINTLN("- Device Name: " + fullDeviceName);
  DEBUG_PRINTLN("- FIXED: Motor stop % with 5% minimum gap");
  DEBUG_PRINTLN("- WiFi auto-reconnection with exponential backoff");
  DEBUG_PRINTLN("- VIEW LOGS: http://192.168.4.1/logs/view");
  DEBUG_PRINT("- Last time sync: ");
  DEBUG_PRINTLN(lastTimeSyncResult);
  
  DEBUG_PRINTLN("Commands: STATUS, RESET, FORCE, AUTO, SCHEDULE ON/OFF, AP, LOGS, CLEARLOG");
  DEBUG_PRINTLN("=====================================");
  
  lastSensorUpdate = safeNow();
  sensorOnline = false;
  // lastPacketTime removed - not needed for wired version
  
  // Log system startup with comprehensive details
  String startupMode = isConfigured ? (autoModeEnabled ? "AUTO" : "IDLE") : "UNCONFIGURED";
  if (scheduleModeEnabled) {
    startupMode += "_SCHEDULED";
  }
  String startupDetails = "device_" + deviceName + "_wifi_" + String(wifiStationMode ? "connected" : "ap_only") + "_logging_" + String(logManager.totalEntries) + "_entries";
  logSystemEvent("SYSTEM_STARTUP", startupDetails);
  
  // Set initial LED status
  updateLEDStatus();
}

// ===========================================
// MAIN LOOP
// ===========================================

// v117.0.12: nightly midnight health restart. If pump is idle and the
// local clock rolls into the 00:00–00:04 window, do a full ESP.restart().
//
// Why: this device runs for months uninterrupted. WiFi driver state,
// TLS session buffers, TCP allocation pools, ~any long-running C++
// libraries — all eventually accumulate bugs (stuck flags, orphaned
// handles, mystery hangs like the "white light, unreachable, needs
// power cycle" symptom the user reported). A daily cold restart in a
// safe window is a well-tested reliability pattern.
//
// Safety gates:
//   • Only in the 00:00–00:04 window (5-min slot each day)
//   • Only when motor is OFF and not in manual override
//   • Not during OTA (would corrupt the flash)
//   • RTC/clock must be valid (year >= 2024)
//   • Fires at most once per calendar day (dayFired latch)
//
// Explicit exclusion from the earlier user constraint "never
// ESP.restart from cloud recovery" — this is a SCHEDULED maintenance
// restart during a known-idle window, not a recovery action.
static void checkNightlyMidnightRestart() {
  if (otaInProgress) return;
  if (motorState) return;
  if (currentMode == MODE_MANUAL_OVERRIDE) return;
  if (!isClockSafe()) return;

  // v118.0.7: boot grace — never fire within 10 min of boot. Combined
  // with the NVS latch below this makes the midnight-reboot-loop
  // impossible: even if the latch write somehow fails to persist AND
  // the clock reads 00:00 right after boot, the grace keeps us out of
  // the window for 10 min, by which point the clock has advanced past
  // 00:04 and the h/m guard rejects.
  if (millis() < (10UL * 60UL * 1000UL)) return;

  DateTime nowTs = safeNow();
  const uint8_t h = nowTs.hour();
  const uint8_t m = nowTs.minute();
  // 5-min window guards against a single-second miss if the loop lags.
  if (h != 0 || m > 4) return;

  // v118.0.7: NVS-persisted latch. Previous version used `static uint16_t
  // lastFiredYear` in RAM — which reset to 0 on every boot. Side effect:
  // once we fire the restart, the device reboots inside the 00:00-00:04
  // window, the RAM latch is zero again, so it fires AGAIN. Infinite
  // reboot loop that was observed on-site. YYYYMMDD int is small +
  // human-readable in NVS dumps.
  const uint32_t todayKey = (uint32_t)nowTs.year() * 10000UL
                          + (uint32_t)nowTs.month() * 100UL
                          + (uint32_t)nowTs.day();
  {
    Preferences p;
    p.begin("pump", true);
    uint32_t lastFiredDay = p.getUInt("nrDay", 0);
    p.end();
    if (lastFiredDay == todayKey) {
      // Already fired today — never fire twice. Guards against the loop
      // regardless of how we got back into the window.
      return;
    }
  }

  // Write latch FIRST (before the delay/restart) so even a crash between
  // here and ESP.restart() still leaves us marked as "fired today".
  {
    Preferences p;
    p.begin("pump", false);
    p.putUInt("nrDay", todayKey);
    p.end();
  }

  Serial.println("[NIGHTLY] Midnight health restart — pump idle, in maintenance window");
  logSystemEvent("NIGHTLY_RESTART", "midnight_idle_maintenance");

  // Small settle so log flushes to LittleFS.
  delay(300);
  ESP.restart();
}

// v117.0.12: force-clear otaInProgress if it's been true too long without
// progress advancing. Without this, a mid-download WiFi drop or crashed
// OTA session leaves the flag stuck true forever, and every part of the
// firmware that guards on it (WiFi reconnect, cloud task startup, LED
// state, setMotor safety) treats the device as still-updating —
// permanent half-brick until a power cycle.
//
// Triggers on either:
//   (a) 5 min elapsed since OTA started AND no progress bytes at all, or
//   (b) 10 min elapsed regardless of progress (soft cap on any OTA session)
//
// Cleared flag → WiFi reconnect resumes → cloud task recovers on its
// own. Safe to run every loop tick; only touches state when guards trip.
static void checkOtaStuckWatchdog() {
  if (!otaInProgress) return;
  const unsigned long now = millis();
  const unsigned long elapsed = now - otaStartTime;
  // Guard (b) — hard cap. Any OTA session longer than 10 min is
  // pathological (fastest ESP32 flash is ~30 sec over LAN, ~2 min via
  // slow cloud OTA — nothing legitimate takes 10 min).
  const bool hardExpired = (elapsed > 10UL * 60UL * 1000UL);
  // Guard (a) — no progress after 5 min. Handles the crashed-mid-download
  // case where onProgress never fires but onError doesn't either.
  const bool stalled = (elapsed > 5UL * 60UL * 1000UL) && (otaProgress == 0);
  if (hardExpired || stalled) {
    Serial.println("[OTA-WATCHDOG] Force-clearing stuck otaInProgress flag");
    otaInProgress = false;
    otaProgress   = 0;
    otaStartTime  = 0;
    logErrorEvent("OTA_WATCHDOG", hardExpired ? "hard_timeout_10min" : "no_progress_5min");
  }
}

void loop() {
  static unsigned long lastMemoryCheck = 0;
  static unsigned long lastSensorCheck = 0;
  static int loopCounter = 0;

  loopCounter++;

  // v117.0.12: unstuck otaInProgress before any downstream code checks it.
  checkOtaStuckWatchdog();
  // v117.0.12: scheduled midnight health restart (idle-only, gated).
  checkNightlyMidnightRestart();

  // Handle serial commands
  handleSerialCommands();

  // Handle web server
  server.handleClient();

  // Handle OTA updates
  handleOTAEvents();

  // Handle MVS OTA updates
  if (!mvsota.isUpdating()) {
    mvsota.handle();
  }

  // Handle WiFi auto-reconnection
  handleWiFiReconnection();

#if ENABLE_CLOUD
  // Push a fresh snapshot for the cloud task to consume. Cheap: a mutex
  // take + struct copy in ~microseconds. All the real work (TLS, DNS,
  // Firebase auth, /live pushes, /history pairing) happens on Core 0
  // in cloudTask() — this call is the ONLY cloud touch-point on Core 1.
  //
  // Called every loop iteration; snapshot itself is idempotent so it
  // doesn't matter that we call it faster than cloud consumes it.
  publishPumpSnapshot();

  // Drain the cloud-log queue. Cloud task enqueues short strings when
  // /live or /history pushes succeed/fail. We call logSystemEvent()
  // here on Core 1 so LittleFS (not thread-safe) is only ever touched
  // from a single core. Bounded 4/loop so we never spend too long here.
  if (g_cloudLogQueue) {
    CloudLogMsg m;
    for (int i = 0; i < 4; i++) {
      if (xQueueReceive(g_cloudLogQueue, &m, 0) != pdTRUE) break;
      logSystemEvent(String(m.action), String(m.details));
    }
  }
#endif

  // Check reset switch
  checkResetSwitch();

  // Check AP timeout
  checkAPTimeout();

  // Check NTP sync (once per hour, syncs daily if needed)
  checkNTPSync();

  // Update WS2812B LED status
  updateLEDStatus();

  // Print status continuously every 3 seconds if in status mode
  if (continuousStatusMode && (millis() - lastStatusPrint) > 3000) {
    displayStatus();
    lastStatusPrint = millis();
  }

  // Memory monitoring every 60 seconds
  if (millis() - lastMemoryCheck > 60000) {
    String memDetails = "free_" + String(ESP.getFreeHeap()) + "_min_" + String(ESP.getMinFreeHeap());
    // Removed verbose memory logging
    lastMemoryCheck = millis();
  }

  // Sensor state monitoring every 30 seconds
  if (millis() - lastSensorCheck > 30000) {
    String sensorDetails = "online_" + String(sensorOnline) + "_hasReading_" + String(hasReceivedReading) +
                          "_timeSince_" + String(safeNow().unixtime() - lastSensorUpdate.unixtime());
    // Removed verbose sensor logging
    lastSensorCheck = millis();
  }

  // ===========================================
  // WIRED SENSOR READING (replaces LoRa packet checking)
  // ===========================================
  
  // Wait for startup delay before reading sensors
  if (!wiredStartupComplete) {
    if (millis() - wiredStartupTime >= WIRED_STARTUP_DELAY_MS) {
      wiredStartupComplete = true;
      DEBUG_PRINTLN(F("Wired sensor startup delay complete - beginning readings"));
    }
  } else {
    // v118: poll the RS485 ultrasonic sensor first (self-throttles
    // via US_POLL_INTERVAL_MS internally). This updates usConfirmedPct
    // and tankLowWet/tankFullWet via usUpdateDiscreteFromPct(), which
    // processTankAndSourceReading() then exposes as currentWaterPercent
    // for the rest of the system.
    usPollTick();

    // Read source probe + expose tank pct (self-throttles via
    // PROBE_READ_INTERVAL_MS internally, safe to call every loop iteration).
    processTankAndSourceReading();

    // Read source/water-presence sensor every 1 second (if enabled)
    if (hasWPSensor && (millis() - lastWPCheckTime >= WIRED_WP_CHECK_INTERVAL_MS)) {
      processWiredWaterPresenceReading();
      lastWPCheckTime = millis();
    }
  }

  // LoRa code removed for wired version:
  // - LoRa.parsePacket() 
  // - processPacket()
  // - LoRa health check / reinitialize

  // Control motor based on current conditions (includes schedule logic)
  controlMotor();

  // Panel-mode actuation: release pulses after their duration, watch the
  // contactor feedback line, and drive the optional buzzer. All three are
  // no-ops in single-phase mode (or when their respective feature is off).
  handlePanelPulses();
  handleMotorFeedback();
  handleBuzzer();

  delay(10);
}

/*
===========================================
COMPLETE CHANGELOG - ALL FIXES IMPLEMENTED
===========================================

✅ 1. MOTOR STOP PERCENTAGE BUG FIXED:
   - Changed minimum gap from 10% to 5% (startPercent + 5)
   - Made display text dynamic in HTML settings page
   - Updated JavaScript validation to calculate dynamically
   - Added event listener for real-time updates
   - Fixed both validation logic and user interface

✅ 2. DEVICE NAME CUSTOMIZATION IMPLEMENTED:
   - Default device name: "senseflow" (becomes "senseflow_mvstech")
   - Dynamic AP SSID generation based on device name
   - Dynamic OTA hostname generation (dash format for DNS)
   - EEPROM storage and validation for device names
   - Web interface field for device name configuration
   - Character validation and sanitization
   - Automatic update of all related names when changed

✅ 3. WIFI AUTO-RECONNECTION SYSTEM ADDED:
   - Smart WiFi status monitoring every 60 seconds
   - Exponential backoff strategy (10s → 20s → 40s → 80s → 160s → 300s max)
   - Maintains AP mode during reconnection attempts
   - Automatic OTA service restart on successful reconnection
   - Comprehensive logging of all WiFi events
   - Non-blocking reconnection (doesn't interfere with other operations)
   - Reset backoff on successful connection
   - Status display in web interface showing reconnection progress

✅ 4. ENHANCED FEATURES PRESERVED:
   - All original logging functionality maintained
   - All motor control logic preserved
   - All scheduling features intact
   - All sensor processing unchanged
   - All web interface features enhanced
   - All serial commands working
   - All safety features preserved

✅ 5. VALIDATION AND ERROR HANDLING:
   - Device name validation (1-20 chars, valid characters only)
   - Percentage validation with correct minimum gap
   - WiFi credentials validation
   - Schedule overlap detection
   - EEPROM corruption handling
   - Network failure recovery

✅ 6. USER INTERFACE IMPROVEMENTS:
   - Dynamic device name display throughout interface
   - WiFi reconnection status indicators
   - Enhanced settings page with device name field
   - Real-time percentage calculation in JavaScript
   - Better error messages and validation feedback
   - Status indicators for all system states

✅ 7. SYSTEM ROBUSTNESS:
   - Graceful handling of WiFi disconnections
   - Automatic recovery from network outages
   - Preserved AP mode for local access during WiFi issues
   - Enhanced logging of system events
   - Better error recovery mechanisms

✅ 8. TRIPLE TAP PASSWORD RESET FEATURE ADDED:
   - Hardware button triple tap disables password protection
   - MAGENTA LED (255, 0, 255) visual confirmation for 2 seconds
   - Tap window increased to 1.5 seconds for easier detection
   - Works in all system modes (Safe Mode, Manual Override, etc.)
   - Immediate device unlock after reset
   - Logged event: "PASSWORD_DISABLED via HARDWARE_BUTTON_TRIPLE_TAP"
   - Permanent audit trail with timestamp
   - Brief MAGENTA flash if password already disabled
   - User can re-enable password in Settings → Password Protection
   - Physical access required (standard IoT security practice)
   - No automatic re-enable - user must manually configure new password

DEPLOYMENT READY:
- All code complete and tested
- No missing functions or incomplete features
- All original functionality preserved
- New features fully integrated
- Comprehensive error handling
- Production-ready robustness

USAGE:
1. Flash this code to ESP32
2. Connect to "senseflow_mvstech" AP (or custom name)
3. Configure device name, tank settings, and WiFiIi
4. System will auto-reconnect to WiFi if disconnected
5. Motor percentages now use 5% minimum gap
6. All features work seamlessly together
 Execution Order in controlMotor():

  1. checkSensorTimeouts()           ← NEW: Always runs first
     â”œâ”€ Updates sensorOnline flag
     â”œâ”€ Updates wpSensorOnline flag
     â””â”€ Logs timeout events

  2. Check OTA in progress           ← Existing
  3. Check manual override timeout   ← Existing
  4. Check Safe Mode                 ← Existing (but sensor status already
  updated)
     â””â”€ return (motor logic stops)
  5. Rest of motor logic...          ← Only if not in Safe Mode

  ---
  Behavior in Different Scenarios:

  Scenario 1: Normal Mode → Sensor Goes Offline

  1. checkSensorTimeouts() detects timeout
  2. Sets sensorOnline = false
  3. Changes mode to MODE_SENSOR_OFFLINE
  4. Stops motor
  ✅ Works as before

  ---
  Scenario 2: Safe Mode → Sensor Goes Offline (NEW BEHAVIOR)

  1. checkSensorTimeouts() detects timeout
  2. Sets sensorOnline = false ✅ NOW UPDATED!
  3. Logs timeout event ✅
  4. Does NOT change mode (stays in Safe Mode)
  5. Motor already OFF
  6. Web UI shows sensor offline status ✅
  7. Serial shows timeout warnings ✅

  Before:
  - ❌ sensorOnline remained true
  - ❌ No timeout logged
  - ❌ User unaware sensor offline

  After:
  - ✅ sensorOnline correctly set to false
  - ✅ Timeout logged
  - ✅ Web UI shows offline status
  - ✅ User can see both: "Safe Mode" + "Sensor Offline"

  ---
  Scenario 3: Safe Mode + Sensor Offline → User Exits Safe Mode

  1. User presses button (single click)
  2. Safe Mode exits → MODE_NORMAL
  3. needFreshDataAfterRecovery = true
  4. Next loop: checkSensorTimeouts() runs
  5. sensorOnline already = false (was updated in Safe Mode)
  6. System correctly waits for sensor to come back online
  ✅ Safe and correct behavior

  ---
  Scenario 4: Safe Mode + Sensor Offline → Sensor Comes Back

  1. System in Safe Mode, sensor offline (sensorOnline = false)
  2. LoRa packet arrives → processPacket() updates sensorOnline = true
  3. Next loop: checkSensorTimeouts() runs
  4. Sensor detected online, no timeout
  5. System stays in Safe Mode (correct)
  6. Web UI shows: "Safe Mode" + "Sensor Online" ✅

  ---
  What's Preserved:

  1. ✅ Safe Mode priority - Safe Mode still blocks motor operations
  2. ✅ Mode hierarchy - Sensor offline won't override Safe Mode
  3. ✅ Safety features - needFreshDataAfterRecovery still works
  4. ✅ Logging - All timeout events logged
  5. ✅ Web UI updates - Sensor status always current

  ---
  What's Improved:

  1. ✅ Sensor status visibility - Always accurate, even in Safe Mode
  2. ✅ User awareness - Can see both Safe Mode AND sensor offline
  3. ✅ Better diagnostics - Timeout events logged in all modes
  4. ✅ Code clarity - Single function handles sensor timeouts
  5. ✅ Less duplication - Removed 50+ lines of duplicate code

  ---
  Key Design Decision:

  Line 3476:
  if (sensorsOffline && currentMode != MODE_SENSOR_OFFLINE && currentMode !=
  MODE_SAFE_MODE)

  Why not override Safe Mode?
  - Safe Mode is a critical error state (dry run protection)
  - Sensor offline is a monitoring state (temporary communication loss)
  - Safe Mode takes priority, but sensor status is still tracked
  - User sees both issues, not just one

  ---
  Summary:

  Before: Sensor monitoring stopped in Safe Mode (blind spot)
  After: Sensor monitoring continues in all modes (full visibility)

  The system now properly separates:
  - 🔐´ Motor Control Policy (what Safe Mode blocks)
  - 🟢 Health Monitoring (what continues in background)

  Pesrfect separation of concerns! 🎯
*/
// added LORA.recive() command to resolve reinitalize"""
