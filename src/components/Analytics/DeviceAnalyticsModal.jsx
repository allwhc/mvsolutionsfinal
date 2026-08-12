import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getHistoryByRange } from "../../firebase/rtdb";
import { getTankerDeliveriesForDevice } from "../../firebase/db";
import { useAuth } from "../../context/AuthContext";
import { RANGES, generateInsights, detectSpikes } from "../../utils/analyticsInsights";
import { useDebugMode } from "../../context/DebugModeContext";
import { resolveLevel } from "../../utils/resolveLevel";

// Lightweight analytics popup. Fires a Firebase read only AFTER the user
// clicks the chart icon on a dashboard tile (passed as `deviceCode`), so
// dashboards with N devices don't load N histories upfront. Single read
// per range switch, cached per range while the modal is open.
//
// Self-contained: builds its own chart + insights from the shared
// utils/analyticsInsights helpers. Click outside / Esc / Close button
// dismisses. "View full chart" deep-links to /device/<code>#analytics
// when the user wants the full Device Detail experience.
// Same forward-fill logic as AnalyticsChart — every interpolated grid
// point inherits the most recent actual value (from before the range if
// available). Grid points BEFORE the first-ever actual stay null so brand
// new devices don't get a fake steady line painted across time they
// didn't exist. Same behavior as Device Detail chart.
function interpolate(history, startTs, endTs, stepMs) {
  const gridTimes = [];
  for (let t = startTs; t <= endTs; t += stepMs) gridTimes.push(t);
  const actuals = history.filter((h) => h.ts >= startTs && h.ts <= endTs);
  const actualSet = new Set(actuals.map((a) => a.ts));
  const merged = [];
  for (const a of actuals) merged.push({ ts: a.ts, pct: a.pct, source: "actual" });
  for (const t of gridTimes) {
    if (!actualSet.has(t)) merged.push({ ts: t, pct: null, source: "interpolated" });
  }
  merged.sort((a, b) => a.ts - b.ts);

  let lastKnown = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].ts < startTs) { lastKnown = history[i].pct ?? null; break; }
  }

  for (const row of merged) {
    if (row.source === "actual") lastKnown = row.pct;
    else row.pct = lastKnown;
  }
  return merged;
}

