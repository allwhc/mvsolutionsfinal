import { ref, onValue, set, update, get, off, push, query, orderByKey, orderByChild, startAt, endAt, limitToLast, remove } from "firebase/database";
import { rtdb } from "./config";

// Fetch history entries by timestamp range (ms since epoch)
// If includeSeed is true, also fetches the most recent entry before startTs
// so callers can carry the last known value forward into the range.
export async function getHistoryByRange(deviceCode, startTs, endTs, includeSeed = false) {
  const histRef = query(
    ref(rtdb, `devices/${deviceCode}/history`),
    orderByChild("ts"),
    startAt(startTs),
    endAt(endTs)
  );
  const snap = await get(histRef);
  const inRange = snap.exists()
    ? Object.entries(snap.val()).map(([key, val]) => ({ key, ...val })).sort((a, b) => (a.ts || 0) - (b.ts || 0))
    : [];

  if (!includeSeed) return inRange;

  const seedRef = query(
    ref(rtdb, `devices/${deviceCode}/history`),
    orderByChild("ts"),
    endAt(startTs - 1),
    limitToLast(1)
  );
  const seedSnap = await get(seedRef);
  if (!seedSnap.exists()) return inRange;
  const seed = Object.entries(seedSnap.val()).map(([key, val]) => ({ key, ...val }));
  return [...seed, ...inRange];
}

// Set analyticsOn flag on device config
export async function setAnalyticsEnabled(deviceCode, enabled) {
  await update(ref(rtdb, `devices/${deviceCode}/config`), {
    analyticsOn: !!enabled,
  });
}

// Set diagnosticsOn flag (firmware 17.0.9+). Admin-only feature for
// remote debug — toggling on tells the firmware to start logging boot
// reasons + uploading them to /diagnostics/boots. Toggling off stops new
// uploads but doesn't wipe existing log entries.
export async function setDiagnosticsEnabled(deviceCode, enabled) {
  await update(ref(rtdb, `devices/${deviceCode}/config`), {
    diagnosticsOn: !!enabled,
  });
}

// Set notifyOn flag (firmware 17.0.9+). Premium-tier gate — when true
// the firmware mirrors change-driven pushes to /notify_trigger and the
// Cloud Function dispatcher fires. Free devices keep this OFF so no
// Cloud Function executions are triggered by their writes.
export async function setNotifyEnabled(deviceCode, enabled) {
  await update(ref(rtdb, `devices/${deviceCode}/config`), {
    notifyOn: !!enabled,
  });
}

// Batch-fetch /config blocks for a set of device codes. Returns
// { deviceCode: { analyticsOn, diagnosticsOn, notifyOn, ... }, ... }
// Used by /admin/devices to filter by current toggle state. Single
// snapshot read per device, no listeners (we don't need live updates
// for filtering — admin refreshes the page if they want fresh data).
export async function getDevicesConfigMap(deviceCodes) {
  if (!Array.isArray(deviceCodes) || deviceCodes.length === 0) return {};
  const out = {};
  await Promise.all(
    deviceCodes.map(async (code) => {
      const snap = await get(ref(rtdb, `devices/${code}/config`));
      out[code] = snap.exists() ? snap.val() : {};
    })
  );
  return out;
}

// Bulk-apply a config flag to many devices in a single RTDB call. Used
// by /admin/devices bulk-actions UI to flip diagnostics / premium for a
// selection of devices at once. Each entry in `updates` is keyed by the
// full RTDB path so we don't pay N round-trips.
export async function bulkSetConfigFlag(deviceCodes, flag, enabled) {
  if (!Array.isArray(deviceCodes) || deviceCodes.length === 0) return;
  if (!["analyticsOn", "diagnosticsOn", "notifyOn"].includes(flag)) {
    throw new Error(`bulkSetConfigFlag: unknown flag ${flag}`);
  }
  const updates = {};
  for (const code of deviceCodes) {
    updates[`devices/${code}/config/${flag}`] = !!enabled;
  }
  await update(ref(rtdb), updates);
}

// Read the boot log for a device. Returns array of entries sorted by
// bootNumber descending (most recent first). Empty array if no log yet.
export async function getDeviceBootLog(deviceCode) {
  const snap = await get(ref(rtdb, `devices/${deviceCode}/diagnostics/boots`));
  if (!snap.exists()) return [];
  const data = snap.val();
  // Firmware writes to slots 0..49 circularly. Sort by bootNumber to get
  // chronological order, descending so newest is first in the UI.
  return Object.entries(data)
    .map(([slot, val]) => ({ slot: parseInt(slot), ...val }))
    .sort((a, b) => (b.bootNumber || 0) - (a.bootNumber || 0));
}

