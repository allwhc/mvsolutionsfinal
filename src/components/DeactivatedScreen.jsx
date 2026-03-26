import { useAuth } from "../context/AuthContext";
import { logout } from "../firebase/auth";

export default function DeactivatedScreen() {
  const { userData } = useAuth();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm text-center">
        <div className="flex items-center justify-center gap-2 mb-4">
          <img src="/favicon-32x32.png" alt="" className="w-8 h-8" />
          <h1 className="text-2xl font-bold" style={{ color: "#1a2e5a" }}>SenseFlow</h1>
        </div>

        <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>

        <h2 className="text-lg font-semibold text-gray-900 mb-2">Account Deactivated</h2>
        <p className="text-sm text-gray-500 mb-6">
          Kindly contact the SenseFlow team to reactivate your account.
        </p>

        <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left">
          <p className="text-xs text-gray-500 mb-2 font-medium">Contact Us</p>
          <p className="text-sm text-gray-700">support@senseflow.in</p>
          <p className="text-sm text-gray-700">+91 98765 43210</p>
        </div>

        <button
          onClick={async () => { await logout(); window.location.reload(); }}
          className="w-full bg-gray-200 text-gray-700 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-300"
        >
          Logout
        </button>
      </div>
    </div>
  );
}
