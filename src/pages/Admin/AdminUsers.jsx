import { useState, useEffect } from "react";
import { getAllUsers, updateUserDoc, getUserSubscriptions, getAllPlans } from "../../firebase/db";

const ROLES = ["individual", "orgAdmin", "orgMember", "superadmin"];

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);
  const [userSubs, setUserSubs] = useState([]);
  const [loadingSubs, setLoadingSubs] = useState(false);

  async function load() {
    const [u, p] = await Promise.all([getAllUsers(), getAllPlans()]);
    setUsers(u);
    setPlans(p);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleRoleChange(uid, newRole) {
    await updateUserDoc(uid, { role: newRole });
    await load();
  }

  async function handleToggleActive(uid, currentActive) {
    const isActive = currentActive !== false; // default true if field doesn't exist
    await updateUserDoc(uid, {
      isActive: !isActive,
      ...(isActive ? { deactivatedAt: new Date() } : { deactivatedAt: null }),
    });
    await load();
  }

  async function handlePlanChange(uid, planId) {
    await updateUserDoc(uid, { planId });
    await load();
  }

  async function handleSetSubscriptionEnd(uid, date) {
    await updateUserDoc(uid, {
      subscriptionEnd: date || null,
      autoDeactivate: !!date,
    });
    await load();
  }

  async function viewSubscriptions(user) {
    setSelectedUser(user);
    setLoadingSubs(true);
    const subs = await getUserSubscriptions(user.uid);
    setUserSubs(subs);
    setLoadingSubs(false);
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Users ({users.length})</h1>

      <div className="space-y-3">
        {users.map((u) => {
          const isActive = u.isActive !== false;
          return (
            <div key={u.uid} className={`bg-white rounded-xl border p-4 ${isActive ? "border-gray-200" : "border-red-200 bg-red-50"}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-sm text-gray-900">{u.displayName || "—"}</p>
                    {!isActive && <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Deactivated</span>}
                  </div>
                  <p className="text-xs text-gray-500">{u.email}</p>
                  {u.orgId && <p className="text-xs text-blue-500">Org: {u.orgName || u.orgId}</p>}
                  {u.subscriptionEnd && (
                    <p className="text-xs text-gray-400 mt-1">Expires: {u.subscriptionEnd}</p>
                  )}
                </div>

                <div className="flex flex-col items-end gap-2">
                  {/* Role */}
                  <select
                    value={u.role}
                    onChange={(e) => handleRoleChange(u.uid, e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none"
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>

                  {/* Plan */}
                  <select
                    value={u.planId || "basic"}
                    onChange={(e) => handlePlanChange(u.uid, e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none"
                  >
                    <option value="basic">Basic</option>
                    {plans.map((p) => <option key={p.planId} value={p.planId}>{p.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100">
                <button
                  onClick={() => viewSubscriptions(u)}
                  className="px-3 py-1 bg-blue-50 text-blue-600 rounded text-xs hover:bg-blue-100"
                >
                  View Devices
                </button>
                <button
                  onClick={() => handleToggleActive(u.uid, u.isActive)}
                  className={`px-3 py-1 rounded text-xs ${
                    isActive
                      ? "bg-red-50 text-red-600 hover:bg-red-100"
                      : "bg-green-50 text-green-600 hover:bg-green-100"
                  }`}
                >
                  {isActive ? "Deactivate" : "Reactivate"}
                </button>
                <input
                  type="date"
                  value={u.subscriptionEnd || ""}
                  onChange={(e) => handleSetSubscriptionEnd(u.uid, e.target.value)}
                  className="px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none"
                  title="Subscription end date"
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* User subscriptions modal */}
      {selectedUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setSelectedUser(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[70vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-1">{selectedUser.displayName || selectedUser.email}</h3>
            <p className="text-xs text-gray-500 mb-4">Subscribed Devices</p>

            {loadingSubs ? (
              <div className="flex justify-center py-4"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div></div>
            ) : userSubs.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-4">No subscriptions</p>
            ) : (
              <div className="space-y-2">
                {userSubs.map((s) => (
                  <div key={s.deviceCode} className="bg-gray-50 rounded-lg p-3">
                    <p className="font-mono text-xs font-semibold">{s.deviceCode}</p>
                    <p className="text-xs text-gray-500">{s.deviceName || "—"}</p>
                  </div>
                ))}
              </div>
            )}

            <button onClick={() => setSelectedUser(null)} className="w-full mt-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
