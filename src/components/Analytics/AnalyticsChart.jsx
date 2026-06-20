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

// ── Insights generator ─────────────────────────────────────────────
// Event detection thresholds — tune here if customer usage patterns differ.
//   Refill = level rose >= 25% within 30 minutes (motor pump / tanker)
//   Drain  = level dropped >= 10% within 2 hours (household consumption)
const REFILL_PCT_THRESHOLD = 25;
const REFILL_MAX_DURATION_MS = 30 * 60 * 1000;
const DRAIN_PCT_THRESHOLD = 10;
const DRAIN_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MIN_POINTS_FOR_INSIGHTS = 5;

function detectEvents(history) {
  if (history.length < 2) return [];
  const events = [];
  let i = 0;
  while (i < history.length - 1) {
    const a = history[i];
    const aPct = a.pct ?? 0;
    let j = i + 1;
    let bestDelta = 0;
    let bestIdx = i + 1;
    // Look ahead while staying within the larger window (use refill window since it's tighter)
    while (j < history.length) {
      const b = history[j];
      const dt = b.ts - a.ts;
      const dp = (b.pct ?? 0) - aPct;
      if (dp > bestDelta && dt <= REFILL_MAX_DURATION_MS) {
        bestDelta = dp;
        bestIdx = j;
      }
      if (dt > DRAIN_MAX_DURATION_MS) break;
      j++;
    }
    // Refill check
    if (bestDelta >= REFILL_PCT_THRESHOLD) {
      events.push({
        type: "refill",
        startTs: a.ts,
        endTs: history[bestIdx].ts,
        pctDelta: bestDelta,
      });
      i = bestIdx;
      continue;
    }
    // Drain check (look ahead for biggest drop)
    let worstDelta = 0;
    let worstIdx = i + 1;
    j = i + 1;
    while (j < history.length) {
      const b = history[j];
      const dt = b.ts - a.ts;
      if (dt > DRAIN_MAX_DURATION_MS) break;
      const dp = (b.pct ?? 0) - aPct;
      if (dp < worstDelta) {
        worstDelta = dp;
        worstIdx = j;
      }
      j++;
    }
    if (-worstDelta >= DRAIN_PCT_THRESHOLD) {
      events.push({
        type: "drain",
        startTs: a.ts,
        endTs: history[worstIdx].ts,
        pctDelta: worstDelta,
      });
      i = worstIdx;
      continue;
    }
    i++;
  }
  return events;
}

function formatHour(hour) {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

function formatLitres(l) {
  if (l >= 1000000) return `${(l / 1000000).toFixed(2)} ML`;
  if (l >= 1000) return `${(l / 1000).toFixed(1)} KL`;
  return `${Math.round(l)} L`;
}

function generateInsights(history, tankCapacity, rangeKey) {
  if (history.length < MIN_POINTS_FOR_INSIGHTS) {
    return {
      enough: false,
      bullets: [`Not enough data to talk about yet — only ${history.length} reading${history.length === 1 ? "" : "s"} in this period. Insights need at least ${MIN_POINTS_FOR_INSIGHTS}.`],
    };
  }

  const bullets = [];
  const totals = calcLitres(history, tankCapacity);

  // Volume summary
  if (tankCapacity > 0) {
    bullets.push(`💧 Refilled ${formatLitres(totals.filled)} in this period`);
    bullets.push(`🚰 Consumed ${formatLitres(totals.consumed)} in this period`);
  } else {
    bullets.push(`💧 Filled ${totals.filled}% worth of tank levels`);
    bullets.push(`🚰 Drained ${totals.consumed}% worth of tank levels`);
  }

  // Daily average
  const spanMs = history[history.length - 1].ts - history[0].ts;
  const days = Math.max(1, spanMs / 86400000);
  if (tankCapacity > 0 && days >= 1) {
    bullets.push(`📅 Daily average consumption: ${formatLitres(totals.consumed / days)}`);
  }

  // Detect refill / drain events
  const events = detectEvents(history);
  const refills = events.filter((e) => e.type === "refill");
  const drains = events.filter((e) => e.type === "drain");

  if (refills.length > 0) {
    bullets.push(`🔁 ${refills.length} refill event${refills.length > 1 ? "s" : ""}`);
    // Peak refill hour
    const refillHours = refills.map((e) => new Date(e.startTs).getHours());
    const refillPeak = mode(refillHours);
    if (refillPeak != null) bullets.push(`⏰ Tank usually fills around ${formatHour(refillPeak)}`);
  } else {
    bullets.push(`🔁 No refill events detected`);
  }

  if (drains.length > 0) {
    const drainHours = drains.map((e) => new Date(e.startTs).getHours());
    const drainPeak = mode(drainHours);
    if (drainPeak != null) bullets.push(`🔥 Heaviest use around ${formatHour(drainPeak)}`);
  }

  // Min level
  const pcts = history.map((h) => h.pct ?? 0);
  const lowest = Math.min(...pcts);
  const highest = Math.max(...pcts);
  bullets.push(`📉 Lowest level reached: ${lowest}%   |   📈 Highest: ${highest}%`);

  // Longest stretch at 0% (dry period) within range
  let longestDry = 0;
  let dryStart = null;
  for (const h of history) {
    if ((h.pct ?? 100) === 0) {
      if (dryStart == null) dryStart = h.ts;
      longestDry = Math.max(longestDry, h.ts - dryStart);
    } else {
      dryStart = null;
    }
  }
  if (longestDry > 60 * 60 * 1000) {
    const dryHrs = (longestDry / (60 * 60 * 1000)).toFixed(1);
    bullets.push(`⚠ Longest dry stretch: ${dryHrs} hours at 0%`);
  }

  // Data coverage disclaimer
  bullets.push(`ℹ Based on ${history.length} data point${history.length > 1 ? "s" : ""} from cloud history.`);

  return { enough: true, bullets };
}

function mode(arr) {
  if (arr.length === 0) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  let best = null, bestCount = 0;
  for (const k in counts) {
    if (counts[k] > bestCount) { bestCount = counts[k]; best = parseInt(k); }
  }
  return best;
}

export default function AnalyticsChart({ deviceCode, tankCapacityLitres, onHistoryLoaded }) {
  const [range, setRange] = useState("24h");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actualsOnly, setActualsOnly] = useState(false);
  const [showInsights, setShowInsights] = useState(false);

  // Generate insights on demand (lazy — only computed when expanded)
  const insights = useMemo(
    () => (showInsights ? generateInsights(history, tankCapacityLitres, range) : null),
    [showInsights, history, tankCapacityLitres, range]
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
