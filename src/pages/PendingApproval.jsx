import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { logout } from "../firebase/auth";

// Blocking screen shown while a self-joined user waits for orgAdmin
// approval. Route guard in App.jsx sends anyone with pendingOrgId (but
// no orgId) here regardless of what URL they typed — they can't reach
// the dashboard until admin approves. Only exits are: log out, or
// refresh to check status.
export default function PendingApproval() {
  const { userData, refreshUserData } = useAuth();
  const navigate = useNavigate();

  async function handleRefresh() {
    await refreshUserData();
    // AuthContext will re-render; if orgId is now set, the route guard
    // in App.jsx will redirect this page to /dashboard automatically.
  }

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white p-8 rounded-xl shadow-md w-full max-w-md text-center">
        <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Waiting for approval</h1>
        {userData?.pendingOrgName && (
          <p className="text-sm text-gray-600 mb-4">
            Your join request to <strong>{userData.pendingOrgName}</strong> has been sent.
          </p>
        )}
        <p className="text-xs text-gray-500 mb-6">
          The organisation admin needs to approve your access before you can see any tanks.
          You&apos;ll get in as soon as they approve.
        </p>

        <div className="space-y-2">
          <button
            onClick={handleRefresh}
            className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            Check status
          </button>
          <button
            onClick={handleLogout}
            className="w-full bg-gray-100 text-gray-700 py-2 rounded-lg text-sm font-medium hover:bg-gray-200"
          >
            Log out
          </button>
        </div>

        <p className="text-[10px] text-gray-400 mt-6">
          Signed in as {userData?.email || userData?.displayName || "—"}
        </p>
      </div>
    </div>
  );
}
