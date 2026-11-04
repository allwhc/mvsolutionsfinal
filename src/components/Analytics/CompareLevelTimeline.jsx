// Time-series overlay for OHT Fill Analysis. Plots the source tank's
// level (dashed near-black) and each OHT's level (solid, categorical
// colors) on a single percentage Y-axis so levels are visually comparable
// even when tank sizes differ.
//
// The diagonal cross-over of source ↓ against OHT ↑ is the visual signal
// of a pump cycle. Small blue triangle markers on the X axis mark where
// the correlation algorithm detected a cycle start.
//
// Range toggle:  Last 24 hours (default) / Last 3 days / Last 7 days /
//                Full period. Full view is downsampled lightly by the
//                browser's own tick-skipping, but we still cap to a
//                reasonable per-tank point count via the window filter.
//
// Interaction:
//   - Legend click isolates a line (others fade to 15% opacity)
//   - Hover crosshair shows every tank's level at that timestamp

import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  CartesianGrid, ReferenceDot,
} from "recharts";
import { COMPARE_COLORS, SOURCE_COLOR } from "./compareColors";
import { filterHistoryByWindow } from "../../utils/compareAnalytics";

const RANGE_OPTIONS = [
  { key: "24h", label: "Last 24 hours", hours: 24  },
  { key: "3d",  label: "Last 3 days",   hours: 72  },
  { key: "7d",  label: "Last 7 days",   hours: 168 },
  { key: "all", label: "Full period",   hours: 0   },
];