// Read the live diagnostics snapshot (uptime, heap, RSSI, etc.). Returns
// null if device has never uploaded one (admin hasn't pressed Refresh).
export async function getDeviceDiagnosticsNow(deviceCode) {
  const snap = await get(ref(rtdb, `devices/${deviceCode}/diagnostics/now`));
  return snap.exists() ? snap.val() : null;
}

// Ask the firmware for a fresh /diagnostics/now snapshot. The device
// picks up the command on its next 5-sec poll (~5 sec round-trip), pushes
// the snapshot, then clears the flag. Admin re-reads after a short delay.
export async function requestDiagnosticsRefresh(deviceCode) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    refreshDiagRequested: true,
  });
}

// Ask the firmware to wipe its boot log (both local NVS and the RTDB
// path under /diagnostics/boots). One-shot — firmware clears the flag.
export async function requestDiagnosticsClear(deviceCode) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    clearDiagLogRequested: true,
  });
  // Also wipe immediately from admin side so UI updates without round-trip.
  await remove(ref(rtdb, `devices/${deviceCode}/diagnostics/boots`));
}

// Clear all history for a device
export async function clearDeviceHistory(deviceCode) {
  await remove(ref(rtdb, `devices/${deviceCode}/history`));
}

// Delete only history entries OLDER than cutoffTs (epoch ms). Used by the
// admin bulk-cleanup tool on /admin/devices to trim long-running devices'
// /history nodes without nuking the recent data the charts still rely on.
//
// Strategy: query /history ordered by ts, endAt(cutoffTs - 1) to get every
// expired entry, then issue a single multi-path update() with `null` at
// each push-key path. One round-trip per device, no matter how many
// entries get deleted.
//
// Returns the number of entries actually removed so the caller can roll
// up a "deleted X entries across N devices" summary for the admin.
export async function deleteHistoryOlderThan(deviceCode, cutoffTs) {
  if (!cutoffTs || cutoffTs <= 0) return 0;
  const expiredRef = query(
    ref(rtdb, `devices/${deviceCode}/history`),
    orderByChild("ts"),
    endAt(cutoffTs - 1)
  );
  const snap = await get(expiredRef);
  if (!snap.exists()) return 0;

  const updates = {};
  let count = 0;
  snap.forEach((child) => {
    updates[`devices/${deviceCode}/history/${child.key}`] = null;
    count++;
  });
  if (count === 0) return 0;

  await update(ref(rtdb), updates);
  return count;
}

// ── Pending Devices (from RTDB, where ESP32 writes) ──
export async function getPendingDevicesRTDB() {
  const snap = await get(ref(rtdb, "pendingDevices"));
  if (!snap.exists()) return [];
  const data = snap.val();
  return Object.entries(data).map(([code, val]) => ({ deviceCode: code, ...val }));
}

// ── Live Data Listener ──
export function listenToDeviceLive(deviceCode, callback) {
  const liveRef = ref(rtdb, `devices/${deviceCode}/live`);
  onValue(liveRef, (snap) => {
    callback(snap.val());
  });
  return () => off(liveRef);
}

// ── Device Info ──
export function listenToDeviceInfo(deviceCode, callback) {
  const infoRef = ref(rtdb, `devices/${deviceCode}/info`);
  onValue(infoRef, (snap) => {
    callback(snap.val());
  });
  return () => off(infoRef);
}

// ── Commands ──
export async function sendRefreshCommand(deviceCode) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    refreshRequested: true,
  });
}

export async function sendValveCommand(deviceCode, command) {
  if (command === "open") {
    await update(ref(rtdb, `devices/${deviceCode}/commands`), { openRequested: true });
  } else if (command === "close") {
    await update(ref(rtdb, `devices/${deviceCode}/commands`), { closeRequested: true });
  }
}

// ── Valve Config (auto mode, thresholds) ──
export async function getValveConfig(deviceCode) {
  const snap = await get(ref(rtdb, `devices/${deviceCode}/config`));
  return snap.val();
}

export async function setValveConfig(deviceCode, config) {
  await set(ref(rtdb, `devices/${deviceCode}/config`), config);
}

export function listenToValveConfig(deviceCode, callback) {
  const configRef = ref(rtdb, `devices/${deviceCode}/config`);
  onValue(configRef, (snap) => { callback(snap.val()); });
  return () => off(configRef);
}

export async function sendMotorCommand(deviceCode, command) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    motorCommand: command, // "on" | "off" | ""
  });
}

