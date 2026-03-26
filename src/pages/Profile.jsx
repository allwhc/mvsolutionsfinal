import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { updateUserDoc } from "../firebase/db";
import { updateProfile, updatePassword } from "firebase/auth";
import { auth } from "../firebase/config";

export default function Profile() {
  const { user, userData, refreshUserData } = useAuth();
  const [displayName, setDisplayName] = useState(userData?.displayName || "");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function handleUpdateName(e) {
    e.preventDefault();
    setMessage(""); setError("");
    try {
      await updateProfile(auth.currentUser, { displayName });
      await updateUserDoc(user.uid, { displayName });
      await refreshUserData();
      setMessage("Name updated");
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    if (newPassword !== confirmPassword) { setError("Passwords don't match"); return; }
    if (newPassword.length < 6) { setError("Password must be at least 6 characters"); return; }
    setMessage(""); setError("");
    try {
      await updatePassword(auth.currentUser, newPassword);
      setNewPassword(""); setConfirmPassword("");
      setMessage("Password changed");
    } catch (err) {
      setError(err.message);
    }
  }

  const ROLE_LABELS = {
    superadmin: "Super Admin",
    orgAdmin: "Org Admin",
    orgMember: "Org Member",
    individual: "Individual",
  };

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Profile</h1>

      {/* User info */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <span className="text-gray-500">Email</span>
          <span className="text-gray-900">{userData?.email}</span>
          <span className="text-gray-500">Role</span>
          <span className="text-gray-900">{ROLE_LABELS[userData?.role] || userData?.role}</span>
          {userData?.orgId && (
            <>
              <span className="text-gray-500">Organisation</span>
              <span className="text-gray-900">{userData.orgId}</span>
            </>
          )}
        </div>
      </div>

      {/* Update name */}
      <form onSubmit={handleUpdateName} className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
        <p className="text-sm font-medium text-gray-700 mb-3">Display Name</p>
        <div className="flex gap-2">
          <input
            type="text" value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm">Update</button>
        </div>
      </form>

      {/* Change password */}
      {user?.providerData?.[0]?.providerId === "password" && (
        <form onSubmit={handleChangePassword} className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-sm font-medium text-gray-700 mb-3">Change Password</p>
          <div className="space-y-3">
            <input
              type="password" placeholder="New Password" value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
            <input
              type="password" placeholder="Confirm New Password" value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
            <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm">Change Password</button>
          </div>
        </form>
      )}

      {message && <p className="text-green-600 text-sm mt-4">{message}</p>}
      {error && <p className="text-red-500 text-sm mt-4">{error}</p>}
    </div>
  );
}
