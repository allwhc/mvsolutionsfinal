import { useState, useEffect } from "react";
import { httpsCallable } from "firebase/functions";
import { getAllUsers, updateUserDoc, getUserSubscriptions, getAllPlans, getAllOrgs, removeSubscriber, addOrgMember, createOrg, removeOrgMember } from "../../firebase/db";
import { functions } from "../../firebase/config";
import { useAuth } from "../../context/AuthContext";

const ROLES = ["individual", "orgAdmin", "orgMember", "superadmin"];

function getEffectiveStatus(u, orgsMap) {
  if (u.isActive === false) return { active: false, reason: "Manually deactivated" };
  if (u.orgId && orgsMap[u.orgId]?.isActive === false) return { active: false, reason: "Org deactivated" };
  // Individual subscription expired
  if (u.subscriptionEnd) {
    const daysLeft = Math.ceil((new Date(u.subscriptionEnd) - new Date()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 0) return { active: false, reason: "Subscription expired" };
  }
  // Org subscription expired
  if (u.orgId && orgsMap[u.orgId]?.subscriptionEnd) {
    const org = orgsMap[u.orgId];
    const daysLeft = Math.ceil((new Date(org.subscriptionEnd) - new Date()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 0) return { active: false, reason: "Org subscription expired" };
  }
  return { active: true, reason: null };
}

export default function AdminUsers() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [orgsMap, setOrgsMap] = useState({});
  const [deviceCounts, setDeviceCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);
  const [userSubs, setUserSubs] = useState([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  // Delete-confirm modal state. Requires the admin to type the target
  // user's email exactly, matching GitHub's destructive-action pattern.
  // Rare high-consequence action → cheap confirmation friction is fine.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Org-picker state for promoting a user to orgAdmin / orgMember. When
  // the admin selects one of those roles in the dropdown, we open this
  // modal to force a choice of WHICH org — otherwise the user ends up
  // with a role but no orgId (broken state that causes /org page to hang).
  const [rolePickTarget, setRolePickTarget] = useState(null);   // user being edited
  const [rolePickNewRole, setRolePickNewRole] = useState("");   // orgAdmin | orgMember
  const [rolePickOrgId, setRolePickOrgId] = useState("");       // existing orgId picked
  const [rolePickNewOrgName, setRolePickNewOrgName] = useState(""); // if creating fresh
  const [rolePickSaving, setRolePickSaving] = useState(false);
  const [rolePickError, setRolePickError] = useState("");

  async function load() {
    const [u, p, orgs] = await Promise.all([getAllUsers(), getAllPlans(), getAllOrgs()]);
    const oMap = {};
    orgs.forEach((o) => { oMap[o.orgId] = o; });
    setOrgsMap(oMap);
    setUsers(u);
    setPlans(p);

    // Load device counts for all users
    const counts = {};
    await Promise.all(u.map(async (user) => {
      try {
        const subs = await getUserSubscriptions(user.uid);
        counts[user.uid] = subs.length;
      } catch { counts[user.uid] = 0; }
    }));
    setDeviceCounts(counts);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleRoleChange(user, newRole) {
    // Promoting to an org role requires picking WHICH org — otherwise
    // the user ends up with role='orgAdmin' but orgId=null, which
    // breaks the /org page. Route through the picker modal instead of
    // saving a broken state.
    if ((newRole === "orgAdmin" || newRole === "orgMember") && !user.orgId) {
      setRolePickTarget(user);
      setRolePickNewRole(newRole);
      setRolePickOrgId("");
      setRolePickNewOrgName("");
      setRolePickError("");
      return;
    }
    // Downgrading FROM an org role back to individual/superadmin — clear
    // the org attachment so nav + rules behave consistently.
    if ((newRole === "individual" || newRole === "superadmin") && user.orgId) {
      const oldOrgId = user.orgId;
      await updateUserDoc(user.uid, { role: newRole, orgId: null, orgName: null });
      try { await removeOrgMember(oldOrgId, user.uid); } catch { /* no-op */ }
      await load();
      return;
    }
    // Same-family transitions (orgAdmin ↔ orgMember with existing orgId,
    // or individual ↔ superadmin) are just a role field update.
    await updateUserDoc(user.uid, { role: newRole });
    await load();
  }

  async function confirmRolePick() {
    if (!rolePickTarget) return;
    let orgId = rolePickOrgId;
    let orgName = "";

    // Two modes: attach to existing org OR create a new one.
    if (orgId === "__new__") {
      const name = rolePickNewOrgName.trim();
      if (!name) { setRolePickError("Enter a name for the new organisation."); return; }
      orgId = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
      if (!orgId) { setRolePickError("Organisation name must contain letters or numbers."); return; }
      if (orgsMap[orgId]) { setRolePickError("An organisation with that name already exists — pick it from the list instead."); return; }
      orgName = name;
    } else if (orgId) {
      orgName = orgsMap[orgId]?.name || orgId;
    } else {
      setRolePickError("Please pick an organisation.");
      return;
    }

    setRolePickSaving(true);
    setRolePickError("");
    try {
      // Create org first if new — must exist before addOrgMember reads its rules.
      if (rolePickOrgId === "__new__") {
        await createOrg(orgId, {
          name: orgName,
          address: "",
          contactEmail: rolePickTarget.email || "",
          contactPhone: "",
          createdBy: rolePickTarget.uid,
        });
      }
      // Update user first so isOrgAdmin(orgId) checks pass on subsequent writes.
      await updateUserDoc(rolePickTarget.uid, {
        role: rolePickNewRole,
        orgId,
        orgName,
      });
      // Add to org member list (harmless if already there).
      try {
        await addOrgMember(orgId, rolePickTarget.uid, {
          role: rolePickNewRole === "orgAdmin" ? "admin" : "member",
          addedBy: rolePickTarget.uid,
        });
      } catch { /* no-op if already a member */ }
      setRolePickTarget(null);
      await load();
    } catch (err) {
      setRolePickError(err.message || "Failed to save. Try again.");
    } finally {
      setRolePickSaving(false);
    }
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

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteConfirmText.trim().toLowerCase() !== (deleteTarget.email || "").toLowerCase()) {
      setDeleteError("Email doesn't match. Type exactly what's shown.");
      return;
    }
    setDeleting(true);
    setDeleteError("");
    try {
      const call = httpsCallable(functions, "adminDeleteUser");
      await call({ uid: deleteTarget.uid });
      setDeleteTarget(null);
      setDeleteConfirmText("");
      await load();
    } catch (err) {
      setDeleteError(err.message || "Delete failed. Try again.");
    } finally {
      setDeleting(false);
    }
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
          const status = getEffectiveStatus(u, orgsMap);
          const isActive = status.active;
          const devCount = deviceCounts[u.uid] || 0;
          return (
            <div key={u.uid} className={`bg-white rounded-xl border p-4 ${isActive ? "border-gray-200" : "border-red-200 bg-red-50"}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-sm text-gray-900">{u.displayName || "—"}</p>
                    {!isActive && <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">{status.reason}</span>}
                    {isActive && <span className="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full">Active</span>}
                  </div>
                  <p className="text-xs text-gray-500">{u.email}</p>
                  {u.orgId && <p className="text-xs text-blue-500">Org: {u.orgName || u.orgId}</p>}
                  <p className="text-xs text-gray-400 mt-1">
                    Devices: {devCount}
                    {u.subscriptionEnd ? ` · Expires: ${u.subscriptionEnd}` : ""}
                  </p>
                </div>

                <div className="flex flex-col items-end gap-2">
                  {/* Role */}
                  <select
                    value={u.role}
                    onChange={(e) => handleRoleChange(u, e.target.value)}
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
                    u.isActive !== false
                      ? "bg-red-50 text-red-600 hover:bg-red-100"
                      : "bg-green-50 text-green-600 hover:bg-green-100"
                  }`}
                >
                  {u.isActive !== false ? "Deactivate" : "Reactivate"}
                </button>
                <input
                  type="date"
                  value={u.subscriptionEnd || ""}
                  onChange={(e) => handleSetSubscriptionEnd(u.uid, e.target.value)}
                  className="px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none"
                  title="Subscription end date"
                />
                {/* Permanent delete — Cloud Function wipes Auth + Firestore
                    + subscriptions in one go. Guarded by type-name confirm
                    in the modal. Cannot delete self or another superadmin. */}
                {u.uid !== currentUser?.uid && u.role !== "superadmin" && (
                  <button
                    onClick={() => { setDeleteTarget(u); setDeleteConfirmText(""); setDeleteError(""); }}
                    className="px-3 py-1 rounded text-xs bg-red-600 text-white hover:bg-red-700"
                    title="Permanently delete this user and all their data"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Org-picker modal — required when promoting a user to an org role.
          Prevents the broken 'orgAdmin with orgId=null' state that leaves
          /org page spinning forever. */}
      {rolePickTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !rolePickSaving && setRolePickTarget(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-2">Assign to organisation</h3>
            <p className="text-sm text-gray-700 mb-4">
              Making <strong>{rolePickTarget.displayName || rolePickTarget.email}</strong>
              {" "}an <strong>{rolePickNewRole}</strong>. Pick which organisation.
            </p>

            <label className="block text-xs text-gray-500 mb-1">Organisation</label>
            <select
              value={rolePickOrgId}
              onChange={(e) => { setRolePickOrgId(e.target.value); setRolePickError(""); }}
              disabled={rolePickSaving}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm mb-3 bg-white"
            >
              <option value="">— Select an organisation —</option>
              {Object.values(orgsMap).map((o) => (
                <option key={o.orgId} value={o.orgId}>{o.name || o.orgId}</option>
              ))}
              <option value="__new__">+ Create new organisation…</option>
            </select>

            {rolePickOrgId === "__new__" && (
              <>
                <label className="block text-xs text-gray-500 mb-1">New organisation name</label>
                <input
                  type="text"
                  value={rolePickNewOrgName}
                  onChange={(e) => { setRolePickNewOrgName(e.target.value); setRolePickError(""); }}
                  placeholder="e.g. Kalpataru Group"
                  disabled={rolePickSaving}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm mb-2"
                />
              </>
            )}

            {rolePickError && <p className="text-red-500 text-xs mb-2">{rolePickError}</p>}

            <div className="flex gap-2 mt-2">
              <button
                onClick={() => setRolePickTarget(null)}
                disabled={rolePickSaving}
                className="flex-1 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmRolePick}
                disabled={rolePickSaving}
                className="flex-1 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {rolePickSaving ? "Saving..." : "Assign"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete-confirm modal — type-name pattern to prevent accidental clicks. */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg text-red-600 mb-2">Delete user permanently</h3>
            <p className="text-sm text-gray-700 mb-3">
              This will remove <strong>{deleteTarget.displayName || deleteTarget.email}</strong> from Firebase Auth,
              wipe their profile, org membership, device subscriptions, and FCM tokens. This action cannot be undone.
            </p>
            <p className="text-sm text-gray-700 mb-2">
              Type the user's email to confirm:
              <span className="block font-mono text-xs bg-gray-100 rounded px-2 py-1 mt-1">{deleteTarget.email}</span>
            </p>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => { setDeleteConfirmText(e.target.value); setDeleteError(""); }}
              placeholder="Type email exactly"
              disabled={deleting}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            {deleteError && <p className="text-red-500 text-xs mt-2">{deleteError}</p>}
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex-1 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

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
                  <div key={s.deviceCode} className="bg-gray-50 rounded-lg p-3 flex items-center justify-between">
                    <div>
                      <p className="font-mono text-xs font-semibold">{s.deviceCode}</p>
                      <p className="text-xs text-gray-500">{s.deviceName || "—"}</p>
                    </div>
                    <button onClick={async () => {
                      if (!confirm("Remove " + s.deviceCode + " from this user?")) return;
                      await removeSubscriber(s.deviceCode, selectedUser.uid);
                      setUserSubs(userSubs.filter(x => x.deviceCode !== s.deviceCode));
                    }} className="text-xs text-red-500 hover:text-red-700">Remove</button>
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