export async function sendRestartCommand(deviceCode) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    restartRequested: true,
  });
}

export async function sendTestCommand(deviceCode) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    testRequested: true,
  });
}

// Ultrasonic geometry push. Firmware v21.1.2+ picks this up on its
// next commands poll (~30 sec), validates, writes NVS, updates its
// in-memory values, and pushes new geometry to /info. Cloud sees
// the /info change via existing WebSocket listener — no separate
// ACK. Admin re-sends if the /info values don't change.
//
// Pass `null` for any field to leave that field untouched on device
// (e.g. only updating overflow keeps tank height + suction as-is).
// Firmware validates ranges; invalid values are dropped silently
// (see [GEOM] Serial log on device).
export async function sendUpdateGeometry(deviceCode, { tankHeight, overflow, suction }) {
  const payload = {};
  if (tankHeight != null && tankHeight !== "") payload.tankHeight = Number(tankHeight);
  if (overflow   != null && overflow   !== "") payload.overflow   = Number(overflow);
  if (suction    != null && suction    !== "") payload.suction    = Number(suction);
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    updateGeometry: payload,
  });
}

// ── Read commands state ──
export async function getDeviceCommands(deviceCode) {
  const snap = await get(ref(rtdb, `devices/${deviceCode}/commands`));
  return snap.val();
}

// ── History (3-day) ──
export async function getDeviceHistory(deviceCode, limitCount = 864) {
  // 864 = 288 per day × 3 days (at 5-min intervals)
  const histRef = query(
    ref(rtdb, `devices/${deviceCode}/history`),
    orderByKey(),
    limitToLast(limitCount)
  );
  const snap = await get(histRef);
  if (!snap.exists()) return [];
  const data = snap.val();
  return Object.entries(data).map(([key, val]) => ({ key, ...val }));
}

export function listenToDeviceHistory(deviceCode, callback, limitCount = 864) {
  const histRef = query(
    ref(rtdb, `devices/${deviceCode}/history`),
    orderByKey(),
    limitToLast(limitCount)
  );
  onValue(histRef, (snap) => {
    if (!snap.exists()) { callback([]); return; }
    const data = snap.val();
    callback(Object.entries(data).map(([key, val]) => ({ key, ...val })));
  });
  return () => off(histRef);
}

// ── SenseFlow Standard (senseflowstandard) commands ──
export async function sfsSetAutoMode(deviceCode, enabled) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), { setAutoMode: !!enabled });
}

export async function sfsForcePumpRun(deviceCode, minutes) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), { setPumpForceRun: minutes });
}

export function listenToSfsLogs(deviceCode, callback) {
  const logsRef = ref(rtdb, `devices/${deviceCode}/logs`);
  onValue(logsRef, (snap) => {
    if (!snap.exists()) { callback([]); return; }
    const data = snap.val();
    const arr = Object.entries(data).map(([k, v]) => ({ slot: k, ...v }));
    arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    callback(arr);
  });
  return () => off(logsRef);
}

// ── Check device online status ──
export function listenToDeviceOnline(deviceCode, callback) {
  const onlineRef = ref(rtdb, `devices/${deviceCode}/info/online`);
  onValue(onlineRef, (snap) => {
    callback(snap.val());
  });
  return () => off(onlineRef);
}

// ── OTA Firmware Updates ──
// Fetch the /info node for a single device (firmware version, OTA status, etc.)
export async function getDeviceInfo(deviceCode) {
  const infoRef = ref(rtdb, `devices/${deviceCode}/info`);
  const snap = await get(infoRef);
  return snap.exists() ? snap.val() : null;
}

// Fetch /info for multiple devices in parallel. Returns map of deviceCode → info.
export async function getDevicesInfoMap(deviceCodes) {
  const entries = await Promise.all(
    deviceCodes.map(async (code) => {
      const info = await getDeviceInfo(code);
      return [code, info];
    })
  );
  return Object.fromEntries(entries);
}

// Batch-read /live for a set of devices. Only used by admin surfaces
// where we need /live.ts freshness for the online check (pumps don't
// write /info/online + /info/lastSeen, so /info alone can't tell us
// if they're currently talking to the cloud). One-shot get() per code
// so this is one round-trip per device — safe for admin-scale fleets
// of a few dozen. Do NOT call from the customer dashboard.
export async function getDevicesLiveMap(deviceCodes) {
  const entries = await Promise.all(
    deviceCodes.map(async (code) => {
      const snap = await get(ref(rtdb, `devices/${code}/live`));
      return [code, snap.exists() ? snap.val() : null];
    })
  );
  return Object.fromEntries(entries);
}

