// Panel Settings tab for PumpDetail — mirrors the AP page's Auto Mode
// Settings section 1:1 (see autoSections HTML in Wired_NAVI_v2_Terrace_cloud.ino
// around line 5654).
//
// Sections match AP order:
//   1. Auto Mode master toggle
//   2. Schedules (3 slots — enable + time ranges)
//   3. Dry Run Protection
//   4. Source Water Detection (with Pre/Post-detection sub-fields)
//   5. Safe Mode Recovery
//
// Data flow — timestamp-based round-trip:
//   1. Tab mounts → one-shot getPanelConfig() reads /devices/{code}/config
//   2. Local form state hydrates from that + firmware defaults
//   3. Customer edits → validated locally (mirrors firmware ranges);
//      dirty flag flips true → Save button turns orange
//   4. Save & Send → atomic multi-field write to /config with fresh
//      savedAt = Math.floor(Date.now()/1000)
//   5. Firmware's next config poll (≤30 sec) validates same fields
//      with same ranges, applies, writes appliedAt = savedAt into
//      /info/appliedConfig
//   6. UI compares the two timestamps (info comes from the /info
//      listener the Live tab already maintains → zero extra reads):
//         appliedAt === savedAt → ✓ Applied
//         appliedAt <  savedAt  → ⏳ Pending
//         appliedAt missing     → ⏳ Pending (device never reported)
//
// Dirty-state guards: navigating away with unsaved changes triggers a
// confirmation dialog. Save button stays blue when clean, flips to
// orange when dirty (per user request — makes unsaved state visually
// obvious).

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { getPanelConfig, savePanelConfig } from "../../firebase/rtdb";
import {
  MAX_TIME_TO_FULL_CHOICES,
  MAX_RUN_TIME_CHOICES,
  DRY_RUN_WAIT_CHOICES,
  SOURCE_DEBOUNCE_CHOICES,
  GRACE_PERIOD_TENS_CHOICES,
  RETRY_WAIT_CHOICES,
  MAX_RETRY_CHOICES,
  MAX_DRY_RUN_CHOICES,
  SMART_CHECK_MINS_CHOICES,
  SMART_MIN_PCT_CHOICES,
  DETECTION_MODE_CHOICES,
  LIMITS,
  formatMinutesLabel,
  formatGraceLabel,
  validateAll,
  withDefaults,
  isFormDirty,
} from "../../utils/panelConfigValidation";

// ─── Tiny UI primitives ────────────────────────────────────────────
function Toggle({ value, onChange, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-50 ${
        value ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-gray-200 text-gray-600 hover:bg-gray-300"
      }`}
    >{value ? "ON" : "OFF"}</button>
  );
}

function StatusPill({ status }) {
  const styles = {
    applied: "bg-green-100 text-green-700 border-green-200",
    pending: "bg-amber-100 text-amber-700 border-amber-200",
    unknown: "bg-gray-100 text-gray-600 border-gray-200",
    dirty:   "bg-orange-100 text-orange-700 border-orange-300",
  }[status] || "bg-gray-100 text-gray-600 border-gray-200";
  const label = {
    applied: "✓ Applied",
    pending: "⏳ Pending",
    unknown: "— No data",
    dirty:   "● Unsaved changes",
  }[status];
  return (
    <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border ${styles}`}>
      {label}
    </span>
  );
}

