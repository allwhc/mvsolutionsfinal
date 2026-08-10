import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { useDevice } from "../hooks/useDevice";
import {
  getDevice, unsubscribeFromDevice, isDeviceOwner, getDeviceSubscribers,
  setDeviceAccess, removeSubscriber, createDeviceInvite, getDeviceInvites,
  updateUserDoc, getOrgGroups, removeDeviceFromOrg, updateOrgGroup,
} from "../firebase/db";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase/config";
import { sendRefreshCommand, sendRestartCommand, sendTestCommand, sendValveCommand, listenToValveConfig, setValveConfig, sfsSetAutoMode, sfsForcePumpRun, listenToSfsLogs, getDeviceBootLog, getDeviceDiagnosticsNow, requestDiagnosticsRefresh, requestDiagnosticsClear, sendUpdateGeometry } from "../firebase/rtdb";
import DeviceCard from "../components/DeviceCard/DeviceCard";
import AnalyticsChart, { generateCSV, downloadCSV } from "../components/Analytics/AnalyticsChart";
import { useDebugMode } from "../context/DebugModeContext";
import { resolveLevel } from "../utils/resolveLevel";

// Notification rule catalogue — kept here so the UI knows what to show and
// the Cloud Function dispatcher uses the same keys / default delays.
const NOTIF_EVENTS = [
  {
    key: "level_empty",
    label: "Tank Empty",
    defaultDelaySec: 60 * 60,
    options: [
      { label: "Immediate", sec: 0 },
      { label: "After 15 min", sec: 15 * 60 },
      { label: "After 30 min", sec: 30 * 60 },
      { label: "After 1 hour", sec: 60 * 60 },
      { label: "After 2 hours", sec: 2 * 60 * 60 },
      { label: "After 3 hours", sec: 3 * 60 * 60 },
      { label: "After 4 hours", sec: 4 * 60 * 60 },
    ],
  },
  {
    key: "level_full",
    label: "Tank Full",
    defaultDelaySec: 0,
    options: [
      { label: "Immediate", sec: 0 },
      { label: "After 15 min", sec: 15 * 60 },
      { label: "After 30 min", sec: 30 * 60 },
      { label: "After 1 hour", sec: 60 * 60 },
    ],
  },
  {
    key: "device_offline",
    label: "Device Offline",
    defaultDelaySec: 30 * 60,
    options: [
      { label: "After 15 min", sec: 15 * 60 },
      { label: "After 30 min", sec: 30 * 60 },
      { label: "After 1 hour", sec: 60 * 60 },
      { label: "After 2 hours", sec: 2 * 60 * 60 },
      { label: "After 4 hours", sec: 4 * 60 * 60 },
    ],
  },
  {
    key: "sensor_error",
    label: "Sensor Error",
    defaultDelaySec: 0,
    options: [
      { label: "Immediate", sec: 0 },
      { label: "After 15 min", sec: 15 * 60 },
      { label: "After 30 min", sec: 30 * 60 },
    ],
  },
];

// RSSI is reported by the device on each /live push. Once the device
// drops offline, that last-known value is stale (could be hours old).
// Treat it as N/A in that state instead of misrepresenting a remembered
// number as a current signal reading.
function rssiLabel(rssi, online) {
  if (!online) return "N/A (device offline)";
  if (rssi === undefined || rssi === null || rssi === 0) return "N/A";
  if (rssi >= -55) return `Excellent (${rssi} dBm)`;
  if (rssi >= -65) return `Good (${rssi} dBm)`;
  if (rssi >= -75) return `Fair (${rssi} dBm)`;
  return `Weak (${rssi} dBm)`;
}

// Format litres as KL when ≥ 1000. Matches dashboard TankViz formatter
// so the volume display is consistent across the app.
function fmtLitres(L) {
  if (!L && L !== 0) return "—";
  if (L >= 1000) {
    const kl = L / 1000;
    return `${kl.toFixed(L % 1000 === 0 ? 0 : 1)} KL`;
  }
  return `${L} L`;
}

// Convert cm → "X ft Y in" for the Tank Geometry rows. Same rounding
// rule as SensorCard's depth display so all views agree.
function cmToFtIn(cm) {
  if (cm == null || !isFinite(cm) || cm < 0) return "";
  const totalInches = cm / 2.54;
  let ft = Math.floor(totalInches / 12);
  let inches = Math.round(totalInches - ft * 12);
  if (inches === 12) { ft += 1; inches = 0; }
  return `${ft} ft ${inches} in`;
}

