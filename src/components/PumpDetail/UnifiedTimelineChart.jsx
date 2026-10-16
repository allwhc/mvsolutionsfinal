// Unified timeline chart — the marquee visualization for pump analytics.
//
// Layers all three data streams onto one time axis:
//   • Tank line (blue area) — terrace pct over time. Drawn from
//     history entries with type="terrace" (pct field 0/50/100 for
//     discrete probes; 0-100 granular when ultrasonic ships later).
//     Rendered as a step function (level holds until next transition).
//
//   • Pump bars (amber) — pump on/off periods, positioned in a
//     dedicated band above the source strip. Drawn from history
//     entries with type="run" (paired-run entries have onTs + offTs).
//
//   • Source strip (green/red) — ground water availability. Drawn
//     from history entries with type="source" (wet/dry transitions).
//
// One SVG, pure client-side, no library dependency. Same rendering
// approach as the daily bar chart and heatmap already in AnalyticsTab.
//
// Reveals patterns the individual charts can't:
//   – fill rate (slope of blue line while amber bar is present)
//   – consumption rate (slope while amber is absent)
//   – wasted pump cycles (amber bar with flat blue = fault / dry-run)
//   – source-dependency (red strip periods coincide with tank drops)
//   – degradation over months (steeper vs shallower fill slopes)

import { useMemo, useState, useRef, useEffect } from "react";
import { fmtDuration } from "../../utils/pumpAnalytics";

// Time-range presets. Values are HOURS. Granular short options let
// customer zoom into recent events (last few minutes of a fill cycle)
// without needing a drag interaction that's error-prone on touch.
const RANGES = [
  { key: "15m", hours: 0.25,   label: "15 min" },
  { key: "30m", hours: 0.5,    label: "30 min" },
  { key: "1h",  hours: 1,      label: "1 hour" },
  { key: "3h",  hours: 3,      label: "3 hours" },
  { key: "6h",  hours: 6,      label: "6 hours" },
  { key: "24h", hours: 24,     label: "24 hours" },
  { key: "7d",  hours: 24 * 7, label: "7 days" },
  { key: "30d", hours: 24 * 30, label: "30 days" },
];

