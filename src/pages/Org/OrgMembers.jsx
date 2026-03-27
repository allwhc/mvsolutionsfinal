import { useState, useEffect } from "react";
import { useAuth } from "../../context/AuthContext";
import { getOrgMembers, addOrgMember, removeOrgMember, updateUserDoc, getUserDoc } from "../../firebase/db";
import { registerWithEmail } from "../../firebase/auth";

export default function OrgMembers() {
  const { userData, user } = useAuth();
  const orgId = userData?.orgId;
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [newRole, setNewRole] = useState("viewer");
  const [error, setError] = useState("");

  async function load() {
    if (!orgId) return;
    const m = await getOrgMembers(orgId);
    // Fetch user details for each member
    const enriched = await Promise.all(
      m.map(async (member) => {
        const userDoc = await getUserDoc(member.uid);
        return {
          ...member,
          displayName: userDoc?.displayName || null,
          email: userDoc?.email || null,
        };
      })
    );
    setMembers(enriched);
    setLoading(false);
  }

  useEffect(() => { load(); }, [orgId]);

  async function handleAdd(e) {
    e.preventDefault();
    setError("");
    try {
      const newUser = await registerWithEmail(newEmail, newPassword, newName);
      await updateUserDoc(newUser.uid, { role: "orgMember", orgId, orgName: userData?.orgName });
      await addOrgMember(orgId, newUser.uid, { role: newRole, addedBy: user.uid });
      setShowAdd(false);
      setNewEmail(""); setNewName(""); setNewPassword("");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRemove(uid) {
    if (!confirm("Remove this member?")) return;
    await removeOrgMember(orgId, uid);
    await updateUserDoc(uid, { role: "individual", orgId: null, orgName: null });
    await load();
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Members</h1>
        <button onClick={() => setShowAdd(!showAdd)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
          + Add Member
        </button>
      </div>

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

      <div className="space-y-3">
        {members.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-10">No members</p>
        ) : members.map((m) => (
          <div key={m.uid} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between">
            <div>
              <p className="font-semibold text-sm text-gray-900">{m.displayName || "Unknown"}</p>
              <p className="text-xs text-gray-500">{m.email || m.uid.substring(0, 16) + "..."}</p>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                m.role === "admin" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
              }`}>{m.role}</span>
            </div>
            {m.uid !== user.uid && (
              <button onClick={() => handleRemove(m.uid)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