// Send an OTA trigger to one or many devices in a single multi-path update.
// devicesWithSchedule = [{ deviceCode, scheduledAt }]
// scheduledAt is epoch seconds (0 = now)
export async function sendOtaTrigger({ devicesWithSchedule, url, version, md5 }) {
  const updates = {};
  for (const { deviceCode, scheduledAt } of devicesWithSchedule) {
    updates[`devices/${deviceCode}/config/otaTrigger`]       = true;
    updates[`devices/${deviceCode}/config/otaTargetUrl`]     = url;
    updates[`devices/${deviceCode}/config/otaTargetVersion`] = version || "";
    updates[`devices/${deviceCode}/config/otaTargetMd5`]     = md5 || "";
    updates[`devices/${deviceCode}/config/otaScheduledAt`]   = scheduledAt || 0;
    updates[`devices/${deviceCode}/info/lastOtaStatus`]      = "queued";
    updates[`devices/${deviceCode}/info/otaRetryCount`]      = 0;
  }
  await update(ref(rtdb), updates);
}

// Cancel a pending OTA on one device (clear trigger)
export async function cancelOtaTrigger(deviceCode) {
  await update(ref(rtdb, `devices/${deviceCode}/config`), {
    otaTrigger: false,
  });
}

// ─── Pump-panel Settings tab helpers ───────────────────────────────
// One-shot read of the panel's current /config node. Called on Panel
// Settings tab open — pairs with the /info listener the Live tab
// already maintains (for the appliedConfig echo) so no extra listener.
export async function getPanelConfig(deviceCode) {
  const snap = await get(ref(rtdb, `devices/${deviceCode}/config`));
  return snap.exists() ? snap.val() : {};
}

// Atomic multi-field save with a fresh savedAt timestamp. Firmware's
// checkCloudConfig() picks this up on its next 60-sec poll, validates
// every field against on-device limits (same as our client-side
// panelConfigValidation.js), persists to NVS, and writes appliedAt =
// savedAt back to /info/appliedConfig on success. UI compares the two
// timestamps to render the per-field ✓/⏳ pill.
//
// v117.0.10+: also increments /config/_v (version counter). Firmware
// polls just _v (~15 B) instead of the full /config JSON (~500 B) on
// each 60-sec tick — full fetch only when _v changed. Cuts steady-
// state config-poll bandwidth by ~30×.
//
// Version increment is done via a transaction so concurrent saves from
// two admins can't collide on the same version number. We fetch the
// current _v, add 1, and include it in the same atomic update() so
// firmware sees savedAt + _v flip together (no half-applied read).
export async function savePanelConfig(deviceCode, fields) {
  const nowSec = Math.floor(Date.now() / 1000);
  // Read current version (returns null when key doesn't exist yet).
  // Missing = start at 1; existing = increment. Small extra read is
  // dwarfed by the write, and only fires on the rare Save action.
  const vSnap = await get(ref(rtdb, `devices/${deviceCode}/config/_v`));
  const nextV = ((vSnap.exists() ? vSnap.val() : 0) || 0) + 1;
  await update(ref(rtdb, `devices/${deviceCode}/config`), {
    ...fields,
    savedAt: nowSec,
    _v: nextV,
  });
  return nowSec;
}

// Force-run pump from cloud. Firmware watches /commands/forceRunMinutes
// (already handled by the v117.0.1 command dispatcher). Value = minutes,
// or -1 for "until tank full". Firmware clears the command node once it
// acts, so leaving the write here is safe — customer can't accidentally
// re-trigger by refreshing the page.
export async function forceRunPump(deviceCode, minutes) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    forceRunMinutes: minutes,
    forceRunRequestedAt: Math.floor(Date.now() / 1000),
  });
}

// Stop an in-progress force run early. Firmware's checkCloudCommands()
// handles forceRunStop symmetrically with forceRunMinutes.
export async function stopForceRunPump(deviceCode) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    forceRunStop: true,
    forceRunStopRequestedAt: Math.floor(Date.now() / 1000),
  });
}

// v118.0.7: cloud equivalent of the AP page's "CLEAR ERROR & RESUME"
// button. Firmware clears all fault state (dry-run, panel fault, safe
// mode, feedback fault) and returns to normal/idle. Command is a bool
// flag the firmware consumes + resets.
export async function clearPumpFault(deviceCode) {
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    clearFault: true,
    clearFaultRequestedAt: Math.floor(Date.now() / 1000),
  });
}
