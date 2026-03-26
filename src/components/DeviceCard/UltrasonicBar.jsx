import { getLevelColor, getLevelTextColor } from "./LevelBar";

export default function UltrasonicBar({ confirmedPct, sensorOffline }) {
  const pct = sensorOffline ? 0 : (confirmedPct ?? 0);

  return (
    <div className="space-y-2">
      {/* Percentage bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-gray-200 rounded-full h-4 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              sensorOffline ? "bg-gray-400" : getLevelColor(pct)
            }`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <span className={`text-lg font-bold min-w-[3rem] text-right ${
          sensorOffline ? "text-gray-400" : getLevelTextColor(pct)
        }`}>
          {sensorOffline ? "--" : `${pct}%`}
        </span>
      </div>

      {/* Sensor type label */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-gray-500">Ultrasonic</span>
        {sensorOffline && (
          <span className="text-xs text-red-500 font-medium">Sensor Offline</span>
        )}
      </div>
    </div>
  );
}
