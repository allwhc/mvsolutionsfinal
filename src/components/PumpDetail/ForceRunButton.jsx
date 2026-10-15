// Force Run button — sits under the Live schematic on PumpDetail.
//
// Two visual states driven by live.pumpState:
//   • Idle / auto  → amber "⚡ Force Run" button → opens preset picker modal
//   • Running manual → red "■ Stop Force Run" button → confirmation → stop
//
// Only renders when the device is online AND canEdit (owner-only). If
// the panel is offline the button is hidden entirely rather than shown
// disabled — a disabled Force Run button on an offline device is
// confusing (customer doesn't know if the command will queue or drop).
//
// Preset choices mirror the AP page dropdown exactly — see
// FORCE_RUN_PRESETS in panelConfigValidation.js.
//
// After the customer clicks Start/Stop, the button visibly locks into
// a "waiting for pump to respond" state — spinner, disabled, status
// text explaining the round-trip. We consider the command confirmed
// when live.pumpState actually changes to the expected value. This
// prevents "did my click do anything?" confusion during the 1-30 sec
// window between cloud write and firmware acting on it.

import { useState, useEffect, useRef } from "react";
import { forceRunPump, stopForceRunPump } from "../../firebase/rtdb";
import { FORCE_RUN_PRESETS } from "../../utils/panelConfigValidation";

// If the pump doesn't change state within this many seconds after
// we sent the command, warn the customer (but don't force-unlock —
// firmware might just be slow; state might yet arrive).
const CONFIRM_TIMEOUT_MS = 30_000;

// v118.0.7: client-side pre-check mirrors the firmware's canStartForceRun()
// guard set — see Wired_NAVI_v2_Ultrasonic_cloud.ino. Running the same
// checks here BEFORE sending the command gives the user instant feedback
// instead of a 30-sec "waiting for pump to confirm" timeout.
//
// Returns {ok: false, reason, human} when a check fails; {ok: true} when
// the command should be sent. Config settings (stopPercent) and live
// readings (terracePct, terraceSensorFault) are the inputs — same as
// firmware. If settings are missing we skip the check (fail-open),
// since a mis-configured guard shouldn't block a legitimate command.
// v118.0.8: guards only apply to the "until tank full" option. Timed
// durations (5/10/15/30/60 min) are always allowed — the user picked a
// specific duration explicitly, they might be priming / flushing / panel
// testing where a full tank is irrelevant. Mirrors the firmware's
// canStartForceRun() mode-dependent logic.
function preflightForceRun(live, settings, wantsUntilFull) {
  if (!wantsUntilFull) return { ok: true };
  if (!live) return { ok: true };
  const sensorFault = !!live.terraceSensorFault;
  if (sensorFault) {
    return {
      ok: false,
      reason: "sensor_offline",
      title: "Tank sensor is offline",
      human: "Can't run until tank full without a working sensor. Pick a timed duration (e.g. 15 min) instead, or wait for the sensor to recover.",
    };
  }
  const stopPct = settings?.stopPercent;
  const curPct  = live?.terracePct;
  if (typeof stopPct === "number" && typeof curPct === "number" && curPct >= stopPct) {
    return {
      ok: false,
      reason: "tank_already_full",
      title: "Tank is already full",
      human: `Current level is ${curPct}%, already at or above your stop threshold (${stopPct}%). "Until tank full" would start and immediately stop. Pick a timed duration if you need to run the pump anyway.`,
    };
  }
  return { ok: true };
}

