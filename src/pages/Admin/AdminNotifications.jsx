import { useEffect, useMemo, useState } from "react";
import {
  collection, getDocs, deleteDoc, updateDoc, doc, writeBatch,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getAllUsers } from "../../firebase/db";
import { db, functions } from "../../firebase/config";
import { useAuth } from "../../context/AuthContext";

// Best-effort parse of a UA string into something readable.
function parseUserAgent(ua = "") {
  let device = "Unknown";
  if (/Android/i.test(ua)) device = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) device = "iOS";
  else if (/Windows/i.test(ua)) device = "Windows";
  else if (/Mac OS X/i.test(ua) || /Macintosh/i.test(ua)) device = "Mac";
  else if (/Linux/i.test(ua)) device = "Linux";

  let browser = "Unknown";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  return `${browser} on ${device}`;
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${String(d.getDate()).padStart(2, "0")}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

export default function AdminNotifications() {
  const { user: authUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [tokenCounts, setTokenCounts] = useState({});   // uid -> number
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [filterEnabled, setFilterEnabled] = useState("all");   // all | on | off
  const [savingFlag, setSavingFlag] = useState({});            // uid -> bool
  const [devicesFor, setDevicesFor] = useState(null);          // uid being inspected
  const [devices, setDevices] = useState([]);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState({});            // tokenId -> bool
  const [testBusy, setTestBusy] = useState({});                // uid -> bool
  const [statusMsg, setStatusMsg] = useState("");

  async function loadAll() {
    setRefreshing(true);
    setStatusMsg("");
    const list = await getAllUsers();
    setUsers(list);

    // Token counts — read fcmTokens subcollection per user in parallel.
    const counts = {};
    await Promise.all(
      list.map(async (u) => {
        try {
          const snap = await getDocs(collection(db, "users", u.uid, "fcmTokens"));
          counts[u.uid] = snap.size;
        } catch (_) {
          counts[u.uid] = 0;
        }
      })
    );
    setTokenCounts(counts);
    setLoading(false);
    setRefreshing(false);
  }

  useEffect(() => { loadAll(); }, []);

  const filtered = useMemo(() => {
    const t = search.trim().toLowerCase();
    return users.filter((u) => {
      const enabled = u.notificationsEnabled !== false;   // missing = true
      if (filterEnabled === "on" && !enabled) return false;
      if (filterEnabled === "off" && enabled) return false;
      if (!t) return true;
      const blob = `${u.displayName || ""} ${u.email || ""} ${u.role || ""} ${u.orgName || ""}`.toLowerCase();
      return blob.includes(t);
    });
  }, [users, search, filterEnabled]);

  async function toggleEnabled(u) {
    const next = u.notificationsEnabled === false;   // flip
    setSavingFlag((s) => ({ ...s, [u.uid]: true }));
    try {
      await updateDoc(doc(db, "users", u.uid), { notificationsEnabled: next });
      setUsers((arr) => arr.map((x) => x.uid === u.uid ? { ...x, notificationsEnabled: next } : x));
    } catch (e) {
      setStatusMsg(`Failed to update ${u.email}: ${e.message}`);
    } finally {
      setSavingFlag((s) => ({ ...s, [u.uid]: false }));
    }
  }

  async function openDevices(u) {
    setDevicesFor(u.uid);
    setDevicesBusy(true);
    try {
      const snap = await getDocs(collection(db, "users", u.uid, "fcmTokens"));
      const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      arr.sort((a, b) => {
        const ta = a.addedAt?.toMillis?.() || 0;
        const tb = b.addedAt?.toMillis?.() || 0;
        return tb - ta;
      });
      setDevices(arr);
    } catch (e) {
      setStatusMsg(`Failed to load devices: ${e.message}`);
      setDevicesFor(null);
    } finally {
      setDevicesBusy(false);
    }
  }

  function closeDevices() {
    setDevicesFor(null);
    setDevices([]);
  }

  async function revokeDevice(uid, tokenId) {
    if (!window.confirm("Revoke this device's notifications? It will stop receiving alerts immediately.")) return;
    setRevokeBusy((s) => ({ ...s, [tokenId]: true }));
    try {
      await deleteDoc(doc(db, "users", uid, "fcmTokens", tokenId));
      setDevices((arr) => arr.filter((d) => d.id !== tokenId));
      setTokenCounts((c) => ({ ...c, [uid]: Math.max(0, (c[uid] || 1) - 1) }));
    } catch (e) {
      setStatusMsg(`Revoke failed: ${e.message}`);
    } finally {
      setRevokeBusy((s) => ({ ...s, [tokenId]: false }));
    }
  }

  async function revokeAllForUser(uid) {
    if (!window.confirm(`Revoke ALL devices for this user? They'll stop receiving notifications until they enable on a device again.`)) return;
    try {
      const snap = await getDocs(collection(db, "users", uid, "fcmTokens"));
      const batch = writeBatch(db);
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      setDevices([]);
      setTokenCounts((c) => ({ ...c, [uid]: 0 }));
    } catch (e) {
      setStatusMsg(`Revoke-all failed: ${e.message}`);
    }
  }

  async function sendTestToUser(u) {
    setTestBusy((s) => ({ ...s, [u.uid]: true }));
    setStatusMsg("");
    try {
      const call = httpsCallable(functions, "adminSendTestToUser");
      const res = await call({ uid: u.uid });
      setStatusMsg(`Test to ${u.email}: sent ${res.data.sent}, failed ${res.data.failed}`);
    } catch (e) {
      setStatusMsg(`Test send failed: ${e.message}`);
    } finally {
      setTestBusy((s) => ({ ...s, [u.uid]: false }));
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Notifications</h1>
        <button
          onClick={loadAll}
          disabled={refreshing}
          className="bg-gray-100 hover:bg-gray-200 text-sm px-3 py-1.5 rounded-lg font-medium disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <label className="flex flex-col md:col-span-2">
            <span className="text-xs text-gray-500 mb-1">Search (name / email / role / org)</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="vishal@example.com"
              className="border rounded px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-gray-500 mb-1">Notifications</span>
            <select
              value={filterEnabled}
              onChange={(e) => setFilterEnabled(e.target.value)}
              className="border rounded px-2 py-1.5"
            >
              <option value="all">All users</option>
              <option value="on">Enabled only</option>
              <option value="off">Disabled only</option>
            </select>
          </label>
        </div>
      </div>

      {/* User list */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="p-4 border-b text-sm text-gray-600">
          <strong>{filtered.length}</strong> user{filtered.length !== 1 ? "s" : ""}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600">
              <tr>
                <th className="p-2 text-left">User</th>
                <th className="p-2 text-left">Role / Org</th>
                <th className="p-2 text-center">Devices</th>
                <th className="p-2 text-center">Notifications</th>
                <th className="p-2 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const enabled = u.notificationsEnabled !== false;
                const count = tokenCounts[u.uid] ?? 0;
                return (
                  <tr key={u.uid} className="border-b hover:bg-gray-50">
                    <td className="p-2">
                      <div className="font-medium">{u.displayName || "—"}</div>
                      <div className="text-xs text-gray-500">{u.email}</div>
                    </td>
                    <td className="p-2">
                      <div className="text-xs">{u.role || "—"}</div>
                      <div className="text-xs text-gray-500">{u.orgName || "—"}</div>
                    </td>
                    <td className="p-2 text-center">
                      <span className="inline-flex items-center gap-1">
                        <span className={`text-base font-bold ${count > 0 ? "text-blue-700" : "text-gray-400"}`}>{count}</span>
                        <button
                          onClick={() => openDevices(u)}
                          className="text-xs text-blue-600 hover:underline ml-1"
                        >
                          view
                        </button>
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <button
                        onClick={() => toggleEnabled(u)}
                        disabled={savingFlag[u.uid]}
                        className={`text-xs px-3 py-1 rounded-full font-semibold transition-colors ${
                          enabled
                            ? "bg-green-100 text-green-700 hover:bg-green-200"
                            : "bg-red-100 text-red-700 hover:bg-red-200"
                        } disabled:opacity-50`}
                      >
                        {savingFlag[u.uid] ? "…" : enabled ? "ON" : "OFF"}
                      </button>
                    </td>
                    <td className="p-2 text-center">
                      <button
                        onClick={() => sendTestToUser(u)}
                        disabled={testBusy[u.uid] || count === 0}
                        className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 px-2 py-1 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                        title={count === 0 ? "No devices registered" : "Send a test notification to this user"}
                      >
                        {testBusy[u.uid] ? "…" : "Send test"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-gray-400">No users match filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {statusMsg && (
        <div className="bg-blue-50 border border-blue-200 text-blue-800 text-sm rounded-lg px-3 py-2">
          {statusMsg}
        </div>
      )}

      {/* Devices modal */}
      {devicesFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-5 max-w-lg w-full mx-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">Registered devices</h3>
              <button onClick={closeDevices} className="text-gray-500 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <div className="text-xs text-gray-500 mb-3">{users.find((u) => u.uid === devicesFor)?.email}</div>
            {devicesBusy ? (
              <div className="flex justify-center py-6">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
              </div>
            ) : devices.length === 0 ? (
              <div className="text-center text-gray-400 py-6">No devices registered.</div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {devices.map((d) => (
                  <div key={d.id} className="border border-gray-200 rounded-lg p-3 flex items-start justify-between gap-2">
                    <div className="text-sm">
                      <div className="font-medium">{parseUserAgent(d.userAgent)}</div>
                      <div className="text-xs text-gray-500 font-mono">{d.id.slice(0, 16)}…</div>
                      <div className="text-xs text-gray-500">Added {fmtDate(d.addedAt)}</div>
                    </div>
                    <button
                      onClick={() => revokeDevice(devicesFor, d.id)}
                      disabled={revokeBusy[d.id]}
                      className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-2 py-1 rounded h-fit disabled:opacity-50"
                    >
                      {revokeBusy[d.id] ? "…" : "Revoke"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {devices.length > 0 && (
              <div className="mt-4 flex justify-between items-center pt-3 border-t">
                <button
                  onClick={() => revokeAllForUser(devicesFor)}
                  className="text-xs text-red-700 hover:underline"
                >
                  Revoke ALL devices for this user
                </button>
                <button onClick={closeDevices} className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg font-medium">
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
