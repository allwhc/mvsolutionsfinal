import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import TankViz, { formatTimestamp } from "./TankViz";
import CleaningBadge from "./CleaningBadge";
import { sendRefreshCommand, listenToValveConfig } from "../../firebase/rtdb";
import { useDebugMode } from "../../context/DebugModeContext";
import { resolveLevel } from "../../utils/resolveLevel";

// Determine card flash class — cleaning never causes flash, only badge.
// Thresholds come from React state on DeviceDetail and are initialised to
// the empty string when the user hasn't set them. `"" != null` is true,
// and `pct >= ""` coerces to `pct >= 0` (always true) which would
// permanently flash the card green. Treat "", null, and undefined the
// same — no threshold configured. Also Number()-coerce the threshold so
// a string like "80" compares numerically against confirmedPct.
function hasThreshold(v) {
  return v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v));
}

function getAlertFlash({ sensorError, sensorOffline, confirmedPct, alertLowPct, alertHighPct }) {
  // Priority 1: Sensor error — purple
  if (sensorError || sensorOffline) return "animate-pulse-purple";
  // Priority 2: Level <= low threshold — red
  if (hasThreshold(alertLowPct)  && confirmedPct <= Number(alertLowPct))  return "animate-pulse-red";
  // Priority 3: Level >= high threshold — green
  if (hasThreshold(alertHighPct) && confirmedPct >= Number(alertHighPct)) return "animate-pulse-green";
  return "";
}

// Compute water column height in cm for an ultrasonic device.
//
// Prefer live.rawCm (accurate — actual sensor reading in cm from
// sensor face to water surface). Fall back to reverse-math from
// confirmedPct + geometry when rawCm is missing (older firmware). The
// reverse-math variant carries a small quantization error (~2 in)
// because pct is integer 0-100.
//
// Returns null if no meaningful depth can be computed (missing
// geometry, missing readings, or an offline / sensor-error state
// that would produce a misleading number).
function computeWaterDepthCm({ rawCm, pct, tankHeightCm, overflowCm, suctionCm }) {
  const tank = Number(tankHeightCm);
  if (!isFinite(tank) || tank <= 0) return null;
  const ovfl    = Number(overflowCm) || 0;
  const suction = Number(suctionCm)  || 0;
  // Effective range: from suction pipe (bottom cutoff) to overflow
  // pipe (top cutoff). If either is disabled it collapses to
  // sensor face → tank bottom / tank top.
  const suctionCutoffCm = suction > 0 && suction < tank ? tank - suction : tank;
  const topCutoffCm     = ovfl    > 0 && ovfl    < tank ? ovfl           : 0;

  // Preferred path: firmware sent live.rawCm (distance sensor→water).
  const rc = Number(rawCm);
  if (isFinite(rc) && rc > 0) {
    let depth = suctionCutoffCm - rc;
    if (depth < 0) depth = 0;
    if (depth > suctionCutoffCm - topCutoffCm) depth = suctionCutoffCm - topCutoffCm;
    return depth;
  }

  // Fallback: reverse-compute from pct. Loses ~1 cm per pct step.
  const p = Number(pct);
  if (isFinite(p) && p >= 0 && p <= 100) {
    const usable = suctionCutoffCm - topCutoffCm;
    if (usable <= 0) return null;
    return (p / 100) * usable;
  }
  return null;
}

// sensorType: 0=none, 1=DIP, 2=ultrasonic
// onOpenAnalytics: optional callback. When provided, the chart icon opens
// the analytics popup via that callback instead of navigating to Device
// Detail. Dashboard supplies it; Device Detail leaves it out so its inline
// chart icon (if any) keeps original behavior.
export default function SensorCard({ deviceCode, deviceName, live, info, catalog, isOnline, lastCleanedAt, cleanIntervalDays, tankCapacityLitres, alertLowPct, alertHighPct, onOpenAnalytics }) {
  const { debugMode } = useDebugMode();
  const sensorType = info?.sensorType ?? catalog?.sensorType ?? 1;
  const sensorCount = info?.sensorCount ?? catalog?.sensorCount ?? 4;
  const rawBits = live?.sensorBits ?? 0;
  const rawPct = live?.confirmedPct ?? 0;
  const flags = live?.flags ?? 0;
  const rawSensorError = !!(flags & 0x01);
  const sensorOffline = !!(flags & 0x20);

  // For DIP sensors: normally use the "highest wet probe" resolved level
  // so a faulty lower probe doesn't wreck the customer's view. In debug
  // mode, expose the raw firmware bits so an installer can spot the
  // faulty probe. Ultrasonic sensors have no probe concept — pass raw
  // through untouched.
  let sensorBits, confirmedPct, sensorError;
  if (sensorType === 1 && !debugMode) {
    const { pct, filledBits } = resolveLevel(rawBits, sensorCount);
    sensorBits = filledBits;
    confirmedPct = pct;
    sensorError = false;
  } else {
    sensorBits = rawBits;
    confirmedPct = rawPct;
    sensorError = rawSensorError;
  }

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
            onOpenAnalytics ? (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenAnalytics(); }}
                title="Quick analytics snapshot"
                className="text-blue-600 hover:text-blue-800"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 5-5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            ) : (
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
            )
          )}
          <CleaningBadge lastCleanedAt={lastCleanedAt} cleanIntervalDays={cleanIntervalDays} />
          <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-green-500" : "bg-gray-300"}`} />
          <span className="text-xs text-gray-500">{isOnline ? "Online" : "Offline"}</span>
        </div>
      </div>

      {/* Tank visualization. Depth is computed here (has the live +
          info + sensorType context) and passed to TankViz so the
          third stat pill renders alongside LEVEL + VOLUME. Only
          ultrasonic devices with enough data get a depth value;
          everything else passes null → pill hidden. */}
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
          waterDepthCm={sensorType === 2 && isOnline && !sensorError
            ? computeWaterDepthCm({
                rawCm:        live?.rawCm,
                pct:          confirmedPct,
                tankHeightCm: info?.tankHeightCm,
                overflowCm:   info?.overflowCm,
                suctionCm:    info?.suctionCm,
              })
            : null}
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