export default function DeviceAnalyticsModal({ deviceCode, deviceName, tankCapacityLitres, currentPct, currentBits, sensorType = 1, sensorCount = 4, onClose }) {
  const { debugMode } = useDebugMode();
  const { user, userData, isOrgAdmin, isOrgMember } = useAuth();
  const isOrg = isOrgAdmin || isOrgMember;
  const tankerScope   = isOrg ? "org" : "user";
  const tankerScopeId = isOrg ? (userData?.orgId || null) : user?.uid;
  // Tanker deliveries for this tank within the current range. Same
  // source as the DeviceDetail chart; popup shows a tiny truck icon
  // + minimal tooltip (no delete — popup is a quick-glance view).
  const [tankerMarkers, setTankerMarkers] = useState([]);
  const [activeMarkerId, setActiveMarkerId] = useState(null);
  const [range, setRange] = useState("24h");
  // Per-range cache so switching tabs back to a previously-loaded range
  // doesn't re-hit Firebase. Cleared when the modal unmounts.
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const rawHistory = cache[range];
  // Same "resolved level" transform as AnalyticsChart on Device Detail —
  // hides probe faults from the customer, opt-in to see raw via the
  // dashboard header debug toggle. DIP only; ultrasonic passes through.
  const history = useMemo(() => {
    if (rawHistory == null) return rawHistory;
    if (sensorType !== 1 || debugMode) return rawHistory;
    return rawHistory.map((h) => {
      if (h.bits == null) return h;
      const { pct } = resolveLevel(h.bits, sensorCount);
      return { ...h, pct };
    });
  }, [rawHistory, sensorType, sensorCount, debugMode]);

  // Apply the same transform to the live "seed" so a device with a
  // faulty probe doesn't paint 0% across the chart when history is empty.
  const seedPct = useMemo(() => {
    if (currentPct == null) return null;
    if (sensorType !== 1 || debugMode || currentBits == null) return currentPct;
    return resolveLevel(currentBits, sensorCount).pct;
  }, [currentPct, currentBits, sensorType, sensorCount, debugMode]);

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

  // Tanker markers fetch — separate from history. Runs when range or
  // scope changes; results feed the overlay on top of the mini chart.
  useEffect(() => {
    if (!tankerScopeId) { setTankerMarkers([]); return; }
    let cancelled = false;
    const endTs = Date.now();
    const startTs = endTs - RANGES[range].ms;
    getTankerDeliveriesForDevice(tankerScope, tankerScopeId, deviceCode, startTs, endTs)
      .then((rows) => { if (!cancelled) setTankerMarkers(rows); })
      .catch(() => { if (!cancelled) setTankerMarkers([]); });
    return () => { cancelled = true; };
  }, [deviceCode, range, tankerScope, tankerScopeId]);

  // Dismiss on Escape so admins can flick through devices keyboard-only.
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const insights = useMemo(
    // Pass the resolved seedPct so sparse-history windows still get a
    // "tank at X%" message with the same resolved level the dashboard
    // shows — never the raw firmware pct that would confuse the customer.
    () => (history != null ? generateInsights(history, tankCapacityLitres, seedPct, sensorType) : null),
    [history, tankCapacityLitres, seedPct, sensorType]
  );

  // Interpolated chart data — matches Device Detail chart behaviour.
  // Forward-fills the last known level across the window so a steady
  // tank shows as a continuous line rather than an empty chart.
  const chartData = useMemo(() => {
    if (!history) return [];
    const endTs = Date.now();
    const r = RANGES[range];
    const startTs = endTs - r.ms;
    // Popup chart has no "Actual values only" toggle — always the
    // smooth default view. Drop spike rows entirely so the mini
    // chart reads clean, matching the primary DeviceDetail chart's
    // default view. Ultrasonic-only (detectSpikes no-ops for DIP).
    const { spikeIndices } = detectSpikes(history || [], sensorType);
    const spikeTs = new Set();
    for (const idx of spikeIndices) if ((history || [])[idx]) spikeTs.add(history[idx].ts);
    const rows = spikeTs.size === 0
      ? (history || [])
      : (history || []).filter((h) => !spikeTs.has(h.ts));
    const interp = interpolate(rows, startTs, endTs, r.stepMs);
    return interp.map((p) => ({
      time: new Date(p.ts).toLocaleString([], {
        month: range === "24h" ? undefined : "short",
        day:   range === "24h" ? undefined : "numeric",
        hour: "2-digit",
        minute: range === "24h" ? "2-digit" : undefined,
      }),
      pct: p.pct,
      isActual: p.source === "actual",
      // isSpike never true in popup — spikes filtered out entirely.
      isSpike: false,
    }));
  }, [history, range, sensorType]);

  const hasChartData = chartData.some((p) => p.pct != null);

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

        {/* Mini chart — with tanker markers overlay for ultrasonic +
            DIP alike. Same source + logic as DeviceDetail's full
            chart, just smaller. No delete button (quick-glance
            popup); user opens full Device Detail to manage. */}
        <div className="px-5 pt-3 relative" style={{ height: 180 }}
             onClick={() => setActiveMarkerId(null)}>
          {loading ? (
            <div className="h-full flex items-center justify-center">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
            </div>
          ) : error ? (
            <div className="h-full flex items-center justify-center text-xs text-red-600">
              {error}
            </div>
          ) : !hasChartData ? (
            <div className="h-full flex items-center justify-center text-xs text-gray-500 bg-gray-50 rounded-lg text-center px-4">
              No level changes in this window yet — chart will fill as your tank refills or drains.
            </div>
          ) : (
            <>
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
                    dot={(props) => {
                      if (!props.payload?.isActual) return null;
                      const isSpike = props.payload?.isSpike;
                      return (
                        <circle
                          key={`dot-${props.index}`}
                          cx={props.cx}
                          cy={props.cy}
                          r={isSpike ? 4 : 3}
                          fill={isSpike ? "#f97316" : "#2563eb"}
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

              {/* Tanker markers overlay — same positioning strategy
                  as DeviceDetail's full chart. Reduced padding since
                  this chart is smaller (XAxis height 40 vs 60). */}
              {tankerMarkers.length > 0 && (() => {
                const endTs = Date.now();
                const startTs = endTs - RANGES[range].ms;
                const totalMs = endTs - startTs;
                if (totalMs <= 0) return null;
                const padLeft = 48, padRight = 12, padTop = 6, padBottom = 45;
                return (
                  <div
                    className="absolute inset-0 pointer-events-none"
                    style={{ paddingLeft: padLeft, paddingRight: padRight, paddingTop: padTop, paddingBottom: padBottom, marginTop: 12 }}
                  >
                    <div className="relative w-full h-full">
                      {tankerMarkers.map((m) => {
                        const pctAcross = ((m.deliveredAt - startTs) / totalMs) * 100;
                        if (pctAcross < 0 || pctAcross > 100) return null;
                        const isActive = activeMarkerId === m.orderId;
                        return (
                          <div
                            key={m.orderId}
                            className="absolute top-0 bottom-0"
                            style={{ left: `${pctAcross}%`, transform: "translateX(-50%)" }}
                          >
                            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-cyan-500/70" />
                            <button
                              onClick={(e) => { e.stopPropagation(); setActiveMarkerId(isActive ? null : m.orderId); }}
                              className={`absolute -top-2 left-1/2 -translate-x-1/2 pointer-events-auto rounded-full p-1 shadow ring-2 ring-white transition-colors ${
                                isActive ? "bg-cyan-600" : "bg-cyan-500 hover:bg-cyan-600"
                              }`}
                              title="Tanker delivery — click for details"
                              aria-label="Tanker delivery marker"
                            >
                              {/* Popup chart is tiny (10px displayed);
                                  full detail becomes mud. Drop the
                                  hatch tabs + chassis so cab + tank
                                  + wheels stay legible. Silhouette
                                  still reads as tanker. */}
                              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2 17V10h3.5l1.5-2h3v9" />
                                <rect x="9" y="8.5" width="12" height="8" rx="3.5" />
                                <circle cx="6.5" cy="19" r="1.4" />
                                <circle cx="17" cy="19" r="1.4" />
                              </svg>
                            </button>
                            {isActive && (
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="absolute pointer-events-auto z-20 bg-white rounded-lg shadow-lg ring-1 ring-gray-200 p-2.5 w-52 text-xs"
                                style={{ top: 16, [pctAcross > 60 ? "right" : "left"]: 6 }}
                              >
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-cyan-700 font-semibold uppercase tracking-wider text-[10px]">Tanker</span>
                                  <button onClick={() => setActiveMarkerId(null)} className="text-gray-400 hover:text-gray-600 text-base leading-none">×</button>
                                </div>
                                <p className="text-gray-900 font-medium">
                                  {new Date(m.deliveredAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                                </p>
                                {(m.volumeL != null || m.waterType) && (
                                  <p className="text-gray-800 mt-1">
                                    {m.volumeL != null && (m.volumeL >= 1000 ? `${(m.volumeL/1000).toFixed(m.volumeL%1000===0?0:1)} KL` : `${m.volumeL} L`)}
                                    {m.waterType && <span className="ml-1 text-[10px] text-gray-500 capitalize">({m.waterType})</span>}
                                  </p>
                                )}
                                {m.supplier && <p className="text-gray-700 mt-0.5">{m.supplier}</p>}
                                {m.otherTanks.length > 0 && (
                                  <p className="text-gray-500 text-[11px] mt-1 pt-1 border-t border-gray-100">
                                    Also: {m.otherTanks.map((t) => t.tankName).join(", ")}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>

        {/* Insights */}
        <div className="px-5 pt-4 pb-3">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Tell me about my tank{deviceName ? ` — ${deviceName}` : ""}
          </h4>
          {loading ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : !insights ? (
            <p className="text-xs text-gray-500">Tank has been steady.</p>
          ) : !insights.enough ? (
            <>
              <p className="text-xs text-gray-500">{insights.bullets[0]}</p>
              <p className="text-[10px] text-gray-400 italic mt-2 pt-2 border-t border-gray-200">
                This is an approximation. For highly accurate data, install SenseFlow flowmeters.
              </p>
            </>
          ) : (
            <ul className="space-y-1 text-sm text-gray-700">
              {insights.bullets.map((b, i) => (
                <li key={i} className="leading-snug">{b}</li>
              ))}
              <li className="leading-snug text-[10px] text-gray-400 italic pt-1 border-t border-gray-200 mt-1">
                This is an approximation. For highly accurate data, install SenseFlow flowmeters.
              </li>
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
