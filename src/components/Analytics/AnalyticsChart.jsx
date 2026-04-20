import { useState, useEffect, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getHistoryByRange } from "../../firebase/rtdb";

// Interpolate sparse history entries into fixed intervals (step interpolation)
// Returns array of { ts, pct } with entries every `stepMs` milliseconds
// Before first data point: pct is null (no line drawn)
function interpolate(history, startTs, endTs, stepMs) {
  if (history.length === 0) return [];
  const result = [];
  let current = 0;
  let lastPct = null;  // null until we've seen the first real entry

  for (let t = startTs; t <= endTs; t += stepMs) {
    // Advance through history entries <= t
    while (current < history.length && history[current].ts <= t) {
      lastPct = history[current].pct ?? lastPct;
      current++;
    }
    result.push({ ts: t, pct: lastPct });
  }
  return result;
}

// Calculate litres filled and consumed from raw history (not interpolated)
function calcLitres(history, tankCapacity) {
  if (!tankCapacity || history.length < 2) return { filled: 0, consumed: 0 };
  let filled = 0;
  let consumed = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].pct ?? 0;
    const curr = history[i].pct ?? 0;
    const delta = curr - prev;
    const litres = (Math.abs(delta) / 100) * tankCapacity;
    if (delta > 0) filled += litres;
    else if (delta < 0) consumed += litres;
  }
  return { filled: Math.round(filled), consumed: Math.round(consumed) };
}

const RANGES = {
  "24h": { ms: 86400000, stepMs: 15 * 60000, label: "Last 24 hours" },
  "7d": { ms: 7 * 86400000, stepMs: 60 * 60000, label: "Last 7 days" },
  "30d": { ms: 30 * 86400000, stepMs: 6 * 60 * 60000, label: "Last 30 days" },
};

export default function AnalyticsChart({ deviceCode, tankCapacityLitres, onHistoryLoaded }) {
  const [range, setRange] = useState("24h");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  const { startTs, endTs, stepMs } = useMemo(() => {
    const end = Date.now();
    const r = RANGES[range];
    return { startTs: end - r.ms, endTs: end, stepMs: r.stepMs };
  }, [range]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getHistoryByRange(deviceCode, startTs, endTs).then((data) => {
      if (cancelled) return;
      setHistory(data);
      setLoading(false);
      if (onHistoryLoaded) onHistoryLoaded(data, { startTs, endTs });
    });
    return () => { cancelled = true; };
  }, [deviceCode, startTs, endTs]);

  const chartData = useMemo(() => {
    const interp = interpolate(history, startTs, endTs, stepMs);
    return interp.map((p) => ({
      time: new Date(p.ts).toLocaleString([], {
        month: range === "24h" ? undefined : "short",
        day: range === "24h" ? undefined : "numeric",
        hour: "2-digit",
        minute: range === "24h" ? "2-digit" : undefined,
      }),
      pct: p.pct,
      litres: (p.pct != null && tankCapacityLitres) ? Math.round((p.pct / 100) * tankCapacityLitres) : null,
    }));
  }, [history, startTs, endTs, stepMs, range, tankCapacityLitres]);

  const litres = useMemo(() => calcLitres(history, tankCapacityLitres), [history, tankCapacityLitres]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400 text-sm">
        No history data yet. Analytics needs to be enabled by admin.
      </div>
    );
  }

  return (
    <div>
      {/* Range tabs */}
      <div className="flex gap-2 mb-4">
        {Object.entries(RANGES).map(([key, r]) => (
          <button
            key={key}
            onClick={() => setRange(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              range === key ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Summary */}
      {tankCapacityLitres > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-blue-50 rounded-lg p-3 text-center">
            <p className="text-xs text-blue-600 font-semibold">Water Filled</p>
            <p className="text-2xl font-bold text-blue-700">{litres.filled.toLocaleString()}L</p>
          </div>
          <div className="bg-orange-50 rounded-lg p-3 text-center">
            <p className="text-xs text-orange-600 font-semibold">Water Consumed</p>
            <p className="text-2xl font-bold text-orange-700">{litres.consumed.toLocaleString()}L</p>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="bg-white rounded-lg" style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
            <Tooltip
              contentStyle={{ fontSize: 12 }}
              formatter={(value, name) => {
                if (name === "pct") return [`${value}%`, "Level"];
                return [value, name];
              }}
            />
            <Line
              type="stepAfter"
              dataKey="pct"
              stroke="#2563eb"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-xs text-gray-400 mt-2 text-center">
        {history.length} actual data point{history.length !== 1 ? "s" : ""} in this range
      </p>
    </div>
  );
}

// Export helper for CSV generation
export function generateCSV(history, tankCapacityLitres, startTs, endTs, stepMs = 15 * 60000) {
  const interp = interpolate(history, startTs, endTs, stepMs);
  const tzOffset = new Date().getTimezoneOffset() * 60000;
  const rows = [["DateTime (Local)", "Level %", "Litres"]];
  for (const p of interp) {
    // Format in local timezone instead of UTC
    const dt = new Date(p.ts - tzOffset).toISOString().replace("T", " ").slice(0, 19);
    if (p.pct == null) {
      rows.push([dt, "", ""]);
    } else {
      const litres = tankCapacityLitres ? Math.round((p.pct / 100) * tankCapacityLitres) : "";
      rows.push([dt, p.pct, litres]);
    }
  }
  return rows.map((r) => r.join(",")).join("\n");
}

export function downloadCSV(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
