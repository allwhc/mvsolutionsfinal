import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import ProtectedRoute from "./components/Layout/ProtectedRoute";
import AppLayout from "./components/Layout/AppLayout";
import LoginForm from "./components/Auth/LoginForm";
import RegisterForm from "./components/Auth/RegisterForm";
import OrgRegisterForm from "./components/Auth/OrgRegisterForm";
import Dashboard from "./pages/Dashboard";
import DeviceDetail from "./pages/DeviceDetail";
import Subscribe from "./pages/Subscribe";
import Profile from "./pages/Profile";
import AdminDashboard from "./pages/Admin/AdminDashboard";
import AdminDevices from "./pages/Admin/AdminDevices";
import AdminUsers from "./pages/Admin/AdminUsers";
import AdminOrgs from "./pages/Admin/AdminOrgs";
import OrgDashboard from "./pages/Org/OrgDashboard";
import OrgMembers from "./pages/Org/OrgMembers";
import OrgGroups from "./pages/Org/OrgGroups";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginForm />} />
          <Route path="/register" element={<RegisterForm />} />
          <Route path="/register/org" element={<OrgRegisterForm />} />

          {/* Protected routes inside layout */}
          <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/device/:code" element={<DeviceDetail />} />
            <Route path="/subscribe" element={<Subscribe />} />
            <Route path="/profile" element={<Profile />} />

            {/* Admin routes */}
            <Route path="/admin" element={<ProtectedRoute roles={["superadmin"]}><AdminDashboard /></ProtectedRoute>} />
            <Route path="/admin/devices" element={<ProtectedRoute roles={["superadmin"]}><AdminDevices /></ProtectedRoute>} />
            <Route path="/admin/users" element={<ProtectedRoute roles={["superadmin"]}><AdminUsers /></ProtectedRoute>} />
            <Route path="/admin/orgs" element={<ProtectedRoute roles={["superadmin"]}><AdminOrgs /></ProtectedRoute>} />

            {/* Org routes */}
            <Route path="/org" element={<ProtectedRoute roles={["orgAdmin"]}><OrgDashboard /></ProtectedRoute>} />
            <Route path="/org/members" element={<ProtectedRoute roles={["orgAdmin"]}><OrgMembers /></ProtectedRoute>} />
            <Route path="/org/groups" element={<ProtectedRoute roles={["orgAdmin"]}><OrgGroups /></ProtectedRoute>} />
          </Route>

          {/* Redirect root */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
