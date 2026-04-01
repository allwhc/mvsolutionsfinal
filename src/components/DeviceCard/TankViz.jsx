import { useState, useEffect, useRef } from "react";

// Smart date formatter
export function formatTimestamp(ts) {
  if (!ts) return "No data";
  const date = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today - 86400000);
  const tsDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (tsDate.getTime() === today.getTime()) return time;
  if (tsDate.getTime() === yesterday.getTime()) return `Yesterday, ${time}`;
  return `${date.getDate()} ${date.toLocaleString("default", { month: "short" })}, ${time}`;
}

export default function TankViz({ confirmedPct, sensorBits, sensorCount, sensorError, sensorType, tankCapacityLitres }) {
  const pct = confirmedPct ?? 0;
  const prevPctRef = useRef(pct);
  const [trend, setTrend] = useState(null);

  useEffect(() => {
    const prev = prevPctRef.current;
    if (pct > prev) setTrend("up");
    else if (pct < prev) setTrend("down");
    else setTrend(null);
    prevPctRef.current = pct;
  }, [pct]);

  // Parse DIP sensors (top to bottom)
  const sensors = [];
  if (sensorType === 1) {
    const count = sensorCount || 4;
    for (let i = count - 1; i >= 0; i--) {
      sensors.push((sensorBits >> i) & 1);
    }
  }

  return (
    <div className="flex items-end justify-center gap-2 my-2">
      {/* DIP sensor dots (left side) */}
      {sensorType === 1 && (
        <div className="flex flex-col justify-between h-16 py-0.5">
          {sensors.map((on, i) => (
            <div
              key={i}
              className={`w-2 h-2 rounded-full transition-all ${
                sensorError
                  ? "bg-purple-500"
                  : on
                  ? "bg-blue-500 shadow-sm shadow-blue-400"
                  : "bg-gray-200 border border-gray-300"
              }`}
            />
          ))}
        </div>
      )}

      {/* Tank body */}
      <div className="relative w-14 h-16 border-2 border-gray-300 rounded-sm bg-gray-50 overflow-hidden">
        {/* Water fill — always blue */}
        <div
          className="absolute bottom-0 left-0 right-0 transition-all duration-700 ease-in-out rounded-b-sm"
          style={{
            height: `${Math.min(pct, 100)}%`,
            background: sensorError
              ? "linear-gradient(to top, #9333EA, #C084FC)"
              : "linear-gradient(to top, #1E40AF, #60A5FA)",
          }}
        />
        {/* Percentage text */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-bold text-gray-900 drop-shadow-[0_1px_1px_rgba(255,255,255,0.5)]">
            {sensorError ? "ERR" : `${pct}%`}
          </span>
        </div>
      </div>

      {/* Trend arrow + Litres */}
      <div className="flex flex-col items-center justify-end h-16 gap-1">
        {trend === "up" && (
          <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 15l7-7 7 7" />
          </svg>
        )}
        {trend === "down" && (
          <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
          </svg>
        )}
        {!trend && (
          <div className="w-3 h-0.5 bg-gray-300 rounded" />
        )}
        {!sensorError && tankCapacityLitres > 0 && (
          <span className="text-[10px] font-semibold text-gray-600">
            {Math.round((pct / 100) * tankCapacityLitres)}L
          </span>
        )}
      </div>
    </div>
  );
}
