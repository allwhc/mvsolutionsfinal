import LevelBar from "./LevelBar";
import UltrasonicBar from "./UltrasonicBar";
import { sendRefreshCommand } from "../../firebase/rtdb";

// sensorType: 0=none, 1=DIP, 2=ultrasonic
export default function SensorCard({ deviceCode, deviceName, live, info, catalog, isOnline }) {
  const sensorType = info?.sensorType ?? catalog?.sensorType ?? 1;
  const sensorCount = info?.sensorCount ?? catalog?.sensorCount ?? 4;
  const sensorBits = live?.sensorBits ?? 0;
  const confirmedPct = live?.confirmedPct ?? 0;
  const flags = live?.flags ?? 0;
  const sensorError = !!(flags & 0x01);
  const sensorOffline = !!(flags & 0x20);

  return (
    <div className={`bg-white rounded-xl shadow-sm border p-4 transition-all ${
      isOnline ? "border-gray-200" : "border-gray-200 opacity-60"
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">{deviceName || deviceCode}</h3>
          <p className="text-xs text-gray-400">{deviceCode}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-green-500" : "bg-gray-300"}`} />
          <span className="text-xs text-gray-500">{isOnline ? "Online" : "Offline"}</span>
        </div>
      </div>

      {/* Sensor visualization */}
      {sensorType === 1 ? (
        <LevelBar
          sensorBits={sensorBits}
          sensorCount={sensorCount}
          confirmedPct={confirmedPct}
          sensorError={sensorError}
        />
      ) : sensorType === 2 ? (
        <UltrasonicBar
          confirmedPct={confirmedPct}
          sensorOffline={sensorOffline}
        />
      ) : (
        <p className="text-sm text-gray-400">No sensor</p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
        <span className="text-xs text-gray-400">
          {live?.timestamp
            ? new Date(live.timestamp * 1000).toLocaleTimeString()
            : "No data"}
        </span>
        <button
          onClick={() => sendRefreshCommand(deviceCode)}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
