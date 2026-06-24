import { Link } from "react-router-dom";
import { useState, useEffect } from "react";
import { getAllDevices, getAllUsers, getAllOrgs, getAllPlans } from "../../firebase/db";
import { getPendingDevicesRTDB } from "../../firebase/rtdb";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase/config";
import { requestAndSaveFcmToken, currentPermission } from "../../firebase/messaging";
import { useAuth } from "../../context/AuthContext";

export default function AdminDashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ devices: 0, pending: 0, users: 0, orgs: 0, plans: 0 });
  const [loading, setLoading] = useState(true);
  const [testStatus, setTestStatus] = useState("");
  const [testBusy, setTestBusy] = useState(false);

  async function handleSendTestNotification() {
    setTestBusy(true);
    setTestStatus("");
    try {
      // Always re-register the token. Permission may be 'granted' from an
      // earlier session but the token never made it to Firestore (e.g. VAPID
      // wasn't loaded, service worker wasn't ready, browser cleared site
      // storage). Re-running is idempotent — same token = setDoc with merge.
      const r = await requestAndSaveFcmToken(user.uid);
      if (r.status !== "granted") {
        setTestStatus(`Cannot send: permission ${r.status}${r.error ? " — " + r.error : ""}`);
        setTestBusy(false);
        return;
      }
      const call = httpsCallable(functions, "sendTestNotification");
      const res = await call();
      setTestStatus(`Sent to ${res.data.sent}, failed ${res.data.failed}`);
    } catch (e) {
      setTestStatus(`Error: ${e.message}`);
    } finally {
      setTestBusy(false);
    }
  }

  useEffect(() => {
    async function load() {
      const [devices, pending, users, orgs, plans] = await Promise.all([
        getAllDevices(), getPendingDevicesRTDB(), getAllUsers(), getAllOrgs(), getAllPlans(),
      ]);
      // Filter pending: exclude devices already registered in catalog
      const registeredCodes = new Set(devices.map(d => d.deviceCode));
      const filteredPending = pending.filter(d => !registeredCodes.has(d.deviceCode));
      setStats({
        devices: devices.length,
        pending: filteredPending.length,
        users: users.length,
        orgs: orgs.length,
        plans: plans.length,
      });
      setLoading(false);
    }
    load();
  }, []);

  const cards = [
    { label: "Registered Devices", count: stats.devices, link: "/admin/devices?tab=registered", color: "bg-blue-50 text-blue-700" },
    { label: "Pending Devices", count: stats.pending, link: "/admin/devices?tab=pending", color: "bg-yellow-50 text-yellow-700" },
    { label: "Users", count: stats.users, link: "/admin/users", color: "bg-green-50 text-green-700" },
    { label: "Organisations", count: stats.orgs, link: "/admin/orgs", color: "bg-purple-50 text-purple-700" },
    { label: "Plans", count: stats.plans, link: "/admin/plans", color: "bg-indigo-50 text-indigo-700" },
    { label: "Firmware Updates", count: "OTA", link: "/admin/firmware", color: "bg-pink-50 text-pink-700" },
    { label: "Notifications", count: "🔔", link: "/admin/notifications", color: "bg-orange-50 text-orange-700" },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Admin Panel</h1>

      {loading ? (
        <div className="flex justify-center py-10">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {cards.map((c) => (
              <Link key={c.label} to={c.link}>
                <div className={`rounded-xl p-6 hover:shadow-md transition-shadow ${c.color}`}>
                  <p className="text-3xl font-bold">{c.count}</p>
                  <p className="text-sm mt-1">{c.label}</p>
                </div>
              </Link>
            ))}
          </div>

          {/* Phase 1 — test the FCM pipeline end-to-end before wiring real events */}
          <div className="mt-6 bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Notifications (Phase 1 test)</h2>
            <p className="text-xs text-gray-500 mb-3">
              Click to send a test notification to your registered browsers/devices. Requires permission granted.
            </p>
            <button
              onClick={handleSendTestNotification}
              disabled={testBusy}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50"
            >
              {testBusy ? "Sending…" : "Send Test Notification"}
            </button>
            {testStatus && <span className="ml-3 text-sm text-gray-700">{testStatus}</span>}
          </div>
        </>
      )}
    </div>
  );
}