export default function DeviceDetail() {
  const { code } = useParams();
  const { user, userData, isSuperAdmin, isOrgAdmin, isOrgMember } = useAuth();
  const orgId = userData?.orgId || null;
  // Org role — only orgAdmin can rename or remove org-owned devices.
  // Regular org members are view-only.
  const isOrg = isOrgAdmin || isOrgMember;
  // Effective "device owner" for permission checks on shared per-tank
  // settings (rename, tank capacity, wing membership, access mode).
  //   • Individual account → the owner (isOwner from subscriptions)
  //   • Org account         → orgAdmin (orgs don't have per-user owners)
  //   • Superadmin          → always
  // isOwner is set later by isDeviceOwner() effect. For org accounts
  // it stays false (no per-user subscription), so `canEditDevice`
  // relies on isOrgAdmin instead — otherwise orgAdmin couldn't edit
  // tank capacity, rename, etc.
  const canEditOrgDevice = isOrg ? isOrgAdmin : true;   // rename-only gate (see also isEffectiveOwner below)
  // Wing/group this device belongs to (org only) — read-only for members,
  // shown to everyone as informational context.
  const [wings, setWings] = useState([]);
  useEffect(() => {
    if (isOrg && orgId) getOrgGroups(orgId).then(setWings);
  }, [isOrg, orgId]);
  const currentWing = wings.find((w) => (w.deviceCodes || []).includes(code));
  const { debugMode } = useDebugMode();
  const { live, info, isOnline } = useDevice(code);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isOwner, setIsOwner] = useState(false);
  // Whoever has authority to edit shared per-tank settings (tank
  // capacity, access mode, etc.). For individual accounts that's the
  // subscription owner; for org accounts, orgAdmin (org devices have
  // no per-user owner concept — the org owns the device, admin manages
  // it). Superadmin always wins. Use this instead of raw `isOwner`
  // anywhere the check is "who can change a shared property of THIS
  // physical tank" — otherwise orgAdmin gets locked out.
  const isEffectiveOwner = isOwner || isOrgAdmin || isSuperAdmin;
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
  const [notifRules, setNotifRules] = useState({});   // { level_empty: {enabled, delaySec}, ... }
  const [savingRule, setSavingRule] = useState({});   // event -> bool
  const [alertError, setAlertError] = useState("");
  const [valveConfig, setValveConfigState] = useState(null);
  const [chartKey, setChartKey] = useState(0);
  const [deviceName, setDeviceName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  // Tank Geometry edit state — ultrasonic only. When editing, fields
  // become inputs; on Send we write a command to /commands/updateGeometry
  // and the device applies it within ~30 sec (existing commands poll).
  // The device pushes new geometry to /info after applying, so the
  // read-only rows in this same section auto-update — that's the ACK.
  // Admin re-sends if the values don't change.
  const [editingGeometry, setEditingGeometry] = useState(false);
  const [geoTankInput,     setGeoTankInput]     = useState("");
  const [geoOverflowInput, setGeoOverflowInput] = useState("");
  const [geoSuctionInput,  setGeoSuctionInput]  = useState("");
  const [geoSending,       setGeoSending]       = useState(false);
  const [geoError,         setGeoError]         = useState("");
  const [valveAlertOpenHours, setValveAlertOpenHours] = useState("");
  const [valveAlertClosedHours, setValveAlertClosedHours] = useState("");
  const [sfsLogs, setSfsLogs] = useState([]);
  const [sfsPumpMinutes, setSfsPumpMinutes] = useState(15);
  const navigate = useNavigate();
  const location = useLocation();

  const isSfs = catalog?.deviceClass === "senseflowstandard" || info?.deviceClass === "senseflowstandard";

  // Scroll to anchor when hash is present (e.g. #analytics)
  useEffect(() => {
    if (!location.hash || loading) return;
    const id = location.hash.slice(1);
    const el = document.getElementById(id);
    if (el) setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
  }, [location.hash, loading, valveConfig?.analyticsOn]);

  useEffect(() => {
    if (!isSfs) return;
    const unsub = listenToSfsLogs(code, setSfsLogs);
    return () => unsub();
  }, [isSfs, code]);

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
        // Tank capacity now lives on the shared device catalog — one
        // physical tank, one capacity, visible to every subscriber /
        // org member. Previously it was per-user (subscriptions/<uid>/
        // devices/<code>.tankCapacityLitres) which meant every new
        // subscriber saw 0L until they set it themselves.
        setTankCapacityLitres(d.tankCapacityLitres || 0);
        // Read order for shared per-tank settings (thresholds, cleaning
        // date, name):
        //   1. deviceCatalog — the canonical value, set by effective owner
        //   2. Legacy per-user subscription — fallback for pre-migration
        //      data. Still stored, still readable, just not authoritative
        //      once catalog has a value.
        // Notification RULES stay per-user (each phone gets to opt in/out
        // per event) — read from subscription only, never from catalog.
        const { getDoc } = await import("firebase/firestore");
        const subSnap = await getDoc(doc(db, "subscriptions", user.uid, "devices", code));
        const subData = subSnap.exists() ? subSnap.data() : {};

        // Alert thresholds — canonical: deviceCatalog. Fallback: sub.
        setAlertLowPct(
          d.alertLowPct  ?? subData.alertLowPct  ?? ""
        );
        setAlertHighPct(
          d.alertHighPct ?? subData.alertHighPct ?? ""
        );
        // Cleaning — canonical: catalog.
        setLastCleanedAt(d.lastCleanedAt        ?? subData.lastCleanedAt      ?? null);
        setCleanIntervalDays(d.cleanIntervalDays ?? subData.cleanIntervalDays ?? 30);
        // Device name — canonical: catalog.
        setDeviceName(d.deviceName ?? subData.deviceName ?? "");

        // Per-user (unchanged):
        setNotifRules(subData.notificationRules || {});
        setValveAlertOpenHours(subData.valveAlertOpenHours ?? "");
        setValveAlertClosedHours(subData.valveAlertClosedHours ?? "");

        // Silent self-migration: if effective owner opens the page and
        // catalog values are empty but their own subscription has
        // values, quietly promote them to catalog. Non-owners never
        // trigger this — only the person allowed to set canonical
        // values does. Wrapped in a fire-and-forget so any single
        // failed write doesn't block the load.
        const canWriteCatalog = owner || isSuperAdmin || (isOrgAdmin && !!orgId);
        if (canWriteCatalog && subSnap.exists()) {
          const patch = {};
          if (d.alertLowPct       == null && subData.alertLowPct       != null) patch.alertLowPct       = subData.alertLowPct;
          if (d.alertHighPct      == null && subData.alertHighPct      != null) patch.alertHighPct      = subData.alertHighPct;
          if (d.lastCleanedAt     == null && subData.lastCleanedAt     != null) patch.lastCleanedAt     = subData.lastCleanedAt;
          if (d.cleanIntervalDays == null && subData.cleanIntervalDays != null) patch.cleanIntervalDays = subData.cleanIntervalDays;
          if (d.deviceName        == null && subData.deviceName        != null) patch.deviceName        = subData.deviceName;
          if (Object.keys(patch).length > 0) {
            updateDoc(doc(db, "deviceCatalog", code), patch)
              .then(() => setCatalog((prev) => ({ ...prev, ...patch })))
              .catch((e) => console.warn("catalog migration failed:", e));
          }
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

  // Rename a device. Fans out to the right stores depending on how
  // this user relates to the device — each write is independent so
  // one missing doc (very common for orgAdmin, who has no personal
  // subscription for org devices) never blocks the others.
  //
  //   • Personal subscription (subscriptions/<uid>/devices/<code>)
  //     → only exists for individual accounts that actually
  //       subscribed to this device. Skip entirely for orgAdmin, who
  //       manages the fleet without ever subscribing personally
  //       (attempting the write throws "No document to update" and
  //       cascaded the whole rename before this refactor).
  //   • deviceCatalog/<code>
  //     → shared display name. Any effective owner may write
  //       (individual owner OR orgAdmin OR superadmin). Everyone else
  //       reads through the fallback chain in the UI.
  //   • orgDevices/<orgId>/devices/<code>
  //     → what the org dashboard tile reads. Bumped for any org
  //       device rename so the tile stops showing the stale name.
  //
  // Local state is optimistic-updated up front so the input closes
  // instantly; the writes race in the background. If any of them
  // fail, we surface an alert but the local rename is kept — user
  // sees their intent, next reload will re-hydrate from Firestore.
  async function saveDeviceName(trimmed) {
    setDeviceName(trimmed);
    if (isEffectiveOwner) setCatalog({ ...catalog, deviceName: trimmed });

    const writes = [];
    // Only touch the personal subscription if it actually exists for
    // this user. Individual subscribers have one; orgAdmin doesn't.
    if (!isOrg) {
      writes.push(
        updateDoc(doc(db, "subscriptions", user.uid, "devices", code), { deviceName: trimmed })
          .catch((e) => console.warn("subscriptions rename failed:", e))
      );
    }
    if (isEffectiveOwner) {
      writes.push(
        updateDoc(doc(db, "deviceCatalog", code), { deviceName: trimmed })
          .catch((e) => console.warn("deviceCatalog rename failed:", e))
      );
    }
    if (orgId) {
      writes.push(
        updateDoc(doc(db, "orgDevices", orgId, "devices", code), { deviceName: trimmed })
          .catch((e) => console.warn("orgDevices rename failed:", e))
      );
    }
    await Promise.allSettled(writes);
  }

  async function handleUnsubscribe() {
    // Org accounts use a different path — the button label + confirm
    // message + underlying write are handled by handleRemoveFromOrg
    // below. This function is now individual-only.
    const msg = isOwner
      ? "You are the owner. If you unsubscribe, ownership transfers to the next subscriber. Continue?"
      : "Unsubscribe from this device?";
    if (!confirm(msg)) return;
    await unsubscribeFromDevice(user.uid, code);
    navigate("/dashboard");
  }

  // orgAdmin action — remove device from the org's shared list AND
  // detach it from every wing. Device catalog is untouched so admin can
  // re-add later by scanning. No ownership transfer (org accounts have
  // no ownership concept — admin manages everything).
  async function handleRemoveFromOrg() {
    if (!orgId) return;
    if (!confirm(`Remove this device from your organisation?\n\nThe device stays registered and can be re-added by scanning its QR code.`)) return;
    try {
      await removeDeviceFromOrg(orgId, code);
      // Auto-detach from any wing that contains this device.
      for (const w of wings) {
        if ((w.deviceCodes || []).includes(code)) {
          const next = (w.deviceCodes || []).filter((c) => c !== code);
          await updateOrgGroup(orgId, w.groupId, { deviceCodes: next });
        }
      }
    } catch (e) {
      console.error("Remove from org failed:", e);
      alert("Failed to remove — try again");
      return;
    }
    navigate("/dashboard");
  }

  // Push geometry values to the device. Uses the existing commands
  // poll — firmware picks up within ~30 sec. Values validated on
  // firmware side (same rules as AP page); anything out of range is
  // silently rejected (Serial log shows "[GEOM] Rejected ..."). Cloud
  // sees the /info values update via existing WebSocket listener —
  // that's the visible ACK.
  async function handleSendGeometry() {
    setGeoError("");
    // Basic front-side validation matching firmware bounds so the
    // admin isn't confused when firmware silently rejects.
    const tank = geoTankInput === "" ? null : Number(geoTankInput);
    const ovfl = geoOverflowInput === "" ? null : Number(geoOverflowInput);
    const suct = geoSuctionInput === "" ? null : Number(geoSuctionInput);
    if (tank != null && (!isFinite(tank) || tank < 36 || tank > 750)) {
      setGeoError("Tank height must be 36-750 cm.");
      return;
    }
    // Use edited tank or current /info value for overflow/suction
    // bounds check (whichever the device will end up with).
    const effectiveTank = tank ?? Number(info?.tankHeightCm) ?? 100;
    if (ovfl != null && ovfl !== 0 && (ovfl < 35 || ovfl >= effectiveTank - 10)) {
      setGeoError(`Overflow must be 0 or between 35 and ${Math.floor(effectiveTank - 10)} cm.`);
      return;
    }
    if (suct != null && suct !== 0 && (suct <= 0 || suct >= effectiveTank - 35)) {
      setGeoError(`Suction must be 0 or between 1 and ${Math.floor(effectiveTank - 36)} cm.`);
      return;
    }
    setGeoSending(true);
    try {
      await sendUpdateGeometry(code, {
        tankHeight: tank,
        overflow:   ovfl,
        suction:    suct,
      });
      // Exit edit mode — device applies within ~30 sec, and the /info
      // WebSocket listener will refresh the read-only rows when the
      // new values land. If nothing changes, admin can click Edit
      // again and re-Send.
      setEditingGeometry(false);
    } catch (e) {
      console.error("sendUpdateGeometry failed:", e);
      setGeoError("Send failed — try again.");
    } finally {
      setGeoSending(false);
    }
  }

  // Parse firmware version string like "21.1.2" or "21.0.7-HIGH" into
  // a comparable tuple. Returns null if unparseable. Used to gate the
  // geometry-edit UI — only firmware v21.1.2+ supports the
  // updateGeometry command; older firmware would ignore it silently.
  function fwSupportsGeometryPush(versionStr) {
    if (!versionStr) return false;
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(versionStr);
    if (!m) return false;
    const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (maj > 21) return true;
    if (maj < 21) return false;
    if (min > 1) return true;
    if (min < 1) return false;
    return patch >= 2;
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

  const DEVICE_CLASS = { 1: "Valve", 2: "Sensor", 3: "Motor", "senseflowstandard": "SenseFlow Standard" };
  const SENSOR_TYPE = { 0: "None", 1: "DIP", 2: "Ultrasonic" };
  const ACCESS_LABELS = { open: "Open", pin: "PIN Protected", invite: "Invite Only" };

  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={() => navigate("/dashboard")} className="text-sm text-blue-600 hover:underline mb-4 inline-block">
        &larr; Back to Dashboard
      </button>

      <DeviceCard deviceCode={code} deviceName={deviceName || catalog.deviceName || code}
        live={live} info={info} catalog={catalog} isOnline={isOnline}
        tankCapacityLitres={tankCapacityLitres}
        lastCleanedAt={lastCleanedAt} cleanIntervalDays={cleanIntervalDays}
        alertLowPct={alertLowPct} alertHighPct={alertHighPct} />

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
                    if (trimmed) await saveDeviceName(trimmed);
                    setEditingName(false);
                  }
                  if (e.key === "Escape") setEditingName(false);
                }}
              />
              <button onClick={async () => {
                const trimmed = nameInput.trim();
                if (trimmed) await saveDeviceName(trimmed);
                setEditingName(false);
              }} className="text-xs text-blue-600 hover:underline">Save</button>
              <button onClick={() => setEditingName(false)} className="text-xs text-gray-400 hover:underline">Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">{deviceName || catalog.deviceName || code}</span>
              {/* Rename allowed for: individual accounts (owner-check
                  further gates behavior elsewhere), or orgAdmin. Regular
                  org members are view-only per the "admin manages
                  fleet" model. */}
              {canEditOrgDevice && (
                <button onClick={() => { setNameInput(deviceName || catalog.deviceName || ""); setEditingName(true); }}
                  className="text-xs text-blue-600 hover:underline">Edit</button>
              )}
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
          {/* User-assigned physical-identity label from the ESP32 NVS.
              Set by installer via AP page — helps match this dashboard
              entry to the physical tank. Distinct from deviceName, which
              is the customer-facing rename-anytime display name. */}
          <span className="text-gray-500">User-Assigned Name</span>
          <span className="text-gray-900">{info?.userAssignedName || "—"}</span>
          {/* Wing/group membership — org accounts only. Read-only for
              everyone here; orgAdmin manages membership from the wing
              tab on the dashboard (per-tile X + Add-to-Wing button). */}
          {isOrg && (
            <>
              <span className="text-gray-500">Wing / Group</span>
              <span className="text-gray-900">{currentWing?.name || "— Unassigned —"}</span>
            </>
          )}
          <span className="text-gray-500">Class</span>
          <span className="text-gray-900">{DEVICE_CLASS[catalog.deviceClass] || "Unknown"}</span>
          <span className="text-gray-500">Sensor Type</span>
          {/* Prefer info.sensorType (fresh from firmware — always
              matches whatever firmware is actually flashed) over
              catalog.sensorType (stale — set once at admin
              registration and never updated after re-flashing to a
              different sensor type). Matches SensorCard which also
              reads info first. */}
          <span className="text-gray-900">{SENSOR_TYPE[info?.sensorType ?? catalog.sensorType] || "Unknown"}</span>

          {/* Tank Geometry — ultrasonic only. Firmware (v21.0.7+) pushes
              tankHeightCm / overflowCm / suctionCm to /info so this
              section auto-refreshes when the device applies a change.
              orgAdmin/superadmin can Edit + Send on firmware v21.1.2+;
              older firmware shows read-only + a tooltip. */}
          {(info?.sensorType ?? catalog.sensorType) === 2 && (() => {
            const tankH = Number(info?.tankHeightCm);
            const ovfl  = Number(info?.overflowCm);
            const suct  = Number(info?.suctionCm);
            const hasTank = isFinite(tankH) && tankH > 0;
            const suctionCutoff = hasTank && suct > 0 && suct < tankH ? tankH - suct : tankH;
            const topCutoff     = ovfl > 0 && (!hasTank || ovfl < tankH) ? ovfl : 0;
            const usable = hasTank ? Math.max(0, suctionCutoff - topCutoff) : null;
            const fmtRow = (cm) => {
              if (!isFinite(cm) || cm < 0) return <span className="text-gray-400">—</span>;
              return <span>{cmToFtIn(cm)} <span className="text-gray-400 text-xs">({Math.round(cm)} cm)</span></span>;
            };
            const canEditGeo   = isEffectiveOwner;
            const fwSupports   = fwSupportsGeometryPush(info?.firmwareVersion);
            const cmInput = (val, setVal, placeholder) => (
              <input
                type="number"
                min="0"
                value={val}
                onChange={(e) => setVal(e.target.value)}
                placeholder={placeholder}
                className="w-20 px-1.5 py-0.5 border border-gray-200 rounded text-xs"
              />
            );

            if (editingGeometry) {
              return (
                <>
                  <span className="text-gray-500">Tank Height</span>
                  <span className="flex items-center gap-1">
                    {cmInput(geoTankInput, setGeoTankInput, `${Math.round(tankH) || "cm"}`)}
                    <span className="text-gray-400 text-xs">cm</span>
                  </span>
                  <span className="text-gray-500">Overflow Pipe</span>
                  <span className="flex items-center gap-1">
                    {cmInput(geoOverflowInput, setGeoOverflowInput, `${Math.round(ovfl) || "0=off"}`)}
                    <span className="text-gray-400 text-xs">cm from sensor</span>
                  </span>
                  <span className="text-gray-500">Suction Cutoff</span>
                  <span className="flex items-center gap-1">
                    {cmInput(geoSuctionInput, setGeoSuctionInput, `${Math.round(suct) || "0=off"}`)}
                    <span className="text-gray-400 text-xs">cm from bottom</span>
                  </span>
                  <span className="text-gray-500"></span>
                  <span className="flex flex-col gap-1 text-xs">
                    {geoError && <span className="text-red-600">{geoError}</span>}
                    <span className="text-gray-400">
                      Leave blank to keep current value. Applies to device within ~30 sec.
                      {!isOnline && " Device is offline — will apply on next reconnect."}
                    </span>
                    <span className="flex gap-2 mt-1">
                      <button
                        onClick={handleSendGeometry}
                        disabled={geoSending}
                        className="bg-blue-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
                      >
                        {geoSending ? "Sending…" : "Send to Device"}
                      </button>
                      <button
                        onClick={() => { setEditingGeometry(false); setGeoError(""); }}
                        className="text-gray-500 hover:text-gray-700 text-xs"
                      >
                        Cancel
                      </button>
                    </span>
                  </span>
                </>
              );
            }

            return (
              <>
                <span className="text-gray-500">Tank Height</span>
                <span className="text-gray-900 flex items-center gap-2">
                  {hasTank ? fmtRow(tankH) : <span className="text-gray-400">Not configured</span>}
                  {/* Edit toggle — only visible to effective owner.
                      Older firmware without geometry push support
                      shows a tooltip explaining why it's greyed. */}
                  {canEditGeo && (
                    fwSupports ? (
                      <button
                        onClick={() => {
                          // Pre-fill inputs from current values so admin
                          // sees what's saved and only overwrites what
                          // they want to change.
                          setGeoTankInput(hasTank ? Math.round(tankH).toString() : "");
                          setGeoOverflowInput(ovfl > 0 ? Math.round(ovfl).toString() : "");
                          setGeoSuctionInput(suct > 0 ? Math.round(suct).toString() : "");
                          setGeoError("");
                          setEditingGeometry(true);
                        }}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Edit
                      </button>
                    ) : (
                      <span className="text-[10px] text-gray-400 italic" title={`Requires firmware v21.1.2+. Current: ${info?.firmwareVersion || "unknown"}`}>
                        (edit needs firmware v21.1.2+)
                      </span>
                    )
                  )}
                </span>
                <span className="text-gray-500">Overflow Pipe</span>
                <span className="text-gray-900">
                  {ovfl > 0 ? <><span className="text-gray-500 text-xs">from sensor</span> {fmtRow(ovfl)}</> : <span className="text-gray-400">Not set (no overflow limit)</span>}
                </span>
                <span className="text-gray-500">Suction Cutoff</span>
                <span className="text-gray-900">
                  {suct > 0 ? <><span className="text-gray-500 text-xs">from tank bottom</span> {fmtRow(suct)}</> : <span className="text-gray-400">Not set (uses tank floor)</span>}
                </span>
                <span className="text-gray-500">Usable Range</span>
                <span className="text-gray-900">
                  {usable != null ? fmtRow(usable) : <span className="text-gray-400">—</span>}
                </span>
              </>
            );
          })()}
          {tankCapacityLitres > 0 && (
            <>
              <span className="text-gray-500">Tank Capacity</span>
              <span className="text-gray-900">{fmtLitres(tankCapacityLitres)}</span>
              {/* Current volume — only meaningful when device is online and
                  reporting a fresh pct. Hide when offline so we don't show
                  a stale derived number. */}
              {isOnline && typeof live?.confirmedPct === "number" && (() => {
                const sType = info?.sensorType ?? catalog.sensorType ?? 1;
                const sCount = info?.sensorCount ?? catalog.sensorCount ?? 4;
                const displayPct = (sType === 1 && !debugMode)
                  ? resolveLevel(live.sensorBits ?? 0, sCount).pct
                  : live.confirmedPct;
                return (
                  <>
                    <span className="text-gray-500">Current Volume</span>
                    <span className="text-gray-900">
                      {fmtLitres(Math.round((displayPct / 100) * tankCapacityLitres))}
                    </span>
                  </>
                );
              })()}
            </>
          )}
          <span className="text-gray-500">Firmware</span>
          <span className="text-gray-900">{info?.firmwareVersion || catalog.firmwareVersion || "Unknown"}</span>
          <span className="text-gray-500">WiFi Signal</span>
          <span className={isOnline ? "text-gray-900" : "text-gray-400"}>{rssiLabel(live?.rssi, isOnline)}</span>
          <span className="text-gray-500">Status</span>
          <span className={isOnline ? "text-green-600" : "text-gray-400"}>{isOnline ? "Online" : "Offline"}</span>
          <span className="text-gray-500">Subscribers</span>
          <span className="text-gray-900">{subscribers.length}</span>
          <span className="text-gray-500">Access</span>
          <span className="text-gray-900">{ACCESS_LABELS[catalog.accessMode] || "Open"}</span>
        </div>
      </div>

      {/* Tank Settings — only for devices with tanks (DIP or Ultrasonic).
          Cleaning date + interval are canonical per tank (not per user
          — a physical cleaning is a physical event). Non-owners see the
          current values read-only. Tank capacity has been effective-
          owner-only for a while; alerts + cleaning now match. */}
      {(catalog && (catalog.sensorType === 1 || catalog.sensorType === 2 || info?.sensorType === 1 || info?.sensorType === 2)) && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Tank Maintenance</h3>
          {!isEffectiveOwner && (
            <p className="text-[11px] text-gray-500 mb-3 bg-gray-50 rounded px-2 py-1">
              Only the tank owner can change maintenance settings.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 text-sm mb-3">
            <span className="text-gray-500">Last Cleaned</span>
            <input type="date" value={lastCleanedAt || ""}
              disabled={!isEffectiveOwner}
              onChange={async (e) => {
                const val = e.target.value;
                setLastCleanedAt(val);
                await updateDoc(doc(db, "deviceCatalog", code), { lastCleanedAt: val })
                  .catch((e) => console.warn("lastCleanedAt save failed:", e));
              }}
              className="px-2 py-0.5 border border-gray-200 rounded text-sm disabled:bg-gray-50 disabled:text-gray-500" />
            <span className="text-gray-500">Clean Every</span>
            <div className="flex items-center gap-1">
              <input type="number" min="7" max="365" value={cleanIntervalDays}
                disabled={!isEffectiveOwner}
                onChange={(e) => setCleanIntervalDays(parseInt(e.target.value) || 30)}
                className="w-14 px-2 py-0.5 border border-gray-200 rounded text-sm disabled:bg-gray-50 disabled:text-gray-500" />
              <span className="text-gray-500 text-xs">days</span>
              {isEffectiveOwner && (
                <button onClick={async () => {
                  await updateDoc(doc(db, "deviceCatalog", code), { cleanIntervalDays })
                    .catch((e) => console.warn("cleanIntervalDays save failed:", e));
                }} className="text-xs text-blue-600 hover:underline ml-1">Save</button>
              )}
            </div>
            <span className="text-gray-500">Tank Capacity</span>
            <div className="flex items-center gap-1">
              {/* Tank capacity lives on the shared device catalog now —
                  one physical tank, one capacity, seen by every user or
                  org member. Only the owner (or superadmin) can edit;
                  everyone else sees the value read-only. */}
              <input type="number" min="0" max="100000" value={tankCapacityLitres}
                onChange={(e) => setTankCapacityLitres(parseInt(e.target.value) || 0)}
                disabled={!isEffectiveOwner}
                className="w-20 px-2 py-0.5 border border-gray-200 rounded text-sm disabled:bg-gray-50 disabled:text-gray-500" />
              <span className="text-gray-500 text-xs">
                {tankCapacityLitres >= 1000
                  ? `= ${(tankCapacityLitres / 1000).toFixed(tankCapacityLitres % 1000 === 0 ? 0 : 1)} KL`
                  : "litres"}
              </span>
              {isEffectiveOwner && (
                <button onClick={async () => {
                  await updateDoc(doc(db, "deviceCatalog", code), { tankCapacityLitres });
                }} className="text-xs text-blue-600 hover:underline ml-1">Save</button>
              )}
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
          {isEffectiveOwner && (
            <button onClick={async () => {
              const today = new Date().toISOString().split("T")[0];
              // Canonical cleaning log — deviceCatalog.
              await updateDoc(doc(db, "deviceCatalog", code), {
                lastCleanedAt: today, cleanIntervalDays,
              }).catch((e) => console.warn("cleaning mark failed:", e));
              setLastCleanedAt(today);
            }} className="w-full bg-green-50 text-green-700 py-2 rounded-lg text-sm font-medium hover:bg-green-100">
              🍃 Mark as Cleaned Today
            </button>
          )}
        </div>
      )}

      {/* Alert Thresholds — for tank devices */}
      {(catalog && (catalog.sensorType === 1 || catalog.sensorType === 2 || info?.sensorType === 1 || info?.sensorType === 2)) && (() => {
        const sc = info?.sensorCount ?? catalog?.sensorCount ?? 4;
        const isSingle = sc === 1;

        return (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
            <h3 className="font-semibold text-gray-900 mb-3">Alert Settings</h3>

            {/* Non-owners see the current thresholds read-only — the
                owner (or orgAdmin / superadmin) is the only one who
                can change them. Matches the "one canonical value per
                tank" model applied to name / capacity / access. */}
            {!isEffectiveOwner && (
              <p className="text-[11px] text-gray-500 mb-3 bg-gray-50 rounded px-2 py-1">
                Only the tank owner can change alerts. Ask them to update these.
              </p>
            )}
            {isSingle ? (
              /* Single sensor — simple toggles */
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-700">Alert when Empty</span>
                  <button
                    disabled={!isEffectiveOwner}
                    onClick={async () => {
                      const newVal = alertLowPct === "" || alertLowPct === null ? 0 : null;
                      setAlertLowPct(newVal === null ? "" : "0");
                      // Canonical write — deviceCatalog. Fire-and-forget:
                      // any write error surfaces via console; UI already
                      // reflects intent optimistically.
                      await updateDoc(doc(db, "deviceCatalog", code), {
                        alertLowPct: newVal,
                      }).catch((e) => console.warn("alertLowPct save failed:", e));
                    }}
                    className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      alertLowPct !== "" && alertLowPct !== null
                        ? "bg-red-500 text-white"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {alertLowPct !== "" && alertLowPct !== null ? "ON" : "OFF"}
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-700">Alert when Present</span>
                  <button
                    disabled={!isEffectiveOwner}
                    onClick={async () => {
                      const newVal = alertHighPct === "" || alertHighPct === null ? 100 : null;
                      setAlertHighPct(newVal === null ? "" : "100");
                      await updateDoc(doc(db, "deviceCatalog", code), {
                        alertHighPct: newVal,
                      }).catch((e) => console.warn("alertHighPct save failed:", e));
                    }}
                    className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      alertHighPct !== "" && alertHighPct !== null
                        ? "bg-green-500 text-white"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {alertHighPct !== "" && alertHighPct !== null ? "ON" : "OFF"}
                  </button>
                </div>
                <p className="text-xs text-gray-400">Card flashes red when empty, green when water is present.</p>
              </div>
            ) : (
              /* Multiple sensors — percentage inputs */
              <>
                <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                  <span className="text-gray-500">Low Alert (≤)</span>
                  <div className="flex items-center gap-1">
                    <input type="number" min="0" max="100" value={alertLowPct}
                      disabled={!isEffectiveOwner}
                      onChange={(e) => { setAlertLowPct(e.target.value); setAlertError(""); }}
                      placeholder="Off"
                      className="w-16 px-2 py-0.5 border border-gray-200 rounded text-sm disabled:bg-gray-50 disabled:text-gray-500" />
                    <span className="text-gray-500 text-xs">%</span>
                  </div>
                  <span className="text-gray-500">High Alert (≥)</span>
                  <div className="flex items-center gap-1">
                    <input type="number" min="0" max="100" value={alertHighPct}
                      disabled={!isEffectiveOwner}
                      onChange={(e) => { setAlertHighPct(e.target.value); setAlertError(""); }}
                      placeholder="Off"
                      className="w-16 px-2 py-0.5 border border-gray-200 rounded text-sm disabled:bg-gray-50 disabled:text-gray-500" />
                    <span className="text-gray-500 text-xs">%</span>
                  </div>
                </div>
                {alertError && <p className="text-red-500 text-xs mb-2">{alertError}</p>}
                {isEffectiveOwner && (
                  <button onClick={async () => {
                    const low = alertLowPct === "" ? null : parseInt(alertLowPct);
                    const high = alertHighPct === "" ? null : parseInt(alertHighPct);
                    if (low != null && high != null && low >= high) {
                      setAlertError("Low must be less than High");
                      return;
                    }
                    // Canonical alert thresholds now live on
                    // deviceCatalog — one setting per physical tank,
                    // applies to every viewer's alert. See ownership
                    // model discussion.
                    await updateDoc(doc(db, "deviceCatalog", code), {
                      alertLowPct: low, alertHighPct: high,
                    }).catch((e) => {
                      console.warn("alerts save failed:", e);
                      setAlertError("Save failed — try again");
                    });
                    setAlertError("");
                  }} className="w-full bg-blue-50 text-blue-700 py-2 rounded-lg text-sm font-medium hover:bg-blue-100">
                    Save Alert Settings
                  </button>
                )}
                <p className="text-xs text-gray-400 mt-2">Card flashes red when low, green when high. Leave empty to disable.</p>
              </>
            )}
          </div>
        );
      })()}

      {/* Notifications — per-user, per-device alert rules.
          Gated on the device's notifyOn config flag, which the admin sets
          when granting premium. If OFF, show an enrollment CTA so the user
          knows the feature exists and how to get it. If ON, show the rules
          UI. Cloud Function on /notify_trigger only fires for premium
          devices, so zero infrastructure cost for free customers. */}
      {!valveConfig?.notifyOn ? (
        <div className="bg-gradient-to-br from-purple-50 to-blue-50 border border-purple-200 rounded-xl mt-4 p-4">
          <div className="flex items-start gap-3">
            <div className="text-2xl flex-shrink-0">🔔</div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-gray-900 text-sm mb-1">Want notifications for this device?</h3>
              <p className="text-xs text-gray-600 mb-2">
                Get alerted when the tank goes empty, fills up, or the sensor faults — even when the app is closed.
              </p>
              <p className="text-xs text-purple-700 font-medium">
                Premium subscription required. Contact your administrator to get enrolled.
              </p>
            </div>
          </div>
        </div>
      ) : (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Notifications</h3>
        <p className="text-xs text-gray-500 mb-3">
          Get a push notification when these conditions hit. All events are OFF by default — turn on what you want.
        </p>
        <div className="space-y-2">
          {NOTIF_EVENTS.map((ev) => {
            const rule = notifRules[ev.key] || {};
            const enabled = rule.enabled === true;
            const currentDelay = typeof rule.delaySec === "number" ? rule.delaySec : ev.defaultDelaySec;
            return (
              <div key={ev.key} className="flex items-center justify-between gap-2 border border-gray-100 rounded-lg p-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900">{ev.label}</div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <select
                    value={currentDelay}
                    disabled={!enabled || !!savingRule[ev.key]}
                    onChange={async (e) => {
                      const delaySec = parseInt(e.target.value);
                      const next = { ...notifRules, [ev.key]: { enabled: true, delaySec } };
                      setNotifRules(next);
                      setSavingRule((s) => ({ ...s, [ev.key]: true }));
                      await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), {
                        notificationRules: next,
                      });
                      setSavingRule((s) => ({ ...s, [ev.key]: false }));
                    }}
                    className="text-xs border rounded px-2 py-1 bg-white disabled:bg-gray-50 disabled:text-gray-400"
                  >
                    {ev.options.map((o) => (
                      <option key={o.sec} value={o.sec}>{o.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={async () => {
                      const next = {
                        ...notifRules,
                        [ev.key]: { enabled: !enabled, delaySec: currentDelay },
                      };
                      setNotifRules(next);
                      setSavingRule((s) => ({ ...s, [ev.key]: true }));
                      await updateDoc(doc(db, "subscriptions", user.uid, "devices", code), {
                        notificationRules: next,
                      });
                      setSavingRule((s) => ({ ...s, [ev.key]: false }));
                    }}
                    disabled={!!savingRule[ev.key]}
                    className={`text-xs px-3 py-1 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                      enabled
                        ? "bg-green-100 text-green-700 hover:bg-green-200"
                        : "bg-gray-200 text-gray-600 hover:bg-gray-300"
                    }`}
                  >
                    {savingRule[ev.key] ? "…" : enabled ? "ON" : "OFF"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-gray-400 mt-3">
          Repeated alerts wait 1 hour before firing again for the same condition.
        </p>
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

      {/* SenseFlow Standard controls — only for senseflowstandard devices */}
      {isSfs && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Tank Controller</h3>

          {/* Mode badge */}
          {live?.modeText && (
            <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 mb-3 text-sm">
              <span className="text-gray-500">Mode</span>
              <span className={`font-semibold ${
                live.mode === 0 ? "text-green-600" :
                live.mode === 3 ? "text-blue-600" :
                live.mode === 5 ? "text-red-600" :
                live.mode === 6 ? "text-orange-600" :
                "text-gray-700"
              }`}>{live.modeText}</span>
            </div>
          )}

          {/* Pump state */}
          <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 mb-3 text-sm">
            <span className="text-gray-500">Pump</span>
            <span className={`font-semibold ${live?.motorState ? "text-green-600" : "text-gray-600"}`}>
              {live?.motorState ? "ON" : "OFF"}
            </span>
          </div>

          {/* Water level detail */}
          {live?.levelPct != null && live.levelPct >= 0 && (
            <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 mb-3 text-sm">
              <span className="text-gray-500">Level</span>
              <span className="font-semibold text-gray-900">
                {live.levelPct.toFixed(0)}%
                {live.distanceCm > 0 && ` · ${live.distanceCm.toFixed(1)} cm`}
                {live.tankLitres > 0 && ` · ~${Math.round((live.levelPct / 100) * live.tankLitres)} L`}
              </span>
            </div>
          )}

          {/* Water presence sensor */}
          {live?.hasWP && (
            <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 mb-3 text-sm">
              <span className="text-gray-500">Water Presence</span>
              <span className={`font-semibold ${live.wpSensorStatus ? "text-blue-600" : "text-gray-500"}`}>
                {live.wpSensorStatus ? "YES" : "NO"}
              </span>
            </div>
          )}

          {/* Dry run */}
          {live?.dryRun && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              <span className="text-red-700 text-xs font-semibold">Dry Run Protection Active</span>
            </div>
          )}

          {/* Auto mode toggle */}
          <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 mb-3">
            <span className="text-sm text-gray-700">Auto Mode</span>
            <button
              onClick={async () => {
                const newVal = !live?.autoMode;
                if (!confirm((newVal ? "Enable" : "Disable") + " auto mode? Change applies within 60 seconds.")) return;
                await sfsSetAutoMode(code, newVal);
              }}
              disabled={!isOnline}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                live?.autoMode ? "bg-green-500 text-white hover:bg-green-600" : "bg-gray-200 text-gray-600 hover:bg-gray-300"
              } disabled:opacity-40`}
            >
              {live?.autoMode ? "ON" : "OFF"}
            </button>
          </div>

          {/* Schedule status */}
          <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 mb-3 text-sm">
            <span className="text-gray-500">Schedule Mode</span>
            <span className={`font-semibold ${live?.scheduleMode ? "text-blue-600" : "text-gray-500"}`}>
              {live?.scheduleMode ? "ON" : "OFF"}
            </span>
          </div>

          {/* Thresholds display */}
          {(live?.startPct != null || live?.stopPct != null) && (
            <div className="bg-blue-50 rounded-lg p-3 mb-3 text-sm">
              <p className="text-xs text-blue-600 font-semibold mb-1">Auto Thresholds</p>
              <div className="text-gray-700">Start: {live.startPct}% · Stop: {live.stopPct}%</div>
            </div>
          )}

          {/* Force pump run */}
          <div className="bg-gray-50 rounded-lg p-3 mb-3">
            <p className="text-xs text-gray-600 font-semibold mb-2">Manual Pump Run</p>
            <div className="flex items-center gap-2">
              <select value={sfsPumpMinutes} onChange={(e) => setSfsPumpMinutes(parseInt(e.target.value))}
                className="px-2 py-1.5 border border-gray-200 rounded text-sm">
                <option value={5}>5 min</option>
                <option value={10}>10 min</option>
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={60}>60 min</option>
              </select>
              <button
                onClick={async () => {
                  if (!confirm(`Force pump run for ${sfsPumpMinutes} minutes? Applies within 60 seconds.`)) return;
                  await sfsForcePumpRun(code, sfsPumpMinutes);
                }}
                disabled={!isOnline}
                className="flex-1 bg-blue-600 text-white py-1.5 rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-40"
              >
                Force Run
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">Device polls commands every 60 seconds.</p>
          </div>

          {/* Cloud logs (last 30) */}
          {sfsLogs.length > 0 && (
            <div className="mt-4">
              <p className="text-xs text-gray-600 font-semibold mb-2">Recent Events ({sfsLogs.length})</p>
              <div className="bg-gray-50 rounded-lg p-2 max-h-60 overflow-y-auto space-y-1">
                {sfsLogs.slice(0, 30).map((log) => (
                  <div key={log.slot} className="text-xs px-2 py-1 border-b border-gray-100 last:border-0">
                    <div className="flex justify-between">
                      <span className="font-mono text-gray-700">{log.action}</span>
                      <span className="text-gray-400">{log.timestamp ? new Date(log.timestamp * 1000).toLocaleString() : "—"}</span>
                    </div>
                    {log.details && <div className="text-gray-500 mt-0.5">{log.details}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Owner controls — visible to the individual owner, orgAdmin
          (org account effective owner), and superadmin. */}
      {isEffectiveOwner && (
        <div className="bg-white rounded-xl shadow-sm border border-blue-200 mt-4 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-900">
              {isOwner ? "Owner Controls" : isOrgAdmin ? "Admin Controls" : "Admin Controls"}
            </h3>
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
              {isOwner ? "Owner" : isOrgAdmin ? "Org Admin" : "Admin"}
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
      {/* Analytics — only shown when analyticsOn is true */}
      {valveConfig?.analyticsOn && (
        <div id="analytics" className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 scroll-mt-20">
          <div className="flex items-center justify-between mb-3 gap-2">
            <h3 className="font-semibold text-gray-900">Analytics</h3>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const { getHistoryByRange } = await import("../firebase/rtdb");
                  const endTs = Date.now();
                  const startTs = endTs - 30 * 86400000;
                  const history = await getHistoryByRange(code, startTs, endTs, true);
                  const csv = generateCSV(history, tankCapacityLitres, startTs, endTs);
                  const safeName = (deviceName || catalog?.deviceName || code).replace(/[^a-zA-Z0-9_-]+/g, "_");
                  downloadCSV(`${safeName}_${code}_30d_history.csv`, csv);
                }}
                className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-lg hover:bg-blue-100"
              >
                Download CSV (30d)
              </button>
              {isEffectiveOwner && (
                <button
                  onClick={async () => {
                    if (!window.confirm("Clear all recorded history for this device? This cannot be undone.")) return;
                    const { clearDeviceHistory } = await import("../firebase/rtdb");
                    try {
                      await clearDeviceHistory(code);
                      setChartKey((k) => k + 1);
                      alert("History cleared.");
                    } catch (e) {
                      alert("Failed to clear history: " + (e?.message || e));
                    }
                  }}
                  className="text-xs bg-red-50 text-red-600 px-3 py-1 rounded-lg hover:bg-red-100"
                >
                  Clear History
                </button>
              )}
            </div>
          </div>
          <AnalyticsChart
            key={chartKey}
            deviceCode={code}
            tankCapacityLitres={tankCapacityLitres}
            sensorType={info?.sensorType ?? catalog.sensorType ?? 1}
            sensorCount={info?.sensorCount ?? catalog.sensorCount ?? 4}
          />
        </div>
      )}

      {/* Diagnostics — admin-only, only visible when diagnosticsOn=true on device */}
      {isSuperAdmin && valveConfig?.diagnosticsOn && (
        <DiagnosticsCard code={code} />
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
          {/* Quick-jump to the tanker log with THIS tank pre-selected.
              Watchman filling up? One click from here → modal opens
              with correct tank + time defaulted to now. */}
          <button onClick={() => navigate(`/tankers?new=1&tank=${code}`)}
            className="px-4 py-2 bg-cyan-50 text-cyan-700 rounded-lg text-sm hover:bg-cyan-100">Log Tanker</button>
          {/* Removal button — path differs by account type:
              • Individual account → Unsubscribe (may transfer ownership)
              • Org account, orgAdmin → Remove from Organisation (deletes
                from orgDevices + detaches from all wings; catalog kept)
              • Org account, member → button hidden (view-only) */}
          {!isOrg && (
            <button onClick={handleUnsubscribe}
              className="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm hover:bg-red-100">Unsubscribe</button>
          )}
          {isOrg && isOrgAdmin && (
            <button onClick={handleRemoveFromOrg}
              className="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm hover:bg-red-100">Remove from Organisation</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Diagnostics Card ──────────────────────────────────────────────
// Admin-only restart history viewer. Reads /devices/<code>/diagnostics/boots
// (populated by firmware 17.0.9+ when diagnosticsOn=true) and renders a
// clean restart table with reason, timestamp, uptime, and firmware version.
// Refresh button asks firmware for a fresh /diagnostics/now snapshot.
// Clear wipes both NVS (via command) and the RTDB log.
function DiagnosticsCard({ code }) {
  const [boots, setBoots] = useState([]);
  const [now, setNow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAll, setShowAll] = useState(false);

  async function reload() {
    setLoading(true);
    const [bootList, snapshot] = await Promise.all([
      getDeviceBootLog(code),
      getDeviceDiagnosticsNow(code),
    ]);
    setBoots(bootList);
    setNow(snapshot);
    setLoading(false);
  }

  useEffect(() => { reload(); }, [code]);

  async function handleRefreshSnapshot() {
    setRefreshing(true);
    await requestDiagnosticsRefresh(code);
    // Wait ~6s for firmware to pick up the command + push the snapshot.
    // Firmware polls commands every 5 sec.
    setTimeout(async () => {
      const fresh = await getDeviceDiagnosticsNow(code);
      setNow(fresh);
      setRefreshing(false);
    }, 6000);
  }

  async function handleClear() {
    if (!confirm("Clear ALL boot log entries for this device? This wipes both cloud and the on-device NVS log.")) return;
    await requestDiagnosticsClear(code);
    setBoots([]);
  }

  // Format unix epoch → "25 Jun, 14:32"
  function fmtTs(epoch) {
    if (!epoch) return "—";
    const d = new Date(epoch * 1000);
    return d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  // Format seconds → "6h 23m" / "18m" / "45s"
  function fmtDur(sec) {
    if (!sec || sec === 0) return "—";
    if (sec < 60)    return `${sec}s`;
    if (sec < 3600)  return `${Math.floor(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  // Reset reason → friendly label + colour for chip
  function reasonChip(reasonStr, reasonCode) {
    const map = {
      "power-on":     { bg: "bg-gray-100",   text: "text-gray-700",   label: "Power-on" },
      "external-pin": { bg: "bg-gray-100",   text: "text-gray-700",   label: "External" },
      "software":     { bg: "bg-blue-100",   text: "text-blue-700",   label: "Software" },
      "panic":        { bg: "bg-red-100",    text: "text-red-700",    label: "Panic" },
      "int-wdt":      { bg: "bg-orange-100", text: "text-orange-700", label: "Int WDT" },
      "task-wdt":     { bg: "bg-orange-100", text: "text-orange-700", label: "Task WDT" },
      "other-wdt":    { bg: "bg-orange-100", text: "text-orange-700", label: "WDT" },
      "deep-sleep":   { bg: "bg-purple-100", text: "text-purple-700", label: "Deep sleep" },
      "brownout":     { bg: "bg-red-100",    text: "text-red-700",    label: "Brownout" },
      "sdio":         { bg: "bg-gray-100",   text: "text-gray-700",   label: "SDIO" },
    };
    const cfg = map[reasonStr] || { bg: "bg-gray-100", text: "text-gray-700", label: `Reason ${reasonCode}` };
    return (
      <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>
        {cfg.label}
      </span>
    );
  }

  const visible = showAll ? boots : boots.slice(0, 10);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-900">Diagnostics <span className="text-xs font-normal text-gray-500">(admin only)</span></h3>
        <div className="flex gap-2">
          <button
            onClick={handleRefreshSnapshot}
            disabled={refreshing}
            className="text-xs px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh snapshot"}
          </button>
          <button
            onClick={handleClear}
            disabled={boots.length === 0}
            className="text-xs px-3 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 disabled:opacity-50"
          >
            Clear log
          </button>
        </div>
      </div>

      {/* Live snapshot */}
      {now ? (
        <div className="bg-gray-50 rounded-lg p-3 mb-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-gray-500">Uptime</div>
            <div className="font-semibold text-gray-900">{fmtDur(now.uptime)}</div>
          </div>
          <div>
            <div className="text-gray-500">Free heap</div>
            <div className="font-semibold text-gray-900">{Math.round((now.freeHeap || 0) / 1024)} KB</div>
          </div>
          <div>
            <div className="text-gray-500">RSSI</div>
            <div className="font-semibold text-gray-900">{now.rssi} dBm</div>
          </div>
          <div>
            <div className="text-gray-500">Push fails</div>
            <div className="font-semibold text-gray-900">{now.consecutivePushFails || 0}</div>
          </div>
        </div>
      ) : (
        <div className="bg-gray-50 rounded-lg p-3 mb-3 text-xs text-gray-500">
          No live snapshot yet. Click <strong>Refresh snapshot</strong> to ask the device.
        </div>
      )}

      {/* Boot log */}
      <div className="text-xs font-semibold text-gray-700 mb-2">Restart history</div>
      {loading ? (
        <div className="text-xs text-gray-500 py-4 text-center">Loading…</div>
      ) : boots.length === 0 ? (
        <div className="text-xs text-gray-500 py-4 text-center bg-gray-50 rounded-lg">
          No restart entries yet. Device will start logging on its next boot.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 font-medium">#</th>
                  <th className="py-2 font-medium">When</th>
                  <th className="py-2 font-medium">Reason</th>
                  <th className="py-2 font-medium">Ran before</th>
                  <th className="py-2 font-medium">Heap</th>
                  <th className="py-2 font-medium">FW</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((b) => (
                  <tr key={b.slot} className="border-b border-gray-100">
                    <td className="py-2 text-gray-500">{b.bootNumber || "—"}</td>
                    <td className="py-2 text-gray-700">{fmtTs(b.epoch)}</td>
                    <td className="py-2">{reasonChip(b.reasonStr, b.reason)}</td>
                    <td className="py-2 text-gray-700">{fmtDur(b.uptimeBefore)}</td>
                    <td className="py-2 text-gray-700">{Math.round((b.freeHeapAtBoot || 0) / 1024)} KB</td>
                    <td className="py-2 text-gray-500">{b.fwVersion || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {boots.length > 10 && (
            <div className="text-center mt-2">
              <button
                onClick={() => setShowAll(!showAll)}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                {showAll ? "Show less" : `Show all ${boots.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
