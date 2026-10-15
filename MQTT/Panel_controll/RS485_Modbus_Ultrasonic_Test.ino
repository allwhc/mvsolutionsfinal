/*
 * RS485 Ultrasonic Sensor — Simple Test Sketch (no cloud, no MQTT)
 *
 * Sensor: RS485 ultrasonic level sensor, Modbus-RTU slave.
 *   - Slave address : 0x01 (confirmed working), changeable via serial command
 *   - Baud          : 9600, 8N1
 *   - Read function code  : 0x03 (Read Holding Register)
 *   - Write function code : 0x06 (Write Single Register)
 *   - Register 0x0100 : processing distance value (mm), response ~500ms
 *   - Register 0x0101 : real-time distance value (mm), response ~100ms
 *   - Register 0x0102 : temperature, unit 0.1°C
 *   - Register 0x0200 : slave address, range 0x01-0xFE, 0xFF = broadcast
 *
 * Wiring (confirmed working):
 *   Sensor  -> RS485 module:  VCC(red), GND(black), B(yellow), A(white)
 *   RS485 module -> ESP32:
 *     RO (RX)      -> ESP32 GPIO5   (usSerial RX)
 *     DI (TX)      -> ESP32 GPIO17  (usSerial TX)
 *     DE+RE (DIR)  -> ESP32 GPIO25  (shorted together, direction control)
 *
 * DIR pin logic (confirmed): LOW = receive, HIGH = transmit.
 *
 * Serial commands (type into Serial Monitor, 115200 baud, newline ending):
 *   HELP              - show commands + valid address range
 *   SETADDR <n>       - change sensor's Modbus address to <n> (1-254 decimal,
 *                        or 0x.. hex). Pings currentAddr first and prints
 *                        what it found; you must type YES on the next line
 *                        to actually send the write. All reads switch to
 *                        the new address immediately after a successful
 *                        change.
 *   ADDR              - show the address currently being used for reads
 *   READ <addr> [reg] - read a specific address/register. On success this
 *                        SWITCHES currentAddr to <addr> for future polling.
 *                        <addr>/[reg] accept decimal or 0x.. hex. [reg]
 *                        defaults to 0x0100 (processed distance) if omitted.
 *                        e.g. READ 5           -> distance from addr 5
 *                             READ 0x05 0x0102 -> temperature from addr 5
 *   SCAN [lo] [hi]    - probe addresses lo..hi (default 1..10) for any
 *                        sensor that replies. Useful after a SETADDR whose
 *                        outcome is unclear.
 *   SCAN FULL         - probe the entire valid range 0x01-0xFE (slower —
 *                        254 addresses, each with a short timeout on miss).
 *   GR                - one-shot: read REAL-TIME distance (0x0101) from
 *                        currentAddr. Works regardless of POLL state.
 *   GP                - one-shot: read PROCESSED distance (0x0100) from
 *                        currentAddr. Works regardless of POLL state.
 *   POLL ON|OFF       - start/stop continuous background polling (default
 *                        ON at boot). Turn OFF to use only GR/GP on demand
 *                        instead of a steady stream of readings.
 *   POLL GR|GP|BOTH   - choose what continuous polling reads each cycle.
 *                        BOTH (default) = processed + real-time + temp.
 *                        GR = real-time only, GP = processed only — both
 *                        skip temperature too, for fewer transactions/cycle.
 */

#include <HardwareSerial.h>

#define RS485_RX_PIN   5    // ESP32 <- module RO
#define RS485_TX_PIN   17   // ESP32 -> module DI
#define RS485_DIR_PIN  25   // module DE+RE (shorted)

#define REG_PROCESSED  0x0100   // filtered distance, mm
#define REG_REALTIME   0x0101   // real-time distance, mm
#define REG_TEMPERATURE 0x0102  // temperature, unit 0.1 degC
#define REG_SLAVE_ADDR  0x0200  // read/write slave address

// Valid Modbus slave address range for this sensor family (datasheet: 0x0200
// register, range 0x01-0xFE, 0xFF reserved as broadcast address).
#define ADDR_MIN  0x01
#define ADDR_MAX  0xFE

