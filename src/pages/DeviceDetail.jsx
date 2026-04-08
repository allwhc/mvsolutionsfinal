import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { useDevice } from "../hooks/useDevice";
import {
  getDevice, unsubscribeFromDevice, isDeviceOwner, getDeviceSubscribers,
  setDeviceAccess, removeSubscriber, createDeviceInvite, getDeviceInvites,
  updateUserDoc,
} from "../firebase/db";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase/config";
import { sendRefreshCommand, sendRestartCommand, sendTestCommand, sendValveCommand, listenToValveConfig, setValveConfig } from "../firebase/rtdb";
import DeviceCard from "../components/DeviceCard/DeviceCard";

export default function DeviceDetail() {
  const { code } = useParams();
  const { user, isSuperAdmin } = useAuth();
  const { live, info, isOnline } = useDevice(code);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isOwner, setIsOwner] = useState(false);
  const [subscribers, setSubscribers] = useState([]);
  const [showAccess, setShowAccess] = useState(false);
  const [accessMode, setAccessMode] = useState("open");
  const [accessPin, setAccessPin] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [lastCleanedAt, setLastCleanedAt] = useState(null);
  const [cleanIntervalDays, setCleanIntervalDays] = useState(30);
  const [tankCapacityLitres, setTankCapacityLitres] = useState(0);
  const [alertLowPct, setAlertLowPct] = useState("");
  const [alertHighPct, setAlertHighPct] = useState("");
  const [alertError, setAlertError] = useState("");
  const [valveConfig, setValveConfigState] = useState(null);
  const [deviceName, setDeviceName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [valveAlertOpenHours, setValveAlertOpenHours] = useState("");
  const [valveAlertClosedHours, setValveAlertClosedHours] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    async function load() {
      const d = await getDevice(code);
      setCatalog(d);
      if (d) {
        const owner = await isDeviceOwner(user.uid, code);
        setIsOwner(owner);
        setAccessMode(d.accessMode || "open");
        setAccessPin(d.accessPin || "");
        const subs = await getDeviceSubscribers(code);
        setSubscribers(subs);
        // Load cleaning data from subscription
        const { getDoc } = await import("firebase/firestore");
        const subSnap = await getDoc(doc(db, "subscriptions", user.uid, "devices", code));
        if (subSnap.exists()) {
          const subData = subSnap.data();
          setLastCleanedAt(subData.lastCleanedAt || null);
          setCleanIntervalDays(subData.cleanIntervalDays || 30);
          setTankCapacityLitres(subData.tankCapacityLitres || 0);
          setAlertLowPct(subData.alertLowPct ?? "");
          setAlertHighPct(subData.alertHighPct ?? "");
          setDeviceName(subData.deviceName || "");
          setValveAlertOpenHours(subData.valveAlertOpenHours ?? "");
          setValveAlertClosedHours(subData.valveAlertClosedHours ?? "");
        }
      }
      setLoading(false);
    }
    load();

    // Listen for valve config changes
    const unsub = listenToValveConfig(code, (cfg) => {
      setValveConfigState(cfg);
    });
    return () => unsub();
  }, [code]);

  async function handleUnsubscribe() {
    const msg = isOwner
      ? "You are the owner. If you unsubscribe, ownership transfers to the next subscriber. Continue?"
      : "Unsubscribe from this device?";
    if (!confirm(msg)) return;
    await unsubscribeFromDevice(user.uid, code);
    navigate("/dashboard");
  }

  async function handleSaveAccess() {
    if (accessMode === "pin" && (!accessPin || accessPin.length < 4)) {
      alert("PIN must be at least 4 characters");
      return;
    }
    await setDeviceAccess(code, accessMode, accessMode === "pin" ? accessPin : null);
    setCatalog({ ...catalog, accessMode, accessPin: accessMode === "pin" ? accessPin : null });
    setShowAccess(false);
  }

  async function handleGenerateInvite() {
    const inviteId = await createDeviceInvite(code, user.uid);
    const url = `${window.location.origin}/subscribe?code=${code}&token=${inviteId}`;
    setInviteLink(url);
  }

  async function handleRemoveSubscriber(uid) {
    if (!confirm("Remove this subscriber?")) return;
    await removeSubscriber(code, uid);
    setSubscribers(subscribers.filter((s) => s.uid !== uid));
  }

  if (loading) {
    return <div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div></div>;
  }

  if (!catalog) {
    return <div className="text-center py-20 text-gray-500">Device not found in catalog</div>;
  }

  const DEVICE_CLASS = { 1: "Valve", 2: "Sensor", 3: "Motor" };
  const SENSOR_TYPE = { 0: "None", 1: "DIP", 2: "Ultrasonic" };
  const ACCESS_LABELS = { open: "Open", pin: "PIN Protected", invite: "Invite Only" };

  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={() => navigate("/dashboard")} className="text-sm text-blue-600 hover:underline mb-4 inline-block">
        &larr; Back to Dashboard
      </button>

      <DeviceCard deviceCode={code} deviceName={deviceName || catalog.deviceName || code}
        live={live} info={info} catalog={catalog} isOnline={isOnline} />

      {/* Device Name — editable */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">Device Name</span>
          {editingName ? (
            <div className="flex items-center gap-2">
              <input type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)}
                maxLength={30} autoFocus
                className="px-2 py-1 border border-gray-300 rounded text-sm w-40"
                onKeyDown={async (e) => {
                  if (e.key === "Enter") {
                    const trimmed = nameInput.trim();
                    if (trimmed) {
                      await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), { deviceName: trimmed });
                      if (isOwner) await updateDoc(doc(db, "deviceCatalog", code), { deviceName: trimmed });
                      setDeviceName(trimmed);
                      if (isOwner) setCatalog({ ...catalog, deviceName: trimmed });
                    }
                    setEditingName(false);
                  }
                  if (e.key === "Escape") setEditingName(false);
                }}
              />
              <button onClick={async () => {
                const trimmed = nameInput.trim();
                if (trimmed) {
                  await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), { deviceName: trimmed });
                  if (isOwner) await updateDoc(doc(db, "deviceCatalog", code), { deviceName: trimmed });
                  setDeviceName(trimmed);
                  if (isOwner) setCatalog({ ...catalog, deviceName: trimmed });
                }
                setEditingName(false);
              }} className="text-xs text-blue-600 hover:underline">Save</button>
              <button onClick={() => setEditingName(false)} className="text-xs text-gray-400 hover:underline">Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">{deviceName || catalog.deviceName || code}</span>
              <button onClick={() => { setNameInput(deviceName || catalog.deviceName || ""); setEditingName(true); }}
                className="text-xs text-blue-600 hover:underline">Edit</button>
            </div>
          )}
        </div>
      </div>

      {/* Device info */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Device Info</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <span className="text-gray-500">Device Code</span>
          <span className="text-gray-900 font-mono">{code}</span>
          <span className="text-gray-500">Class</span>
          <span className="text-gray-900">{DEVICE_CLASS[catalog.deviceClass] || "Unknown"}</span>
          <span className="text-gray-500">Sensor Type</span>
          <span className="text-gray-900">{SENSOR_TYPE[catalog.sensorType] || "Unknown"}</span>
          <span className="text-gray-500">Firmware</span>
          <span className="text-gray-900">{catalog.firmwareVersion || "Unknown"}</span>
          <span className="text-gray-500">RSSI</span>
          <span className="text-gray-900">{live?.rssi ? `${live.rssi} dBm` : "N/A"}</span>
          <span className="text-gray-500">Status</span>
          <span className={isOnline ? "text-green-600" : "text-gray-400"}>{isOnline ? "Online" : "Offline"}</span>
          <span className="text-gray-500">Subscribers</span>
          <span className="text-gray-900">{subscribers.length}</span>
          <span className="text-gray-500">Access</span>
          <span className="text-gray-900">{ACCESS_LABELS[catalog.accessMode] || "Open"}</span>
        </div>
      </div>

      {/* Tank Settings — only for devices with tanks (DIP or Ultrasonic) */}
      {(catalog && (catalog.sensorType === 1 || catalog.sensorType === 2 || info?.sensorType === 1 || info?.sensorType === 2)) && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Tank Maintenance</h3>
          <div className="grid grid-cols-2 gap-2 text-sm mb-3">
            <span className="text-gray-500">Last Cleaned</span>
            <input type="date" value={lastCleanedAt || ""}
              onChange={async (e) => {
                const val = e.target.value;
                setLastCleanedAt(val);
                await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), { lastCleanedAt: val });
              }}
              className="px-2 py-0.5 border border-gray-200 rounded text-sm" />
            <span className="text-gray-500">Clean Every</span>
            <div className="flex items-center gap-1">
              <input type="number" min="7" max="365" value={cleanIntervalDays}
                onChange={(e) => setCleanIntervalDays(parseInt(e.target.value) || 30)}
                className="w-14 px-2 py-0.5 border border-gray-200 rounded text-sm" />
              <span className="text-gray-500 text-xs">days</span>
              <button onClick={async () => {
                await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), { cleanIntervalDays });
              }} className="text-xs text-blue-600 hover:underline ml-1">Save</button>
            </div>
            <span className="text-gray-500">Tank Capacity</span>
            <div className="flex items-center gap-1">
              <input type="number" min="0" max="100000" value={tankCapacityLitres}
                onChange={(e) => setTankCapacityLitres(parseInt(e.target.value) || 0)}
                className="w-20 px-2 py-0.5 border border-gray-200 rounded text-sm" />
              <span className="text-gray-500 text-xs">litres</span>
              <button onClick={async () => {
                await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), { tankCapacityLitres });
              }} className="text-xs text-blue-600 hover:underline ml-1">Save</button>
            </div>
            <span className="text-gray-500">Status</span>
            <span>{(() => {
              if (!lastCleanedAt) return <span className="text-gray-400">Set cleaning date</span>;
              const days = Math.floor((new Date() - new Date(lastCleanedAt)) / 86400000);
              const left = cleanIntervalDays - days;
              if (left > 14) return <span className="text-green-600">🍃 Clean ({days}d ago)</span>;
              if (left > 0) return <span className="text-yellow-600">⚠️ Due in {left} days</span>;
              return <span className="text-red-600">🔴 Overdue by {Math.abs(left)} days</span>;
            })()}</span>
          </div>
          <button onClick={async () => {
            const today = new Date().toISOString().split("T")[0];
            await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), {
              lastCleanedAt: today, cleanIntervalDays, tankCapacityLitres,
            });
            setLastCleanedAt(today);
          }} className="w-full bg-green-50 text-green-700 py-2 rounded-lg text-sm font-medium hover:bg-green-100">
            🍃 Mark as Cleaned Today
          </button>
        </div>
      )}

      {/* Alert Thresholds — for tank devices */}
      {(catalog && (catalog.sensorType === 1 || catalog.sensorType === 2 || info?.sensorType === 1 || info?.sensorType === 2)) && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Alert Thresholds</h3>
          <div className="grid grid-cols-2 gap-2 text-sm mb-3">
            <span className="text-gray-500">Low Alert (≤)</span>
            <div className="flex items-center gap-1">
              <input type="number" min="0" max="100" value={alertLowPct}
                onChange={(e) => { setAlertLowPct(e.target.value); setAlertError(""); }}
                placeholder="Off"
                className="w-16 px-2 py-0.5 border border-gray-200 rounded text-sm" />
              <span className="text-gray-500 text-xs">%</span>
            </div>
            <span className="text-gray-500">High Alert (≥)</span>
            <div className="flex items-center gap-1">
              <input type="number" min="0" max="100" value={alertHighPct}
                onChange={(e) => { setAlertHighPct(e.target.value); setAlertError(""); }}
                placeholder="Off"
                className="w-16 px-2 py-0.5 border border-gray-200 rounded text-sm" />
              <span className="text-gray-500 text-xs">%</span>
            </div>
          </div>
          {alertError && <p className="text-red-500 text-xs mb-2">{alertError}</p>}
          <button onClick={async () => {
            const low = alertLowPct === "" ? null : parseInt(alertLowPct);
            const high = alertHighPct === "" ? null : parseInt(alertHighPct);
            if (low != null && high != null && low >= high) {
              setAlertError("Low must be less than High");
              return;
            }
            await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), {
              alertLowPct: low, alertHighPct: high,
            });
            setAlertError("");
          }} className="w-full bg-blue-50 text-blue-700 py-2 rounded-lg text-sm font-medium hover:bg-blue-100">
            Save Alert Settings
          </button>
          <p className="text-xs text-gray-400 mt-2">Card flashes red when low, green when high. Leave empty to disable.</p>
        </div>
      )}

      {/* Valve Controls — only for valve devices */}
      {(catalog?.deviceClass === 1 || info?.deviceClass === 1) && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Valve Controls</h3>

          {/* Open / Close buttons */}
          <div className="flex gap-2 mb-4">
            <button onClick={() => sendValveCommand(code, "open")}
              disabled={!isOnline}
              className="flex-1 bg-green-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed">
              Open Valve
            </button>
            <button onClick={() => sendValveCommand(code, "close")}
              disabled={!isOnline}
              className="flex-1 bg-red-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed">
              Close Valve
            </button>
          </div>

          {/* Valve state */}
          {live?.valveState != null && (
            <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 mb-3 text-sm">
              <span className="text-gray-500">Current State</span>
              <span className={`font-semibold ${
                live.valveState === 2 ? "text-green-600" :
                live.valveState === 4 ? "text-red-600" :
                live.valveState === 5 ? "text-red-700" :
                live.valveState === 6 ? "text-purple-600" :
                "text-blue-600"
              }`}>
                {["Recovery", "Opening", "Open", "Closing", "Closed", "Fault", "LS Error"][live.valveState] || "Unknown"}
              </span>
            </div>
          )}

          {/* Auto mode toggle */}
          <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 mb-3">
            <span className="text-sm text-gray-700">Auto Mode</span>
            <button
              onClick={async () => {
                const newAuto = !(valveConfig?.autoMode);
                if (newAuto && !confirm("Enable auto mode? The valve will open/close automatically based on thresholds. Device must be online.")) return;
                await setValveConfig(code, {
                  ...valveConfig,
                  autoMode: newAuto,
                  minPercent: valveConfig?.minPercent ?? 25,
                  maxPercent: valveConfig?.maxPercent ?? 75,
                });
              }}
              disabled={!isOnline}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                valveConfig?.autoMode
                  ? "bg-green-500 text-white hover:bg-green-600"
                  : "bg-gray-200 text-gray-600 hover:bg-gray-300"
              } disabled:opacity-40`}
            >
              {valveConfig?.autoMode ? "ON" : "OFF"}
            </button>
          </div>

          {/* Thresholds — only shown when auto mode is on */}
          {valveConfig?.autoMode && (
            <div className="bg-blue-50 rounded-lg p-3 space-y-2">
              <p className="text-xs text-blue-600 font-semibold">Auto Thresholds</p>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-600 w-24">Open at ≤</span>
                <select
                  value={valveConfig?.minPercent ?? 25}
                  onChange={async (e) => {
                    await setValveConfig(code, { ...valveConfig, minPercent: parseInt(e.target.value) });
                  }}
                  className="px-2 py-1 border border-gray-200 rounded text-sm"
                >
                  {[0, 17, 20, 25, 33, 40, 50, 60, 67, 75, 80, 83].filter(v => v < (valveConfig?.maxPercent ?? 75)).map(v => (
                    <option key={v} value={v}>{v}%</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-600 w-24">Close at ≥</span>
                <select
                  value={valveConfig?.maxPercent ?? 75}
                  onChange={async (e) => {
                    await setValveConfig(code, { ...valveConfig, maxPercent: parseInt(e.target.value) });
                  }}
                  className="px-2 py-1 border border-gray-200 rounded text-sm"
                >
                  {[17, 20, 25, 33, 40, 50, 60, 67, 75, 80, 83, 100].filter(v => v > (valveConfig?.minPercent ?? 25)).map(v => (
                    <option key={v} value={v}>{v}%</option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-gray-400">Device stores thresholds locally. Works even if internet disconnects.</p>
            </div>
          )}

          {/* Valve Alert Settings */}
          <div className="bg-gray-50 rounded-lg p-3 mt-3 space-y-2">
            <p className="text-xs text-gray-600 font-semibold">Valve Alerts</p>
            <p className="text-[11px] text-gray-400">Card flashes when valve stays open or closed too long. Leave empty to disable.</p>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-600 w-32">Alert if open &gt;</span>
              <input type="number" min="0" max="168" value={valveAlertOpenHours}
                onChange={(e) => setValveAlertOpenHours(e.target.value)}
                placeholder="Off"
                className="w-16 px-2 py-0.5 border border-gray-200 rounded text-sm" />
              <span className="text-gray-500 text-xs">hours</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-600 w-32">Alert if closed &gt;</span>
              <input type="number" min="0" max="168" value={valveAlertClosedHours}
                onChange={(e) => setValveAlertClosedHours(e.target.value)}
                placeholder="Off"
                className="w-16 px-2 py-0.5 border border-gray-200 rounded text-sm" />
              <span className="text-gray-500 text-xs">hours</span>
            </div>
            <button onClick={async () => {
              const openH = valveAlertOpenHours === "" ? null : parseInt(valveAlertOpenHours);
              const closedH = valveAlertClosedHours === "" ? null : parseInt(valveAlertClosedHours);
              await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), {
                valveAlertOpenHours: openH, valveAlertClosedHours: closedH,
              });
            }} className="w-full bg-blue-50 text-blue-700 py-2 rounded-lg text-sm font-medium hover:bg-blue-100">
              Save Valve Alerts
            </button>
          </div>
        </div>
      )}

      {/* Owner controls */}
      {(isOwner || isSuperAdmin) && (
        <div className="bg-white rounded-xl shadow-sm border border-blue-200 mt-4 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-900">
              {isOwner ? "Owner Controls" : "Admin Controls"}
            </h3>
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
              {isOwner ? "Owner" : "Admin"}
            </span>
          </div>

          {/* Access control */}
          <button onClick={() => setShowAccess(!showAccess)}
            className="w-full text-left px-3 py-2 bg-gray-50 rounded-lg text-sm text-gray-700 hover:bg-gray-100 mb-3">
            Access: <strong>{ACCESS_LABELS[accessMode]}</strong> — tap to change
          </button>

          {showAccess && (
            <div className="bg-gray-50 rounded-lg p-3 mb-3 space-y-2">
              {["open", "pin", "invite"].map((mode) => (
                <label key={mode} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="access" value={mode} checked={accessMode === mode}
                    onChange={(e) => setAccessMode(e.target.value)} />
                  <span>{ACCESS_LABELS[mode]}</span>
                </label>
              ))}
              {accessMode === "pin" && (
                <input type="text" placeholder="Set PIN (4-6 chars)" value={accessPin}
                  onChange={(e) => setAccessPin(e.target.value)} maxLength={6}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono tracking-widest" />
              )}
              <button onClick={handleSaveAccess}
                className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-xs font-medium">Save</button>
            </div>
          )}

          {/* Generate invite link */}
          {accessMode === "invite" && (
            <div className="mb-3">
              <button onClick={handleGenerateInvite}
                className="px-4 py-2 bg-green-50 text-green-600 rounded-lg text-sm hover:bg-green-100">
                Generate Invite Link
              </button>
              {inviteLink && (
                <div className="mt-2 bg-gray-50 rounded-lg p-2">
                  <p className="text-xs text-gray-400 mb-1">Share this link (expires in 48h, max 5 uses)</p>
                  <p className="text-xs font-mono break-all text-blue-600">{inviteLink}</p>
                  <button onClick={() => { navigator.clipboard.writeText(inviteLink); }}
                    className="mt-1 text-xs text-blue-600 hover:underline">Copy</button>
                </div>
              )}
            </div>
          )}

          {/* Subscribers list */}
          <div>
            <p className="text-xs text-gray-500 font-medium mb-2">
              Subscribers ({subscribers.length})
            </p>
            <div className="space-y-1.5">
              {subscribers.map((s) => (
                <div key={s.uid} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                  <div>
                    <span className="text-xs text-gray-700">{s.uid.substring(0, 12)}...</span>
                    {s.isOwner && <span className="text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded ml-2">Owner</span>}
                  </div>
                  {!s.isOwner && s.uid !== user.uid && (
                    <button onClick={() => handleRemoveSubscriber(s.uid)}
                      className="text-xs text-red-500 hover:text-red-700">Remove</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* Actions — at bottom */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Actions</h3>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => sendRefreshCommand(code)}
            className="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg text-sm hover:bg-blue-100">Force Refresh</button>
          <button onClick={() => { if (confirm("Send test blink command to this device?")) sendTestCommand(code); }}
            className="px-4 py-2 bg-green-50 text-green-600 rounded-lg text-sm hover:bg-green-100">Test LED</button>
          <button onClick={() => { if (confirm("Restart this device? It will go offline for a few seconds.")) sendRestartCommand(code); }}
            className="px-4 py-2 bg-yellow-50 text-yellow-600 rounded-lg text-sm hover:bg-yellow-100">Restart</button>
          <button onClick={handleUnsubscribe}
            className="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm hover:bg-red-100">Unsubscribe</button>
        </div>
      </div>
    </div>
  );
}