export default function ForceRunButton({ code, live, isOnline, canEdit, settings }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [stopOpen,   setStopOpen]   = useState(false);
  const [selectedMinutes, setSelectedMinutes] = useState(15);
  const [err, setErr] = useState("");
  // v118.0.8: pre-check rejection shown as a prominent in-modal banner
  // (title + body) instead of a one-line red text. "Tank is already
  // full" especially needs to be unmissable so the operator understands
  // *why* nothing happened instead of thinking the button broke.
  const [preflightError, setPreflightError] = useState(null);
  // pending: {kind: "start"|"stop", sentAt: ms, timedOut: bool} or null
  // Drives the "sending / waiting for confirm" UI shown on the button
  // itself once the modal closes.
  const [pending, setPending] = useState(null);
  const timeoutRef = useRef(null);

  // Firmware publishes pumpState="manual" for a manual/force run.
  // That's our ground-truth signal — button labels + confirmation
  // detection all key off this.
  const isManualRunning = live?.pumpState === "manual";

  // Confirmation detection: a pending command is "confirmed" the
  // moment live.pumpState reaches the state that command was aiming
  // for. Watching pumpState (not the /commands node) means we're
  // measuring actual pump behavior, not just "cloud accepted the write".
  useEffect(() => {
    if (!pending) return;
    const confirmedStart = pending.kind === "start" && isManualRunning;
    const confirmedStop  = pending.kind === "stop"  && !isManualRunning;
    if (confirmedStart || confirmedStop) {
      setPending(null);
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    }
  }, [pending, isManualRunning]);

  // Clear pending state when tab closes / component unmounts to avoid
  // leaked timers.
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  if (!isOnline || !canEdit) return null;

  async function handleStart() {
    setErr("");
    setPreflightError(null);
    // v118.0.7: client-side pre-check — reject locally when sensor is
    // offline or tank is already full. Same guards firmware runs; doing
    // them here first means the user sees "why" in the modal instead of
    // staring at a 30-sec "waiting" spinner that silently times out.
    const wantsUntilFull = selectedMinutes === -1;
    const pre = preflightForceRun(live, settings, wantsUntilFull);
    if (!pre.ok) {
      setPreflightError({ title: pre.title, body: pre.human });
      return;
    }
    // Optimistic pending state — flip UI immediately even before the
    // network round-trip returns. The button lock + progress line
    // renders from `pending`, so it's visible the moment click happens.
    setPending({ kind: "start", sentAt: Date.now(), timedOut: false });
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setPending((p) => (p ? { ...p, timedOut: true } : p));
    }, CONFIRM_TIMEOUT_MS);
    try {
      await forceRunPump(code, selectedMinutes);
      setPickerOpen(false);
    } catch (e) {
      console.error("force run failed:", e);
      setErr("Command failed to send — try again");
      setPending(null);
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    }
  }
  async function handleStop() {
    setErr("");
    setPending({ kind: "stop", sentAt: Date.now(), timedOut: false });
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setPending((p) => (p ? { ...p, timedOut: true } : p));
    }, CONFIRM_TIMEOUT_MS);
    try {
      await stopForceRunPump(code);
      setStopOpen(false);
    } catch (e) {
      console.error("force stop failed:", e);
      setErr("Command failed to send — try again");
      setPending(null);
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    }
  }

  // Locked state — pending command hasn't been confirmed by live.pumpState yet.
  // Render a disabled button with spinner + progress text so it's crystal
  // clear something IS in flight and clicking again would be redundant.
  if (pending) {
    const isStart = pending.kind === "start";
    const label = isStart ? "Starting force run…" : "Stopping force run…";
    const bg = isStart ? "bg-amber-400" : "bg-red-500";
    const subtitle = pending.timedOut
      ? "Still waiting — check that the panel has WiFi. The command will apply when it reconnects."
      : "Command sent. Waiting for the pump to confirm…";
    return (
      <div className="w-full">
        <button
          disabled
          className={`w-full ${bg} text-white font-semibold py-3 rounded-xl shadow-sm flex items-center justify-center gap-2 opacity-90 cursor-wait`}
        >
          <Spinner />
          <span>{label}</span>
        </button>
        <p className={`text-xs mt-2 text-center ${pending.timedOut ? "text-amber-700" : "text-gray-500"}`}>
          {subtitle}
        </p>
      </div>
    );
  }

  return (
    <>
      {isManualRunning ? (
        <button
          onClick={() => { setErr(""); setStopOpen(true); }}
          className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl shadow-sm transition-colors flex items-center justify-center gap-2"
        >
          <span className="text-lg leading-none">■</span> Stop Force Run
        </button>
      ) : (
        <button
          onClick={() => { setErr(""); setPreflightError(null); setPickerOpen(true); }}
          className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-3 rounded-xl shadow-sm transition-colors flex items-center justify-center gap-2"
        >
          <span className="text-lg leading-none">⚡</span> Force Run Pump
        </button>
      )}
      {err && <p className="text-xs text-red-600 mt-2 text-center">{err}</p>}

      {/* Start modal — preset picker */}
      {pickerOpen && (
        <Modal onClose={() => setPickerOpen(false)}>
          <h3 className="font-semibold text-lg text-gray-900 mb-1">Force Run Pump</h3>
          <p className="text-sm text-gray-600 mb-4">
            Manually turn on the pump for the selected duration. Pump will return to auto mode when the timer expires or the source dries out.
          </p>
          <label className="block text-xs text-gray-500 mb-1">Duration</label>
          <select
            value={selectedMinutes}
            onChange={(e) => {
              setSelectedMinutes(parseInt(e.target.value));
              // v118.0.9: switching duration clears a stale preflight
              // error. e.g. picked "Until tank full" → saw "already
              // full" alert → switched to "15 min" → old alert gone.
              setPreflightError(null);
            }}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4 bg-white"
            autoFocus
          >
            {FORCE_RUN_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          {/* v118.0.9: prominent error banner for pre-check rejection.
              Previously was tiny red text; now full alert box with
              title + body + icon so the operator can't miss WHY the
              start was blocked. */}
          {preflightError && (
            <div className="mb-4 border border-red-200 bg-red-50 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <span className="text-red-600 text-base leading-none">⚠</span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-red-800 text-sm mb-0.5">{preflightError.title}</div>
                  <div className="text-xs text-red-700 leading-relaxed">{preflightError.body}</div>
                </div>
              </div>
            </div>
          )}
          {err && <p className="text-red-600 text-xs mb-3">{err}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setPickerOpen(false)}
              className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
              Cancel
            </button>
            <button onClick={handleStart}
              className="px-4 py-1.5 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600 flex items-center gap-1.5">
              <span className="text-base leading-none">⚡</span>
              <span>Start Force Run</span>
            </button>
          </div>
        </Modal>
      )}

      {/* Stop modal — confirmation */}
      {stopOpen && (
        <Modal onClose={() => setStopOpen(false)}>
          <h3 className="font-semibold text-lg text-gray-900 mb-1">Stop Force Run?</h3>
          <p className="text-sm text-gray-600 mb-4">
            This stops the pump and returns it to auto mode immediately.
          </p>
          {err && <p className="text-red-600 text-xs mb-3">{err}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setStopOpen(false)}
              className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
              Cancel
            </button>
            <button onClick={handleStop}
              className="px-4 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-1.5">
              <span className="text-base leading-none">■</span>
              <span>Stop Pump</span>
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// Inline SVG spinner — no external icon dep. Matches the button
// height by using currentColor and 1em sizing.
function Spinner() {
  return (
    <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path
        d="M22 12a10 10 0 00-10-10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Modal({ children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 mx-4" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
