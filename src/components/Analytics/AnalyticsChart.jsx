import { useState, useEffect, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getHistoryByRange } from "../../firebase/rtdb";
import {
  RANGES,
  calcLitres,
  generateInsights,
  MIN_POINTS_FOR_INSIGHTS,
} from "../../utils/analyticsInsights";

// Merge actual history entries with grid timestamps (every stepMs)
// Returns array of { ts, pct, source } — source is "actual" or "interpolated"
//
// Forward-fill rule: every interpolated grid point inherits the most
// recent actual value, regardless of how old that value is. This is
// correct because firmware 17.0.8+ writes to /history ONLY on confirmed
// level change — a "no new entry" period means the level was steady, not
// that the device was offline. We can't tell offline from steady-state
// just by looking at /history; for that the user has the device's online
// badge elsewhere in the UI plus the "Actual values only" toggle which
// suppresses the forward-fill.
//
// Before first data point in range: pct stays null (no line drawn).
function interpolate(history, startTs, endTs, stepMs) {
  // Build set of grid timestamps (as numbers)
  const gridTimes = [];
  for (let t = startTs; t <= endTs; t += stepMs) gridTimes.push(t);

  // Filter history to within range
  const actuals = history.filter((h) => h.ts >= startTs && h.ts <= endTs);

  // Merge and sort unique timestamps
  const actualSet = new Set(actuals.map((a) => a.ts));
  const merged = [];
  for (const a of actuals) {
    merged.push({ ts: a.ts, pct: a.pct, source: "actual" });
  }
  for (const t of gridTimes) {
    if (!actualSet.has(t)) merged.push({ ts: t, pct: null, source: "interpolated" });
  }
  merged.sort((a, b) => a.ts - b.ts);

  // Seed lastKnown from the most recent actual BEFORE range start.
  // No staleness check — last known truth is what we paint forward.
  let lastKnown = null;
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

// calcLitres, RANGES, and insight helpers live in utils/analyticsInsights.js
// so both this full-page chart and the dashboard popup modal share one
// source of truth. The interpolate() function above stays here because
// it's chart-render-specific.



export default function AnalyticsChart({ deviceCode, tankCapacityLitres, onHistoryLoaded }) {
  const [range, setRange] = useState("24h");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actualsOnly, setActualsOnly] = useState(false);
  const [showInsights, setShowInsights] = useState(false);

  // Generate insights on demand (lazy — only computed when expanded)
  const insights = useMemo(
    () => (showInsights ? generateInsights(history, tankCapacityLitres) : null),
    [showInsights, history, tankCapacityLitres]
  );

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
    return interp.map((p) => {
      const isActual = p.source === "actual";
      const pct = actualsOnly ? (isActual ? p.pct : null) : p.pct;
      return {
        time: new Date(p.ts).toLocaleString([], {
          month: range === "24h" ? undefined : "short",
          day: range === "24h" ? undefined : "numeric",
          hour: "2-digit",
          minute: range === "24h" ? "2-digit" : undefined,
        }),
        pct,
        isActual,
        litres: (pct != null && tankCapacityLitres) ? Math.round((pct / 100) * tankCapacityLitres) : null,
      };
    });
  }, [history, startTs, endTs, stepMs, range, tankCapacityLitres, actualsOnly]);

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
      {/* Range tabs + actuals-only toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex gap-2">
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
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={actualsOnly}
            onChange={(e) => setActualsOnly(e.target.checked)}
            className="w-3.5 h-3.5 accent-blue-600"
          />
          Actual values only
        </label>
      </div>

      {/* Summary */}
      {tankCapacityLitres > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-blue-50 rounded-lg p-4 text-center">
            <p className="text-sm text-blue-600 font-semibold">Water Filled</p>
            <p className="text-4xl font-extrabold text-blue-700">{litres.filled.toLocaleString()}L</p>
          </div>
          <div className="bg-orange-50 rounded-lg p-4 text-center">
            <p className="text-sm text-orange-600 font-semibold">Water Consumed</p>
            <p className="text-4xl font-extrabold text-orange-700">{litres.consumed.toLocaleString()}L</p>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="bg-white rounded-lg relative" style={{ height: 320 }}>
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

        {/* Empty-state overlay — covers the chart grid when there's literally
            nothing to draw. Stops "Actual values only" from looking like the
            chart broke when in reality the user just has zero actuals in the
            window. Also fires when the device was offline the whole range. */}
        {!hasChartData && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-white/90 rounded-lg px-4 py-3 text-center max-w-xs">
              <p className="text-sm font-medium text-gray-700">No data in this window</p>
              <p className="text-xs text-gray-500 mt-1">
                {actualsOnly
                  ? "No actual readings in this range. Uncheck 'Actual values only' to see the carried-forward line."
                  : "Device may have been offline. Try a wider range."}
              </p>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 mt-2 text-center">
        {actualsInRange.length} actual data point{actualsInRange.length !== 1 ? "s" : ""} in this range
      </p>

      {/* Insights panel — collapsed by default, expand on click */}
      <div className="mt-3 border-t border-gray-100 pt-3">
        <button
          onClick={() => setShowInsights((s) => !s)}
          className="w-full flex items-center justify-between text-sm font-semibold text-gray-700 hover:text-blue-700"
        >
          <span>💬 Tell me about my analytics ({RANGES[range].label})</span>
          <span className="text-xs text-gray-400">{showInsights ? "▲ Hide" : "▼ Show"}</span>
        </button>
        {showInsights && insights && (
          <div className="mt-3 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-lg p-3">
            <ul className="space-y-1.5 text-sm text-gray-800">
              {insights.bullets.map((b, i) => (
                <li key={i} className="leading-snug">{b}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
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