// v118.0.8: readable CSV export. Previous version wrote one row per
// event with blank columns + ISO UTC timestamps (…Z suffix) — operators
// couldn't open it in Excel and understand what state the system was
// in at any given moment. Rewrite:
//   • Local time in device's timezone, formatted DD-MMM-YYYY HH:MM:SS
//   • Every row carries the FULL state (tank % + pump state + source
//     state) using the step-chart carry-forward convention, so an
//     operator can scan ANY row and see what was true at that moment
//   • Event + cause columns say what CHANGED at that timestamp
//   • Human-readable headers in Title Case for spreadsheet column labels
function downloadWindowCSV({ tankPoints, pumpRuns, sourceSegments, tMin, tMax, deviceLabel }) {
  // Step 1: collect every distinct timestamp in the window with an
  // "event tag" describing what changed. Multiple events at the same
  // millisecond collapse into one row with event tags joined by ";".
  const eventsByTs = new Map();
  const bump = (ts, tag, cause) => {
    if (ts == null) return;
    const key = Math.round(ts);
    const entry = eventsByTs.get(key) || { ts: key, tags: [], causes: [] };
    entry.tags.push(tag);
    if (cause) entry.causes.push(cause);
    eventsByTs.set(key, entry);
  };
  for (const p of tankPoints)      bump(p.ts, "tank_reading");
  for (const r of pumpRuns) {
    bump(r.start, "pump_on",  r.cause);
    bump(r.end,   "pump_off", r.cause);
  }
  for (const s of sourceSegments)  bump(s.start, "source_change");

  // Step 2: sort unique timestamps, then step-sample tank + pump + source
  // at each one so the row carries the FULL state. This is the same
  // carry-forward model the chart uses — tank step-holds last reading,
  // pump looks at run containment, source looks at segment containment.
  const sortedEvents = Array.from(eventsByTs.values()).sort((a, b) => a.ts - b.ts);
  function tankAt(ts) {
    let v = null;
    for (const p of tankPoints) { if (p.ts <= ts) v = p.pct; else break; }
    return v;
  }
  function pumpAt(ts) {
    for (const r of pumpRuns) { if (r.start <= ts && ts <= r.end) return "ON"; }
    return "off";
  }
  function sourceAt(ts) {
    for (const s of sourceSegments) { if (s.start <= ts && ts <= s.end) return s.wet ? "present" : "absent"; }
    return "";
  }
  // Local time formatter — device operator reads in their timezone.
  // DD-MMM-YYYY HH:MM:SS — unambiguous (no US m/d/y vs d/m/y confusion).
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const fmtLocal = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const rows = [["Timestamp", "Tank %", "Pump", "Source", "Event", "Cause"]];
  for (const e of sortedEvents) {
    const tank   = tankAt(e.ts);
    const pump   = pumpAt(e.ts);
    const source = sourceAt(e.ts);
    rows.push([
      fmtLocal(e.ts),
      tank == null ? "" : `${tank}%`,
      pump,
      source,
      e.tags.join(";"),
      Array.from(new Set(e.causes)).join(";"),
    ]);
  }

  const csv = rows.map((r) => r.map((c) => {
    const s = String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  // Local-time filename too — easier to find later in Downloads folder.
  const fnameTs = (ms) => fmtLocal(ms).replace(/[: ]/g, "-");
  a.href = url;
  a.download = `${deviceLabel || "pump"}_${fnameTs(tMin)}_to_${fnameTs(tMax)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function UnifiedTimelineChart({ history, live, deviceLabel, tankVolumeL, hasSource = true }) {
  const [rangeKey, setRangeKey] = useState("24h");
  // v118.0.6: "Show raw points" toggle — when ON, overlay a dot at
  // every actual history data point so customer can see where readings
  // came from vs where the chart interpolated. Matches tank-monitor
  // dashboard pattern.
  const [showRaw, setShowRaw] = useState(false);
  // v118.0.8: match the History tab's "Show short events (<1 min)"
  // toggle — same semantics applied to the pump bars on this chart and
  // the CSV export. Default OFF so the timeline isn't visually spammed
  // with feedback-blip ticks that aren't real pump work.
  const [showShortRuns, setShowShortRuns] = useState(false);
  // v118.0.7: click-to-select a pump run on the chart; the detail card
  // below shows per-run metrics (ΔtankPct, duration, estimated litres).
  const [selectedRunIdx, setSelectedRunIdx] = useState(null);
  const range = RANGES.find((r) => r.key === rangeKey) || RANGES.find((r) => r.key === "24h");
  // Custom date/time window: explicit [start, end] ms override for the
  // preset range. Set via the "Custom range" picker. Null when using a
  // preset — preset dictates the view.
  const [customWindow, setCustomWindow] = useState(null);
  // Picker open state — controls the custom range modal.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Filter history by time window + split into three streams. Pass
  // `live` so splitHistory can anchor the "current" value at the right
  // edge — otherwise the line would just carry the LAST HISTORY point
  // forward, which can be an hour old if nothing changed meanwhile.
  const { tankPoints, tankLiveAnchor, pumpRuns: allPumpRuns, sourceSegments, tMin, tMax, empty } = useMemo(
    () => splitHistory(history, range.hours, customWindow, live),
    [history, range.hours, customWindow, live]
  );
  // v118.0.8: apply the short-run filter at chart level too so the
  // amber bars match what History tab shows. 60-sec cutoff matches the
  // HistoryTable threshold in PumpDetail.jsx.
  const pumpRuns = useMemo(() => {
    if (showShortRuns) return allPumpRuns;
    return allPumpRuns.filter((r) => (r.end - r.start) >= 60_000);
  }, [allPumpRuns, showShortRuns]);
  // Reset selection when the filter changes — selectedRunIdx indexes
  // into the FILTERED pumpRuns array; keeping it across filter flips
  // would land on the wrong run or an undefined slot.
  useEffect(() => { setSelectedRunIdx(null); }, [showShortRuns, rangeKey, customWindow]);

  // Reset custom window whenever the preset range changes — customer
  // clicking a preset button wants that view, not a lingering custom one.
  function handleRangeChange(nextKey) {
    setCustomWindow(null);
    setRangeKey(nextKey);
  }
  function handleCustomApply(startMs, endMs) {
    setCustomWindow([startMs, endMs]);
    setPickerOpen(false);
  }

  const header = (
    <ChartHeader
      rangeKey={rangeKey}
      onRangeChange={handleRangeChange}
      isCustom={!!customWindow}
      customWindow={customWindow}
      onOpenPicker={() => setPickerOpen(true)}
      onClearCustom={() => setCustomWindow(null)}
    />
  );

  return (
    <>
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
        {header}
        <div className="flex items-center justify-between flex-wrap gap-2 mt-1 mb-3">
          <p className="text-xs text-gray-500">
            <strong>Hover</strong> for exact tank / pump / source values at any moment.
          </p>
          <div className="flex items-center gap-3">
            {/* v118.0.6: show-raw toggle — DEFAULT OFF shows a clean
                smooth line (interpolation hidden from UI entirely); when
                ON, overlay actual data-point dots + dashed interpolation
                hints so an installer can audit where readings came from.
                Per Vishal: don't surface "interpolated" language unless
                the customer explicitly asks for raw data. */}
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showShortRuns}
                onChange={(e) => setShowShortRuns(e.target.checked)}
                className="w-3.5 h-3.5"
              />
              Show short events (&lt;1 min)
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showRaw}
                onChange={(e) => setShowRaw(e.target.checked)}
                className="w-3.5 h-3.5"
              />
              Show raw data points
            </label>
            {/* v118.0.7: CSV download of the currently-visible window. */}
            {!empty && (
              <button
                type="button"
                onClick={() => downloadWindowCSV({ tankPoints, pumpRuns, sourceSegments, tMin, tMax, deviceLabel })}
                className="text-xs text-blue-700 hover:text-blue-900 border border-blue-200 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded-md font-medium"
                title="Download the chart's current time range as CSV"
              >
                ⬇ CSV
              </button>
            )}
          </div>
        </div>
        {empty ? (
          <p className="text-sm text-gray-500 text-center py-8">
            No pump, tank, or source events recorded in this time range.
          </p>
        ) : (
          <>
            <ChartCanvas
              tankPoints={tankPoints}
              tankLiveAnchor={tankLiveAnchor}
              pumpRuns={pumpRuns}
              sourceSegments={hasSource ? sourceSegments : []}
              hasSource={hasSource}
              tMin={tMin}
              tMax={tMax}
              showRaw={showRaw}
              tankVolumeL={tankVolumeL}
              onSelectRun={setSelectedRunIdx}
              selectedRunIdx={selectedRunIdx}
            />
            <Legend showRaw={showRaw} hasSource={hasSource} />
            {selectedRunIdx != null && pumpRuns[selectedRunIdx] && (
              <PumpRunDetailCard
                run={pumpRuns[selectedRunIdx]}
                tankPoints={tankPoints}
                tankLiveAnchor={tankLiveAnchor}
                tankVolumeL={tankVolumeL}
                onClose={() => setSelectedRunIdx(null)}
              />
            )}
          </>
        )}
      </div>

      {/* Custom range picker modal — from/to datetime inputs. */}
      {pickerOpen && (
        <CustomRangePicker
          initialStart={customWindow ? customWindow[0] : Date.now() - 6 * 3600 * 1000}
          initialEnd={customWindow ? customWindow[1] : Date.now()}
          onApply={handleCustomApply}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

function ChartHeader({ rangeKey, onRangeChange, isCustom, customWindow, onOpenPicker, onClearCustom }) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-2">
      <h3 className="font-semibold text-gray-800">📊 Unified timeline</h3>
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {/* Preset row */}
        <div className="flex items-center gap-1 flex-wrap justify-end">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => onRangeChange(r.key)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                rangeKey === r.key && !isCustom
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >{r.label}</button>
          ))}
          {/* Custom range button — outlined so it stands apart from presets */}
          <button
            onClick={onOpenPicker}
            className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
              isCustom
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
            }`}
            title="Pick specific date and time range"
          >
            📅 Custom
          </button>
        </div>
        {/* When custom is active, show the range summary + clear */}
        {isCustom && customWindow && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-600">
              {new Date(customWindow[0]).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              {" → "}
              {new Date(customWindow[1]).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
            </span>
            <button
              onClick={onClearCustom}
              className="text-orange-600 hover:text-orange-700 font-medium"
              title="Clear custom range"
            >× Clear</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Custom range picker modal — two datetime-local inputs (from, to)
// plus quick shortcuts for common backward windows relative to a
// chosen end time. Validates end > start; disables Apply when invalid.
function CustomRangePicker({ initialStart, initialEnd, onApply, onClose }) {
  // datetime-local expects "YYYY-MM-DDTHH:MM" format in local time.
  const toLocalInput = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [startStr, setStartStr] = useState(toLocalInput(initialStart));
  const [endStr,   setEndStr]   = useState(toLocalInput(initialEnd));

  const startMs = new Date(startStr).getTime();
  const endMs   = new Date(endStr).getTime();
  const valid = isFinite(startMs) && isFinite(endMs) && endMs > startMs;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-lg text-gray-900 mb-1">Custom time range</h3>
        <p className="text-xs text-gray-500 mb-4">Pick the exact start and end date/time for the timeline.</p>

        <label className="block text-xs text-gray-600 mb-1">From</label>
        <input
          type="datetime-local"
          value={startStr}
          onChange={(e) => setStartStr(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3"
        />
        <label className="block text-xs text-gray-600 mb-1">To</label>
        <input
          type="datetime-local"
          value={endStr}
          onChange={(e) => setEndStr(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4"
        />

        {!valid && (
          <p className="text-red-600 text-xs mb-3">End time must be after start time.</p>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
            Cancel
          </button>
          <button
            onClick={() => onApply(startMs, endMs)}
            disabled={!valid}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            Apply range
          </button>
        </div>
      </div>
    </div>
  );
}

// v118.0.7: when customer clicks a pump bar on the chart, show the run's
// details — duration, tank % delta over the run, litres filled, and the
// equivalent per-hour fill rate. "Filled" is estimated as (endPct -
// startPct) × tankVolume ÷ 100 — needs tankVolumeL to compute; shows a
// placeholder when tank volume isn't configured on the device.
//
// Start/end pct come from the nearest tank reading at the run boundary,
// using the step-chart's carry-forward convention. If the tank sensor
// was faulted during the run, both edges may read the same value → we
// show "no fill data" instead of "0 L" which would be misleading.
function PumpRunDetailCard({ run, tankPoints, tankLiveAnchor, tankVolumeL, onClose }) {
  const durationSec = Math.max(0, Math.round((run.end - run.start) / 1000));
  function pctAt(ts) {
    let v = null;
    for (const p of tankPoints) {
      if (p.ts <= ts) v = p.pct;
      else break;
    }
    if (v == null && tankPoints.length > 0) v = tankPoints[0].pct;
    if (tankLiveAnchor && ts >= tankLiveAnchor.ts) v = tankLiveAnchor.pct;
    return v;
  }
  const startPct = pctAt(run.start);
  const endPct   = pctAt(run.end);
  const deltaPct = (startPct != null && endPct != null) ? (endPct - startPct) : null;
  const litres   = (deltaPct != null && typeof tankVolumeL === "number" && tankVolumeL > 0)
                   ? Math.round((deltaPct / 100) * tankVolumeL)
                   : null;
  const hours    = durationSec / 3600;
  const minutes  = durationSec / 60;
  const litresPerHour   = (litres != null && hours > 0)   ? Math.round(litres / hours)   : null;
  // v118.0.13: L/min alongside L/h — more intuitive for small tanks (6
  // L/min reads better than 360 L/h). One decimal when < 10 so slow
  // fills (0.5 L/min) stay useful. Both shown; operator picks whichever
  // framing clicks.
  const litresPerMin    = (litres != null && minutes > 0) ? (litres / minutes)           : null;
  const litresPerMinStr = litresPerMin == null ? null
                          : (litresPerMin >= 10 ? Math.round(litresPerMin).toString()
                                                 : litresPerMin.toFixed(1));
  return (
    <div className="mt-4 bg-blue-50 border border-blue-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-blue-900">
          Pump run · {new Date(run.start).toLocaleString()}
        </div>
        <button
          onClick={onClose}
          className="text-blue-700 hover:text-blue-900 text-sm leading-none"
          title="Close"
        >× Close</button>
      </div>
      <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Metric label="Duration" value={fmtDuration(durationSec)} />
        <Metric
          label="Tank change"
          value={deltaPct != null ? `${startPct}% → ${endPct}%` : "—"}
          sub={deltaPct != null ? `${deltaPct >= 0 ? "+" : ""}${deltaPct}%` : null}
        />
        <Metric
          label="Litres filled"
          value={litres != null ? `${litres.toLocaleString()} L` : "—"}
          sub={tankVolumeL ? `tank: ${tankVolumeL.toLocaleString()} L` : "set tank volume to compute"}
        />
        <Metric
          label="Fill rate"
          value={litresPerMinStr != null ? `${litresPerMinStr} L/min` : "—"}
          sub={litresPerHour != null
                 ? `${litresPerHour.toLocaleString()} L/h${run.cause ? ` · cause: ${run.cause}` : ""}`
                 : (run.cause ? `cause: ${run.cause}` : null)}
        />
      </div>
    </div>
  );
}
function Metric({ label, value, sub }) {
  return (
    <div>
      <div className="text-xs text-blue-700 uppercase tracking-wide">{label}</div>
      <div className="text-base font-semibold text-blue-950">{value}</div>
      {sub && <div className="text-xs text-blue-600 mt-0.5">{sub}</div>}
    </div>
  );
}

function Legend({ showRaw, hasSource = true }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
      <div className="flex items-center gap-1.5">
        <svg width="16" height="10" viewBox="0 0 16 10">
          <line x1="1" y1="5" x2="15" y2="5" stroke="#2563eb" strokeWidth="2.5" />
          <circle cx="8" cy="5" r="2.5" fill="#2563eb" stroke="#fff" strokeWidth="1" />
        </svg>
        <span>Terrace tank level</span>
      </div>
      {/* "Interpolated" legend only when raw mode is ON — otherwise the
          customer sees a clean solid line and doesn't need the concept. */}
      {showRaw && (
        <div className="flex items-center gap-1.5">
          <svg width="16" height="10" viewBox="0 0 16 10">
            <line x1="1" y1="5" x2="15" y2="5" stroke="#60a5fa" strokeWidth="2" strokeDasharray="2,1.5" opacity="0.75" />
          </svg>
          <span>Interpolated (no new data)</span>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-4 h-3 rounded-sm" style={{ backgroundColor: "#fcd34d", opacity: 0.6 }} />
        <span>Pump running</span>
      </div>
      {hasSource && (
        <>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: "#22c55e" }} />
            <span>Source water present</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: "#ef4444" }} />
            <span>Source dry</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Data preparation ─────────────────────────────────────────────
// Firmware history event shapes:
//   type="run":     { onTs, offTs, causeStart, causeEnd, terraceStart, terraceEnd,
//                     sourceStart, sourceEnd, runSec, ... }  (unix seconds)
//   type="terrace": { state: "empty|half|full|sensor_fault", pct?: number, ts: ms }
//   type="source":  { state: "wet|dry", ts: ms }
//
// RTDB server timestamps come back as MILLISECONDS for the /history push
// (ts/.sv=timestamp), but the paired-run entries use unix SECONDS from
// on-device time() calls. Normalize everything to milliseconds here so
// the chart math is consistent.
function toMillis(v) {
  if (typeof v !== "number" || !isFinite(v) || v <= 0) return null;
  return v > 1e12 ? v : v * 1000;
}
function pctFromState(state, pctField) {
  if (typeof pctField === "number") return pctField;
  return state === "full" ? 100
       : state === "half" ? 50
       : state === "empty" ? 0
       : null;   // sensor_fault → skip
}

function splitHistory(history, windowHours, zoomWindow, live) {
  const now = Date.now();
  // Zoom overrides preset: when zoomed, use the explicit [start, end]
  // range. This flows through everything (filter, sourceSegments
  // padding, chart canvas x-axis) uniformly.
  const winStart = zoomWindow ? zoomWindow[0] : (now - windowHours * 3600 * 1000);
  const winEnd   = zoomWindow ? zoomWindow[1] : now;
  const inWindow = (ms) => ms != null && ms >= winStart && ms <= winEnd + 1;

  // v118.0.9: analytics 0%-drop bug fix. The chart was dropping to 0%
  // every time the pump turned on because paired-run history entries
  // seed tank from the terrace ENUM at the run's start/end — and on
  // ultrasonic devices the enum ("empty"/"half"/"full") only reflects
  // whether the discrete-probe stubs crossed the start/stop threshold,
  // not the actual pct. A tank sitting at 21% has terraceStart="empty"
  // → pctFromState returns 0 → chart jams a 0% point at pump-start
  // timestamp, overwriting the real 21% from the granular reading.
  //
  // Detection: if ANY granular `type==="terrace"` entry carries a
  // numeric h.pct within the window, we assume ultrasonic firmware
  // and skip pump-run tank seeding entirely. Discrete-probe devices
  // never set numeric h.pct → fallback keeps working for them.
  let hasGranularTerrace = false;
  for (const h of history || []) {
    if (h && h.type === "terrace" && typeof h.pct === "number" && inWindow(toMillis(h.ts))) {
      hasGranularTerrace = true;
      break;
    }
  }

  const tank = [];        // { ts: ms, pct: 0-100 }
  const pumpRuns = [];    // { start: ms, end: ms, cause: str }
  const sources = [];     // { ts: ms, wet: bool }

  // v118.0.7: track the LAST pre-window value for tank + source so we
  // can seed the window-start with "state as of the moment the window
  // begins", instead of dropping pre-window history entirely. Without
  // this, a 30-min view that opens AFTER the last transition shows
  // either (a) no data OR (b) the first in-window point carried
  // backward, which contradicts what the 24-hour view would show at
  // the same timestamp. Classic bug: 24h view = 100% at 23:27 (because
  // last transition was at 18:50 → 100 carried forward); 30m view at
  // 23:27 showed something different because the carry-backward of
  // the first in-window point ignored the earlier 100%.
  let preWindowTankPct = null;
  let preWindowTankTs  = -Infinity;
  let preWindowSourceWet = null;
  let preWindowSourceTs  = -Infinity;

  for (const h of history || []) {
    if (!h) continue;
    if (h.type === "run") {
      const s = toMillis(h.onTs);
      const e = toMillis(h.offTs);
      if (s == null) continue;
      // Some old rows may have onTs but no offTs — treat end as start+runSec.
      const end = e ?? (h.runSec ? s + h.runSec * 1000 : s);
      // Track pre-window state via run start/end before deciding to drop.
      // v118.0.9: skip enum-sourced tank values on ultrasonic devices
      // (granular readings exist and are more accurate).
      const pctS = hasGranularTerrace ? null : pctFromState(h.terraceStart);
      const pctE = hasGranularTerrace ? null : pctFromState(h.terraceEnd);
      if (pctS != null && s < winStart && s > preWindowTankTs) {
        preWindowTankTs = s; preWindowTankPct = pctS;
      }
      if (pctE != null && end < winStart && end > preWindowTankTs) {
        preWindowTankTs = end; preWindowTankPct = pctE;
      }
      if (h.sourceStart && s < winStart && s > preWindowSourceTs) {
        preWindowSourceTs = s; preWindowSourceWet = h.sourceStart === "wet";
      }
      if (h.sourceEnd && end < winStart && end > preWindowSourceTs) {
        preWindowSourceTs = end; preWindowSourceWet = h.sourceEnd === "wet";
      }
      if (!inWindow(s) && !inWindow(end)) continue;
      pumpRuns.push({
        start: Math.max(s, winStart),
        end:   Math.min(end, winEnd),
        cause: h.causeStart || "auto",
      });
      // Paired-run entries also seed tank + source at start and end —
      // useful when standalone terrace/source events are missing (older
      // firmware without v117.0.14 event emission).
      if (pctS != null && inWindow(s)) tank.push({ ts: s, pct: pctS });
      if (pctE != null && inWindow(end)) tank.push({ ts: end, pct: pctE });
      if (h.sourceStart && inWindow(s)) sources.push({ ts: s, wet: h.sourceStart === "wet" });
      if (h.sourceEnd   && inWindow(end)) sources.push({ ts: end, wet: h.sourceEnd === "wet" });
    } else if (h.type === "terrace") {
      const ts = toMillis(h.ts);
      const pct = pctFromState(h.state, h.pct);
      if (pct == null) continue;
      if (ts != null && ts < winStart && ts > preWindowTankTs) {
        preWindowTankTs = ts; preWindowTankPct = pct;
      }
      if (!inWindow(ts)) continue;
      tank.push({ ts, pct });
    } else if (h.type === "source") {
      const ts = toMillis(h.ts);
      if (ts != null && ts < winStart && ts > preWindowSourceTs) {
        preWindowSourceTs = ts; preWindowSourceWet = h.state === "wet";
      }
      if (!inWindow(ts)) continue;
      sources.push({ ts, wet: h.state === "wet" });
    }
  }

  // v118.0.7: inject a synthetic point AT winStart carrying the pre-
  // window value forward. This is what makes "state as of now" views
  // consistent across different time ranges — a 30-min view ending at
  // 23:27 shows the same tank value at 23:27 as a 24-hour view would.
  if (preWindowTankPct != null) {
    tank.push({ ts: winStart, pct: preWindowTankPct });
  }
  if (preWindowSourceWet != null) {
    sources.push({ ts: winStart, wet: preWindowSourceWet });
  }

  // Sort each stream chronologically.
  tank.sort((a, b) => a.ts - b.ts);
  sources.sort((a, b) => a.ts - b.ts);
  pumpRuns.sort((a, b) => a.start - b.start);

  // Dedupe consecutive tank points with identical pct (only real
  // transitions matter for the step chart).
  const tankPoints = [];
  for (const p of tank) {
    const last = tankPoints[tankPoints.length - 1];
    if (last && last.pct === p.pct) continue;
    tankPoints.push(p);
  }

  // Convert source transitions to segments. Each segment spans from its
  // ts to the next transition's ts (or window end). Sink initial state
  // by carrying the FIRST seen state backward to window start so the
  // strip isn't blank at the left edge.
  const sourceSegments = [];
  for (let i = 0; i < sources.length; i++) {
    const endTs = i + 1 < sources.length ? sources[i + 1].ts : winEnd;
    if (i === 0 && sources[0].ts > winStart) {
      // Left-edge padding: assume same state before we have data.
      sourceSegments.push({ start: winStart, end: sources[0].ts, wet: sources[0].wet });
    }
    sourceSegments.push({
      start: sources[i].ts,
      end:   endTs,
      wet:   sources[i].wet,
    });
  }

  // v118.0.6: live anchor at NOW using the current /live snapshot.
  // Used by chart canvas to draw a DASHED interpolation segment from
  // the last history point to NOW with the current live value. Without
  // this, the forward-carry would use the stale pct from the last
  // transition event (potentially 30+ minutes old).
  //
  // Only used when the live timestamp is fresh (<10 min) AND the sensor
  // isn't flagged as faulted — otherwise we'd be drawing fiction.
  //
  // v118.0.7: for OFFLINE devices (live stale or sensor faulted), still
  // forward-carry from the last-known history value to the right edge
  // of the window — just at `tMax` rather than at live's ts, and
  // without pretending we have a fresh reading. The chart was previously
  // ending the line at the last history point mid-window for offline
  // devices, leaving a confusing blank right-portion. "Last known state"
  // is more useful than nothing.
  let tankLiveAnchor = null;
  const liveTs = toMillis(live?.ts);
  const liveFresh = liveTs && (now - liveTs) < 10 * 60 * 1000;
  const liveSensorHealthy = !live?.terraceSensorFault;
  if (liveFresh && liveSensorHealthy && typeof live?.terracePct === "number") {
    tankLiveAnchor = { ts: Math.min(now, winEnd), pct: live.terracePct };
  } else if (tankPoints.length > 0) {
    // No usable live reading — carry the last history point forward to
    // the right edge of the window using its own pct. Marks as stale
    // so the renderer can style it differently (future enhancement —
    // for now just carries the line through).
    const lastTank = tankPoints[tankPoints.length - 1];
    if (lastTank.ts < winEnd) {
      tankLiveAnchor = { ts: winEnd, pct: lastTank.pct, stale: true };
    }
  }

  // Source live anchor — same idea for the source strip. If no source
  // transitions in the window but we have a current state in /live,
  // extend that back across the whole window as a flat segment.
  if (sourceSegments.length === 0 && liveFresh && live?.sourceState) {
    sourceSegments.push({
      start: winStart,
      end:   winEnd,
      wet:   live.sourceState === "wet",
      interpolated: true,   // marks for dashed/translucent render
    });
  } else if (sourceSegments.length > 0 && liveFresh && live?.sourceState) {
    // Extend the last known segment forward to live's current state —
    // if the state hasn't changed, just extend to winEnd (already done
    // in the loop above). If live says state changed since last history
    // event, add a new segment from that last event's end to winEnd.
    const lastSeg = sourceSegments[sourceSegments.length - 1];
    const liveWet = live.sourceState === "wet";
    if (lastSeg.wet !== liveWet && lastSeg.end < winEnd) {
      sourceSegments.push({
        start: lastSeg.end,
        end:   winEnd,
        wet:   liveWet,
        interpolated: true,
      });
    }
  }

  const empty = tankPoints.length === 0 && pumpRuns.length === 0 && sourceSegments.length === 0 && !tankLiveAnchor;
  return {
    tankPoints,
    tankLiveAnchor,
    pumpRuns,
    sourceSegments,
    tMin: winStart,
    tMax: winEnd,
    empty,
  };
}

// ─── SVG canvas ────────────────────────────────────────────────────
// Redesigned layout — LINE chart, not filled area. The blue LINE traces
// tank level over time; amber SHADED REGIONS behind the line show when
// the pump was running. Correlation between pump activity and tank rise
// is instantly visible — "line rose here because pump was on".
//
// viewBox 1000×280 units:
//   30..220  → tank line area (0-100% on y axis; 190 units tall)
//   235..255 → pump-run marker band (thin — bars are just a marker;
//              the primary pump signal is the amber shading behind the line)
//   260..278 → source strip
//
// Padding: 40 on left (y-labels), 12 on right.
function ChartCanvas({ tankPoints, tankLiveAnchor, pumpRuns, sourceSegments, tMin, tMax, showRaw, tankVolumeL, onSelectRun, selectedRunIdx, hasSource = true }) {
  const W = 1000;
  const PADL = 88;     // wide gutter so "Source"/"Pump" 18px labels fit clearly
  const PADR = 20;
  const chartW = W - PADL - PADR;

  // Bigger bands — chart is more compelling when each stream has room
  // to breathe. Tank line gets the primary real estate; pump + source
  // bands are chunkier so status is legible at a glance.
  const TANK_TOP = 34,  TANK_BOT = 254;    // 220 units tall
  const PUMP_TOP = 274, PUMP_BOT = 302;    // 28 units
  const SRC_TOP  = 316, SRC_BOT  = 344;    // 28 units — matches Pump for symmetry
  const totalH = 390;                       // room for x-axis labels below

  const xFor = (ts) => PADL + ((ts - tMin) / (tMax - tMin)) * chartW;
  const yForPct = (pct) => TANK_BOT - (pct / 100) * (TANK_BOT - TANK_TOP);

  // v118.0.6: build tank paths based on mode.
  // showRaw=OFF (default): one SOLID continuous path from left edge to
  //   current moment, interpolation stitched invisibly — customer sees
  //   one clean line, no "interpolated" labels, no distinction.
  // showRaw=ON (installer audit mode): SOLID between actual history
  //   points, DASHED for interpolated regions (before first point AND
  //   after last point), so customer can see exactly where real data ended.
  let tankLinePath   = "";    // SOLID
  let leftFillerPath = "";    // DASHED (showRaw only)
  let rightFillerPath = "";   // DASHED (showRaw only)

  if (tankPoints.length > 0) {
    const first = tankPoints[0];
    const firstX = xFor(first.ts);
    const firstY = yForPct(first.pct);
    const last = tankPoints[tankPoints.length - 1];
    const lastX = xFor(last.ts);
    const lastY = yForPct(last.pct);

    // Build the "between actual data" step path. Always needed.
    let coreSegment = `M ${firstX} ${firstY} `;
    for (let i = 1; i < tankPoints.length; i++) {
      const p = tankPoints[i];
      const x = xFor(p.ts);
      const y = yForPct(p.pct);
      coreSegment += `L ${x} ${yForPct(tankPoints[i - 1].pct)} L ${x} ${y} `;
    }

    // Right-edge extension to live anchor OR tMax.
    let rightSegment = "";
    if (tankLiveAnchor) {
      const anchorX = xFor(tankLiveAnchor.ts);
      const anchorY = yForPct(tankLiveAnchor.pct);
      rightSegment = `M ${lastX} ${lastY} L ${anchorX} ${lastY} L ${anchorX} ${anchorY}`;
      if (anchorX < xFor(tMax)) rightSegment += ` L ${xFor(tMax)} ${anchorY}`;
    } else {
      rightSegment = `M ${lastX} ${lastY} L ${xFor(tMax)} ${lastY}`;
    }

    // Left-edge extension from tMin to first point (horizontal at firstY).
    const leftSegment = (first.ts > tMin)
      ? `M ${xFor(tMin)} ${firstY} L ${firstX} ${firstY}`
      : "";

    if (showRaw) {
      // Installer mode — split paths for different stroke styles.
      tankLinePath    = coreSegment;
      leftFillerPath  = leftSegment;
      rightFillerPath = rightSegment;
    } else {
      // Clean mode — ONE continuous solid path, interpolation invisible.
      tankLinePath = (leftSegment ? `${leftSegment} ` : "") + coreSegment + " " + rightSegment;
    }
  } else if (tankLiveAnchor) {
    // No history in window but live has current pct — flat line across.
    const anchorY = yForPct(tankLiveAnchor.pct);
    const flatPath = `M ${xFor(tMin)} ${anchorY} L ${xFor(tMax)} ${anchorY}`;
    if (showRaw) {
      rightFillerPath = flatPath;
    } else {
      tankLinePath = flatPath;
    }
  }

  // Y-axis grid + labels — 0/25/50/75/100.
  const yGridLevels = [0, 25, 50, 75, 100];

  // X-axis tick labels — up to 6 evenly spaced.
  const xTickCount = 6;
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => tMin + (i / xTickCount) * (tMax - tMin));
  const fmtTick = (ms) => {
    const d = new Date(ms);
    if (tMax - tMin <= 25 * 3600 * 1000) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    return d.toLocaleDateString([], { day: "2-digit", month: "short" });
  };

  // ── Hover state — crosshair + tooltip ──
  // Mouse position tracking converts client pixels to viewBox coords
  // via the SVG's own bounding rect, then to a timestamp via xFor's
  // inverse. All three data streams sampled at that timestamp to build
  // a "what was everything at time T" tooltip.
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const [hoverX, setHoverX] = useState(null);      // in viewBox X coords
  const [hoverPx, setHoverPx] = useState(null);    // in wrapper client pixels (for tooltip positioning)

  function onMove(e) {
    const svg = svgRef.current;
    const wrap = wrapRef.current;
    if (!svg || !wrap) return;
    const rect = svg.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    if (relX < 0 || relX > rect.width) { setHoverX(null); return; }
    const vbX = (relX / rect.width) * W;
    if (vbX < PADL || vbX > W - PADR) { setHoverX(null); return; }
    setHoverX(vbX);
    const wrapRect = wrap.getBoundingClientRect();
    setHoverPx({
      x: e.clientX - wrapRect.left,
      y: e.clientY - wrapRect.top,
    });
  }
  function onLeave() { setHoverX(null); setHoverPx(null); }

  // Convert hoverX (viewBox coord) → timestamp → sample each stream.
  const hover = useMemo(() => {
    if (hoverX == null) return null;
    const ts = tMin + ((hoverX - PADL) / chartW) * (tMax - tMin);
    // Tank: find the most recent point at or before ts; carry level forward.
    // v118.0.6: also consider tankLiveAnchor as the right-edge value, AND
    // if hovering BEFORE first data point but we have ANY data, use the
    // first point's value as interpolated. Matches the visual chart —
    // if the line is drawn through that x, hover should show the value.
    let tankPct = null;
    for (const p of tankPoints) {
      if (p.ts <= ts) tankPct = p.pct;
      else break;
    }
    // If no past point AND we have any data at all, use the first point's
    // pct (chart draws horizontal interpolation to the first point).
    if (tankPct == null && tankPoints.length > 0) {
      tankPct = tankPoints[0].pct;
    }
    // If hover is past the last data point AND we have a live anchor
    // ahead of our last found value, use the live value for right-of-last.
    if (tankLiveAnchor && (tankPoints.length === 0 || ts >= tankPoints[tankPoints.length - 1].ts)) {
      // If hover is at or past the live anchor's ts, show live value;
      // otherwise show the carried-forward last-known (already set above).
      if (ts >= tankLiveAnchor.ts || tankPoints.length === 0) {
        tankPct = tankLiveAnchor.pct;
      }
    }
    // Pump: is there a run whose [start, end] contains ts?
    const pumpRun = pumpRuns.find((r) => r.start <= ts && ts <= r.end);
    // Source: find the segment containing ts.
    const sourceSeg = sourceSegments.find((s) => s.start <= ts && ts <= s.end);
    return {
      ts,
      tankPct,
      pumpRunning: !!pumpRun,
      pumpCause: pumpRun ? pumpRun.cause : null,
      sourceWet: sourceSeg ? sourceSeg.wet : null,
    };
  }, [hoverX, tankPoints, tankLiveAnchor, pumpRuns, sourceSegments, tMin, tMax, chartW, PADL]);

  return (
    <div ref={wrapRef} className="w-full overflow-x-auto relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${totalH}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-96 select-none"
        onMouseMove={onMove}
        onMouseLeave={onLeave}>
        {/* Faint background for the tank chart area — makes the plot
            surface distinct from the marker bands below. */}
        <rect x={PADL} y={TANK_TOP} width={chartW} height={TANK_BOT - TANK_TOP}
          fill="#fafafa" />

        {/* Pump-run shading BEHIND the line — semi-transparent amber
            columns spanning the full tank chart height at times when
            the pump was running. This is the primary visual signal:
            you SEE the line rise inside amber regions. Rendered before
            gridlines so the grid stays visible over the shading. */}
        {pumpRuns.map((r, i) => {
          const x1 = xFor(r.start);
          const x2 = xFor(r.end);
          const w = Math.max(x2 - x1, 2);
          const fill = r.cause === "force" || r.cause === "manual_button" ? "#fbbf24" : "#fcd34d";
          return (
            <rect
              key={`ps-${i}`}
              x={x1} y={TANK_TOP} width={w} height={TANK_BOT - TANK_TOP}
              fill={fill}
              opacity="0.35"
            >
              <title>{`Pump ${r.cause} — ${new Date(r.start).toLocaleString()} to ${new Date(r.end).toLocaleString()} (${fmtDuration((r.end - r.start) / 1000)})`}</title>
            </rect>
          );
        })}

        {/* Horizontal gridlines + y-axis labels for tank chart */}
        {yGridLevels.map((lv) => {
          const y = yForPct(lv);
          return (
            <g key={lv}>
              <line x1={PADL} y1={y} x2={W - PADR} y2={y}
                stroke={lv === 0 || lv === 100 ? "#d1d5db" : "#e5e7eb"}
                strokeWidth="1"
                strokeDasharray={lv === 0 || lv === 100 ? "" : "2,3"} />
              <text x={PADL - 10} y={y + 6} fontSize="16" fontWeight="600" fill="#374151" textAnchor="end">{lv}%</text>
            </g>
          );
        })}

        {/* Tank level LINE — the primary signal. Thick blue stroke,
            no fill. Step function reveals discrete transitions clearly. */}
        {/* Left-edge dashed interpolation — only in showRaw mode. In
            clean mode this is merged into the single solid tankLinePath. */}
        {showRaw && leftFillerPath && (
          <path d={leftFillerPath} fill="none" stroke="#93c5fd" strokeWidth="2.5" strokeDasharray="5,4" opacity="0.6" />
        )}
        {/* SOLID — between actual history data points */}
        {tankLinePath && (
          <>
            <path d={tankLinePath} fill="none" stroke="#1e40af" strokeWidth="4" strokeLinejoin="round" opacity="0.15" />
            <path d={tankLinePath} fill="none" stroke="#2563eb" strokeWidth="3" strokeLinejoin="round" />
          </>
        )}
        {/* DASHED interpolation path — only in showRaw (installer) mode.
            In clean mode this gets merged into tankLinePath above. */}
        {showRaw && rightFillerPath && (
          <path d={rightFillerPath} fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeDasharray="6,4" opacity="0.75" />
        )}
        {/* Live anchor dot — shown only in showRaw mode so clean mode
            doesn't have UI chrome at the edge. */}
        {showRaw && tankLiveAnchor && (
          <circle
            cx={xFor(tankLiveAnchor.ts)}
            cy={yForPct(tankLiveAnchor.pct)}
            r="5"
            fill="#fff" stroke="#2563eb" strokeWidth="2.5"
          >
            <title>{`Current: ${tankLiveAnchor.pct}% (live)`}</title>
          </circle>
        )}

        {/* Data-point dots — shown ONLY in raw mode. Clean mode presents
            a single uncluttered line. */}
        {showRaw && tankPoints.map((p, i) => (
          <circle
            key={`tp-${i}`}
            cx={xFor(p.ts)} cy={yForPct(p.pct)}
            r="5"
            fill="#2563eb" stroke="#fff" strokeWidth="2"
          >
            <title>{`${p.pct}% at ${new Date(p.ts).toLocaleString()}`}</title>
          </circle>
        ))}

        {/* Pump-run marker band — thin colored bars in dedicated band
            below tank. Complements the amber shading behind the line
            with an unambiguous "pump was on here" indicator when the
            shading is hard to see (e.g. dense overlapping runs). */}
        <text x={PADL - 10} y={PUMP_TOP + 20} fontSize="18" fontWeight="700" fill="#374151" textAnchor="end">Pump</text>
        <line x1={PADL} y1={(PUMP_TOP + PUMP_BOT) / 2} x2={W - PADR} y2={(PUMP_TOP + PUMP_BOT) / 2}
          stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3,3" />
        {pumpRuns.map((r, i) => {
          const x1 = xFor(r.start);
          const x2 = xFor(r.end);
          const w = Math.max(x2 - x1, 3);
          const fill = r.cause === "force" || r.cause === "manual_button" ? "#d97706" : "#f59e0b";
          const isSel = selectedRunIdx === i;
          return (
            <rect
              key={`pb-${i}`}
              x={x1} y={PUMP_TOP} width={w} height={PUMP_BOT - PUMP_TOP}
              rx="2" ry="2"
              fill={fill}
              stroke={isSel ? "#1e40af" : "none"}
              strokeWidth={isSel ? "2" : "0"}
              style={{ cursor: onSelectRun ? "pointer" : "default" }}
              onClick={(e) => { if (onSelectRun) { e.stopPropagation(); onSelectRun(isSel ? null : i); } }}
            >
              <title>{`Pump ${r.cause} — ${new Date(r.start).toLocaleString()} to ${new Date(r.end).toLocaleString()} (${fmtDuration((r.end - r.start) / 1000)}) — click for details`}</title>
            </rect>
          );
        })}

        {/* Source strip — green/red segments. v118.0.13: hidden entirely
            when the panel has no source sensor configured (hasSource=false)
            so we don't render a misleading full-width band from the
            "water presumed available" firmware default. */}
        {hasSource && (
          <>
            <text x={PADL - 10} y={SRC_TOP + 20} fontSize="18" fontWeight="700" fill="#374151" textAnchor="end">Source</text>
            {sourceSegments.map((s, i) => {
              const x1 = xFor(s.start);
              const x2 = xFor(s.end);
              const w = Math.max(x2 - x1, 1);
              const fill = s.wet ? "#22c55e" : "#ef4444";
              // v118.0.6: visual distinction between actual + interpolated
              // only in showRaw mode. Clean mode shows a uniform strip.
              const dim = showRaw && s.interpolated;
              return (
                <rect
                  key={`s-${i}`}
                  x={x1} y={SRC_TOP} width={w} height={SRC_BOT - SRC_TOP}
                  fill={fill}
                  opacity={dim ? "0.45" : "0.85"}
                  strokeDasharray={dim ? "4,3" : ""}
                  stroke={dim ? fill : "none"}
                  strokeWidth={dim ? "1" : "0"}
                >
                  <title>{`Source ${s.wet ? "present" : "dry"} — ${new Date(s.start).toLocaleString()} to ${new Date(s.end).toLocaleString()}${(showRaw && s.interpolated) ? " (interpolated)" : ""}`}</title>
                </rect>
              );
            })}
          </>
        )}

        {/* Vertical gridlines + X-axis ticks + labels */}
        {xTicks.map((ts, i) => {
          const x = xFor(ts);
          return (
            <g key={`x-${i}`}>
              <line x1={x} y1={TANK_TOP} x2={x} y2={SRC_BOT}
                stroke="#f3f4f6" strokeWidth="1" />
              <line x1={x} y1={SRC_BOT} x2={x} y2={SRC_BOT + 5} stroke="#9ca3af" strokeWidth="1" />
              <text x={x} y={SRC_BOT + 26} fontSize="15" fontWeight="500" fill="#374151" textAnchor="middle">{fmtTick(ts)}</text>
            </g>
          );
        })}

        {/* Crosshair — vertical dashed line following the cursor, drawn
            LAST so it sits on top of everything else. */}
        {hoverX != null && (
          <g pointerEvents="none">
            <line x1={hoverX} y1={TANK_TOP} x2={hoverX} y2={SRC_BOT}
              stroke="#4b5563" strokeWidth="1" strokeDasharray="3,3" opacity="0.7" />
            {/* Dot on the tank line at the hover time — shows exact
                intersection with the tank level for that moment. */}
            {hover?.tankPct != null && (
              <circle
                cx={hoverX}
                cy={yForPct(hover.tankPct)}
                r="5"
                fill="#2563eb"
                stroke="#fff"
                strokeWidth="2"
              />
            )}
          </g>
        )}
      </svg>

      {/* Floating tooltip — HTML overlay so text stays crisp regardless
          of SVG scaling. Positioned to the right of the cursor, flips
          to the left when near the right edge to stay in-view. */}
      {hover && hoverPx && (
        <div
          className="absolute pointer-events-none bg-white border border-gray-300 rounded-lg shadow-lg text-xs p-2.5 z-10"
          style={{
            left: hoverPx.x + 12,
            top: Math.max(hoverPx.y - 60, 4),
            transform: hoverPx.x > (wrapRef.current?.clientWidth || 0) - 180 ? "translateX(calc(-100% - 24px))" : "none",
            minWidth: 160,
          }}
        >
          <div className="font-semibold text-gray-800 mb-1.5 pb-1 border-b border-gray-100">
            {new Date(hover.ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
          </div>
          <div className="space-y-1">
            <TooltipRow color="#2563eb" label="Tank"
              value={hover.tankPct != null ? `${hover.tankPct}%` : "—"} />
            <TooltipRow color={hover.pumpRunning ? "#f59e0b" : "#d1d5db"} label="Pump"
              value={hover.pumpRunning
                ? (hover.pumpCause === "force" || hover.pumpCause === "manual_button"
                    ? "Running · Manual"
                    : "Running · Auto")
                : "Off"} />
            <TooltipRow color={hover.sourceWet === null ? "#d1d5db" : (hover.sourceWet ? "#22c55e" : "#ef4444")}
              label="Source"
              value={hover.sourceWet === null ? "—" : (hover.sourceWet ? "Present" : "Dry")} />
          </div>
        </div>
      )}
    </div>
  );
}

function TooltipRow({ color, label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
        <span className="text-gray-500">{label}</span>
      </div>
      <span className="font-medium text-gray-800">{value}</span>
    </div>
  );
}
