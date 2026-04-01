import TankViz from "./TankViz";
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
      <div className="flex items-center justify-between mb-1">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">{deviceName || deviceCode}</h3>
          <p className="text-xs text-gray-400">{deviceCode}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-green-500" : "bg-gray-300"}`} />
          <span className="text-xs text-gray-500">{isOnline ? "Online" : "Offline"}</span>
        </div>
      </div>

      {/* Tank visualization */}
      {sensorOffline ? (
        <div className="text-center py-4">
          <p className="text-sm text-red-500 font-medium">Sensor Offline</p>
        </div>
      ) : (
        <TankViz
          confirmedPct={confirmedPct}
          sensorBits={sensorBits}
          sensorCount={sensorCount}
          sensorError={sensorError}
          sensorType={sensorType}
        />
      )}

      {/* Sensor type label */}
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>{sensorType === 1 ? "DIP" : sensorType === 2 ? "Ultrasonic" : "Sensor"}</span>
        {sensorError && <span className="text-purple-600 font-medium">Sensor Error</span>}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100">
        <span className="text-xs text-gray-400">
          {live?.timestamp
            ? new Date(live.timestamp).toLocaleTimeString()
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
