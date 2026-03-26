import { Navigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import DeactivatedScreen from "../DeactivatedScreen";

export default function ProtectedRoute({ children, roles }) {
  const { isAuthenticated, loading, role, isDeactivated, isSuperAdmin } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  // Deactivated users see the deactivation screen (superadmin never deactivated)
  if (isDeactivated && !isSuperAdmin) return <DeactivatedScreen />;

  if (roles && !roles.includes(role)) return <Navigate to="/dashboard" replace />;

  return children;
}
