import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import TankViz, { formatTimestamp } from "./TankViz";
import CleaningBadge from "./CleaningBadge";
import { sendRefreshCommand, listenToValveConfig } from "../../firebase/rtdb";

// Determine card flash class — cleaning never causes flash, only badge
function getAlertFlash({ sensorError, sensorOffline, confirmedPct, alertLowPct, alertHighPct }) {
  // Priority 1: Sensor error — purple
  if (sensorError || sensorOffline) return "animate-pulse-purple";
  // Priority 2: Level <= low threshold — red
  if (alertLowPct != null && confirmedPct <= alertLowPct) return "animate-pulse-red";
  // Priority 3: Level >= high threshold — green
  if (alertHighPct != null && confirmedPct >= alertHighPct) return "animate-pulse-green";
  return "";
}

// sensorType: 0=none, 1=DIP, 2=ultrasonic
export default function SensorCard({ deviceCode, deviceName, live, info, catalog, isOnline, lastCleanedAt, cleanIntervalDays, tankCapacityLitres, alertLowPct, alertHighPct }) {
  const sensorType = info?.sensorType ?? catalog?.sensorType ?? 1;
  const sensorCount = info?.sensorCount ?? catalog?.sensorCount ?? 4;
  const sensorBits = live?.sensorBits ?? 0;
  const confirmedPct = live?.confirmedPct ?? 0;
  const flags = live?.flags ?? 0;
  const sensorError = !!(flags & 0x01);
  const sensorOffline = !!(flags & 0x20);

  const flashClass = isOnline ? getAlertFlash({
    sensorError, sensorOffline, confirmedPct,
    alertLowPct, alertHighPct, lastCleanedAt, cleanIntervalDays,
  }) : "";

  const [analyticsOn, setAnalyticsOn] = useState(false);
  useEffect(() => {
    const unsub = listenToValveConfig(deviceCode, (cfg) => setAnalyticsOn(!!cfg?.analyticsOn));
    return () => unsub();
  }, [deviceCode]);

  return (
    <div className={`bg-white rounded-xl shadow-sm border p-4 transition-all ${
      isOnline ? "border-gray-200" : "border-gray-200 opacity-60"
    } ${flashClass}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">{deviceName || deviceCode}</h3>
          <p className="text-xs text-gray-400">{deviceCode}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {analyticsOn && (
            <Link
              to={`/device/${deviceCode}#analytics`}
              onClick={(e) => e.stopPropagation()}
              title="View analytics"
              className="text-blue-600 hover:text-blue-800"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 5-5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </Link>
          )}
          <CleaningBadge lastCleanedAt={lastCleanedAt} cleanIntervalDays={cleanIntervalDays} />
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
          tankCapacityLitres={tankCapacityLitres}
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
          {formatTimestamp(live?.timestamp)}
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
