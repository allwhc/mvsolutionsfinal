import { Link } from "react-router-dom";
import { useDevices } from "../hooks/useDevices";
import DeviceCard from "../components/DeviceCard/DeviceCard";

export default function Dashboard() {
  const { devices, loading } = useDevices();

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
        <div className="text-5xl mb-4">📡</div>
        <h2 className="text-xl font-semibold text-gray-800 mb-2">No devices yet</h2>
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

  // Count online/offline
  const onlineCount = devices.filter((d) => {
    const lastSeen = d.info?.lastSeen;
    const isStale = lastSeen ? (Date.now() / 1000 - lastSeen) > 900 : true;
    return d.info?.online && !isStale;
  }).length;

  return (
    <div>
      {/* Status bar */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500">
            {onlineCount} online, {devices.length - onlineCount} offline — {devices.length} total
          </p>
        </div>
        <Link
          to="/subscribe"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          + Add Device
        </Link>
      </div>

      {/* Device grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {devices.map((d) => {
          const lastSeen = d.info?.lastSeen;
          const isStale = lastSeen ? (Date.now() / 1000 - lastSeen) > 900 : true;
          const isOnline = d.info?.online && !isStale;

          return (
            <Link key={d.deviceCode} to={`/device/${d.deviceCode}`}>
              <DeviceCard
                deviceCode={d.deviceCode}
                deviceName={d.deviceName}
                live={d.live}
                catalog={d.catalog}
                isOnline={isOnline}
              />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
