import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { logout } from "../../firebase/auth";

export default function Navbar() {
  const { isAuthenticated, userData, isSuperAdmin, isOrgAdmin } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  if (!isAuthenticated) return null;

  return (
    <nav className="bg-white border-b border-gray-200 px-4 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <Link to="/dashboard" className="text-xl font-bold text-blue-600">
          SenseFlow
        </Link>

        <div className="flex items-center gap-4">
          <Link to="/dashboard" className="text-gray-600 hover:text-gray-900 text-sm">
            Dashboard
          </Link>
          <Link to="/subscribe" className="text-gray-600 hover:text-gray-900 text-sm">
            Subscribe
          </Link>

          {isOrgAdmin && (
            <Link to="/org" className="text-gray-600 hover:text-gray-900 text-sm">
              Org
            </Link>
          )}

          {isSuperAdmin && (
            <Link to="/admin" className="text-gray-600 hover:text-gray-900 text-sm">
              Admin
            </Link>
          )}

          <Link to="/profile" className="text-gray-600 hover:text-gray-900 text-sm">
            {userData?.displayName || "Profile"}
          </Link>

          <button
            onClick={handleLogout}
            className="text-sm text-red-500 hover:text-red-700"
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
  );
}
