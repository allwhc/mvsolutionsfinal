// Tank Comparison Analytics (Beta)
//
// Standalone mode     : pick up to 10 tanks, see combined headlines, hour
//                       chart, ranked consumption, and click-expand per-tank
//                       hour patterns.
// OHT Fill Analysis   : pick 1 source + 1-9 OHTs it feeds. See daily
//                       sump-level change vs OHT delivery, pump activity by
//                       hour, delivery share across OHTs. We DO NOT claim
//                       efficiency — most sumps have municipal inflow so
//                       drawn-vs-delivered math isn't valid at level-sensor
//                       alone. SenseFlow panel CTA promotes true metering.
//
// Data flow:
//   1. Admin picks tanks (searchable list) + 1 or 2 months
//   2. Click "Run analysis" → IndexedDB cache checked first
//   3. Cache miss → consume one quota unit, fetch /history per tank for
//      the whole range, clean each with cleanHistoryForAnalytics(),
//      cache the result
//   4. Render the appropriate sections for the chosen mode
//
// Monthly quota default is 10 analyses per org, auto-reset at month
// boundary. Super-admin can edit the limit per-org in future.

import { useState, useMemo, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { useDevices } from "../hooks/useDevices";
import { getHistoryByRange } from "../firebase/rtdb";
import { readCompareQuota, consumeCompareQuota } from "../firebase/compareQuota";
import { getCachedCompare, putCachedCompare, clearCompareCache } from "../firebase/compareCache";
import { cleanHistoryForAnalytics } from "../utils/analyticsInsights";
import { correlateSourceToTerraces } from "../utils/sourceTerraceCorrelation";
import { buildCompareCsv, suggestedCsvFilename, suggestedPdfFilename } from "../utils/compareCsv";
import { perTankTotals, buildHeadlines, combinedHourlyConsumption } from "../utils/compareAnalytics";
import { resolveLevel } from "../utils/resolveLevel";
import CompareHeadlines from "../components/Analytics/CompareHeadlines";
import CompareHourChart from "../components/Analytics/CompareHourChart";
import CompareRankBars from "../components/Analytics/CompareRankBars";
import CompareSourceTerrace from "../components/Analytics/CompareSourceTerrace";
import { useDebugMode } from "../context/DebugModeContext";

const MAX_TANKS = 10;

function pickCompareCandidates(devices) {
  return devices
    .filter((d) => (d.info?.deviceClass ?? d.catalog?.deviceClass ?? 2) === 2)
    .map((d) => ({
      deviceCode:         d.deviceCode,
      deviceName:         d.deviceName || d.deviceCode,
      tankCapacityLitres: d.tankCapacityLitres || 0,
      sensorType:         d.info?.sensorType ?? d.catalog?.sensorType ?? 1,
      sensorCount:        d.info?.sensorCount ?? d.catalog?.sensorCount ?? 4,
    }));
}

const PERIOD_OPTIONS = [
  { value: 1, label: "Last 1 month"  },
  { value: 2, label: "Last 2 months" },
];

// Range = last N whole months ending now. Includes today. IST boundaries
// aren't strictly honoured (we use ms since epoch), but accuracy to ±5½ hrs
// at the month edge doesn't change the analytics meaningfully.
function periodRangeMs(months) {
  const endTs = Date.now();
  const d = new Date(endTs);
  d.setMonth(d.getMonth() - months);
  return { startTs: d.getTime(), endTs };
}

function periodKey(months) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-last${months}m`;
}

function resolveDipHistory(rawHistory, device, debugMode) {
  if (device.sensorType !== 1 || debugMode) return rawHistory;
  return rawHistory.map((h) => {
    if (h.bits == null) return h;
    const { pct } = resolveLevel(h.bits, device.sensorCount);
    return { ...h, pct };
  });
}

export default function TankCompare() {
  const { userData, isOrgAdmin, isSuperAdmin } = useAuth();
  const { devices, loading: devicesLoading } = useDevices();
  const { debugMode } = useDebugMode();

  const candidates = useMemo(() => pickCompareCandidates(devices), [devices]);
  const [months, setMonths] = useState(1);
  const [mode,   setMode]   = useState("standalone");   // "standalone" | "source_terrace"
  const [selected, setSelected] = useState([]);
  const [sourceCode, setSourceCode] = useState(null);
  const [search, setSearch] = useState("");
  const [quota, setQuota] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const orgId   = userData?.orgId || null;
  const orgName = userData?.orgName || "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const q = await readCompareQuota(orgId);
        if (!cancelled) setQuota(q);
      } catch {
        if (!cancelled) setQuota({ enabled: true, limit: 10, used: 0, remaining: 10, resetMonth: "", nextReset: "" });
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  // Filter candidates by search box. Matches on tank name OR device code,
  // case-insensitive. Empty search = show everything.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) =>
      (c.deviceName || "").toLowerCase().includes(q) ||
      (c.deviceCode || "").toLowerCase().includes(q)
    );
  }, [candidates, search]);

  const toggleSelected = (code) => {
    setSelected((prev) => {
      if (prev.includes(code)) {
        if (sourceCode === code) setSourceCode(null);
        return prev.filter((c) => c !== code);
      }
      if (prev.length >= MAX_TANKS) return prev;
      return [...prev, code];
    });
  };

  const selectAllVisible = () => {
    const codes = visible.map((v) => v.deviceCode);
    const next  = Array.from(new Set([...selected, ...codes])).slice(0, MAX_TANKS);
    setSelected(next);
  };

  const clearAll = () => {
    setSelected([]);
    setSourceCode(null);
    setResult(null);
    setError(null);
  };

  const canRun = selected.length >= 2
    && (mode === "standalone" || (mode === "source_terrace" && sourceCode && selected.includes(sourceCode)));

  const run = async () => {
    if (!canRun || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const selectedDevices = selected
        .map((code) => candidates.find((c) => c.deviceCode === code))
        .filter(Boolean);

      const cacheKey = [...selected, `m${months}`];
      const cached   = await getCachedCompare(orgId, periodKey(months), cacheKey);
      let tankData;

      if (cached?.tanks) {
        tankData = cached.tanks;
      } else {
        if (quota && quota.remaining <= 0) {
          setError(`Monthly quota completed — refreshes on ${quota.nextReset}.`);
          setLoading(false);
          return;
        }
        if (quota && !quota.enabled) {
          setError("Tank comparison is not enabled for this organisation.");
          setLoading(false);
          return;
        }
        const { startTs, endTs } = periodRangeMs(months);
        const histories = await Promise.all(
          selectedDevices.map((d) => getHistoryByRange(d.deviceCode, startTs, endTs, true))
        );
        tankData = selectedDevices.map((d, i) => ({
          device:  d,
          history: resolveDipHistory(histories[i] || [], d, debugMode),
        }));
        await putCachedCompare(orgId, periodKey(months), cacheKey, { tanks: tankData });
        try {
          await consumeCompareQuota(orgId);
          const q = await readCompareQuota(orgId);
          setQuota(q);
        } catch { /* ignore */ }
      }

      const tanks = tankData.map((t) => ({
        device:       t.device,
        rawHistory:   t.history,
        cleanHistory: cleanHistoryForAnalytics(t.history || [], t.device.sensorType || 2),
      }));

      const perTank    = perTankTotals(tanks);
      const headlines  = buildHeadlines(perTank);
      const hourly     = combinedHourlyConsumption(tanks);

      let correlation = null;
      let sourceDev   = null;
      let terraceDevs = [];
      let sourceClean = null;
      let terraceClean = [];
      if (mode === "source_terrace" && sourceCode) {
        const source   = tanks.find((t) => t.device.deviceCode === sourceCode);
        const terraces = tanks.filter((t) => t.device.deviceCode !== sourceCode);
        if (source && terraces.length > 0) {
          sourceDev   = source.device;
          terraceDevs = terraces.map((t) => t.device);
          sourceClean = source.cleanHistory;
          terraceClean = terraces.map((t) => t.cleanHistory);
          correlation = correlateSourceToTerraces({
            source:                  sourceDev,
            terraces:                terraceDevs,
            cleanedSourceHistory:    sourceClean,
            cleanedTerraceHistories: terraceClean,
          });
        }
      }

      // Range in days for per-day averages in the headline. Based on
      // the period selector (1 or 2 months).
      const periodDays = months * 30;

      setResult({ tanks, perTank, headlines, hourly, correlation, sourceDev, terraceDevs, sourceClean, terraceClean, periodDays });
    } catch (e) {
      setError(e.message || "Failed to load comparison data.");
    } finally {
      setLoading(false);
    }
  };

  const periodLabel = PERIOD_OPTIONS.find((p) => p.value === months)?.label || "";

  const downloadCsv = () => {
    if (!result?.tanks) return;
    const blob = buildCompareCsv({
      orgName,
      periodLabel,
      tanks: result.tanks.map((t) => ({ device: t.device, history: t.cleanHistory })),
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedCsvFilename(orgName, periodLabel);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Scoped print trigger. We flip `body.tank-compare-print` right before
  // window.print() so the @media print rules in index.css take effect:
  //   - hides Navbar + app chrome
  //   - removes layout max-width so charts span the page
  //   - reveals the .print-only report header (SenseFlow brand + title +
  //     org + period + generated-at)
  //   - adds break-inside: avoid so chart cards stay whole
  //
  // We ALSO swap document.title momentarily — browsers use the page
  // title as the default "Save as PDF" filename in the print dialog,
  // so this gives users a meaningful default instead of the site's
  // base title. Restored on afterprint.
  //
  // afterprint fires even when the user cancels the print dialog, so
  // both title and body class always clean up.
  const printReport = () => {
    const body = document.body;
    const prevTitle = document.title;
    const onAfter = () => {
      body.classList.remove("tank-compare-print");
      document.title = prevTitle;
      window.removeEventListener("afterprint", onAfter);
    };
    window.addEventListener("afterprint", onAfter);
    body.classList.add("tank-compare-print");
    document.title = suggestedPdfFilename(orgName, periodLabel);
    window.print();
  };

  if (!isOrgAdmin && !isSuperAdmin) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Tank Comparison Analytics</h1>
        <p className="text-gray-600">This feature is available to organisation administrators only.</p>
      </div>
    );
  }

  if (devicesLoading) {
    return <div className="max-w-5xl mx-auto p-6 text-gray-600">Loading tanks…</div>;
  }

  return (
    <div className="max-w-6xl mx-auto p-6 pb-24 print:p-0 print:max-w-none">
      {/* Header */}
      <div className="mb-6 print:mb-3">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          Tank Comparison Analytics
          <span className="text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 rounded-full px-2 py-0.5">Beta</span>
        </h1>
        <p className="text-sm text-gray-600 mt-1 max-w-3xl">
          This is an evolving analytics tool. Metrics improve as more history accumulates. Based on tank-level readings; actual flow may vary.
        </p>
      </div>

      {/* Quota */}
      {quota && (
        <div className={`mb-6 rounded-lg border p-3 text-sm print:hidden ${
          quota.remaining > 0 ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-rose-50 border-rose-200 text-rose-900"
        }`}>
          {quota.remaining > 0
            ? <><span className="font-medium">{quota.remaining} of {quota.limit}</span> analyses available this month</>
            : <>Monthly quota completed — refreshes on <span className="font-medium">{quota.nextReset}</span></>
          }
        </div>
      )}

      {/* Controls */}
      <section className="rounded-lg border border-gray-200 bg-white p-4 mb-6 print:hidden">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Set up comparison</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Mode</label>
            <select
              value={mode}
              onChange={(e) => { setMode(e.target.value); setSourceCode(null); setResult(null); }}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            >
              <option value="standalone">Standalone comparison</option>
              <option value="source_terrace">OHT fill analysis (source → OHT)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Period</label>
            <select
              value={months}
              onChange={(e) => { setMonths(Number(e.target.value)); setResult(null); }}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            >
              {PERIOD_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button
              onClick={run}
              disabled={!canRun || loading || (quota && quota.remaining <= 0)}
              className="flex-1 bg-blue-600 text-white rounded px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700"
            >
              {loading ? "Loading…" : "Run analysis"}
            </button>
          </div>
        </div>

        {/* Picker */}
        <div>
          <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
            <label className="text-xs font-medium text-gray-700">
              Select tanks
              <span className="ml-2 text-gray-500 font-normal">
                {selected.length}/{MAX_TANKS} selected · {visible.length} of {candidates.length} tank{candidates.length !== 1 ? "s" : ""}{search ? " shown" : ""}
              </span>
              {mode === "source_terrace" && selected.length > 0 && !sourceCode && (
                <span className="ml-2 text-amber-700">pick a source tank below</span>
              )}
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={selectAllVisible}
                disabled={visible.length === 0 || selected.length >= MAX_TANKS}
                className="text-xs rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Select all visible
              </button>
              <button
                onClick={clearAll}
                disabled={selected.length === 0 && !result}
                className="text-xs rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Clear all
              </button>
            </div>
          </div>

          <div className="mb-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tanks — try 'oht', 'ug', 'drinking'…"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>

          {candidates.length === 0 ? (
            <p className="text-sm text-gray-500">
              No tanks available. Tank Comparison works with ultrasonic and DIP level sensors.
            </p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-gray-500 italic">No tanks match "{search}".</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto border border-gray-200 rounded p-2 bg-gray-50">
              {visible.map((c) => {
                const isSelected = selected.includes(c.deviceCode);
                const isSource   = sourceCode === c.deviceCode;
                const limitHit   = !isSelected && selected.length >= MAX_TANKS;
                return (
                  <div
                    key={c.deviceCode}
                    className={`rounded border p-2 text-sm transition ${
                      isSelected ? "bg-blue-50 border-blue-300" : "bg-white border-gray-200 hover:border-gray-300"
                    } ${limitHit ? "opacity-50 pointer-events-none" : ""}`}
                  >
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelected(c.deviceCode)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 truncate">{c.deviceName}</div>
                        <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                          <span>{c.sensorType === 1 ? "DIP" : "Ultrasonic"}</span>
                          <span>•</span>
                          {c.tankCapacityLitres > 0
                            ? <span>{c.tankCapacityLitres.toLocaleString()} L</span>
                            : <span className="text-amber-700">%-only (no capacity set)</span>
                          }
                        </div>
                      </div>
                    </label>
                    {mode === "source_terrace" && isSelected && (
                      <label className="flex items-center gap-1 mt-1.5 text-xs cursor-pointer">
                        <input
                          type="radio"
                          name="sourceTank"
                          checked={isSource}
                          onChange={() => setSourceCode(c.deviceCode)}
                        />
                        <span className={isSource ? "font-medium text-gray-900" : "text-gray-600"}>Mark as source</span>
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {error && (
          <p className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{error}</p>
        )}
      </section>

      {/* Results */}
      {result && (
        <div className="space-y-6">
          {/* Top strip: period + download buttons */}
          <div className="flex items-center justify-between gap-3 flex-wrap print:hidden">
            <div className="text-sm text-gray-700">
              <span className="font-semibold">{result.tanks.length}</span> tanks compared · <span className="font-semibold">{periodLabel}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={downloadCsv}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Download CSV
              </button>
              <button
                onClick={printReport}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                Download report (PDF)
              </button>
              <button
                onClick={() => { clearCompareCache(); run(); }}
                disabled={loading || (quota && quota.remaining <= 0)}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Discard cached data and re-fetch (uses one quota unit)"
              >
                Refresh data
              </button>
            </div>
          </div>

          {/* Print-only report masthead. Logo + brand wordmark + tagline
              on the left, org/period/timestamp on the right. Visible
              ONLY in print (hidden on screen by `print-only hidden` +
              the @media print rule in index.css that reveals it). The
              on-screen view has the Navbar providing its own brand. */}
          <div className="print-only hidden mb-5 pb-4 border-b-2" style={{ borderColor: "#1a2e5a" }}>
            <div className="flex items-start justify-between gap-6">
              <div className="flex items-center gap-3">
                <img
                  src="/android-chrome-192x192.png"
                  alt=""
                  style={{ width: 56, height: 56 }}
                />
                <div>
                  <div className="text-2xl font-bold leading-tight" style={{ color: "#1a2e5a" }}>SenseFlow</div>
                  <div className="text-xs text-gray-600 leading-tight">Smart Water Management Solution</div>
                  <div className="text-sm font-semibold text-gray-900 mt-1.5">
                    Tank Comparison Analytics Report
                  </div>
                  <div className="text-xs text-gray-500">
                    {mode === "source_terrace" ? "OHT fill analysis" : "Standalone comparison"}
                  </div>
                </div>
              </div>
              <div className="text-right text-xs text-gray-700">
                <div className="font-semibold text-gray-900 text-sm">{orgName || "—"}</div>
                <div className="mt-0.5">{periodLabel}</div>
                <div>{result.tanks.length} tanks compared</div>
                <div className="mt-1.5 text-gray-500">
                  Generated {new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16)} IST
                </div>
              </div>
            </div>
          </div>

          {mode === "standalone" && (
            <>
              <CompareHeadlines headlines={result.headlines} />
              <CompareHourChart hourly={result.hourly} />
              <CompareRankBars tanks={result.tanks} perTank={result.perTank} />
              {/* Product promotion — same 4 products as OHT fill mode but
                  with standalone-framing intro. Duplicated inline per
                  explicit choice; keep copy aligned when editing either.
                  See CompareSourceTerrace.jsx → PanelCta for the mirror. */}
              <section className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
                <h3 className="text-sm font-semibold text-indigo-900 mb-1">Extend your analytics with more SenseFlow devices</h3>
                <p className="text-sm text-indigo-900 mb-3">
                  Level sensors show percentage and volume held in the tank. The following SenseFlow products add actual flow measurement, remote valve control, and pump monitoring to this dashboard:
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="rounded-md bg-white border border-indigo-200 p-3">
                    <div className="text-sm font-semibold text-indigo-900 mb-1">SenseFlow Flowmeter</div>
                    <p className="text-xs text-indigo-900">
                      Measure actual litres delivered or consumed, not just level change. Catches slow leaks that don't show up as a tank-level drop, and gives a true per-outlet breakdown.
                    </p>
                  </div>
                  <div className="rounded-md bg-white border border-indigo-200 p-3">
                    <div className="text-sm font-semibold text-indigo-900 mb-1">SenseFlow Smart Valves</div>
                    <p className="text-xs text-indigo-900">
                      Open and close water lines remotely — society gate valves, tanker inlets, selective per-tank fills. Automate using level thresholds already visible on your dashboard.
                    </p>
                  </div>
                  <div className="rounded-md bg-white border border-indigo-200 p-3">
                    <div className="text-sm font-semibold text-indigo-900 mb-1">SenseFlow Panel Monitoring</div>
                    <p className="text-xs text-indigo-900">
                      Non-invasive add-on for your existing pump starter panel. Reports pump run-time, current draw, and fault events so you can catch stuck pumps and dry-run damage early.
                    </p>
                  </div>
                  <div className="rounded-md bg-white border border-indigo-200 p-3">
                    <div className="text-sm font-semibold text-indigo-900 mb-1">SenseFlow Panel Controller</div>
                    <p className="text-xs text-indigo-900">
                      Full pump automation: auto start/stop by tank level, schedules, force-run, pause/resume, dry-run protection, safe-mode recovery, and remote control from the dashboard.
                    </p>
                  </div>
                </div>
                <p className="text-xs text-indigo-800 mt-3">Contact your SenseFlow installer to add any of these to your setup.</p>
              </section>
            </>
          )}

          {mode === "source_terrace" && result.correlation && (
            <CompareSourceTerrace
              correlation={result.correlation}
              source={result.sourceDev}
              terraces={result.terraceDevs}
              cleanedSourceHistory={result.sourceClean}
              cleanedTerraceHistories={result.terraceClean}
              days={result.periodDays}
            />
          )}

          <p className="text-xs text-gray-500 print:text-[10px]">
            Chart values are spike-filtered and smoothed with a 10-minute moving average, same as the standalone tank analytics. Numbers derived from tank-level readings; for billing-grade metering use a flow meter.
          </p>
        </div>
      )}
    </div>
  );
}
