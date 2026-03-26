import LevelBar from "./LevelBar";
import UltrasonicBar from "./UltrasonicBar";
import { sendRefreshCommand, sendValveCommand } from "../../firebase/rtdb";

const VALVE_STATES = {
  0: { label: "Recovery", color: "text-yellow-600" },
  1: { label: "Opening", color: "text-blue-600" },
  2: { label: "Open", color: "text-green-600" },
  3: { label: "Closing", color: "text-blue-600" },
  4: { label: "Closed", color: "text-red-600" },
  5: { label: "Fault", color: "text-red-700" },
  6: { label: "LS Error", color: "text-purple-600" },
};

export default function ValveCard({ deviceCode, deviceName, live, catalog, isOnline }) {
  const sensorType = catalog?.sensorType ?? 1;
  const sensorCount = catalog?.sensorCount ?? 4;
  const sensorBits = live?.sensorBits ?? 0;
  const confirmedPct = live?.confirmedPct ?? 0;
  const flags = live?.flags ?? 0;
  const stateVal = live?.stateVal ?? 4;
  const sensorError = !!(flags & 0x01);
  const sensorOffline = !!(flags & 0x20);

  const valveState = VALVE_STATES[stateVal] || VALVE_STATES[4];
  const canControl = isOnline && stateVal !== 5 && stateVal !== 6;

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

      {/* Valve state */}
      <div className="flex items-center justify-between mb-3 bg-gray-50 rounded-lg px-3 py-2">
        <span className="text-xs text-gray-500">Valve</span>
        <span className={`text-sm font-semibold ${valveState.color}`}>
          {valveState.label}
        </span>
      </div>

      {/* Valve controls */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => sendValveCommand(deviceCode, "open")}
          disabled={!canControl || stateVal === 2 || stateVal === 1}
          className="flex-1 bg-green-500 text-white py-1.5 rounded-lg text-xs font-medium hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Open
        </button>
        <button
          onClick={() => sendValveCommand(deviceCode, "close")}
          disabled={!canControl || stateVal === 4 || stateVal === 3}
          className="flex-1 bg-red-500 text-white py-1.5 rounded-lg text-xs font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Close
        </button>
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
