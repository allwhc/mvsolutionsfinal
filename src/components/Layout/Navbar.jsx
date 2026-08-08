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

  // Small line icons per nav item — scanability + slight professional
  // upgrade. Outline (not solid) so they don't compete visually with
  // the label text. Same 16px size everywhere for consistency.
  const NAV_ICONS = {
    "/dashboard":  (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>),
    "/subscribe":  (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>),
    "/tankers":    (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 17h8m-8 0a2 2 0 11-4 0m4 0a2 2 0 10-4 0m12 0a2 2 0 11-4 0m4 0a2 2 0 10-4 0m1-9V6a1 1 0 00-1-1H4a1 1 0 00-1 1v11a1 1 0 001 1h1m10-1a1 1 0 001-1v-5l-3-4H9" /></svg>),
    "/org":        (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>),
    "/admin":      (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>),
    "/profile":    (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>),
  };

  const navLink = (to, label) => (
    <Link
      to={to}
      className={`text-sm px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
        location.pathname.startsWith(to)
          ? "bg-blue-50 text-blue-700 font-medium"
          : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
      }`}
      onClick={() => setMenuOpen(false)}
    >
      {NAV_ICONS[to] || null}
      <span>{label}</span>
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
          <img src="/android-chrome-192x192.png" alt="" className="w-9 h-9" />
          <span className="text-xl font-bold" style={{ color: "#1a2e5a" }}>SenseFlow</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-1">
          {navLink("/dashboard", "Dashboard")}
          {/* "Add Device" removed from top nav — already exposed as a
              prominent blue button on the dashboard header, having
              it in both places was redundant. Route still works if
              anything deep-links to /subscribe. */}
          {navLink("/tankers", "Water Tankers")}
          {(isOrgAdmin || isOrgMember) && navLink("/org", "Organisation")}
          {isSuperAdmin && navLink("/admin", "Admin")}
          {navLink("/profile", userData?.displayName || "Profile")}
          <button
            onClick={handleLogout}
            className="text-sm text-red-500 hover:text-red-700 ml-2 px-3 py-1.5 flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span>Logout</span>
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
          {/* "Add Device" removed from top nav — already exposed as a
              prominent blue button on the dashboard header, having
              it in both places was redundant. Route still works if
              anything deep-links to /subscribe. */}
          {navLink("/tankers", "Water Tankers")}
          {(isOrgAdmin || isOrgMember) && navLink("/org", "Organisation")}
          {isSuperAdmin && navLink("/admin", "Admin")}
          {navLink("/profile", userData?.displayName || "Profile")}
          <button
            onClick={handleLogout}
            className="text-sm text-red-500 hover:text-red-700 text-left px-3 py-1.5 flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span>Logout</span>
          </button>
        </div>
      )}
    </nav>
  );
}
