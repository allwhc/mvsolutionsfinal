import { useState, useEffect } from "react";
import { useAuth } from "../../context/AuthContext";
import { getOrgMembers, addOrgMember, removeOrgMember, updateUserDoc, createUserDoc } from "../../firebase/db";
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
  const [newRole, setNewRole] = useState("viewer");
  const [error, setError] = useState("");

  async function load() {
    if (!orgId) return;
    const m = await getOrgMembers(orgId);
    setMembers(m);
    setLoading(false);
  }

  useEffect(() => { load(); }, [orgId]);

  async function handleAdd(e) {
    e.preventDefault();
    setError("");
    try {
      const newUser = await registerWithEmail(newEmail, newPassword, newName);
      await updateUserDoc(newUser.uid, { role: "orgMember", orgId });
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
    await updateUserDoc(uid, { role: "individual", orgId: null });
    await load();
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Members</h1>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          + Add Member
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="bg-white rounded-xl border border-gray-200 p-4 mb-4 space-y-3">
          <input type="text" placeholder="Full Name" value={newName} onChange={(e) => setNewName(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
          <input type="email" placeholder="Email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
          <input type="password" placeholder="Password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
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
              <p className="font-semibold text-sm text-gray-900">{m.uid}</p>
              <p className="text-xs text-gray-500">Role: {m.role}</p>
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
