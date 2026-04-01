import { useState, useEffect, useRef } from "react";

function getStatusColor(pct) {
  if (pct <= 10) return { fill: "from-red-500 to-red-400", text: "text-red-600", label: "Critical" };
  if (pct <= 25) return { fill: "from-orange-500 to-orange-400", text: "text-orange-600", label: "Low" };
  if (pct <= 50) return { fill: "from-yellow-500 to-yellow-400", text: "text-yellow-600", label: "Half" };
  if (pct <= 75) return { fill: "from-cyan-500 to-cyan-400", text: "text-cyan-600", label: "Good" };
  return { fill: "from-green-500 to-green-400", text: "text-green-600", label: "Full" };
}

function getFillStyle(pct) {
  if (pct <= 10) return "linear-gradient(to top, #DC2626, #F87171)";
  if (pct <= 25) return "linear-gradient(to top, #D97706, #FCD34D)";
  if (pct <= 50) return "linear-gradient(to top, #CA8A04, #FDE047)";
  if (pct <= 75) return "linear-gradient(to top, #0891B2, #67E8F9)";
  return "linear-gradient(to top, #16A34A, #4ADE80)";
}

export default function TankViz({ confirmedPct, sensorBits, sensorCount, sensorError, sensorType }) {
  const pct = confirmedPct ?? 0;
  const status = getStatusColor(pct);
  const prevPctRef = useRef(pct);
  const [trend, setTrend] = useState(null); // "up" | "down" | null

  useEffect(() => {
    const prev = prevPctRef.current;
    if (pct > prev) setTrend("up");
    else if (pct < prev) setTrend("down");
    else setTrend(null);
    prevPctRef.current = pct;
  }, [pct]);

  // Parse DIP sensors
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
        {/* Water fill */}
        <div
          className="absolute bottom-0 left-0 right-0 transition-all duration-700 ease-in-out rounded-b-sm"
          style={{
            height: `${Math.min(pct, 100)}%`,
            background: sensorError ? "linear-gradient(to top, #9333EA, #C084FC)" : getFillStyle(pct),
          }}
        />
        {/* Percentage text */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`text-xs font-bold ${pct > 40 ? "text-white" : "text-gray-700"} drop-shadow-sm`}>
            {sensorError ? "ERR" : `${pct}%`}
          </span>
        </div>
      </div>

      {/* Trend arrow */}
      <div className="flex flex-col items-center justify-end h-16">
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
      </div>
    </div>
  );
}
