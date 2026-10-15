import { useEffect, useRef, useState } from "react";

// Threshold alert with 1-min sustained-state debounce.
//
// The bug: ultrasonic sensors oscillate 55↔56% around a 55% threshold and
// fire the alert visual every 20-30 sec even when the tank is physically
// stable. Symmetric hysteresis on the ENTRY *and* EXIT edges filters that
// out — a state flip is only committed after the new state has held for
// DEBOUNCE_MS uninterrupted.
//
// Model:
//   - Every device has a committed "in alert" boolean.
//   - When a live push flips the raw alert-zone status, we schedule a
//     one-shot commit setTimeout for +DEBOUNCE_MS. If another push
//     reverses the flip before that fires, we cancel it — the committed
//     state never changes.
//   - Firmware pushes are change-driven with a 5-min heartbeat floor, so
//     "silence" == "state unchanged". A pending flip therefore commits
//     purely on the wall clock, no confirming push needed. That handles
//     the "level drops to 40%, no push for 5 min" case correctly.
//
// Initial state: first push after tab open sets committed state
// IMMEDIATELY (no debounce) — customer opening the dashboard on a
// genuinely-low tank must see the alert without a 1-min stall. Every
// subsequent flip goes through the debounce.
//
// Scope: browser-only. Each tab tracks its own timers. Nothing written
// to Firebase, no cross-tab coordination. If the tab reloads, the "first
// push" logic re-fires — acceptable, matches "we only care about while
// the browser is open".

export const DEBOUNCE_MS = 1 * 60 * 1000;

// Raw alert-zone check — pure of any debouncing. Matches the semantics
// Dashboard's SensorCard and Kiosk's isTankInAlert used before.
//
// Percentage source is device-class aware:
//   • Sensor / valve / motor  → live.confirmedPct  (0-100 or null)
//   • Pump (deviceClass=4)    → live.terracePct    when firmware
//     publishes a continuous ultrasonic level, else the discrete
//     terraceState enum mapped to 0/50/100 (empty/half/full).
// Same alertLowPct/alertHighPct thresholds apply to both so nothing
// downstream (notifications, sound, flash) has to branch by class.
function isInAlertZone(d) {
  const isPump = d.info?.deviceClass === 4;
  let pct;
  if (isPump) {
    const raw = d.live?.terracePct;
    if (typeof raw === "number" && isFinite(raw)) {
      pct = raw;
    } else {
      const s = d.live?.terraceState;
      pct = s === "full" ? 100 : s === "half" ? 50 : s === "empty" ? 0 : null;
    }
  } else {
    pct = d.live?.confirmedPct;
  }
  const lo = d.alertLowPct;
  const hi = d.alertHighPct;
  if (typeof pct === "number") {
    if (lo != null && lo !== "" && pct <= Number(lo)) return true;
    if (hi != null && hi !== "" && pct >= Number(hi)) return true;
  }

  // Pump-only extras — source-dry and pump-fault flags. Each is opt-in
  // via a separate catalog boolean so users can enable exactly the
  // categories they care about. All feed the same debounced "in alert"
  // signal so downstream (flash, beep, push) treats them uniformly.
  if (isPump) {
    const src        = d.live?.sourceState;                    // "wet" | "dry"
    const pumpState  = d.live?.pumpState;                      // "off"/"auto"/"manual"/"fault"/…
    const pumpStage  = d.live?.pumpStage;                      // "SAFE_MODE" / "DRY_RUN_RECOVERY" / …
    const causeLast  = d.live?.lastCauseEnd;                   // firmware sets on each pump_off event
    // Source dry (with pump attempting to run) — the impeller-protection
    // scenario the user called out. Only flags when the pump is
    // actually trying to move water, not just idle-source-dry.
    if (d.alertSourceDry && src === "dry" && (pumpState === "auto" || pumpState === "manual" || pumpState === "starting")) return true;
    // Firmware-detected dry_run event on the last completed run.
    if (d.alertPumpDryRun && causeLast === "dry_run") return true;
    // Firmware-detected max_runtime event on the last completed run.
    if (d.alertPumpMaxRuntime && causeLast === "max_runtime") return true;
    // Persistent SAFE_MODE lockout — stays flagged until the customer clears it.
    if (d.alertPumpSafeMode && pumpStage === "SAFE_MODE") return true;
  }

  return false;
}

export function useDebouncedAlerts(devices) {
  // Committed public state: deviceCode → boolean (in alert or not).
  // Consumers read this. Bumped as a fresh Map on every commit so
  // downstream useMemos react.
  const [committed, setCommitted] = useState(() => new Map());

  // Per-device pending timer handles. Cleared / rescheduled as pushes
  // come in. Stored in a ref so re-renders don't wipe them.
  const timersRef = useRef(new Map());
  // Track which devices we've seen at least one push for — first push
  // per device bypasses the debounce. Ref so it survives re-renders.
  const seenRef = useRef(new Set());

  useEffect(() => {
    setCommitted((prev) => {
      const next = new Map(prev);
      let changed = false;

      for (const d of devices) {
        const code = d.deviceCode;
        const raw  = isInAlertZone(d);
        const cur  = next.get(code) ?? false;

        // First encounter with this device this tab-lifetime → adopt
        // raw state immediately, no debounce. Applies to page-load
        // AND to devices added mid-session (rare).
        if (!seenRef.current.has(code)) {
          seenRef.current.add(code);
          if (raw !== cur) {
            next.set(code, raw);
            changed = true;
          }
          continue;
        }

        // Already-seen device. If raw matches committed, cancel any
        // pending flip — the tank returned to its committed state
        // before the debounce fired.
        if (raw === cur) {
          const t = timersRef.current.get(code);
          if (t) {
            clearTimeout(t);
            timersRef.current.delete(code);
          }
          continue;
        }

        // raw != committed AND a timer is already pending — keep the
        // existing timer running (it was scheduled at the moment of
        // the first flip; the intermediate pushes don't extend it).
        if (timersRef.current.has(code)) continue;

        // New flip. Schedule a one-shot commit.
        const timer = setTimeout(() => {
          timersRef.current.delete(code);
          setCommitted((p) => {
            const m = new Map(p);
            m.set(code, raw);
            return m;
          });
        }, DEBOUNCE_MS);
        timersRef.current.set(code, timer);
      }

      // Clean up committed entries for devices that vanished from the
      // list (subscription removed, org membership revoked, etc). Also
      // cancel their pending timers if any.
      for (const code of next.keys()) {
        if (!devices.some((d) => d.deviceCode === code)) {
          next.delete(code);
          changed = true;
          const t = timersRef.current.get(code);
          if (t) { clearTimeout(t); timersRef.current.delete(code); }
          seenRef.current.delete(code);
        }
      }

      return changed ? next : prev;
    });
  }, [devices]);

  // Clean up all pending timers on unmount.
  useEffect(() => {
    return () => {
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, []);

  return committed;
}
