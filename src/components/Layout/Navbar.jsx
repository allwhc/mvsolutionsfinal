import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { logout } from "../../firebase/auth";

export default function Navbar() {
  const { isAuthenticated, userData, isSuperAdmin, isOrgAdmin, isOrgMember } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  if (!isAuthenticated) return null;

  const isOrg = isOrgAdmin || isOrgMember;
  const orgName = userData?.orgName || userData?.orgId || "";

  const navLink = (to, label) => (
    <Link
      to={to}
      className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
        location.pathname.startsWith(to)
          ? "bg-blue-50 text-blue-700 font-medium"
          : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
      }`}
      onClick={() => setMenuOpen(false)}
    >
      {label}
    </Link>
  );

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-40">
      {/* Org banner */}
      {isOrg && orgName && (
        <div className="bg-blue-600 text-white text-center py-1.5 text-xs font-medium tracking-wide">
          {orgName}
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link to="/dashboard" className="flex items-center gap-2">
          <img src="/favicon-32x32.png" alt="" className="w-7 h-7" />
          <span className="text-xl font-bold" style={{ color: "#1a2e5a" }}>SenseFlow</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-1">
          {navLink("/dashboard", "Dashboard")}
          {navLink("/subscribe", "Add Device")}
          {(isOrgAdmin || isOrgMember) && navLink("/org", "Organisation")}
          {isSuperAdmin && navLink("/admin", "Admin")}
          {navLink("/profile", userData?.displayName || "Profile")}
          <button
            onClick={handleLogout}
            className="text-sm text-red-500 hover:text-red-700 ml-2 px-3 py-1.5"
          >
            Logout
          </button>
        </div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="md:hidden p-2 text-gray-600"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {menuOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-gray-100 px-4 py-3 flex flex-col gap-1 bg-white">
          {navLink("/dashboard", "Dashboard")}
          {navLink("/subscribe", "Add Device")}
          {(isOrgAdmin || isOrgMember) && navLink("/org", "Organisation")}
          {isSuperAdmin && navLink("/admin", "Admin")}
          {navLink("/profile", userData?.displayName || "Profile")}
          <button
            onClick={handleLogout}
            className="text-sm text-red-500 hover:text-red-700 text-left px-3 py-1.5"
          >
            Logout
          </button>
        </div>
      )}
    </nav>
  );
}
