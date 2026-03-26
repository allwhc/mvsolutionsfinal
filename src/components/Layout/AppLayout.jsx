import { Outlet } from "react-router-dom";
import Navbar from "./Navbar";
import { useAuth } from "../../context/AuthContext";

export default function AppLayout() {
  const { expiryWarningDays, subscriptionEndDate } = useAuth();

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />

      {/* Subscription expiry warning */}
      {expiryWarningDays !== null && (
        <div className={`text-center py-2 text-sm font-medium ${
          expiryWarningDays <= 7 ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"
        }`}>
          Your subscription expires {expiryWarningDays <= 1 ? "tomorrow" : `in ${expiryWarningDays} days`} ({subscriptionEndDate}). Contact SenseFlow team to renew.
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
