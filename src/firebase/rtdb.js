import { ref, onValue, set, update, get, off } from "firebase/database";
import { rtdb } from "./config";

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
  await update(ref(rtdb, `devices/${deviceCode}/commands`), {
    valveCommand: command, // "open" | "close" | ""
  });
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

// ── Check device online status ──
export function listenToDeviceOnline(deviceCode, callback) {
  const onlineRef = ref(rtdb, `devices/${deviceCode}/info/online`);
  onValue(onlineRef, (snap) => {
    callback(snap.val());
  });
  return () => off(onlineRef);
}
