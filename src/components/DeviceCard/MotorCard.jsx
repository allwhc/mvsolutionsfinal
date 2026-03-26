import LevelBar from "./LevelBar";
import UltrasonicBar from "./UltrasonicBar";
import { sendRefreshCommand, sendMotorCommand } from "../../firebase/rtdb";

const MOTOR_STATES = {
  0: { label: "Stopped", color: "text-gray-600" },
  1: { label: "Starting", color: "text-blue-600" },
  2: { label: "Running", color: "text-green-600" },
  3: { label: "Stopping", color: "text-blue-600" },
  4: { label: "Fault", color: "text-red-700" },
  5: { label: "Overload", color: "text-red-700" },
};

export default function MotorCard({ deviceCode, deviceName, live, catalog, isOnline }) {
  const sensorType = catalog?.sensorType ?? 0;
  const sensorCount = catalog?.sensorCount ?? 0;
  const sensorBits = live?.sensorBits ?? 0;
  const confirmedPct = live?.confirmedPct ?? 0;
  const flags = live?.flags ?? 0;
  const stateVal = live?.stateVal ?? 0;
  const sensorError = !!(flags & 0x01);
  const sensorOffline = !!(flags & 0x20);

  const motorState = MOTOR_STATES[stateVal] || MOTOR_STATES[0];
  const canControl = isOnline && stateVal !== 4 && stateVal !== 5;

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

      {/* Motor state */}
      <div className="flex items-center justify-between mb-3 bg-gray-50 rounded-lg px-3 py-2">
        <span className="text-xs text-gray-500">Motor</span>
        <span className={`text-sm font-semibold ${motorState.color}`}>
          {motorState.label}
        </span>
      </div>

      {/* Motor controls */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => sendMotorCommand(deviceCode, "on")}
          disabled={!canControl || stateVal === 2 || stateVal === 1}
          className="flex-1 bg-green-500 text-white py-1.5 rounded-lg text-xs font-medium hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Turn ON
        </button>
        <button
          onClick={() => sendMotorCommand(deviceCode, "off")}
          disabled={!canControl || stateVal === 0 || stateVal === 3}
          className="flex-1 bg-red-500 text-white py-1.5 rounded-lg text-xs font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Turn OFF
        </button>
      </div>

      {/* Sensor visualization (if any) */}
      {sensorType === 1 ? (
        <LevelBar
          sensorBits={sensorBits}
          sensorCount={sensorCount}
          confirmedPct={confirmedPct}
          sensorError={sensorError}
        />
      ) : sensorType === 2 ? (
        <UltrasonicBar confirmedPct={confirmedPct} sensorOffline={sensorOffline} />
      ) : null}

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
