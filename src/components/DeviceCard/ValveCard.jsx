import { useState, useEffect } from "react";
import TankViz, { formatTimestamp } from "./TankViz";
import { sendRefreshCommand, sendValveCommand, listenToValveConfig } from "../../firebase/rtdb";

const VALVE_STATES = {
  0: { label: "Recovery", color: "text-yellow-600" },
  1: { label: "Opening", color: "text-blue-600" },
  2: { label: "Open", color: "text-green-600" },
  3: { label: "Closing", color: "text-blue-600" },
  4: { label: "Closed", color: "text-red-600" },
  5: { label: "Fault", color: "text-red-700" },
  6: { label: "LS Error", color: "text-purple-600" },
};

export default function ValveCard({ deviceCode, deviceName, live, info, catalog, isOnline }) {
  const sensorType = info?.sensorType ?? catalog?.sensorType ?? 1;
  const sensorCount = info?.sensorCount ?? catalog?.sensorCount ?? 4;
  const sensorBits = live?.sensorBits ?? 0;
  const confirmedPct = live?.confirmedPct ?? 0;
  const flags = live?.flags ?? 0;
  const stateVal = live?.valveState ?? live?.stateVal ?? 4;
  const sensorError = !!(flags & 0x01);
  const autoMode = !!(flags & 0x10);
  const isStreamTest = info?.streamTest === true;

  const [valveConfig, setValveConfig] = useState(null);
  const [pendingCmd, setPendingCmd] = useState(null); // "open" or "close"

  useEffect(() => {
    const unsub = listenToValveConfig(deviceCode, (cfg) => setValveConfig(cfg));
    return () => unsub();
  }, [deviceCode]);

  // Clear pending when valve state changes to the expected state
  useEffect(() => {
    if (pendingCmd === "open" && (stateVal === 1 || stateVal === 2)) setPendingCmd(null);
    if (pendingCmd === "close" && (stateVal === 3 || stateVal === 4)) setPendingCmd(null);
  }, [stateVal, pendingCmd]);

  // Timeout — clear pending after 20s even if no response
  useEffect(() => {
    if (!pendingCmd) return;
    const t = setTimeout(() => setPendingCmd(null), 20000);
    return () => clearTimeout(t);
  }, [pendingCmd]);

  const valveState = VALVE_STATES[stateVal] || VALVE_STATES[4];
  const isBusy = stateVal === 0 || stateVal === 1 || stateVal === 3; // recovery, opening, closing
  const canControl = isOnline && !autoMode && !isBusy && !pendingCmd && stateVal !== 5 && stateVal !== 6;

  return (
    <div className={`bg-white rounded-xl shadow-sm border p-4 transition-all ${
      isStreamTest
        ? (isOnline ? "border-purple-400 border-2" : "border-purple-200 border-2 opacity-60")
        : (isOnline ? "border-gray-200" : "border-gray-200 opacity-60")
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">{deviceName || deviceCode}</h3>
          <p className="text-xs text-gray-400">{deviceCode}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {isStreamTest && (
            <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-semibold">STREAM</span>
          )}
          {autoMode && (
            <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-semibold">AUTO</span>
          )}
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

      {/* Auto mode thresholds */}
      {autoMode && valveConfig && (
        <div className="flex items-center justify-between mb-2 px-1 text-[11px] text-blue-600">
          <span>Open at ≤ {valveConfig.minPercent ?? 25}%</span>
          <span>Close at ≥ {valveConfig.maxPercent ?? 75}%</span>
        </div>
      )}

      {/* Valve controls */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => { setPendingCmd("open"); sendValveCommand(deviceCode, "open"); }}
          disabled={!canControl || stateVal === 2}
          className="flex-1 bg-green-500 text-white py-1.5 rounded-lg text-xs font-medium hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pendingCmd === "open" ? (
            <span className="flex items-center justify-center gap-1">
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Opening...
            </span>
          ) : "Open"}
        </button>
        <button
          onClick={() => { setPendingCmd("close"); sendValveCommand(deviceCode, "close"); }}
          disabled={!canControl || stateVal === 4}
          className="flex-1 bg-red-500 text-white py-1.5 rounded-lg text-xs font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pendingCmd === "close" ? (
            <span className="flex items-center justify-center gap-1">
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Closing...
            </span>
          ) : "Close"}
        </button>
      </div>

      {/* Tank visualization — only if device has sensors */}
      {sensorCount > 0 && (
        <TankViz
          confirmedPct={confirmedPct}
          sensorBits={sensorBits}
          sensorCount={sensorCount}
          sensorError={sensorError}
          sensorType={sensorType}
        />
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
        <span className="text-xs text-gray-400">
          {live?.timestamp
            ? formatTimestamp(live.timestamp)
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