// Current address used for all reads. Not a #define anymore — SETADDR
// changes this at runtime so every subsequent poll uses the new address.
uint8_t currentAddr = 0x01;

HardwareSerial rs485(2);   // UART2

// Poll interval — sensor response time is ~500ms for processed value,
// so don't poll faster than that.
const unsigned long POLL_INTERVAL_MS = 1000;
unsigned long lastPoll = 0;

// Continuous background polling — ON by default (matches prior behavior).
// POLL OFF stops it; POLL ON resumes it. GR/GP (one-shot commands) work
// regardless of this flag — they're independent of the background loop.
bool pollingEnabled = true;

// What the continuous poller reads each cycle. Default BOTH matches prior
// behavior (processed + real-time + temperature). POLL GR / POLL GP
// narrow it to just that one register, no temperature — fewer Modbus
// transactions per cycle, useful once you've picked which register you
// actually want to watch continuously.
enum PollMode { POLL_MODE_BOTH, POLL_MODE_GR_ONLY, POLL_MODE_GP_ONLY };
PollMode pollMode = POLL_MODE_BOTH;

const char* pollModeName(PollMode m) {
  switch (m) {
    case POLL_MODE_GR_ONLY: return "GR only (real-time, no temp)";
    case POLL_MODE_GP_ONLY: return "GP only (processed, no temp)";
    default:                return "BOTH (processed + real-time + temp)";
  }
}

// Retry a failed read this many times (each retry re-sends the request)
// before giving up on this poll cycle and falling back to the last good
// value. Sensor is confirmed alive/correctly addressed — failures seen so
// far are transient bus noise / partial frames, not a config problem.
#define MAX_RETRIES 5
// Small gap between retries so we don't hammer the bus back-to-back.
#define RETRY_GAP_MS 50

// Last successfully read value per register — displayed instead of an
// error whenever a poll fails, same "never go blank" philosophy as the
// production firmware. Tracked independently for processed (0x0100) vs
// real-time (0x0101) so one register failing doesn't mark the other stale.
int32_t lastGoodProcessedMm = -1;
bool haveGoodProcessed = false;
int32_t lastGoodRealtimeMm = -1;
bool haveGoodRealtime = false;


