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
  const prevPctRef = useRef(null);
  const [trend, setTrend] = useState(null);

  useEffect(() => {
    const prev = prevPctRef.current;
    if (prev === null) {
      // First render — no trend
      prevPctRef.current = pct;
      return;
    }
    if (pct !== prev) {
      // Only update trend when value actually changes
      if (pct > prev) setTrend("up");
      else setTrend("down");
      prevPctRef.current = pct;
    }
  }, [pct]);

  // Parse DIP sensors (top to bottom) with error detection
  const count = sensorCount || 4;
  const sensors = [];
  if (sensorType === 1) {
    // Find consecutive count from bottom
    let consecutive = 0;
    for (let i = 0; i < count; i++) {
      if ((sensorBits >> i) & 1) consecutive++;
      else break;
    }
    // Build sensor array top-to-bottom with error marking
    for (let i = count - 1; i >= 0; i--) {
      const isOn = (sensorBits >> i) & 1;
      // Gap = sensor OFF but a higher sensor is ON (non-consecutive)
      const isGap = sensorError && !isOn && i < count && (() => {
        for (let j = i + 1; j < count; j++) {
          if ((sensorBits >> j) & 1) return true;
        }
        return false;
      })();
      sensors.push({ on: isOn, gap: isGap });
    }
  }

  const litres = !sensorError && tankCapacityLitres > 0
    ? Math.round((pct / 100) * tankCapacityLitres)
    : null;
  const litreDisplay = litres == null
    ? null
    : litres >= 1000
      ? `${(litres / 1000).toFixed(litres % 1000 === 0 ? 0 : 1)} KL`
      : `${litres} L`;

  return (
    <div className="flex flex-col items-center gap-3 my-2">
      {/* Top row: probes + tank + trend */}
      <div className="flex items-center justify-center gap-3">
        {/* DIP sensor dots (left side) */}
        {sensorType === 1 && (
          <div className={`flex flex-col ${count === 1 ? "justify-center" : "justify-between"} h-20 py-1`}>
            {sensors.map((s, i) => (
              <div
                key={i}
                className={`w-2.5 h-2.5 rounded-full transition-all ${
                  s.gap
                    ? "bg-red-500 shadow-sm shadow-red-400 ring-2 ring-red-200"
                    : s.on
                    ? "bg-blue-500 shadow-sm shadow-blue-400"
                    : "bg-gray-200 border border-gray-300"
                }`}
              />
            ))}
          </div>
        )}

        {/* Tank body — taller + glossier */}
        <div className="relative w-16 h-20 border-2 border-gray-400 rounded-md bg-gradient-to-b from-gray-50 to-gray-100 overflow-hidden shadow-inner">
          {/* Water fill */}
          <div
            className="absolute bottom-0 left-0 right-0 transition-all duration-700 ease-in-out rounded-b-md"
            style={{
              height: `${Math.min(pct, 100)}%`,
              background: sensorError
                ? "linear-gradient(to top, #7e22ce 0%, #a855f7 60%, #d8b4fe 100%)"
                : "linear-gradient(to top, #1e3a8a 0%, #2563eb 50%, #60a5fa 100%)",
              boxShadow: "inset 0 2px 4px rgba(255,255,255,0.25)",
            }}
          />
          {/* Subtle gloss highlight */}
          <div
            className="absolute top-0 left-0 w-1/3 h-full pointer-events-none rounded-l-md"
            style={{
              background: "linear-gradient(to right, rgba(255,255,255,0.18), rgba(255,255,255,0))",
            }}
          />
          {/* Tank lid accent */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-b from-gray-300 to-gray-400 border-b border-gray-500/30" />
        </div>

        {/* Trend arrow on right */}
        <div className="flex flex-col items-center justify-center h-20">
          {trend === "up" && (
            <div className="bg-green-50 rounded-full p-1 ring-1 ring-green-200">
              <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 15l7-7 7 7" />
              </svg>
            </div>
          )}
          {trend === "down" && (
            <div className="bg-red-50 rounded-full p-1 ring-1 ring-red-200">
              <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          )}
          {!trend && (
            <div className="bg-gray-100 rounded-full p-1 ring-1 ring-gray-200">
              <div className="w-4 h-0.5 bg-gray-400 rounded" />
            </div>
          )}
        </div>
      </div>

      {/* Bottom row: highlighted % + KL chips */}
      <div className={`flex items-stretch ${litreDisplay ? "gap-2" : ""} w-full max-w-[220px]`}>
        {/* Percentage chip */}
        <div
          className={`flex-1 rounded-lg px-3 py-1.5 text-center shadow-sm ${
            sensorError
              ? "bg-gradient-to-br from-purple-50 to-purple-100 ring-1 ring-purple-200"
              : "bg-gradient-to-br from-blue-50 to-blue-100 ring-1 ring-blue-200"
          }`}
        >
          <div className={`text-[10px] uppercase tracking-wider font-semibold ${sensorError ? "text-purple-600" : "text-blue-600"}`}>
            Level
          </div>
          <div className={`text-2xl font-extrabold leading-tight ${sensorError ? "text-purple-700" : "text-blue-700"}`}>
            {sensorError ? "ERR" : count === 1 ? (pct > 0 ? "ON" : "OFF") : `${pct}%`}
          </div>
        </div>

        {/* Litres chip — only when capacity configured */}
        {litreDisplay && (
          <div className="flex-1 rounded-lg px-3 py-1.5 text-center bg-gradient-to-br from-cyan-50 to-cyan-100 ring-1 ring-cyan-200 shadow-sm">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-cyan-700">
              Volume
            </div>
            <div className="text-2xl font-extrabold leading-tight text-cyan-700 whitespace-nowrap">
              {litreDisplay}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
