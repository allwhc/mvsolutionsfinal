import { useState, useEffect, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getHistoryByRange } from "../../firebase/rtdb";
import {
  getTankerDeliveriesForDevice,
  deleteTankerOrder,
} from "../../firebase/db";
import { useAuth } from "../../context/AuthContext";
import {
  RANGES,
  calcLitres,
  generateInsights,
  MIN_POINTS_FOR_INSIGHTS,
} from "../../utils/analyticsInsights";
import { useDebugMode } from "../../context/DebugModeContext";
import { resolveLevel } from "../../utils/resolveLevel";

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



export default function AnalyticsChart({ deviceCode, tankCapacityLitres, sensorType = 1, sensorCount = 4, onHistoryLoaded }) {
  const { debugMode } = useDebugMode();
  const { user, userData, isSuperAdmin, isOrgAdmin, isOrgMember } = useAuth();
  const [range, setRange] = useState("24h");
  const [rawHistory, setRawHistory] = useState([]);
  // Tanker deliveries that touched THIS device within the chart's
  // current time range. Rendered as vertical markers. Fetched
  // separately from history since it lives in Firestore, not RTDB.
  const [tankerMarkers, setTankerMarkers] = useState([]);
  // Which marker's popover is open. Null when nothing focused.
  const [activeMarkerId, setActiveMarkerId] = useState(null);

  // Scope used to query tanker orders. Individual accounts read from
  // their own scope; org members/admin from the org's shared list.
  // Superadmin sees whichever scope owns THIS device — best-effort:
  // if the device is in a subscription for them, "user"; if they've
  // clicked into an org's device via /admin, we still show the org's
  // deliveries (superadmin has permission via rules).
  const isOrg = isOrgAdmin || isOrgMember;
  const tankerScope   = isOrg ? "org" : "user";
  const tankerScopeId = isOrg ? (userData?.orgId || null) : user?.uid;
  // Delete permission mirrors the Tankers log page: individual owner
  // OR orgAdmin OR superadmin.
  const canDeleteTanker = isSuperAdmin || (!isOrg) || isOrgAdmin;
  // Apply resolved-level transform for DIP sensors when not in debug mode.
  // Ultrasonic sensors + debug mode fall through with raw pct so the
  // installer / admin can see the true firmware output.
  const history = useMemo(() => {
    if (sensorType !== 1 || debugMode) return rawHistory;
    return rawHistory.map((h) => {
      if (h.bits == null) return h;   // pre-migration entries stay as-is
      const { pct } = resolveLevel(h.bits, sensorCount);
      return { ...h, pct };
    });
  }, [rawHistory, sensorType, sensorCount, debugMode]);
  const setHistory = setRawHistory;
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

  // Load tanker deliveries that touched this device within range.
  // Separate effect from history (different data source, different
  // update cadence). Refetches when range or scope changes; also
  // re-runs after a marker delete via bumping loadKey.
  const [tankerLoadKey, setTankerLoadKey] = useState(0);
  useEffect(() => {
    if (!tankerScopeId) { setTankerMarkers([]); return; }
    let cancelled = false;
    getTankerDeliveriesForDevice(tankerScope, tankerScopeId, deviceCode, startTs, endTs)
      .then((rows) => { if (!cancelled) setTankerMarkers(rows); })
      .catch((e) => {
        // Non-fatal — chart still renders history without markers.
        console.warn("Tanker markers fetch failed:", e);
        if (!cancelled) setTankerMarkers([]);
      });
    return () => { cancelled = true; };
  }, [deviceCode, startTs, endTs, tankerScope, tankerScopeId, tankerLoadKey]);

  async function handleDeleteMarker(orderId) {
    if (!confirm("Delete this tanker delivery from the log?\n\nThis removes the entry for every tank it filled — deletes the entire event.")) return;
    try {
      await deleteTankerOrder(orderId);
      setActiveMarkerId(null);
      setTankerLoadKey((k) => k + 1);
    } catch (e) {
      console.error("Delete tanker marker failed:", e);
      alert("Delete failed — try again");
    }
  }

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

      {/* Chart. Wrapping div holds the Recharts SVG plus an overlay
          for tanker delivery markers — vertical bars positioned by
          time percentage across the visible range. Recharts'
          ReferenceLine anchors to data-point labels which don't
          always exist at the marker's exact millis, so an
          absolute-positioned overlay is more reliable. */}
      <div
        className="bg-white rounded-lg relative"
        style={{ height: 320 }}
        onClick={() => setActiveMarkerId(null)}
      >
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

        {/* Tanker markers overlay. Positions are computed as a %
            across the plot area accounting for Recharts' YAxis
            (~48px on the left) and its right/top/bottom margins.
            Each marker is a vertical bar + a small truck icon at
            top; click to open the popover with delivery details. */}
        {tankerMarkers.length > 0 && (() => {
          const totalMs = endTs - startTs;
          if (totalMs <= 0) return null;
          // Chart plot area padding — YAxis reserves ~48px on the
          // left, right margin ~10px, top 5, bottom ~65 (X-axis
          // labels rotated). Tuned by eye — Recharts doesn't expose
          // internal chart dimensions publicly.
          const padLeft   = 48;
          const padRight  = 12;
          const padTop    = 6;
          const padBottom = 65;
          return (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ paddingLeft: padLeft, paddingRight: padRight, paddingTop: padTop, paddingBottom: padBottom }}
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
                      {/* Vertical marker line */}
                      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-cyan-500/70" />
                      {/* Truck icon button — clickable */}
                      <button
                        onClick={(e) => { e.stopPropagation(); setActiveMarkerId(isActive ? null : m.orderId); }}
                        className={`absolute -top-1 left-1/2 -translate-x-1/2 pointer-events-auto rounded-full p-1 shadow ring-2 ring-white transition-colors ${
                          isActive ? "bg-cyan-600" : "bg-cyan-500 hover:bg-cyan-600"
                        }`}
                        title="Tanker delivery — click for details"
                        aria-label="Tanker delivery marker"
                      >
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 17V10h3.5l1.5-2h3v9" />
                          <rect x="9" y="8.5" width="12" height="8" rx="3.5" />
                          <line x1="14" y1="8.5" x2="14" y2="6.5" />
                          <line x1="16" y1="8.5" x2="16" y2="6.5" />
                          <path d="M2 17h20" />
                          <circle cx="6.5" cy="19" r="1.4" />
                          <circle cx="17" cy="19" r="1.4" />
                        </svg>
                      </button>
                      {/* Popover — appears when this marker is clicked.
                          Auto-positions above the line. Delete button
                          only for those with permission. */}
                      {isActive && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute pointer-events-auto z-20 bg-white rounded-lg shadow-lg ring-1 ring-gray-200 p-3 w-56 text-xs"
                          style={{
                            // Try to keep popover on-screen: if
                            // marker is on the right half, anchor
                            // popover to the right so it doesn't
                            // overflow the chart area.
                            top: 20,
                            [pctAcross > 60 ? "right" : "left"]: pctAcross > 60 ? 8 : 8,
                            transform: pctAcross > 60 ? "translateX(0)" : "translateX(0)",
                          }}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-cyan-700 font-semibold uppercase tracking-wider text-[10px]">
                              Tanker delivery
                            </span>
                            <button
                              onClick={() => setActiveMarkerId(null)}
                              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
                              aria-label="Close"
                            >
                              ×
                            </button>
                          </div>
                          <p className="text-gray-900 font-medium">
                            {new Date(m.deliveredAt).toLocaleString([], {
                              day: "numeric", month: "short",
                              hour: "2-digit", minute: "2-digit",
                            })}
                          </p>
                          {/* Volume + water type on one line — the
                              headline stat. Property manager doesn't
                              know per-tank split, so we only show the
                              total tanker volume. */}
                          {(m.volumeL != null || m.waterType) && (
                            <p className="text-gray-800 font-medium mt-1">
                              {m.volumeL != null && (
                                m.volumeL >= 1000
                                  ? `${(m.volumeL / 1000).toFixed(m.volumeL % 1000 === 0 ? 0 : 1)} KL`
                                  : `${m.volumeL} L`
                              )}
                              {m.waterType && (
                                <span className="ml-1 text-[10px] text-gray-500 capitalize">
                                  ({m.waterType})
                                </span>
                              )}
                            </p>
                          )}
                          {/* Cost + payment status */}
                          {(m.cost != null || m.paymentStatus) && (
                            <div className="flex items-center gap-2 mt-1">
                              {m.cost != null && (
                                <span className="text-blue-700 font-medium">
                                  ₹{Number(m.cost).toLocaleString("en-IN")}
                                </span>
                              )}
                              {m.paymentStatus === "paid" && (
                                <span className="text-[10px] font-semibold text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded-full">
                                  ✓ Paid{m.paymentMode ? ` · ${m.paymentMode}` : ""}
                                </span>
                              )}
                              {m.paymentStatus === "pending" && (
                                <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                                  Pending
                                </span>
                              )}
                            </div>
                          )}
                          {/* Supplier + phone */}
                          {m.supplier && (
                            <p className="text-gray-700 mt-1.5">
                              <span className="text-gray-500">Supplier:</span> {m.supplier}
                              {m.supplierPhone && (
                                <a href={`tel:${m.supplierPhone}`} className="text-blue-600 hover:underline block">
                                  {m.supplierPhone}
                                </a>
                              )}
                            </p>
                          )}
                          {/* Vehicle + driver */}
                          {m.vehicleNo && (
                            <p className="text-gray-700 mt-1">
                              <span className="text-gray-500">Vehicle:</span>{" "}
                              <span className="font-mono">{m.vehicleNo}</span>
                            </p>
                          )}
                          {m.driverName && (
                            <p className="text-gray-700">
                              <span className="text-gray-500">Driver:</span> {m.driverName}
                              {m.driverPhone && (
                                <a href={`tel:${m.driverPhone}`} className="text-blue-600 hover:underline ml-1">
                                  · {m.driverPhone}
                                </a>
                              )}
                            </p>
                          )}
                          {m.receivedBy && (
                            <p className="text-gray-700 mt-1">
                              <span className="text-gray-500">Received by:</span> {m.receivedBy}
                            </p>
                          )}
                          {m.otherTanks.length > 0 && (
                            <div className="mt-1.5 pt-1.5 border-t border-gray-100">
                              <span className="text-gray-500">Also filled:</span>{" "}
                              <span className="text-gray-700">
                                {m.otherTanks.map((t) => t.tankName).join(", ")}
                              </span>
                            </div>
                          )}
                          {m.notes && (
                            <p className="text-gray-500 mt-1.5 italic truncate" title={m.notes}>
                              {m.notes}
                            </p>
                          )}
                          {canDeleteTanker && (
                            <button
                              onClick={() => handleDeleteMarker(m.orderId)}
                              className="mt-2 w-full text-xs text-red-600 hover:bg-red-50 py-1.5 rounded border border-red-200"
                            >
                              Delete this delivery
                            </button>
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

      {/* Insights panel — collapsed by default, expand on click */}
      <div className="mt-3 border-t border-gray-100 pt-3">
        <button
          onClick={() => setShowInsights((s) => !s)}
          className="w-full flex items-center justify-between text-sm font-semibold text-gray-700 hover:text-blue-700"
        >
          <span>💬 Tell me about my tank ({RANGES[range].label})</span>
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
