import { Link } from "react-router-dom";
import { useState, useEffect } from "react";
import { getAllDevices, getPendingDevices, getAllUsers, getAllOrgs } from "../../firebase/db";

export default function AdminDashboard() {
  const [stats, setStats] = useState({ devices: 0, pending: 0, users: 0, orgs: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [devices, pending, users, orgs] = await Promise.all([
        getAllDevices(), getPendingDevices(), getAllUsers(), getAllOrgs(),
      ]);
      setStats({
        devices: devices.length,
        pending: pending.length,
        users: users.length,
        orgs: orgs.length,
      });
      setLoading(false);
    }
    load();
  }, []);

  const cards = [
    { label: "Registered Devices", count: stats.devices, link: "/admin/devices", color: "bg-blue-50 text-blue-700" },
    { label: "Pending Devices", count: stats.pending, link: "/admin/devices", color: "bg-yellow-50 text-yellow-700" },
    { label: "Users", count: stats.users, link: "/admin/users", color: "bg-green-50 text-green-700" },
    { label: "Organisations", count: stats.orgs, link: "/admin/orgs", color: "bg-purple-50 text-purple-700" },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Admin Panel</h1>

      {loading ? (
        <div className="flex justify-center py-10">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {cards.map((c) => (
            <Link key={c.label} to={c.link}>
              <div className={`rounded-xl p-6 ${c.color}`}>
                <p className="text-3xl font-bold">{c.count}</p>
                <p className="text-sm mt-1">{c.label}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