// ─── Main component ────────────────────────────────────────────────
//
// Fetch-first UX (v2 — device-is-master model):
//   • Tab mounts → NO auto-fetch. Placeholder with "🔄 Fetch settings
//     from device" button, form hidden.
//   • Customer clicks Fetch → one-shot GET of /info/appliedConfig →
//     form appears populated with actual device state.
//   • Customer edits → dirty state (orange Save button + tab-change guard)
//   • Save & Send → writes /config with fresh savedAt → firmware picks
//     up on next 60-sec poll → echoes back appliedAt=savedAt.
//   • Success: form STAYS visible with the just-sent values + green
//     "✓ Applied on device" banner. Fresh fetch needed to see any
//     later device changes.
//   • Every fresh tab visit needs a fresh fetch (per Q3 answer).
//     Achieved by resetting `fetched` state on unmount/remount via key
//     on the parent side, plus a defensive reset here on `code` change.
//
// onDirtyChange lets the parent know when the form has unsaved edits
// so it can intercept tab navigation and prompt the user.
export default function PanelSettingsTab({ code, info, live, isOnline, canEdit, onDirtyChange = () => {} }) {
  // Fetch-state — starts false, flips true after successful Fetch click.
  // Rendering short-circuits on this — hides everything until true.
  const [fetched, setFetched]     = useState(false);
  const [fetching, setFetching]   = useState(false);
  const [fetchErr, setFetchErr]   = useState("");
  const [saving, setSaving]       = useState(false);
  const [saveErr, setSaveErr]     = useState("");
  const [form, setForm]           = useState(withDefaults({}));
  const [remoteConfig, setRemoteConfig] = useState(null);   // baseline for dirty-check
  // Ephemeral "✓ Applied on device" banner shown briefly after a
  // successful round-trip. Auto-hides after 6 sec so the form doesn't
  // wear the banner permanently.
  const [showAppliedBanner, setShowAppliedBanner] = useState(false);

  // Fetch handler — the ONLY way form data gets loaded. Manual button
  // click enforces the "customer sees explicit fetch action" rule from
  // the master-slave design (Q1 lock-in).
  //
  // Load precedence stays the same as before: /info/appliedConfig is
  // ground truth (device says "here's what I'm running with"), /config
  // is a fallback for brand-new devices that haven't mirrored yet.
  async function handleFetch() {
    if (!code) return;
    setFetching(true);
    setFetchErr("");
    setShowAppliedBanner(false);
    try {
      // Read BOTH sources to handle the "pending save while offline"
      // scenario correctly.
      //
      // /info/appliedConfig = what the device has actually applied
      //                       (device-side ground truth).
      // /config             = what cloud has pushed / is trying to push.
      //                       Includes savedAt of the last cloud save.
      //
      // Decision rule:
      //   • If /config.savedAt > appliedConfig.appliedAt → there's a
      //     PENDING save the device hasn't confirmed yet. Load /config
      //     so customer's uncommitted changes aren't erased by refetch.
      //     (This is the bug the user hit: they turned autoMode off
      //     while device was offline, hit Refetch, and their change
      //     was overwritten by the device's stale ON state.)
      //   • Otherwise → load /info/appliedConfig (device is up-to-date
      //     with cloud OR there's no cloud save at all).
      const cloudCfg = await getPanelConfig(code);
      const applied  = info?.appliedConfig;
      const hasApplied = applied && Object.keys(applied).length > 2;

      const savedAtCloud   = cloudCfg?.savedAt || 0;
      const appliedAtDev   = applied?.appliedAt || 0;
      const pendingSave    = savedAtCloud > 0 && savedAtCloud > appliedAtDev;

      let source;
      if (pendingSave) {
        // Preserve pending save — merge cloud values onto applied so we
        // don't lose any device-only fields (e.g. fields firmware
        // publishes but cloud doesn't touch).
        source = hasApplied ? { ...applied, ...cloudCfg } : cloudCfg;
      } else if (hasApplied) {
        source = applied;
      } else {
        source = cloudCfg;
      }
      const hydrated = withDefaults(source || {});
      // Baseline is always the applied state — dirty-check compares
      // form vs baseline. When there's a pending save, form shows the
      // pending values but baseline is device state, so the form
      // correctly reports as "dirty" (unsaved from device's POV) which
      // keeps the orange Save button visible for re-send if needed.
      const baseline = hasApplied ? withDefaults(applied) : hydrated;
      setRemoteConfig({ ...baseline, savedAt: savedAtCloud });
      setForm(hydrated);
      setFetched(true);
    } catch (e) {
      console.error("panel config fetch failed:", e);
      setFetchErr("Could not fetch settings — check device connection and try again");
    } finally {
      setFetching(false);
    }
  }

  // Defensive reset on device-code change — if user navigates between
  // two different pumps' Settings tabs, force fresh fetch each time.
  useEffect(() => {
    setFetched(false);
    setFetchErr("");
    setSaveErr("");
    setShowAppliedBanner(false);
    setRemoteConfig(null);
    setForm(withDefaults({}));
  }, [code]);

  // Round-trip confirmation watcher — when appliedConfig.appliedAt
  // catches up to what we just saved, flip the banner ON briefly. Keeps
  // the form visible with the just-sent values (per Q1 answer: form
  // stays visible with green banner after successful send).
  //
  // Track the savedAt value we've already banner-notified for. Without
  // this latch, a spurious appliedAt (which briefly might equal savedAt
  // as data races through listeners) could re-fire the banner. And on
  // fetched re-mount we don't want an older confirmed save to re-fire
  // the banner just because appliedAt happens to equal savedAt from a
  // fetch that hydrated both from the same past save.
  const appliedAt   = info?.appliedConfig?.appliedAt;
  const savedAt     = remoteConfig?.savedAt;
  const bannerFiredForRef = useRef(0);
  useEffect(() => {
    if (!fetched) return;
    if (!savedAt || !appliedAt) return;
    if (appliedAt !== savedAt) return;
    // Only fire the banner when we HAVEN'T already fired for this
    // exact savedAt. Prevents refetch-triggered false confirms.
    if (bannerFiredForRef.current === savedAt) return;
    bannerFiredForRef.current = savedAt;
    setShowAppliedBanner(true);
    const t = setTimeout(() => setShowAppliedBanner(false), 6000);
    return () => clearTimeout(t);
  }, [fetched, savedAt, appliedAt]);

  // Dismissal watcher — the moment a NEW pending state starts (savedAt
  // exists and doesn't match appliedAt), tear down any lingering "✓
  // Applied" banner from a PREVIOUS save. Without this, the 6-sec toast
  // from an earlier save can visually overlap the fresh "⏳ Pending"
  // state and produce a contradictory UI: green banner says applied,
  // pill next to it says pending. The `showSavedBanner` toast from the
  // just-fired save is separate — that one is CORRECT to show alongside
  // pending (it says "Saved to cloud, waiting for device"). The green
  // "applied on device" banner only makes sense while status="applied".
  useEffect(() => {
    if (!savedAt) return;
    const stillPending = !appliedAt || appliedAt !== savedAt;
    if (stillPending && showAppliedBanner) setShowAppliedBanner(false);
  }, [savedAt, appliedAt, showAppliedBanner]);

  // Validation runs on every form change — Save button gated on this.
  const { valid, errors } = useMemo(() => validateAll(form), [form]);
  const dirty = useMemo(() => isFormDirty(form, remoteConfig), [form, remoteConfig]);

  // Notify parent so it can install its own beforeunload / tab-change guard.
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  // Browser-level warning if the user hits refresh / closes tab with
  // unsaved changes. Doesn't cover in-app navigation — parent handles
  // that via onDirtyChange callback + its own tab-change interceptor.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Per-form status derived from savedAt vs appliedAt round-trip.
  // dirty state wins visually. When form matches what was just fetched
  // AND no cloud save is pending, we consider it "applied" (device is
  // running with these exact values). savedAt only exists after a Save
  // action from cloud — its absence is normal for fresh fetches.
  const status = (() => {
    if (dirty) return "dirty";
    const savedAtLocal   = remoteConfig?.savedAt;
    const appliedAtLocal = info?.appliedConfig?.appliedAt;
    // No cloud save yet — form reflects fetched device state = "applied".
    if (!savedAtLocal) return "applied";
    // Save was sent — pending until device confirms via matching appliedAt.
    if (savedAtLocal && appliedAtLocal && appliedAtLocal === savedAtLocal) return "applied";
    return "pending";
  })();

  // Lock the form while a save is in flight (Save → device confirms).
  // Prevents the customer from editing values that overwrite what they
  // just sent — until it's confirmed applied on the device, edits would
  // be racing the pending write. Once "applied", customer must click
  // Refetch to unlock (guarantees they see current device state before
  // making a new change).
  //
  // Locked when: status is "pending" OR we're mid-save. Also locked when
  // saving flag is set (network round-trip in progress).
  const formLocked = (status === "pending") || saving;
  // fieldsEditable combines the owner-permission gate with the pending-
  // lock gate so every input in the form can check ONE flag. Fields are
  // editable when: customer has write permission AND no save is currently
  // in flight waiting for device confirmation.
  const fieldsEditable = canEdit && !formLocked;
  // v118.0.9: safety-sensitive fields (tank geometry + pump start/stop
  // thresholds) are LOCKED while the pump is currently running. A
  // mid-run change to e.g. stopPercent could instantly flip the pump
  // off or create oscillation; a mid-run tank height change recomputes
  // all pct values + could trip the dry-run watchdog. Cosmetic fields
  // (tank volume for display, notification toggles) stay editable.
  const pumpRunning = live?.pumpState === "auto" || live?.pumpState === "manual" || live?.pumpState === "starting";
  const safetyFieldsEditable = fieldsEditable && !pumpRunning;

  // Update helpers
  const patch = useCallback((field, value) => {
    setForm((f) => ({ ...f, [field]: value }));
  }, []);
  const patchSchedule = useCallback((i, field, value) => {
    setForm((f) => {
      const next = f.schedules.slice();
      next[i] = { ...next[i], [field]: value };
      return { ...f, schedules: next };
    });
  }, []);

  // Ephemeral "just saved" confirmation banner. Fires immediately on
  // successful cloud write (regardless of device online state) so the
  // customer sees clear feedback that their Save click actually did
  // something. Distinct from showAppliedBanner which waits for device
  // round-trip — this one confirms only the cloud-side write succeeded.
  const [showSavedBanner, setShowSavedBanner] = useState(false);
  const savedBannerTimerRef = useRef(null);

  async function handleSave() {
    if (!canEdit || !valid) return;
    setSaving(true);
    setSaveErr("");
    try {
      const savedAt = await savePanelConfig(code, form);
      // Optimistically merge — baseline now matches form so dirty flips false;
      // round-trip pill flips to Pending until firmware confirms.
      setRemoteConfig({ ...form, savedAt });
      // Fire the "saved to cloud" banner. Different from the "applied
      // on device" banner (showAppliedBanner) — this one fires now,
      // that one waits for device to echo back appliedAt=savedAt.
      setShowSavedBanner(true);
      if (savedBannerTimerRef.current) clearTimeout(savedBannerTimerRef.current);
      savedBannerTimerRef.current = setTimeout(() => setShowSavedBanner(false), 5000);
    } catch (e) {
      console.error("panel config save failed:", e);
      setSaveErr("Save failed — check your connection and try again");
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    if (!remoteConfig) return;
    setForm(remoteConfig);
  }

  // Not fetched yet → show ONLY the fetch placeholder card. Everything
  // else (form, save bar, status banner) stays hidden. This is the
  // "hide first, ask fetch" behaviour Vishal locked in (device-as-master
  // rework — cloud shouldn't display stale /config values as if they
  // were the current device state).
  if (!fetched) {
    return (
      <div className="space-y-4">
        {/* Offline warning — soft (per user rec Option B). Fetch still
            works (reads cloud-cached appliedConfig), but caller is told
            data may be stale + writes will queue until reconnect. */}
        {!isOnline && <OfflineWarning code={code} appliedAt={appliedAt} />}

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
          <div className="text-4xl mb-3">📥</div>
          <h3 className="font-semibold text-gray-800 mb-1">Panel settings not loaded</h3>
          <p className="text-xs text-gray-500 mb-5 max-w-md mx-auto">
            Click below to fetch the panel's current settings from the device. Editing without fetching first could overwrite changes made at the panel's AP page.
          </p>
          {fetchErr && <p className="text-red-600 text-xs mb-3">{fetchErr}</p>}
          <button
            onClick={handleFetch}
            disabled={fetching || !canEdit}
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-2.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {fetching ? "Fetching from device…" : "🔄 Fetch settings from device"}
          </button>
          {!canEdit && (
            <p className="text-[11px] text-amber-700 mt-3">Only the device owner can fetch and change settings.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      {/* Offline warning — soft (per Option B). Fetched data may be
          stale (from cloud cache, not live); Save & Send queues in
          /config until firmware reconnects and applies. */}
      {!isOnline && <OfflineWarning code={code} appliedAt={appliedAt} />}

      {/* Immediate "saved to cloud" confirmation — fires the instant
          the cloud write returns, regardless of whether the device is
          online. Auto-hides after 5 sec. This is the "yes we captured
          your change" feedback the customer needs so they don't wonder
          if their Save click did anything, especially when the device
          is offline and the round-trip confirm is minutes away. */}
      {showSavedBanner && (
        <div className={`border rounded-xl p-3 text-sm flex items-center gap-2 ${
          isOnline
            ? "bg-blue-50 border-blue-200 text-blue-800"
            : "bg-amber-50 border-amber-300 text-amber-900"
        }`}>
          <span className="text-lg leading-none">💾</span>
          <span>
            {isOnline
              ? "Saved — sending to panel now. Confirmation expected within 60 seconds."
              : "Saved — will apply to panel as soon as it's back online."}
          </span>
        </div>
      )}

      {/* Green "✓ Applied on device" banner — appears briefly after a
          successful round-trip (savedAt === appliedAt), auto-hides in
          6 sec. Confirms the customer's Send actually reached device. */}
      {showAppliedBanner && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-800 flex items-center gap-2">
          <span className="text-lg leading-none">✓</span>
          <span>Settings applied on device successfully.</span>
        </div>
      )}

      {/* Round-trip status banner + Refetch button */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-4 flex items-center justify-between flex-wrap gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-800">Panel settings</div>
          <div className="text-xs text-gray-500">
            Loaded from device{appliedAt ? ` — last confirmed ${new Date(appliedAt * 1000).toLocaleString()}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <StatusPill status={status} />
          {/* Refetch button — customer's escape hatch out of the pending
              lock state (per Vishal's design: once ✓ Applied, must
              Refetch before editing again). Enabled during pending +
              applied states so the customer can always break out and
              reload; disabled only while an edit is in flight (dirty)
              or during the fetch itself. */}
          <button
            onClick={handleFetch}
            disabled={fetching || dirty || saving}
            title={dirty ? "Discard your unsaved changes first" : "Reload current device state and enable editing"}
            className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-400 disabled:cursor-not-allowed font-medium"
          >
            {fetching ? "Fetching…" : "↻ Refetch to edit"}
          </button>
        </div>
      </div>

      {!canEdit && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
          Only the device owner can change settings. Fields shown read-only.
        </div>
      )}

      {/* Pending-lock banner — appears whenever fields are locked because
          a save is in flight or waiting for device confirmation. Tells
          the customer explicitly what's happening + the escape hatch
          (Refetch) that will let them edit again. Per Vishal: "till the
          time the setting is application stage or something it should
          not allow to edit any settings when its done and confirm only
          tell to refetch and allow to edit that". */}
      {canEdit && formLocked && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm text-blue-900 flex items-start gap-2">
          <span className="text-lg leading-none mt-0.5">🔒</span>
          <div>
            <div className="font-semibold mb-0.5">Settings locked while save is in progress</div>
            <div className="text-xs">
              {saving
                ? "Sending your changes to the cloud…"
                : isOnline
                  ? "Waiting for the panel to confirm your last save. Fields will unlock once confirmed — or click Refetch above to reload the current device state."
                  : "The panel is offline. Your last save is queued and will apply once the panel reconnects. Fields will unlock once confirmed — or click Refetch to reload the device's last-known state and edit again."}
            </div>
          </div>
        </div>
      )}

      {/* ── 1. Auto-mode ── */}
      <Section title="⚙️ Auto Mode" defaultOpen>
        <Row label="Auto mode" hint="Master switch — pump runs automatically based on tank level and schedules when ON. When OFF, all Auto Mode settings below are ignored.">
          <Toggle value={form.autoModeEnabled} onChange={(v) => patch("autoModeEnabled", v)} disabled={!fieldsEditable} />
        </Row>
      </Section>

      {/* ── 1b. Water Level Settings (v118 ultrasonic variant) ──
          Tank geometry + pump start/stop thresholds + capacity. Visible
          on both v117 (discrete probes — fields ignored by firmware) and
          v118 (ultrasonic — fields used). On v117 the firmware simply
          ignores unknown writes, so no gating needed here. Values are
          validated client-side via the panelConfigValidation module
          with the same 2% step / 2% gap rules firmware enforces. */}
      <Section title="💧 Water Level Settings" defaultOpen>
        <p className="text-xs text-gray-500 mb-2">
          Tell the pump when to start and stop based on tank water level. For ultrasonic-sensor panels only (v118+).
        </p>
        {pumpRunning && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-md px-3 py-2 mb-2">
            ⚠ Pump is running — tank-level fields are locked while the pump runs. Stop the pump or wait for it to finish to edit.
          </div>
        )}
        <Row label="Tank height (cm)" hint="Full water column height from tank bottom to the sensor mounting point. Max 1200 cm (12 m).">
          <input type="number" min="10" max="1200" disabled={!safetyFieldsEditable}
            value={form.usTankHeightCm}
            onChange={(e) => patch("usTankHeightCm", parseInt(e.target.value) || 0)}
            className="w-24 px-2 py-1 border border-gray-200 rounded text-sm bg-white disabled:bg-gray-50" />
        </Row>
        {errors.usTankHeightCm && <FieldError msg={errors.usTankHeightCm} />}
        <Row label="Sensor offset (cm)" hint="Dead zone — distance from the sensor face to water surface when tank is 100% full. Typically 20-30 cm.">
          <input type="number" min="0" max="100" disabled={!safetyFieldsEditable}
            value={form.usSensorOffsetCm}
            onChange={(e) => patch("usSensorOffsetCm", parseInt(e.target.value) || 0)}
            className="w-24 px-2 py-1 border border-gray-200 rounded text-sm bg-white disabled:bg-gray-50" />
        </Row>
        {errors.usSensorOffsetCm && <FieldError msg={errors.usSensorOffsetCm} />}
        <Row label={`Pump start level: ${form.startPercent}%`} hint="Pump turns ON when water drops to this level.">
          <input type="range" min="2" max="98" step="2" disabled={!safetyFieldsEditable}
            value={form.startPercent}
            onChange={(e) => {
              const newStart = parseInt(e.target.value);
              patch("startPercent", newStart);
              // Auto-clamp stop ≥ start + 2 (firmware enforces this too).
              if (form.stopPercent < newStart + 2) {
                patch("stopPercent", Math.min(100, newStart + 2));
              }
            }}
            className="w-40 accent-orange-500 disabled:opacity-50" />
        </Row>
        {errors.startPercent && <FieldError msg={errors.startPercent} />}
        <Row label={`Pump stop level: ${form.stopPercent}%`} hint="Pump turns OFF when water reaches this level. Must be at least 2% above start.">
          <input type="range" min={Math.max(4, form.startPercent + 2)} max="100" step="2" disabled={!safetyFieldsEditable}
            value={form.stopPercent}
            onChange={(e) => patch("stopPercent", parseInt(e.target.value))}
            className="w-40 accent-green-500 disabled:opacity-50" />
        </Row>
        {errors.stopPercent && <FieldError msg={errors.stopPercent} />}
        <Row label="Tank capacity (litres)" hint="Optional — used for volume display (e.g. '5.5 / 6 KL'). Set to 0 to hide volume.">
          <input type="number" min="0" max="100000" disabled={!fieldsEditable}
            value={form.tankVolume}
            onChange={(e) => patch("tankVolume", parseInt(e.target.value) || 0)}
            className="w-28 px-2 py-1 border border-gray-200 rounded text-sm bg-white disabled:bg-gray-50" />
        </Row>
        {errors.tankVolume && <FieldError msg={errors.tankVolume} />}
      </Section>

      {/* ── 2. Schedules ── */}
      <Section title="📅 Schedules"
        header={<Toggle value={form.scheduleModeEnabled} onChange={(v) => patch("scheduleModeEnabled", v)} disabled={!fieldsEditable} />}>
        <p className="text-xs text-gray-500 mb-2">
          When schedule mode is ON, pump starts and stops automatically at set times based on water level. Up to 3 daily schedules.
        </p>
        <div className="space-y-3">
          {form.schedules.map((s, i) => (
            <div key={i} className={`border rounded-lg p-3 ${s.enabled ? "border-blue-200 bg-blue-50/40" : "border-gray-200"}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Schedule {i + 1}</span>
                <Toggle value={s.enabled} onChange={(v) => patchSchedule(i, "enabled", v)} disabled={!fieldsEditable} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <label className="text-gray-500 self-center">Start</label>
                <input type="time" disabled={!fieldsEditable}
                  value={`${String(s.startHour).padStart(2,"0")}:${String(s.startMinute).padStart(2,"0")}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    patchSchedule(i, "startHour",   isFinite(h) ? h : 0);
                    patchSchedule(i, "startMinute", isFinite(m) ? m : 0);
                  }}
                  className="px-2 py-1 border border-gray-200 rounded text-sm disabled:bg-gray-50" />
                <label className="text-gray-500 self-center">End</label>
                <input type="time" disabled={!fieldsEditable}
                  value={`${String(s.endHour).padStart(2,"0")}:${String(s.endMinute).padStart(2,"0")}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    patchSchedule(i, "endHour",   isFinite(h) ? h : 0);
                    patchSchedule(i, "endMinute", isFinite(m) ? m : 0);
                  }}
                  className="px-2 py-1 border border-gray-200 rounded text-sm disabled:bg-gray-50" />
              </div>
              {/* v118.0.9: weekday chips (Sun..Sat, bitmask bit 0..6) */}
              <div className="mt-3">
                <div className="text-xs text-gray-500 mb-1">Days this schedule runs</div>
                <div className="flex gap-1 flex-wrap">
                  {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((lbl, bit) => {
                    const mask = (s.dayMask ?? 0x7F) & 0x7F;
                    const active = (mask & (1 << bit)) !== 0;
                    return (
                      <button
                        key={bit}
                        type="button"
                        disabled={!fieldsEditable}
                        onClick={() => {
                          // Toggle the bit; coerce 0 → every-day (matches firmware's
                          // "never silently disable" rule).
                          let next = mask ^ (1 << bit);
                          if (next === 0) next = 0x7F;
                          patchSchedule(i, "dayMask", next);
                        }}
                        className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                          active
                            ? "bg-blue-500 text-white border-blue-500"
                            : "bg-white text-gray-500 border-gray-300 hover:bg-gray-50"
                        } ${!fieldsEditable ? "opacity-50 cursor-not-allowed" : ""}`}
                      >{lbl}</button>
                    );
                  })}
                </div>
              </div>
              {/* v118.0.9: fill-until-full per schedule */}
              <label className="flex items-center gap-2 mt-3 text-xs text-gray-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  disabled={!fieldsEditable}
                  checked={!!s.fillUntilFull}
                  onChange={(e) => patchSchedule(i, "fillUntilFull", e.target.checked)}
                  className="w-3.5 h-3.5"
                />
                <span>Fill tank completely during this window (ignore start % threshold)</span>
              </label>
            </div>
          ))}
        </div>
        {errors.schedules && <FieldError msg={errors.schedules} />}
      </Section>

      {/* ── 3. Dry Run Protection ── */}
      <Section title="⚠️ Dry Run Protection"
        header={<Toggle value={form.dryRunProtectionOn} onChange={(v) => patch("dryRunProtectionOn", v)} disabled={!fieldsEditable} />}>
        <p className="text-xs text-gray-500 mb-3">
          Monitors the tank while the pump runs. If no filling is detected (smart) or FULL isn't reached in time (classic), motor enters Dry Run mode. After max retries → Safe Mode to protect the pump.
        </p>
        {/* v118.0.9: Smart (level-change) vs Classic (time-based) toggle.
            Smart detection polls tank level every N minutes and faults
            when rise is below threshold — catches dry source in 5-15 min
            typical instead of waiting the full 30-min LOW→FULL budget. */}
        <Row label="Detection mode" hint="Smart (recommended): detects when the water level isn't rising. Classic: time-based, waits until the tank reaches FULL.">
          <SelectPill disabled={!fieldsEditable} value={form.smartDryRunEnabled ? 1 : 0}
            onChange={(v) => patch("smartDryRunEnabled", v === 1)}
            options={[{ value: 1, label: "Smart" }, { value: 0, label: "Classic" }]} />
        </Row>
        {form.smartDryRunEnabled ? (
          <>
            <Row label="Check interval" hint="How often to compare the tank level vs the start of the window.">
              <SelectPill disabled={!fieldsEditable} value={form.smartDryRunCheckMins}
                onChange={(v) => patch("smartDryRunCheckMins", v)}
                options={SMART_CHECK_MINS_CHOICES.map((n) => ({ value: n, label: `${n} min` }))} />
            </Row>
            <Row label="Minimum rise expected" hint="Tank must rise by at least this much per check. If not, counts as a dry-run attempt.">
              <SelectPill disabled={!fieldsEditable} value={form.smartDryRunMinPct}
                onChange={(v) => patch("smartDryRunMinPct", v)}
                options={SMART_MIN_PCT_CHOICES.map((n) => ({ value: n, label: `${n}%` }))} />
            </Row>
          </>
        ) : (
          <Row label="Max time to reach FULL">
            <SelectPill disabled={!fieldsEditable} value={form.maxTimeToNextProbeMins} onChange={(v) => patch("maxTimeToNextProbeMins", v)}
              options={MAX_TIME_TO_FULL_CHOICES.map((n) => ({ value: n, label: formatMinutesLabel(n) }))} />
          </Row>
        )}
        <Row label="Max retries">
          <SelectPill disabled={!fieldsEditable} value={form.maxDryRunCount} onChange={(v) => patch("maxDryRunCount", v)}
            options={MAX_DRY_RUN_CHOICES.map((n) => ({ value: n, label: String(n) }))} />
        </Row>
        <Row label="Max continuous run time">
          <SelectPill disabled={!fieldsEditable} value={form.maxRunTimeMins} onChange={(v) => patch("maxRunTimeMins", v)}
            options={MAX_RUN_TIME_CHOICES.map((n) => ({ value: n, label: formatMinutesLabel(n) }))} />
        </Row>
        <Row label="Wait between retries">
          <SelectPill disabled={!fieldsEditable} value={form.dryRunWaitMins} onChange={(v) => patch("dryRunWaitMins", v)}
            options={DRY_RUN_WAIT_CHOICES.map((n) => ({ value: n, label: `${n} min` }))} />
        </Row>
      </Section>

      {/* ── 4. Source Water Detection ── */}
      <Section title="💧 Source Water Detection"
        header={<Toggle value={form.hasWPSensor} onChange={(v) => patch("hasWPSensor", v)} disabled={!fieldsEditable} />}>
        <p className="text-xs text-gray-500 mb-3">
          When enabled, pump operation depends on source water detection. Configure sensor node name from the panel's AP page.
        </p>
        <Row label="Detection mode">
          <SelectPill disabled={!fieldsEditable} value={form.detectionMode} onChange={(v) => patch("detectionMode", v)}
            options={DETECTION_MODE_CHOICES} wide />
        </Row>
        <Row label="Source confirmation period" hint="Source water must be present continuously for this duration to confirm stable supply.">
          <SelectPill disabled={!fieldsEditable} value={form.sourceDebounceSecs} onChange={(v) => patch("sourceDebounceSecs", v)}
            options={SOURCE_DEBOUNCE_CHOICES.map((n) => ({ value: n, label: n >= 60 ? `${n/60} min` : `${n} sec` }))} />
        </Row>

        {/* Post-Detection only fields — hidden when Pre-Detection */}
        {form.detectionMode === 1 && (
          <>
            <Row label="Grace period" hint="Motor runs during this period to pull water through inlet pipe. Source sensor is ignored until grace period ends.">
              <SelectPill disabled={!fieldsEditable} value={form.gracePeriodTens} onChange={(v) => patch("gracePeriodTens", v)}
                options={GRACE_PERIOD_TENS_CHOICES.map((t) => ({ value: t, label: formatGraceLabel(t) }))} />
            </Row>
            <Row label="Max retries before Safe Mode">
              <SelectPill disabled={!fieldsEditable} value={form.maxRetryCount} onChange={(v) => patch("maxRetryCount", v)}
                options={MAX_RETRY_CHOICES.map((n) => ({ value: n, label: String(n) }))} />
            </Row>
            <Row label="Wait between retries">
              <SelectPill disabled={!fieldsEditable} value={form.retryWaitMins} onChange={(v) => patch("retryWaitMins", v)}
                options={RETRY_WAIT_CHOICES.map((n) => ({ value: n, label: `${n} min` }))} />
            </Row>
          </>
        )}
      </Section>

      {/* ── 5. Safe Mode Recovery ── */}
      <Section title="🛟 Safe Mode Recovery">
        <p className="text-xs text-gray-500 mb-3">
          When Safe Mode is triggered (after retries exhausted), it can auto-clear at next schedule start or after a timeout.
        </p>
        <Row label="Auto-clear at next schedule start">
          <Toggle value={form.autoRecoverOnSchedule} onChange={(v) => patch("autoRecoverOnSchedule", v)} disabled={!fieldsEditable} />
        </Row>
        <Row label="Auto-clear after timeout">
          <Toggle value={form.autoRecoverOnTimeout} onChange={(v) => patch("autoRecoverOnTimeout", v)} disabled={!fieldsEditable} />
        </Row>
        <Row label="Timeout (hours)" hint={`Only used when 'Clear after timeout' is ON. ${LIMITS.autoRecoverTimeoutHours.min}–${LIMITS.autoRecoverTimeoutHours.max}.`}>
          <input type="number" disabled={!fieldsEditable || !form.autoRecoverOnTimeout}
            min={LIMITS.autoRecoverTimeoutHours.min} max={LIMITS.autoRecoverTimeoutHours.max}
            value={form.autoRecoverTimeoutHours}
            onChange={(e) => patch("autoRecoverTimeoutHours", parseInt(e.target.value) || 0)}
            className="w-20 px-2 py-1 border border-gray-200 rounded text-sm disabled:bg-gray-50" />
        </Row>
        {errors.autoRecoverTimeoutHours && <FieldError msg={errors.autoRecoverTimeoutHours} />}
      </Section>

      {/* ── Save & Send bar ── */}
      {canEdit && (() => {
        // Button-state model — one primary button label + colour per
        // scenario, always enabled when there's ANY reason a customer
        // might want to press it. The Save flow feels stuck when the
        // button disables/greys the instant a save completes, so we
        // keep it clickable in the "pending confirm" state too — the
        // customer can re-save (with same or different values) at any
        // time. Confirmation lives on the banner + sync-status pill,
        // not on button-disable-as-signal.
        //
        //   1. saving       → spinner label, disabled, blue
        //   2. invalid form → "Fix highlighted fields", disabled, gray
        //   3. dirty        → orange "Save & Send", ENABLED; Discard visible
        //   4. pending conf → blue "Save & Send Again", ENABLED
        //                     (customer might want to force re-send)
        //   5. clean+applied → gray "No changes to send", disabled
        const savedAtLocal   = remoteConfig?.savedAt;
        const appliedAtLocal = info?.appliedConfig?.appliedAt;
        const pendingConfirm = savedAtLocal &&
          (!appliedAtLocal || appliedAtLocal !== savedAtLocal);

        let btnLabel, btnClass, btnDisabled;
        if (!valid) {
          btnLabel = "Fix highlighted fields to save";
          btnClass = "bg-gray-400";
          btnDisabled = true;
        } else if (saving) {
          btnLabel = "Saving…";
          btnClass = "bg-blue-500";
          btnDisabled = true;
        } else if (dirty) {
          btnLabel = "● Save & Send to Panel";
          btnClass = "bg-orange-500 hover:bg-orange-600";
          btnDisabled = false;
        } else if (pendingConfirm) {
          // Fields are locked while pending — button label reflects that.
          // Customer's escape hatch is the Refetch button in the header,
          // not another Save (nothing new to save).
          btnLabel = isOnline
            ? "⏳ Locked — waiting for panel to confirm"
            : "🔒 Locked — waiting for panel to reconnect";
          btnClass = "bg-gray-400";
          btnDisabled = true;
        } else {
          btnLabel = "No changes to send";
          btnClass = "bg-gray-400";
          btnDisabled = true;
        }

        return (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-4 sticky bottom-4 z-10">
            {saveErr && <p className="text-red-600 text-xs mb-2">{saveErr}</p>}

            {/* NB: the pending-state banner lives at the TOP of the tab
                now (see "Settings locked while save is in progress" 🔒
                banner near the header) — a single source of truth for
                the "why is the form locked" signal. No duplicate here. */}

            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={btnDisabled}
                className={`flex-1 font-semibold py-2.5 rounded-lg text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors ${btnClass}`}
              >
                {btnLabel}
              </button>
              {dirty && (
                <button
                  onClick={handleDiscard}
                  disabled={saving}
                  className="px-4 py-2.5 rounded-lg text-gray-700 bg-gray-100 hover:bg-gray-200 text-sm font-medium"
                >
                  Discard
                </button>
              )}
            </div>

            {!pendingConfirm && (
              <p className="text-[11px] text-gray-500 mt-2 text-center">
                {!isOnline
                  ? "Device is offline — any save will queue and apply automatically once the panel reconnects."
                  : dirty
                    ? "Save & Send pushes changes to the panel — takes up to 60 seconds to confirm."
                    : "Panel checks for new settings every ~60 seconds."}
              </p>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ─── Section + Row helpers ────────────────────────────────────────
// v118.0.9: Section is now collapsible to match the AP page's accordion
// layout. Auto Mode (and anything explicitly passed defaultOpen=true)
// stays expanded on first render; the rest collapse so the whole form
// isn't a scroll wall. Header toggle has an arrow + is clickable itself
// so the Toggle switch next to the title stays independent (clicking
// the switch doesn't collapse — stopPropagation on the header element).
function Section({ title, header, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      <div
        className="flex items-center justify-between px-5 py-3 cursor-pointer select-none hover:bg-gray-50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <h3 className="font-semibold text-gray-800 flex items-center gap-2">
          <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
          <span>{title}</span>
        </h3>
        {header && (
          <div onClick={(e) => e.stopPropagation()}>{header}</div>
        )}
      </div>
      {open && (
        <div className="px-5 pb-5 space-y-3">{children}</div>
      )}
    </div>
  );
}
function Row({ label, hint, children }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-gray-700">{label}</div>
          {hint && <div className="text-[11px] text-gray-400 mt-0.5">{hint}</div>}
        </div>
        <div className="flex-shrink-0">{children}</div>
      </div>
    </div>
  );
}
function FieldError({ msg }) {
  return <p className="text-red-500 text-xs mt-1">{msg}</p>;
}
function SelectPill({ value, onChange, options, disabled, wide }) {
  return (
    <select
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(parseInt(e.target.value))}
      className={`${wide ? "w-full" : ""} px-2 py-1 border border-gray-200 rounded text-sm bg-white disabled:bg-gray-50`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// Amber warning banner shown at the top of the Settings tab when the
// device is offline. Explains that fetched data is cached (potentially
// stale) and that any saves will queue in /config until the panel
// reconnects. Uses the same visual language as other in-app warnings.
function OfflineWarning({ appliedAt }) {
  const lastLabel = appliedAt
    ? new Date(appliedAt * 1000).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : "unknown";
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
      <div className="flex items-start gap-2">
        <span className="text-base leading-none mt-0.5">⚠</span>
        <div>
          <div className="font-semibold mb-0.5">Device is offline</div>
          <div className="text-xs">
            Showing last-known settings from the device (confirmed {lastLabel}). Changes you save will queue and apply automatically once the panel reconnects.
          </div>
        </div>
      </div>
    </div>
  );
}