function fmtTickTime(ts, rangeKey) {
  const d = new Date(ts + 5.5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  if (rangeKey === "24h") return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (rangeKey === "3d" || rangeKey === "7d") {
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:00`;
  }
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
}

function fmtTooltipTime(ts) {
  const d = new Date(ts + 5.5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Align per-tank histories onto a shared timestamp index so Recharts can
// render them as multiple lines on one chart. Missing cells stay undefined
// (connectNulls on each Line handles the gap).
function buildAlignedRows(series) {
  const tsSet = new Set();
  for (const s of series) for (const h of s.history) tsSet.add(h.ts);
  const tsAll = [...tsSet].sort((a, b) => a - b);
  const idx = series.map((s) => {
    const m = new Map();
    for (const h of s.history) m.set(h.ts, h.pct);
    return m;
  });
  return tsAll.map((ts) => {
    const row = { ts };
    for (let i = 0; i < series.length; i++) {
      const v = idx[i].get(ts);
      if (v != null) row[`pct_${series[i].code}`] = v;
    }
    return row;
  });
}

export default function CompareLevelTimeline({
  source,
  terraces,
  cleanedSourceHistory,
  cleanedTerraceHistories,
  correlation,
}) {
  const [rangeKey, setRangeKey] = useState("24h");
  const [isolated, setIsolated] = useState(null);

  const hours = RANGE_OPTIONS.find((r) => r.key === rangeKey)?.hours ?? 24;

  // Trim each tank's history to the chosen window. Use the very latest
  // timestamp across any series as "now" so a device that stopped pushing
  // yesterday still appears correctly.
  const { rows, cycleMarkers } = useMemo(() => {
    const allTs = [
      ...(cleanedSourceHistory || []).map((h) => h.ts),
      ...(cleanedTerraceHistories || []).flat().map((h) => h.ts),
    ];
    const latest = allTs.length > 0 ? Math.max(...allTs) : Date.now();

    const series = [];
    if (source && cleanedSourceHistory) {
      series.push({
        code:    source.deviceCode,
        name:    source.deviceName || source.deviceCode,
        isSource: true,
        history: filterHistoryByWindow(cleanedSourceHistory, hours, latest),
      });
    }
    for (let i = 0; i < (terraces || []).length; i++) {
      const dev = terraces[i];
      series.push({
        code:    dev.deviceCode,
        name:    dev.deviceName || dev.deviceCode,
        isSource: false,
        history: filterHistoryByWindow(cleanedTerraceHistories[i] || [], hours, latest),
      });
    }
    const alignedRows = buildAlignedRows(series);

    // Cycle-start markers — only the cycles whose start falls inside the
    // visible window. Rendered as small blue triangles on the X-axis
    // (y = 2 so they hug the bottom of the chart area).
    const cutoff = hours > 0 ? latest - hours * 3600 * 1000 : 0;
    const visibleCycles = (correlation?.cycles || []).filter((c) => c.ts >= cutoff);

    return { rows: alignedRows, cycleMarkers: visibleCycles, series };
  }, [source, terraces, cleanedSourceHistory, cleanedTerraceHistories, correlation, hours]);

  // Which tanks are actually in the trimmed series (needed for legend + Line array)
  const seriesForRender = useMemo(() => {
    const out = [];
    if (source) out.push({ code: source.deviceCode, name: source.deviceName || source.deviceCode, isSource: true });
    for (const d of (terraces || [])) out.push({ code: d.deviceCode, name: d.deviceName || d.deviceCode, isSource: false });
    return out;
  }, [source, terraces]);

  const colorFor = (code, isSource) => {
    if (isSource) return SOURCE_COLOR;
    const terraceIdx = (terraces || []).findIndex((d) => d.deviceCode === code);
    return COMPARE_COLORS[terraceIdx % COMPARE_COLORS.length];
  };
  const opacityFor = (code) => !isolated ? 1 : (isolated === code ? 1 : 0.15);

  if (rows.length === 0) {
    return (
      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Level timeline — source vs OHTs</h3>
        <p className="text-sm text-gray-500">No readings in this period.</p>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Level timeline — source vs OHTs</h3>
          <p className="text-sm text-gray-600">
            When the source tank line (dashed) drops as an OHT line (solid) rises, a pump cycle is running.{" "}
            {cycleMarkers.length > 0 && (
              <span className="text-gray-500">▲ marks a detected pump cycle start.</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r.key}
              onClick={() => setRangeKey(r.key)}
              className={`text-xs px-2.5 py-1 rounded border transition ${
                rangeKey === r.key
                  ? "bg-blue-600 text-white border-blue-700"
                  : "bg-white text-gray-700 border-gray-300 hover:border-blue-300 hover:bg-blue-50"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-3" style={{ width: "100%", height: 340 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(ts) => fmtTickTime(ts, rangeKey)}
              stroke="#6b7280"
              fontSize={11}
            />
            <YAxis
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              stroke="#6b7280"
              fontSize={11}
            />
            <Tooltip
              labelFormatter={(ts) => fmtTooltipTime(ts)}
              formatter={(v, name) => v == null ? ["—", name] : [`${Math.round(v)}%`, name]}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }}
            />
            <Legend
              onClick={(e) => {
                const code = e?.dataKey?.toString().replace(/^pct_/, "");
                setIsolated((prev) => prev === code ? null : code);
              }}
              wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
            />
            {seriesForRender.map((s) => (
              <Line
                key={s.code}
                dataKey={`pct_${s.code}`}
                name={s.name + (s.isSource ? "  (source)" : "")}
                stroke={colorFor(s.code, s.isSource)}
                strokeDasharray={s.isSource ? "6 4" : undefined}
                strokeWidth={2}
                strokeOpacity={opacityFor(s.code)}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
            {/* Cycle-start markers: small triangles at the bottom of the
                chart area. Only shown when the user isn't zoomed in so
                much that there are no markers in the visible window. */}
            {cycleMarkers.map((c, i) => (
              <ReferenceDot
                key={`cm-${i}`}
                x={c.ts}
                y={2}
                r={4}
                fill="#2563eb"
                stroke="#fff"
                strokeWidth={1}
                shape={({ cx, cy }) => (
                  <polygon
                    points={`${cx - 5},${cy + 4} ${cx + 5},${cy + 4} ${cx},${cy - 4}`}
                    fill="#2563eb"
                    stroke="#fff"
                    strokeWidth={1}
                  />
                )}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {isolated && (
        <div className="text-xs text-gray-500 mt-1">
          Showing <span className="font-medium">{seriesForRender.find((s) => s.code === isolated)?.name || isolated}</span> only — click its legend row to show all.
        </div>
      )}
    </section>
  );
}
