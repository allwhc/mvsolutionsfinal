---
name: pump-automation-plan
description: "Design discussion for the pump+valves+sensors automation feature — logic card, broker modes, firmware architecture. NOT YET BUILT. Resume here when continuing the automation work."
metadata: 
  node_type: memory
  type: project
  originSessionId: cf6100db-ee70-4804-8050-2fdc8dbd2904
  modified: 2026-11-03T12:14:25.880Z
---

# Pump Automation / Logic Card — design notes

**Status:** DESIGN DISCUSSED, NOT BUILT. Decisions mostly agreed; waiting on final scope confirmation to code the demo.

**Why:** Customer (Kalpataru-shape) wants a dashboard logic card where one pump intelligently fills multiple overhead tanks via motorized valves, with safety interlocks, scheduling, and offline resilience.

## Target site layout

- 1 ground tank with ultrasonic sensor (source of water, dry-run protection)
- 1 pump (relay-controlled)
- 4 overhead tanks each with ultrasonic sensor
- 4 motorized valves (one per overhead tank)
- Everything on same WiFi

## Hard-coded safety rules (NON-NEGOTIABLE, enforced by firmware/engine not customer)

1. **Freshness:** every sensor reading must be < 60 sec old. Any stale sensor → stop pump immediately.
2. **No dry pumping:** pump never runs with all valves closed (impeller safety).
3. **Ground floor:** pump never starts if ground tank < configurable min % (dry-run protection).
4. **One-at-a-time filling:** only ONE valve open at any moment (pressure split, sequential fill).
5. **Max run cap:** pump auto-stops after max_minutes per session.

## Config format — hybrid approach decided

Both **form wizard** AND **YAML/script view** of the same underlying JSON. Form is default (housing-society admins), YAML tab for power users. Both edit the same stored config.

JSON schema sketch:
```json
{
  "pump_code": "SF-PUMP-001",
  "ground_sensor": "SF-GROUND-001",
  "min_ground_pct": 20,
  "stations": [
    {"sensor": "SF-TANK-A", "valve": "SF-VALVE-A", "start_below": 20, "stop_above": 90},
    ...
  ],
  "strategy": "sequential",   // or "equalize" / "priority"
  "safety": {
    "staleness_sec": 60,
    "require_valve_open": true,
    "min_ground_pct": 20,
    "max_run_minutes": 30
  },
  "schedules": [
    {"cron": "0 6 * * *", "duration_minutes": 60, "strategy": "equalize", "overrides_automation": true}
  ]
}
```

## Where logic runs — ARCHITECTURE DECISION (user chose "flexible")

**Chosen: ONE firmware supports multiple modes, selectable per deployment.** Pump logic doesn't care where messages come from; only connection setup differs.

**Three modes:**

### Mode 1 — Pure Cloud (default)
- Pump + sensors + valves all connect to UK MQTT broker
- Pump subscribes to tank/ground/valve topics via cloud
- Logic runs on pump ESP32
- If internet dies → pump safely stops (stale-data interlock fires)
- **Use when:** reliable internet, non-critical site

### Mode 2 — Pure Local (pump acts as broker)
- Pump ESP32 runs tiny MQTT broker (`uMQTTBroker` or `sMQTTBroker` lib)
- Sensors + valves on same WiFi connect to pump's local IP
- Logic runs on pump ESP32
- Zero cloud involvement
- **Use when:** no internet OR data-privacy requirement
- **Caveat:** no remote monitoring, no cloud dashboard
- **Risks:** pump reboot = 10-30 sec site outage; ESP32 broker handles ~20 clients max

### Mode 3 — Hybrid (my recommendation for production)
- Pump acts as local broker
- Pump ALSO bridges all local messages to cloud (MQTT bridging — Mosquitto standard feature)
- Sensors see local broker (fast, works offline)
- Cloud sees everything via bridge (dashboard, history, alerts)
- Cloud dies → local keeps working
- **Use when:** best of both worlds, serious deployments

## Mode-switch handling (unresolved — pick before coding)

When customer switches pump mode, every sensor at the site needs to be reconfigured too.

- **A — Manual:** customer walks to each sensor, hits reset, reconfigures via AP page. Labor-intensive, error-prone.
- **B — Smart cutover (my rec):** cloud publishes broker-change command to all sensors, they update NVS + reboot + connect to new broker. One-click UX, needs firmware support.
- **C — Auto-discovery:** sensor tries cloud, falls back to mDNS discovery. Magical but complex.

**My recommendation stands: Option B (smart cutover).**

## Firmware architecture for the pump (pseudo-code)

```
on boot:
  load config from NVS (sensor list, thresholds, schedules, broker mode)
  connect to WiFi
  
  if broker_mode == "cloud" or "hybrid":
    attempt cloud MQTT connection
  if broker_mode == "local" or "hybrid":
    start local MQTT broker on port 1883
  
  subscribe to configured topics (local, cloud, or both)
  
loop:
  check safety interlocks:
    - any sensor stale > staleness_sec → stop pump, publish alert
    - ground tank < min_ground_pct → stop pump
    - all valves closed → never allow pump on
    - pump running > max_minutes → stop pump
  
  check schedule:
    - cron time matches → activate scheduled mode (overrides reactive)
  
  decide action per strategy (sequential / equalize / priority):
    - if any tank < start_below AND safety OK:
      - pick next tank per strategy
      - publish "open valve X" command (via MQTT)
      - wait for valve ack
      - turn ON own relay (pump)
    - if current tank >= stop_above:
      - publish "close valve X"
      - turn OFF own relay
      - advance to next tank per strategy
```

