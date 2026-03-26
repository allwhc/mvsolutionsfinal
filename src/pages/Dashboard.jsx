import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useDevices } from "../hooks/useDevices";
import { getOrgGroups } from "../firebase/db";
import DeviceCard from "../components/DeviceCard/DeviceCard";

export default function Dashboard() {
  const { userData, isOrgAdmin, isOrgMember } = useAuth();
  const { devices, loading } = useDevices();
  const [filter, setFilter] = useState("all"); // "all" | "personal" | "org" | groupId
  const [groups, setGroups] = useState([]);

  const isOrg = isOrgAdmin || isOrgMember;
  const orgId = userData?.orgId;

  // Load org groups for filtering
  useEffect(() => {
    if (isOrg && orgId) {
      getOrgGroups(orgId).then(setGroups);
    }
  }, [isOrg, orgId]);

  // Greeting based on time of day
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="text-center py-20">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          {greeting}, {userData?.displayName?.split(" ")[0] || "there"}
        </h2>
        {isOrg && (
          <p className="text-blue-600 font-medium mb-4">{userData?.orgName || orgId}</p>
        )}
        <p className="text-gray-500 mb-6">Subscribe to a device to start monitoring</p>
        <Link
          to="/subscribe"
          className="inline-block bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          Add Device
        </Link>
      </div>
    );
  }

  // Filter devices
  const filteredDevices = devices.filter((d) => {
    if (filter === "all") return true;
    if (filter === "personal") return !d.groupId;
    if (filter === "org") return !!d.groupId;
    // Filter by specific groupId
    const group = groups.find((g) => g.groupId === filter);
    if (group) return group.deviceCodes?.includes(d.deviceCode);
    return true;
  });

  // Count online/offline
  const isDeviceOnline = (d) => {
    const lastSeen = d.info?.lastSeen;
    const isStale = lastSeen ? (Date.now() / 1000 - lastSeen) > 900 : true;
    return d.info?.online && !isStale;
  };
  const onlineCount = filteredDevices.filter(isDeviceOnline).length;

  return (
    <div>
      {/* Welcome header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {greeting}, {userData?.displayName?.split(" ")[0] || "there"}
            </h1>
            {isOrg && (
              <p className="text-blue-600 font-medium text-sm mt-0.5">
                {userData?.orgName || orgId}
              </p>
            )}
            <p className="text-sm text-gray-500 mt-1">
              {onlineCount} online, {filteredDevices.length - onlineCount} offline — {filteredDevices.length} device{filteredDevices.length !== 1 ? "s" : ""}
            </p>
          </div>
          <Link
            to="/subscribe"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            + Add Device
          </Link>
        </div>
      </div>

      {/* Filter tabs */}
      {isOrg && (
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filter === "all" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            All ({devices.length})
          </button>
          <button
            onClick={() => setFilter("personal")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filter === "personal" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            My Devices
          </button>
          <button
            onClick={() => setFilter("org")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filter === "org" ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            Org Devices
          </button>
          {groups.map((g) => (
            <button
              key={g.groupId}
              onClick={() => setFilter(g.groupId)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === g.groupId ? "bg-indigo-100 text-indigo-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {/* Device grid */}
      {filteredDevices.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-10">No devices in this filter</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredDevices.map((d) => (
            <Link key={d.deviceCode} to={`/device/${d.deviceCode}`}>
              <DeviceCard
                deviceCode={d.deviceCode}
                deviceName={d.deviceName}
                live={d.live}
                info={d.info}
                catalog={d.catalog}
                isOnline={isDeviceOnline(d)}
              />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
