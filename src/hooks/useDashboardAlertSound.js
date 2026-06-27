import { useEffect, useRef, useState } from "react";

// Browser-synthesised alert beep. Uses Web Audio API directly so we don't
// ship any audio assets. Two tones differentiate severity:
//   "low"   → falling pitch (880 → 440 Hz, ~400 ms) — "tank going dry"
//   "high"  → rising pitch  (440 → 880 Hz, ~400 ms) — "tank full / refill done"
// Single shared AudioContext so we don't spawn one per beep — browsers
// limit concurrent contexts and creating them is slow on first call.
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  // Modern browsers suspend the context until the user interacts with the
  // page. resume() is a no-op if already running.
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playBeep(severity) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  const now  = ctx.currentTime;

  // Pitch sweep direction encodes severity.
  if (severity === "low") {
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.4);
  } else {
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.4);
  }

  // Envelope: quick attack, gentle decay. Stops the audible click that
  // plain on/off gating produces, and keeps the beep from sounding harsh.
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.25, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.5);
}

// Detect ONLY user-configured threshold breaches. We deliberately ignore
// sensor errors, offline state, and other system signals — user said
// "just the dashboard alerts activated by user only should have sound."
// alertLowPct / alertHighPct come from the subscription doc and are
// undefined/null when the user never opened the Alert Settings panel.
function severityFor(d) {
  const pct = d.live?.confirmedPct;
  if (typeof pct !== "number") return null;
  const low  = d.alertLowPct;
  const high = d.alertHighPct;
  if (low  != null && low  !== "" && pct <= Number(low))  return "low";
  if (high != null && high !== "" && pct >= Number(high)) return "high";
  return null;
}

// Edge-triggered alert sound for dashboard. Fires once per device when a
// threshold is newly breached, falls silent when the device drops back
// into the safe range. No continuous looping — user said "blinking" is
// the existing visual signal; this is the audio companion.
export function useDashboardAlertSound(devices) {
  const [muted, setMuted] = useState(() => {
    return localStorage.getItem("dashboardAlertMuted") === "true";
  });
  const prevAlertingRef = useRef(new Map());   // deviceCode → severity

  function toggleMuted() {
    setMuted((m) => {
      const next = !m;
      localStorage.setItem("dashboardAlertMuted", String(next));
      // A user-initiated click is exactly the gesture browsers require to
      // unlock AudioContext. Touch it here so the first real alert beep
      // doesn't get swallowed by autoplay policy.
      if (!next) getAudioCtx();
      return next;
    });
  }

  useEffect(() => {
    if (muted) {
      // While muted we still track who is currently alerting, so when the
      // user unmutes we don't re-fire for already-active alerts.
      const now = new Map();
      for (const d of devices) {
        const sev = severityFor(d);
        if (sev) now.set(d.deviceCode, sev);
      }
      prevAlertingRef.current = now;
      return;
    }

    const prev = prevAlertingRef.current;
    const now  = new Map();
    let firstNewSeverity = null;

    for (const d of devices) {
      const sev = severityFor(d);
      if (!sev) continue;
      now.set(d.deviceCode, sev);
      // Edge: either device wasn't alerting before, or it crossed from
      // one severity to the other (e.g. drained from full to empty
      // without ever being in the safe zone). Both deserve a fresh beep.
      const was = prev.get(d.deviceCode);
      if (was !== sev) {
        if (!firstNewSeverity) firstNewSeverity = sev;
      }
    }

    if (firstNewSeverity) playBeep(firstNewSeverity);
    prevAlertingRef.current = now;
  }, [devices, muted]);

  return { muted, toggleMuted };
}
