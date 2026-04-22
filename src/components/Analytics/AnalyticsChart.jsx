import { useState, useEffect, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getHistoryByRange } from "../../firebase/rtdb";

// Merge actual history entries with grid timestamps (every stepMs)
// Returns array of { ts, pct, source } — source is "actual" or "interpolated"
// Before first data point: pct is null (no line drawn)
function interpolate(history, startTs, endTs, stepMs) {
  // Build set of grid timestamps (as numbers)
  const gridTimes = [];
  for (let t = startTs; t <= endTs; t += stepMs) gridTimes.push(t);

  // Filter history to within range
  const actuals = history.filter((h) => h.ts >= startTs && h.ts <= endTs);

  // Merge and sort unique timestamps
  const actualSet = new Set(actuals.map((a) => a.ts));
  const merged = [];
  // Add all actuals first
  for (const a of actuals) {
    merged.push({ ts: a.ts, pct: a.pct, source: "actual" });
  }
  // Add grid times that don't coincide with actuals
  for (const t of gridTimes) {
    if (!actualSet.has(t)) merged.push({ ts: t, pct: null, source: "interpolated" });
  }
  // Sort by timestamp
  merged.sort((a, b) => a.ts - b.ts);

  // Fill interpolated values with last known actual value
  // Use global last actual (including before the range start) for carrying value forward
  let lastKnown = null;
  // Find last actual before range start to seed lastKnown
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].ts < startTs) { lastKnown = history[i].pct ?? null; break; }
  }

  for (const row of merged) {
    if (row.source === "actual") {
      lastKnown = row.pct;
    } else {
      row.pct = lastKnown;
    }
  }

  return merged;
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
    getHistoryByRange(deviceCode, startTs, endTs, true).then((data) => {
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
      isActual: p.source === "actual",
      litres: (p.pct != null && tankCapacityLitres) ? Math.round((p.pct / 100) * tankCapacityLitres) : null,
    }));
  }, [history, startTs, endTs, stepMs, range, tankCapacityLitres]);

  const litres = useMemo(() => calcLitres(history, tankCapacityLitres), [history, tankCapacityLitres]);

  const actualsInRange = useMemo(
    () => history.filter((h) => h.ts >= startTs && h.ts <= endTs),
    [history, startTs, endTs]
  );
  const hasChartData = chartData.some((p) => p.pct != null);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!hasChartData) {
    return (
      <div>
        {/* Range tabs still shown so user can try other ranges */}
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
        <div className="text-center py-12 text-gray-400 text-sm">
          No data recorded before this range.
          <br />
          <span className="text-xs">Device will record on next level change.</span>
        </div>
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
      <div className="bg-white rounded-lg" style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10 }}
              interval="preserveStartEnd"
              angle={-35}
              textAnchor="end"
              height={60}
            />
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
              dot={(props) => {
                if (!props.payload?.isActual) return null;
                return (
                  <circle
                    key={`dot-${props.index}`}
                    cx={props.cx}
                    cy={props.cy}
                    r={3}
                    fill="#2563eb"
                    stroke="#fff"
                    strokeWidth={1}
                  />
                );
              }}
              isAnimationActive={false}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-xs text-gray-400 mt-2 text-center">
        {actualsInRange.length} actual data point{actualsInRange.length !== 1 ? "s" : ""} in this range
      </p>
    </div>
  );
}

// Export helper for CSV generation
export function generateCSV(history, tankCapacityLitres, startTs, endTs, stepMs = 15 * 60000) {
  const interp = interpolate(history, startTs, endTs, stepMs);
  const tzOffset = new Date().getTimezoneOffset() * 60000;
  const rows = [["DateTime (Local)", "Level %", "Litres", "Source"]];
  for (const p of interp) {
    // Format in local timezone instead of UTC
    const dt = new Date(p.ts - tzOffset).toISOString().replace("T", " ").slice(0, 19);
    if (p.pct == null) {
      rows.push([dt, "", "", "no data"]);
    } else {
      const litres = tankCapacityLitres ? Math.round((p.pct / 100) * tankCapacityLitres) : "";
      rows.push([dt, p.pct, litres, p.source || ""]);
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
