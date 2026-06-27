import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getHistoryByRange } from "../../firebase/rtdb";
import { RANGES, generateInsights } from "../../utils/analyticsInsights";

// Lightweight analytics popup. Fires a Firebase read only AFTER the user
// clicks the chart icon on a dashboard tile (passed as `deviceCode`), so
// dashboards with N devices don't load N histories upfront. Single read
// per range switch, cached per range while the modal is open.
//
// Self-contained: builds its own chart + insights from the shared
// utils/analyticsInsights helpers. Click outside / Esc / Close button
// dismisses. "View full chart" deep-links to /device/<code>#analytics
// when the user wants the full Device Detail experience.
export default function DeviceAnalyticsModal({ deviceCode, deviceName, tankCapacityLitres, onClose }) {
  const [range, setRange] = useState("24h");
  // Per-range cache so switching tabs back to a previously-loaded range
  // doesn't re-hit Firebase. Cleared when the modal unmounts.
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const history = cache[range];

  // Lazy load — only fires Firebase read for the currently-visible range.
  useEffect(() => {
    if (cache[range] !== undefined) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const endTs = Date.now();
    const startTs = endTs - RANGES[range].ms;
    getHistoryByRange(deviceCode, startTs, endTs)
      .then((data) => {
        if (cancelled) return;
        setCache((c) => ({ ...c, [range]: data || [] }));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Could not load history");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [deviceCode, range, cache]);

  // Dismiss on Escape so admins can flick through devices keyboard-only.
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const insights = useMemo(
    () => (history && history.length > 0 ? generateInsights(history, tankCapacityLitres) : null),
    [history, tankCapacityLitres]
  );

  // Compact chart data — just the actuals, no interpolation. The popup
  // is meant for a quick visual; interpolation is overkill at this size.
  const chartData = useMemo(() => {
    if (!history) return [];
    return history.map((h) => ({
      time: new Date(h.ts).toLocaleString([], {
        month: range === "24h" ? undefined : "short",
        day:   range === "24h" ? undefined : "numeric",
        hour: "2-digit",
        minute: range === "24h" ? "2-digit" : undefined,
      }),
      pct: h.pct,
    }));
  }, [history, range]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 truncate">{deviceName || deviceCode}</h3>
            <p className="text-xs text-gray-500">Analytics snapshot</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Range tabs */}
        <div className="flex gap-2 px-5 pt-4">
          {Object.entries(RANGES).map(([key, r]) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                range === key ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* Mini chart */}
        <div className="px-5 pt-3" style={{ height: 180 }}>
          {loading ? (
            <div className="h-full flex items-center justify-center">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
            </div>
          ) : error ? (
            <div className="h-full flex items-center justify-center text-xs text-red-600">
              {error}
            </div>
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-gray-500 bg-gray-50 rounded-lg">
              No data in this window.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" angle={-30} textAnchor="end" height={40} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
                <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => [`${v}%`, "Level"]} />
                <Line
                  type="stepAfter"
                  dataKey="pct"
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={{ r: 2, fill: "#2563eb", stroke: "#fff", strokeWidth: 1 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Insights */}
        <div className="px-5 pt-4 pb-3">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Tell me about my analytics
          </h4>
          {loading ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : !insights ? (
            <p className="text-xs text-gray-500">No data yet to summarise.</p>
          ) : !insights.enough ? (
            <p className="text-xs text-gray-500">{insights.bullets[0]}</p>
          ) : (
            <ul className="space-y-1 text-sm text-gray-700">
              {insights.bullets.map((b, i) => (
                <li key={i} className="leading-snug">{b}</li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50">
          <Link
            to={`/device/${deviceCode}#analytics`}
            onClick={onClose}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            View full chart →
          </Link>
          <button
            onClick={onClose}
            className="text-xs px-4 py-1.5 bg-gray-200 text-gray-700 rounded-lg font-medium hover:bg-gray-300"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
