import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";

export default function OrgDashboard() {
  const { userData } = useAuth();

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Organisation Panel</h1>
      <p className="text-gray-500 text-sm mb-6">Org: {userData?.orgId}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Link to="/org/members">
          <div className="bg-blue-50 text-blue-700 rounded-xl p-6">
            <p className="text-lg font-bold">Members</p>
            <p className="text-sm">Manage org members and roles</p>
          </div>
        </Link>
        <Link to="/org/groups">
          <div className="bg-purple-50 text-purple-700 rounded-xl p-6">
            <p className="text-lg font-bold">Groups</p>
            <p className="text-sm">Manage device groups</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