Estimated: ~300 lines of C++ firmware. Reusable across sites.

## Logic card dashboard UI (sketch)

```
┌─────────────────────────────────────────────────────────┐
│  🏠 <Site Name> — Overhead Tank Automation             │
│  Status: ● ACTIVE  (filling Tank C now)                 │
│                                                           │
│  Ground Tank G: 68% ✓ (min 20%)                         │
│                                                           │
│  Overhead Tanks:                                         │
│    T1 ████████████░░░░░░ 65% [▣valve closed] ✓ SAFE    │
│    T2 ███████████████░░░ 82% [▣valve closed] ✓ SAFE    │
│    T3 ████████░░░░░░░░░░ 42% [▶ VALVE OPEN]  🔵 FILLING│
│    T4 ████░░░░░░░░░░░░░░ 18% [▣valve closed] ⚠ QUEUED  │
│                                                           │
│  Pump P1:  ● RUNNING  (5 min 12 sec)  Max 30 min        │
│  All sensors fresh ✓  All interlocks pass ✓             │
│                                                           │
│  Today: Filled 4 tanks (6:00 AM session)                │
│  [⚙ Edit Config]  [⏸ Pause]  [⏹ Emergency Stop]        │
└─────────────────────────────────────────────────────────┘
```

**Decided: one card per site/automation**, not one per device. Groups the whole pump+tanks+valves system visually.

## Scheduling

- Daily simple picker (e.g. "6:00 AM every day") + "Advanced" expands to cron syntax.
- Scheduled sessions can OVERRIDE reactive automation during their window.
- Reactive = failsafe (catches unexpected drops throughout day).
- Scheduled = proactive (water available when customers wake up).

## Demo scope (NOT YET BUILT — waiting on go-ahead)

**Chose: Demo B (medium, ~1 day of work).**

### What demo B includes
- New customer account (`demo@senseflow.in` / `demo1234`) on stress-test server
- 10 dedicated virtual devices on Mac mini (1 ground + 4 tanks + 1 pump + 4 valves)
- Virtual pump device (Mac mini) simulating pump firmware with broker-mode toggle
- Logic card dashboard page in React
- Form editor + YAML view toggle for config
- Logic engine runs in cloud (simpler for demo; later moves to firmware)
- Postgres `automation_configs` table as source of truth
- Safety interlocks enforced
- Schedule + reactive modes both work
- Pause / Emergency Stop buttons

### What demo B does NOT include (defer to real build)
- Real ESP32 firmware for pump
- Hybrid mode (cloud + local bridge) — demo is cloud only
- Multi-pump per site (one pump per card for Phase 1)
- Physical e-stop wiring
- OTA for pump firmware

### Resume checklist when continuing

1. Reconfirm demo scope hasn't changed
2. Confirm these 7 decisions still hold:
   - Demo scope: **B**
   - Virtual pump device simulating firmware: **yes**
   - Config storage: Postgres `automation_configs`
   - One card per site: yes
   - Form + YAML toggle: yes
   - Schedule UI: simple picker + advanced cron
   - Demo account: `demo@senseflow.in` / `demo1234`
3. Check stress-test infrastructure still running (`https://57-128-151-42.sslip.io/stress`)
4. Spawn 10 new dedicated virtual devices on Mac mini (don't collide with 500-sensor load test)
5. Add `users`, `orgs`, `automation_configs` tables to Postgres
6. Add basic auth endpoints (JWT, no email verification needed for demo)
7. Build Logic Card React page
8. Build config editor (form + YAML tab)
9. Build logic engine in Node API (subscribe to topics, enforce safety, publish commands)
10. Build virtual pump sim script with broker-mode toggle

**Estimated: 4-6 hours of work.** Result: live URL where you log in as demo customer and see the automation working on virtual hardware.

## Open questions for next session

1. Mode-switch cutover (A/B/C) — my rec was B (smart cutover). Needs final confirm.
2. Multi-pump support in UI (one card vs multiple)?
3. Should the demo prove local-broker mode too, or just cloud mode first?
4. Priority filling strategy (fill T1 → T4 in order) — build in Phase 1 or defer?

## Related memory

- [[project_senseflow_architecture]] — overall platform structure
- [[project_pricing_business_model]] — if we write one; pump automation is a premium tier
- [[feedback_wifi_disconnect]] — firmware WiFi rules apply to pump firmware too
- [[feedback_firebase_init_internet_gate]] — not relevant if we move off Firebase

## Last touched

Session on 2026-11-03. Stress-test infrastructure (500 virtual devices + 100 customers) was running at:
- UK server: `57.128.151.42` (OVH London, 4 vCPU / 8 GB / Ubuntu 24.04 / Docker stack)
- Dashboard: `https://57-128-151-42.sslip.io/stress`
- Mac mini: `home1@10.241.2.79` (pwd `vish`) — running sim_devices_async.py, sim_customers.py, monitor.py in detached screens, caffeinate preventing sleep
- Stack details in `project_senseflow_server_migration` memory (if that gets written next)