// Modbus CRC16 (CRC-16/MODBUS, poly 0xA001, init 0xFFFF, little-endian output)
uint16_t modbusCRC16(const uint8_t* buf, uint8_t len) {
  uint16_t crc = 0xFFFF;
  for (uint8_t i = 0; i < len; i++) {
    crc ^= buf[i];
    for (uint8_t b = 0; b < 8; b++) {
      if (crc & 0x0001) {
        crc >>= 1;
        crc ^= 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

// Sends a Modbus-RTU "Read Holding Register" request (function 0x03) for
// a single register, reads back the response, and returns the raw 16-bit
// register value (caller applies whatever scale the register uses — mm for
// distance, 0.1 degC for temperature). Returns -1 on timeout/CRC/format error.
int32_t readModbusRegister(uint8_t slaveAddr, uint16_t regAddr) {
  uint8_t req[8];
  req[0] = slaveAddr;
  req[1] = 0x03;                       // function code: read holding register
  req[2] = (regAddr >> 8) & 0xFF;      // register address high byte
  req[3] = regAddr & 0xFF;             // register address low byte
  req[4] = 0x00;                       // qty high byte
  req[5] = 0x01;                       // qty low byte (1 register)
  uint16_t crc = modbusCRC16(req, 6);
  req[6] = crc & 0xFF;                 // CRC low byte first
  req[7] = (crc >> 8) & 0xFF;          // CRC high byte

  // Flush any stale bytes sitting in the RX buffer before we transmit.
  while (rs485.available()) rs485.read();

  // Switch to transmit mode, send request, then switch back to receive.
  digitalWrite(RS485_DIR_PIN, HIGH);
  delayMicroseconds(100);
  rs485.write(req, 8);
  rs485.flush();                       // wait until bytes are physically sent
  delayMicroseconds(100);
  digitalWrite(RS485_DIR_PIN, LOW);

  // Expected response: addr(1) + func(1) + bytecount(1) + data(2) + crc(2) = 7 bytes
  //
  // Two timeouts guard this loop:
  //   - overall 500ms cap — the sensor's documented worst-case response time
  //     for the processed-value register.
  //   - 30ms inter-byte gap — once bytes start arriving, a real frame's
  //     bytes are back-to-back at 9600 baud (~1ms/byte). If the gap between
  //     two received bytes exceeds this, the frame is noise/collision
  //     debris and we abandon it immediately instead of waiting out the
  //     full 500ms window — lets a retry fire sooner.
  uint8_t resp[7];
  uint8_t received = 0;
  unsigned long start = millis();
  unsigned long lastByteAt = start;
  const unsigned long INTERBYTE_TIMEOUT_MS = 30;
  while (received < 7 && (millis() - start) < 500) {
    if (rs485.available()) {
      resp[received++] = rs485.read();
      lastByteAt = millis();
    } else if (received > 0 && (millis() - lastByteAt) > INTERBYTE_TIMEOUT_MS) {
      break;   // frame stalled mid-way — noise, don't wait out the full window
    }
  }

  // Silent failure paths — no per-attempt logging. loop() retries under the
  // hood and only ever prints the final Distance line for the poll cycle.
  if (received < 7) {
    return -1;
  }

  if (resp[0] != slaveAddr || resp[1] != 0x03 || resp[2] != 0x02) {
    return -1;
  }

  uint16_t respCrc = modbusCRC16(resp, 5);
  uint16_t recvCrc = resp[5] | (resp[6] << 8);
  if (respCrc != recvCrc) {
    return -1;
  }

  uint16_t regValue = (resp[3] << 8) | resp[4];
  return regValue;
}

// Wraps readModbusRegister() with the same retry policy used for distance
// polling. Returns -1 if every attempt fails.
int32_t readModbusRegisterRetry(uint8_t slaveAddr, uint16_t regAddr) {
  int32_t value = -1;
  for (uint8_t attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    value = readModbusRegister(slaveAddr, regAddr);
    if (value >= 0) break;
    delay(RETRY_GAP_MS);
  }
  return value;
}

// Sends a Modbus-RTU "Write Single Register" request (function 0x06).
// Per datasheet, the slave echoes back the exact same frame on success.
// Returns true if the echo matches (write confirmed), false otherwise.
bool writeModbusRegister(uint8_t slaveAddr, uint16_t regAddr, uint16_t value) {
  uint8_t req[8];
  req[0] = slaveAddr;
  req[1] = 0x06;
  req[2] = (regAddr >> 8) & 0xFF;
  req[3] = regAddr & 0xFF;
  req[4] = (value >> 8) & 0xFF;
  req[5] = value & 0xFF;
  uint16_t crc = modbusCRC16(req, 6);
  req[6] = crc & 0xFF;
  req[7] = (crc >> 8) & 0xFF;

  while (rs485.available()) rs485.read();

  digitalWrite(RS485_DIR_PIN, HIGH);
  delayMicroseconds(100);
  rs485.write(req, 8);
  rs485.flush();
  delayMicroseconds(100);
  digitalWrite(RS485_DIR_PIN, LOW);

  uint8_t resp[8];
  uint8_t received = 0;
  unsigned long start = millis();
  unsigned long lastByteAt = start;
  const unsigned long INTERBYTE_TIMEOUT_MS = 30;
  while (received < 8 && (millis() - start) < 500) {
    if (rs485.available()) {
      resp[received++] = rs485.read();
      lastByteAt = millis();
    } else if (received > 0 && (millis() - lastByteAt) > INTERBYTE_TIMEOUT_MS) {
      break;
    }
  }

  if (received < 8) return false;

  // Success = slave echoes the exact request frame back.
  for (uint8_t i = 0; i < 8; i++) {
    if (resp[i] != req[i]) return false;
  }
  return true;
}

void printHelp() {
  Serial.println();
  Serial.println("=== Commands ===");
  Serial.printf("  HELP                - show this help\n");
  Serial.printf("  ADDR                - show address currently used for reads (now: 0x%02X)\n", currentAddr);
  Serial.printf("  SETADDR <n>         - change sensor address. Valid range: 0x%02X-0x%02X (%u-%u decimal).\n",
                ADDR_MIN, ADDR_MAX, ADDR_MIN, ADDR_MAX);
  Serial.println("                        Accepts decimal (SETADDR 5) or hex (SETADDR 0x05).");
  Serial.println("                        Pings currentAddr first and asks you to type YES to");
  Serial.println("                        confirm before writing anything.");
  Serial.println("  READ <addr> [reg]   - read a specific address/register. On success, background");
  Serial.println("                        polling SWITCHES to <addr> from then on. [reg] defaults to");
  Serial.println("                        0x0100 (distance) if omitted.");
  Serial.println("                        e.g. READ 5   |   READ 0x05 0x0102");
  Serial.println("  SCAN [lo] [hi]      - probe addresses lo..hi (default 1..10) for a reply.");
  Serial.println("  SCAN FULL           - probe the entire valid range 0x01..0xFE (slower).");
  Serial.println("  GR                  - one-shot: read REAL-TIME distance (0x0101) from currentAddr");
  Serial.println("  GP                  - one-shot: read PROCESSED distance (0x0100) from currentAddr");
  Serial.printf("  POLL ON|OFF         - start/stop continuous background polling (now: %s)\n",
                pollingEnabled ? "ON" : "OFF");
  Serial.printf("  POLL GR|GP|BOTH     - choose what continuous polling reads each cycle (now: %s)\n",
                pollModeName(pollMode));
  Serial.println("                        GR/GP modes skip temperature too, for fewer transactions/cycle.");
  Serial.println();
}

// Parses "SETADDR 5" or "SETADDR 0x05" -> 5. Returns -1 if not a valid number.
int32_t parseAddrArg(const String& arg) {
  String a = arg;
  a.trim();
  if (a.length() == 0) return -1;
  long val;
  if (a.startsWith("0x") || a.startsWith("0X")) {
    val = strtol(a.c_str() + 2, nullptr, 16);
  } else {
    val = strtol(a.c_str(), nullptr, 10);
  }
  return val;
}

// How many times to retry the WRITE frame itself before giving up.
#define SETADDR_WRITE_RETRIES 4
// After the write is sent, wait this long before trying the new address at
// all — the sensor needs a moment to actually apply the change internally.
#define SETADDR_SETTLE_MS      3000
// Then try reading the new address this many times (with a gap) before
// concluding the change didn't take.
#define SETADDR_VERIFY_RETRIES 3
#define SETADDR_VERIFY_GAP_MS  500

// Quick, single-pass probe (no retries — caller decides whether to retry)
// across lo..hi. Returns the first address that replies, or 0 if none do.
uint8_t quickFindSensor(uint8_t lo, uint8_t hi) {
  for (uint16_t addr = lo; addr <= hi; addr++) {
    if (readModbusRegister((uint8_t)addr, REG_PROCESSED) >= 0) return (uint8_t)addr;
  }
  return 0;
}

// Pending confirmation state for SETADDR's two-step flow: ping first,
// require the user to type YES before the write actually happens.
bool    pendingSetAddrActive = false;
uint8_t pendingNewAddr       = 0;

void handleSetAddr(const String& arg) {
  int32_t newAddr = parseAddrArg(arg);
  if (newAddr < ADDR_MIN || newAddr > ADDR_MAX) {
    Serial.printf("Invalid address. Valid range: 0x%02X-0x%02X (%u-%u decimal).\n",
                  ADDR_MIN, ADDR_MAX, ADDR_MIN, ADDR_MAX);
    return;
  }

  // Step 0: before touching anything, confirm currentAddr is actually a
  // live sensor. Writing to a dead address always fails every retry and
  // looks like a bus problem when the real issue is a stale currentAddr
  // (e.g. from an earlier SETADDR that moved it without this sketch
  // noticing). Ping first, show the user what's there, and require an
  // explicit YES before sending the write.
  Serial.printf("Checking currentAddr 0x%02X before writing...\n", currentAddr);
  int32_t pingValue = readModbusRegisterRetry(currentAddr, REG_PROCESSED);
  if (pingValue < 0) {
    Serial.printf("0x%02X did not respond. Not safe to write — the sensor may have moved.\n"
                  "Run 'SCAN' or 'SCAN FULL' to find it, then 'READ <addr>' to point currentAddr "
                  "there, before retrying SETADDR.\n", currentAddr);
    return;
  }

  Serial.printf("Confirmed: 0x%02X is alive (distance %ld mm / %.1f cm).\n",
                currentAddr, (long)pingValue, pingValue / 10.0);
  Serial.printf("About to change its address to 0x%02X. Type YES to proceed, or anything else to cancel.\n",
                (uint8_t)newAddr);
  pendingSetAddrActive = true;
  pendingNewAddr = (uint8_t)newAddr;
}

// Called once the user has typed YES after a pinged SETADDR. Does the
// actual write + verify that handleSetAddr used to do unconditionally.
void executeSetAddr(uint8_t newAddr) {
  Serial.printf("Writing new address 0x%02X to sensor currently at 0x%02X...\n",
                newAddr, currentAddr);

  // Step 1: send the write frame (function 0x06, register 0x0200). Per
  // datasheet Example 4, the slave echoes the exact request back on success.
  // Bus drops partial frames on plain reads too (see MAX_RETRIES), so retry
  // a handful of times before concluding the write itself failed.
  bool wroteOk = false;
  for (uint8_t attempt = 1; attempt <= SETADDR_WRITE_RETRIES; attempt++) {
    wroteOk = writeModbusRegister(currentAddr, REG_SLAVE_ADDR, (uint16_t)newAddr);
    if (wroteOk) break;
    Serial.printf("  write attempt %u/%u failed, retrying...\n", attempt, SETADDR_WRITE_RETRIES);
    delay(RETRY_GAP_MS);
  }
  if (!wroteOk) {
    Serial.println("Write failed after retries — no/invalid echo from sensor. Address unchanged.");
    return;
  }

  // Step 2: a clean write echo doesn't guarantee the sensor is already
  // answering under the new address — some modules apply it after a short
  // internal delay. Give it a moment, then poll the NEW address until it
  // actually replies instead of trusting the echo alone.
  Serial.printf("Write echoed OK. Waiting %lus for sensor to apply it, then checking 0x%02X...\n",
                SETADDR_SETTLE_MS / 1000UL, (uint8_t)newAddr);
  delay(SETADDR_SETTLE_MS);
  bool verified = false;
  for (uint8_t attempt = 1; attempt <= SETADDR_VERIFY_RETRIES; attempt++) {
    int32_t test = readModbusRegister((uint8_t)newAddr, REG_PROCESSED);
    if (test >= 0) { verified = true; break; }
    Serial.printf("  verify attempt %u/%u: new address not replying yet, retrying...\n",
                  attempt, SETADDR_VERIFY_RETRIES);
    delay(SETADDR_VERIFY_GAP_MS);
  }

  if (!verified) {
    // Don't just assume the OLD address is still valid — check it. If the
    // write actually succeeded (its echo said so) the sensor has already
    // moved and the old address is gone too; silently reverting currentAddr
    // in that case makes the sketch claim an address that doesn't respond.
    int32_t oldStillWorks = readModbusRegister(currentAddr, REG_PROCESSED);
    if (oldStillWorks >= 0) {
      Serial.printf("Write echoed OK, but 0x%02X never replied. Old address 0x%02X "
                    "still works — address change did not take. Staying on 0x%02X.\n",
                    (uint8_t)newAddr, currentAddr, currentAddr);
    } else {
      Serial.printf("Write echoed OK, but neither 0x%02X (new) nor 0x%02X (old) is "
                    "replying right now. Sensor may be mid-transition — try 'READ 0x%02X 0x0100' "
                    "in a few seconds, or SCAN to find it.\n",
                    (uint8_t)newAddr, currentAddr, (uint8_t)newAddr);
    }
    return;
  }

  currentAddr = (uint8_t)newAddr;
  Serial.printf("Success — confirmed reply from 0x%02X. Now reading from 0x%02X.\n",
                currentAddr, currentAddr);

  // Old readings no longer apply now that we're pointed at (what should be)
  // the same physical sensor under its new address — force a fresh read
  // next cycle rather than showing a stale value under the new label.
  haveGoodProcessed = false;
  haveGoodRealtime = false;
}

// Formats a raw register value for display, guessing the right unit from
// the register address (only the three read-only registers we know about).
void printRegValue(uint16_t regAddr, int32_t rawValue) {
  if (regAddr == REG_PROCESSED || regAddr == REG_REALTIME) {
    Serial.printf("%ld mm (%.1f cm)\n", (long)rawValue, rawValue / 10.0);
  } else if (regAddr == REG_TEMPERATURE) {
    Serial.printf("%.1f C\n", rawValue / 10.0);
  } else {
    Serial.printf("raw = %ld (0x%04lX)\n", (long)rawValue, (long)rawValue);
  }
}

// READ <addr> [reg] — reads a user-given address/register once, AND (if the
// read succeeds) switches currentAddr to it, so all subsequent background
// polling continues from that address. Also useful for reading a specific
// register (e.g. temperature) from whatever address is currently active,
// without changing anything, if <addr> matches currentAddr already.
void handleRead(const String& arg) {
  String a = arg;
  a.trim();
  int spaceIdx = a.indexOf(' ');
  String addrStr = (spaceIdx > 0) ? a.substring(0, spaceIdx) : a;
  String regStr  = (spaceIdx > 0) ? a.substring(spaceIdx + 1) : "";
  regStr.trim();

  int32_t addr = parseAddrArg(addrStr);
  if (addr < ADDR_MIN || addr > ADDR_MAX) {
    Serial.printf("Invalid address. Valid range: 0x%02X-0x%02X (%u-%u decimal).\n",
                  ADDR_MIN, ADDR_MAX, ADDR_MIN, ADDR_MAX);
    return;
  }

  uint16_t reg = REG_PROCESSED;   // default register if none given
  if (regStr.length() > 0) {
    int32_t parsedReg = parseAddrArg(regStr);   // same 0x../decimal parsing works here
    if (parsedReg < 0) {
      Serial.println("Invalid register. Use decimal or 0x.. hex, e.g. 0x0102.");
      return;
    }
    reg = (uint16_t)parsedReg;
  }

  Serial.printf("Reading addr 0x%02X, register 0x%04X... ", (uint8_t)addr, reg);
  int32_t value = readModbusRegisterRetry((uint8_t)addr, reg);
  if (value < 0) {
    Serial.println("no reply.");
    return;
  }
  printRegValue(reg, value);

  if ((uint8_t)addr != currentAddr) {
    Serial.printf("Switching background polling to 0x%02X.\n", (uint8_t)addr);
    currentAddr = (uint8_t)addr;
    haveGoodProcessed = false;
  haveGoodRealtime = false;
  }
}

// SCAN [lo] [hi] — probes every address in range for a reply on the
// distance register. Default range 1..10 covers the common small-bus case;
// pass explicit bounds to sweep further, or SCAN FULL / SCAN ALL to sweep
// the entire valid range (0x01-0xFE, 254 addresses — takes longer since
// each miss still pays a short per-address timeout).
void handleScan(const String& arg) {
  String a = arg;
  a.trim();
  String aUpper = a; aUpper.toUpperCase();
  uint8_t lo = 1, hi = 10;

  if (aUpper == "FULL" || aUpper == "ALL") {
    lo = ADDR_MIN;
    hi = ADDR_MAX;
  } else if (a.length() > 0) {
    int spaceIdx = a.indexOf(' ');
    String loStr = (spaceIdx > 0) ? a.substring(0, spaceIdx) : a;
    String hiStr = (spaceIdx > 0) ? a.substring(spaceIdx + 1) : "";
    int32_t loVal = parseAddrArg(loStr);
    if (loVal >= ADDR_MIN && loVal <= ADDR_MAX) lo = (uint8_t)loVal;
    if (hiStr.length() > 0) {
      int32_t hiVal = parseAddrArg(hiStr);
      if (hiVal >= ADDR_MIN && hiVal <= ADDR_MAX) hi = (uint8_t)hiVal;
    }
  }
  if (hi < lo) { uint8_t t = lo; lo = hi; hi = t; }

  Serial.printf("Scanning 0x%02X..0x%02X for a reply (this may take a %s)...\n", lo, hi,
                (hi - lo > 30) ? "while — full range" : "few seconds");
  bool foundAny = false;
  uint8_t firstFound = 0;
  for (uint16_t addr = lo; addr <= hi; addr++) {
    int32_t value = readModbusRegister((uint8_t)addr, REG_PROCESSED);   // single try, no retry — keep scan fast
    if (value >= 0) {
      Serial.printf("  FOUND: 0x%02X replied — distance %ld mm (%.1f cm)\n",
                    (uint8_t)addr, (long)value, value / 10.0);
      if (!foundAny) firstFound = (uint8_t)addr;
      foundAny = true;
    }
  }
  if (!foundAny) {
    Serial.println("  No sensor replied in that range.");
    return;
  }

  // Adopt the first responding address as currentAddr — SCAN is run
  // precisely to find where the sensor actually is (e.g. after an
  // ambiguous SETADDR result), so switch reads to it automatically
  // instead of leaving currentAddr pointed at a dead address.
  if (firstFound != currentAddr) {
    Serial.printf("Switching currentAddr from 0x%02X to 0x%02X (found responding).\n",
                  currentAddr, firstFound);
    currentAddr = firstFound;
    haveGoodProcessed = false;
  haveGoodRealtime = false;
  }
}

// GR/GP — one-shot read of a single register from currentAddr, independent
// of the background polling loop (works whether POLL is ON or OFF). Does
// NOT touch the lastGood*/haveGood* staleness-tracking state used by the
// continuous poller — this is a separate, on-demand check.
void handleOneShotRead(uint16_t reg, const char* label) {
  Serial.printf("[addr 0x%02X] %s: ", currentAddr, label);
  int32_t value = readModbusRegisterRetry(currentAddr, reg);
  if (value < 0) {
    Serial.println("no reply.");
    return;
  }
  Serial.printf("%ld mm (%.1f cm)\n", (long)value, value / 10.0);
}

void handleSerialCommand() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() == 0) return;

  // A SETADDR ping is waiting on user confirmation — the next line typed
  // is treated as the yes/no answer, not a new command, regardless of
  // what it looks like.
  if (pendingSetAddrActive) {
    String answer = line;
    answer.trim();
    answer.toUpperCase();
    pendingSetAddrActive = false;   // consume the pending state either way
    if (answer == "YES") {
      executeSetAddr(pendingNewAddr);
    } else {
      Serial.println("Cancelled — address unchanged.");
    }
    return;
  }

  String cmd = line;
  String arg = "";
  int spaceIdx = line.indexOf(' ');
  if (spaceIdx > 0) {
    cmd = line.substring(0, spaceIdx);
    arg = line.substring(spaceIdx + 1);
  }
  cmd.toUpperCase();

  if (cmd == "HELP") {
    printHelp();
  } else if (cmd == "ADDR") {
    Serial.printf("Currently reading from address 0x%02X.\n", currentAddr);
  } else if (cmd == "SETADDR") {
    handleSetAddr(arg);
  } else if (cmd == "READ") {
    handleRead(arg);
  } else if (cmd == "SCAN") {
    handleScan(arg);
  } else if (cmd == "GR") {
    handleOneShotRead(REG_REALTIME, "Real-time");
  } else if (cmd == "GP") {
    handleOneShotRead(REG_PROCESSED, "Processed");
  } else if (cmd == "POLL") {
    String a = arg; a.toUpperCase();
    if (a == "ON") {
      pollingEnabled = true;
      lastPoll = 0;   // fire immediately instead of waiting a full interval
      Serial.printf("Continuous polling ON — mode: %s\n", pollModeName(pollMode));
    } else if (a == "OFF") {
      pollingEnabled = false;
      Serial.println("Continuous polling OFF. Use GR/GP for one-shot reads.");
    } else if (a == "GR") {
      pollMode = POLL_MODE_GR_ONLY;
      Serial.println("Poll mode set: GR only (real-time, no temp).");
    } else if (a == "GP") {
      pollMode = POLL_MODE_GP_ONLY;
      Serial.println("Poll mode set: GP only (processed, no temp).");
    } else if (a == "BOTH") {
      pollMode = POLL_MODE_BOTH;
      Serial.println("Poll mode set: BOTH (processed + real-time + temp).");
    } else {
      Serial.println("Usage: POLL ON|OFF|GR|GP|BOTH");
    }
  } else {
    Serial.printf("Unknown command '%s'. Type HELP for commands.\n", cmd.c_str());
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== RS485 Ultrasonic Sensor Test ===");

  pinMode(RS485_DIR_PIN, OUTPUT);
  digitalWrite(RS485_DIR_PIN, LOW);   // start in receive mode

  rs485.begin(9600, SERIAL_8N1, RS485_RX_PIN, RS485_TX_PIN);

  Serial.println("RS485 initialized. Polling sensor...");
  printHelp();
}

void loop() {
  handleSerialCommand();

  if (pollingEnabled && millis() - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = millis();

    bool wantProcessed = (pollMode == POLL_MODE_BOTH || pollMode == POLL_MODE_GP_ONLY);
    bool wantRealtime  = (pollMode == POLL_MODE_BOTH || pollMode == POLL_MODE_GR_ONLY);
    bool wantTemp      = (pollMode == POLL_MODE_BOTH);

    // Poll only what the current mode calls for. Each register keeps its
    // own last-good value and staleness — a failure on one never marks
    // another stale, so you always see whichever one is actually fresh.
    int32_t processedMm = -1, realtimeMm = -1, tempRaw = -1;

    if (wantProcessed) {
      processedMm = readModbusRegisterRetry(currentAddr, REG_PROCESSED);
      if (processedMm >= 0) {
        lastGoodProcessedMm = processedMm;
        haveGoodProcessed = true;
      }
    }

    if (wantRealtime) {
      realtimeMm = readModbusRegisterRetry(currentAddr, REG_REALTIME);
      if (realtimeMm >= 0) {
        lastGoodRealtimeMm = realtimeMm;
        haveGoodRealtime = true;
      }
    }

    if (wantTemp) {
      tempRaw = readModbusRegisterRetry(currentAddr, REG_TEMPERATURE);
    }

    // Never print a bare error — always show the last good value per
    // register (with its own [stale] marker if that register's retries
    // all failed this cycle). Matches the production firmware's "never
    // go blank" fallback philosophy, applied per-register instead of
    // collapsing both distance readings into one.
    bool haveAnything = (wantProcessed && haveGoodProcessed) || (wantRealtime && haveGoodRealtime);
    if (haveAnything) {
      Serial.printf("[addr 0x%02X] ", currentAddr);

      if (wantProcessed) {
        if (haveGoodProcessed) {
          bool staleP = (processedMm < 0);
          Serial.printf("Processed: %ld mm (%.1f cm)%s   ",
                        (long)lastGoodProcessedMm, lastGoodProcessedMm / 10.0,
                        staleP ? "[stale]" : "");
        } else {
          Serial.print("Processed: n/a   ");
        }
      }

      if (wantRealtime) {
        if (haveGoodRealtime) {
          bool staleR = (realtimeMm < 0);
          Serial.printf("Real-time: %ld mm (%.1f cm)%s   ",
                        (long)lastGoodRealtimeMm, lastGoodRealtimeMm / 10.0,
                        staleR ? "[stale]" : "");
        } else {
          Serial.print("Real-time: n/a   ");
        }
      }

      if (wantTemp) {
        if (tempRaw >= 0) {
          Serial.printf("Temp: %.1f C\n", tempRaw / 10.0);
        } else {
          Serial.println("Temp: n/a");
        }
      } else {
        Serial.println();
      }
    } else {
      Serial.println("No reading yet — check wiring/address/baud.");
    }
  }
}
