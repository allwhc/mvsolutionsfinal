import { useState, useEffect } from "react";
import { useAuth } from "../../context/AuthContext";
import {
  getOrgMembers, addOrgMember, removeOrgMember,
  approveOrgMember, rejectOrgMember, updateUserDoc,
} from "../../firebase/db";
import { registerWithEmail } from "../../firebase/auth";

export default function OrgMembers() {
  const { userData, user } = useAuth();
  const orgId = userData?.orgId;
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [newRole, setNewRole] = useState("viewer");
  const [error, setError] = useState("");

  async function load() {
    if (!orgId) { setLoading(false); return; }
    setLoadError("");
    try {
      // Membership records now carry displayName + email inline (added
      // at self-join or admin-create). No per-member /users/<uid> read
      // needed — the users rule blocks that for anyone but the owner
      // or superadmin, so calling getUserDoc(member.uid) here would
      // throw permission-denied and hang the page.
      const m = await getOrgMembers(orgId);
      setMembers(m);
    } catch (e) {
      console.error("Load members failed:", e);
      setLoadError("Couldn't load members. Try refreshing.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [orgId]);

  async function handleAdd(e) {
    e.preventDefault();
    setError("");
    try {
      const newUser = await registerWithEmail(newEmail, newPassword, newName);
      await updateUserDoc(newUser.uid, { role: "orgMember", orgId, orgName: userData?.orgName });
      // Admin-added members skip the approval queue — they're
      // immediately active. Denormalise displayName + email so the
      // list can render without cross-user reads.
      await addOrgMember(orgId, newUser.uid, {
        role: newRole,
        status: "active",
        addedBy: user.uid,
        displayName: newName,
        email: newEmail,
      });
      setShowAdd(false);
      setNewEmail(""); setNewName(""); setNewPassword("");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleApprove(uid, memberName) {
    if (!confirm(`Approve ${memberName || "this member"}? They will get access to all tanks in the org.`)) return;
    try {
      await approveOrgMember(orgId, uid, user.uid);
      await load();
    } catch (e) {
      console.error("Approve failed:", e);
      alert("Failed to approve — try again");
    }
  }

  async function handleReject(uid, memberName) {
    if (!confirm(`Reject ${memberName || "this member"}'s join request?`)) return;
    try {
      await rejectOrgMember(orgId, uid);
      await load();
    } catch (e) {
      console.error("Reject failed:", e);
      alert("Failed to reject — try again");
    }
  }

  async function handleRemove(uid, memberName) {
    const label = memberName || "this member";
    if (!confirm(`Remove ${label} from your organisation?\n\nThey will lose access to all tanks in the org.`)) return;
    try {
      await removeOrgMember(orgId, uid);
      await load();
    } catch (e) {
      console.error("Remove failed:", e);
      alert("Failed to remove — try again");
    }
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  if (!orgId) {
    return (
      <div className="max-w-lg mx-auto mt-10 bg-yellow-50 border border-yellow-200 rounded-xl p-6 text-center">
        <h3 className="font-semibold text-gray-900 mb-1">No organisation assigned</h3>
        <p className="text-sm text-gray-600">
          Your account has an organisation role but isn't linked to any organisation yet.
          Ask a SenseFlow superadmin to assign you to an organisation, or contact support.
        </p>
      </div>
    );
  }

  // Split members by status so pending self-joins get a distinct
  // "waiting for approval" section at the top. Grandfathered members
  // (records written before the status field existed) default to
  // "active" so they don't disappear from the list.
  const pending = members.filter((m) => m.status === "pending");
  const active  = members.filter((m) => (m.status || "active") === "active");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Members</h1>
        <button onClick={() => setShowAdd(!showAdd)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
          + Add Member
        </button>
      </div>

      {loadError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {showAdd && (
        <form onSubmit={handleAdd} className="bg-white rounded-xl border border-gray-200 p-4 mb-4 space-y-3">
          <input type="text" placeholder="Full Name" value={newName} onChange={(e) => setNewName(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
          <input type="email" placeholder="Email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
          <div className="relative">
            <input type={showPassword ? "text" : "password"} placeholder="Password" value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm pr-10" required />
            <button type="button" onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              {showPassword ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              )}
            </button>
          </div>
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button type="submit" className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm">Add</button>
        </form>
      )}

      {/* Pending approvals — shown at top when non-empty. Self-joiners
          land here waiting for admin approval. Rejecting deletes the
          request; approving upgrades them to active + grants dashboard
          access. */}
      {pending.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-yellow-800">
              Pending approval
            </h2>
            <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full font-semibold">
              {pending.length}
            </span>
          </div>
          <div className="space-y-2">
            {pending.map((m) => (
              <div key={m.uid} className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 flex items-center justify-between flex-wrap gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-gray-900 truncate">
                    {m.displayName || m.email || m.uid.substring(0, 12) + "…"}
                  </p>
                  <p className="text-xs text-gray-600 truncate">{m.email || "no email on record"}</p>
                  <span className="inline-block mt-1 text-[10px] bg-yellow-200 text-yellow-800 px-2 py-0.5 rounded-full font-semibold">
                    Waiting for approval
                  </span>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleApprove(m.uid, m.displayName || m.email)}
                    className="text-xs font-semibold bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(m.uid, m.displayName || m.email)}
                    className="text-xs font-semibold bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-300"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active members list */}
      <div className="space-y-3">
        {pending.length > 0 && active.length > 0 && (
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-1">
            Active members
          </h2>
        )}
        {active.length === 0 && pending.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-10">No members</p>
        ) : active.map((m) => (
          <div key={m.uid} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between">
            <div>
              <p className="font-semibold text-sm text-gray-900">{m.displayName || "Unknown"}</p>
              <p className="text-xs text-gray-500">{m.email || m.uid.substring(0, 16) + "..."}</p>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                m.role === "admin" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
              }`}>{m.role}</span>
            </div>
            {m.uid !== user.uid && (
              <button onClick={() => handleRemove(m.uid, m.displayName || m.email)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
