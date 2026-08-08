import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { DebugModeProvider } from "./context/DebugModeContext";
import ProtectedRoute from "./components/Layout/ProtectedRoute";
import AppLayout from "./components/Layout/AppLayout";
import LoginForm from "./components/Auth/LoginForm";
import RegisterForm from "./components/Auth/RegisterForm";
import OrgRegisterForm from "./components/Auth/OrgRegisterForm";
import Dashboard from "./pages/Dashboard";
import DeviceDetail from "./pages/DeviceDetail";
import Kiosk from "./pages/Kiosk";
import Subscribe from "./pages/Subscribe";
import Tankers from "./pages/Tankers";
import Profile from "./pages/Profile";
import JoinOrg from "./pages/JoinOrg";
import PendingApproval from "./pages/PendingApproval";
import AdminDashboard from "./pages/Admin/AdminDashboard";
import AdminDevices from "./pages/Admin/AdminDevices";
import AdminFirmware from "./pages/Admin/AdminFirmware";
import AdminNotifications from "./pages/Admin/AdminNotifications";
import AdminUsers from "./pages/Admin/AdminUsers";
import AdminOrgs from "./pages/Admin/AdminOrgs";
import AdminPlans from "./pages/Admin/AdminPlans";
import OrgDashboard from "./pages/Org/OrgDashboard";
import OrgMembers from "./pages/Org/OrgMembers";
import OrgGroups from "./pages/Org/OrgGroups";
import OrgInvite from "./pages/Org/OrgInvite";
import NotificationListener from "./components/NotificationListener";

// Redirect superadmin to /admin, others to /dashboard
function HomeRedirect() {
  const { isSuperAdmin, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={isSuperAdmin ? "/admin" : "/dashboard"} replace />;
}

// Blocking guard for users with a pending self-join. If a user has
// pendingOrgId set but no active orgId, they must sit on
// /pending-approval and wait for orgAdmin to approve. This wraps every
// authenticated non-kiosk route (dashboard, device, admin, org, etc.)
// so a pending user can't sneak into any data view by typing a URL.
function PendingGate({ children }) {
  const { userData, loading } = useAuth();
  if (loading) return null;
  const isPending = !!userData?.pendingOrgId && !userData?.orgId;
  if (isPending) return <Navigate to="/pending-approval" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <DebugModeProvider>
        <NotificationListener />
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginForm />} />
          <Route path="/register" element={<RegisterForm />} />
          <Route path="/register/org" element={<OrgRegisterForm />} />
          <Route path="/join/:orgId" element={<JoinOrg />} />

          {/* Pending-approval page — reachable only when authenticated
              AND pendingOrgId is set. Sits outside AppLayout so the
              blocked user doesn't see the header/sidebar of an app
              they haven't been let into. */}
          <Route path="/pending-approval" element={<ProtectedRoute><PendingApproval /></ProtectedRoute>} />

          {/* Protected routes inside layout — wrapped in PendingGate
              so a self-joined user waiting for admin approval gets
              force-redirected to /pending-approval no matter what URL
              they type. */}
          <Route element={<ProtectedRoute><PendingGate><AppLayout /></PendingGate></ProtectedRoute>}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/device/:code" element={<DeviceDetail />} />
            <Route path="/subscribe" element={<Subscribe />} />
            <Route path="/tankers" element={<Tankers />} />
            <Route path="/profile" element={<Profile />} />

            {/* Admin routes */}
            <Route path="/admin" element={<ProtectedRoute roles={["superadmin"]}><AdminDashboard /></ProtectedRoute>} />
            <Route path="/admin/devices" element={<ProtectedRoute roles={["superadmin"]}><AdminDevices /></ProtectedRoute>} />
            <Route path="/admin/users" element={<ProtectedRoute roles={["superadmin"]}><AdminUsers /></ProtectedRoute>} />
            <Route path="/admin/orgs" element={<ProtectedRoute roles={["superadmin"]}><AdminOrgs /></ProtectedRoute>} />
            <Route path="/admin/plans" element={<ProtectedRoute roles={["superadmin"]}><AdminPlans /></ProtectedRoute>} />
            <Route path="/admin/firmware" element={<ProtectedRoute roles={["superadmin"]}><AdminFirmware /></ProtectedRoute>} />
            <Route path="/admin/notifications" element={<ProtectedRoute roles={["superadmin"]}><AdminNotifications /></ProtectedRoute>} />

            {/* Org routes */}
            <Route path="/org" element={<ProtectedRoute roles={["orgAdmin"]}><OrgDashboard /></ProtectedRoute>} />
            <Route path="/org/members" element={<ProtectedRoute roles={["orgAdmin"]}><OrgMembers /></ProtectedRoute>} />
            <Route path="/org/groups" element={<ProtectedRoute roles={["orgAdmin"]}><OrgGroups /></ProtectedRoute>} />
            <Route path="/org/invite" element={<ProtectedRoute roles={["orgAdmin"]}><OrgInvite /></ProtectedRoute>} />
          </Route>

          {/* Kiosk mode — full-screen wall display, no AppLayout so
              the app's sidebar/header don't take up screen real estate.
              Still gated by PendingGate so a waiting user can't see
              other people's tanks via the kiosk URL either. */}
          <Route path="/kiosk" element={<ProtectedRoute><PendingGate><Kiosk /></PendingGate></ProtectedRoute>} />

          {/* Redirect root — superadmin goes to /admin, others to /dashboard */}
          <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </DebugModeProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
