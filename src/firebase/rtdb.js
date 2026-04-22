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

// Clear all history for a device
export async function clearDeviceHistory(deviceCode) {
  await remove(ref(rtdb, `devices/${deviceCode}/history`));
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
