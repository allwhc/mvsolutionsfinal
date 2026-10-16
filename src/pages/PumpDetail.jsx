import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase/config";
import { listenToDeviceHistory, clearDeviceHistory, clearPumpFault } from "../firebase/rtdb";
import PanelSettingsTab from "../components/PumpDetail/PanelSettingsTab";
import ForceRunButton from "../components/PumpDetail/ForceRunButton";
import AnalyticsTab from "../components/PumpDetail/AnalyticsTab";
import { computePumpAnalytics, fmtDuration } from "../utils/pumpAnalytics";
import CleaningBadge from "../components/DeviceCard/CleaningBadge";
import {
  SourceTank,
  PumpIcon,
  TerraceTank,
  WaterFlow,
  terracePctFromLive,
} from "../components/DeviceCard/PumpCard";

// ─── Small formatters ──────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtTs(unixSec) {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  return d.toLocaleString();
}
function fmtDate(unixSec) {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  const day = String(d.getDate()).padStart(2, "0");
  return `${day}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}
function fmtTime(unixSec) {
  if (!unixSec) return "—";
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// Combined "27-Sep-2026 · 04:43 PM" — single-line date+time for tables
// where vertical stacking wastes row height.
function fmtDateTime(unixSec) {
  if (!unixSec) return "—";
  return `${fmtDate(unixSec)} · ${fmtTime(unixSec)}`;
}

// causeStart/causeEnd → user-readable label + Tailwind color
const CAUSE_STYLE = {
  auto:                    { label: "Auto",       cls: "bg-blue-100 text-blue-800"    },
  schedule:                { label: "Scheduled",  cls: "bg-indigo-100 text-indigo-800"},
  force:                   { label: "Manual",     cls: "bg-amber-100 text-amber-800"  },
  manual_button:           { label: "Panel",      cls: "bg-amber-100 text-amber-800"  },
  boot_detected_running:   { label: "Recovered",  cls: "bg-gray-100 text-gray-700"    },
  feedback_timeout:        { label: "Fault stop", cls: "bg-red-100 text-red-800"      },
  dry_run:                 { label: "Dry run",    cls: "bg-red-100 text-red-800"      },
  max_runtime:             { label: "Max runtime",cls: "bg-red-100 text-red-800"      },
};
function CauseBadge({ cause }) {
  const s = CAUSE_STYLE[cause] || { label: cause || "—", cls: "bg-gray-100 text-gray-700" };
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

// Terrace state → small colored dot
const TERRACE_DOT = {
  empty: "bg-gray-300",
  half:  "bg-blue-300",
  full:  "bg-blue-600",
  sensor_fault: "bg-red-400",
};
function TerraceDot({ state }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${TERRACE_DOT[state] || "bg-gray-300"}`} />;
}

// ─── Live schematic (bigger version of the card view) ──────────────
// Full-page live schematic. Reuses the SAME SourceTank / PumpIcon /
// TerraceTank / WaterFlow components as PumpCard, just rendered at
// scale=2 so the icons feel appropriate for a detail page instead of
// a tile. Same left-to-right flow direction (source → pump → terrace),
// same rotating impeller when running, same cleaning-badge overlays.
// Keeps a single source of visual truth — a design change to the card
// automatically flows through here.
// v118.0.7: fault clear-and-resume button. Sends /commands/clearFault
// which firmware consumes + resets all fault state (same reset the AP
// page's "CLEAR ERROR & RESUME" button performs). Three-state UX:
// idle / sending / sent (brief). Any error surfaces inline.
function ClearFaultButton({ code }) {
  const [state, setState] = useState("idle");
  const [err,   setErr]   = useState("");
  async function handleClick() {
    if (!code || state === "sending") return;
    setErr("");
    setState("sending");
    try {
      await clearPumpFault(code);
      setState("sent");
      setTimeout(() => setState("idle"), 3000);
    } catch (e) {
      console.error("clear fault failed:", e);
      setErr("Failed to send — try again");
      setState("idle");
    }
  }
  const label = state === "sending" ? "Sending…" : state === "sent" ? "✓ Clear command sent" : "🔄 Clear Fault & Resume";
  return (
    <div className="mb-3 max-w-sm mx-auto">
      <button
        onClick={handleClick}
        disabled={state !== "idle"}
        className="w-full text-sm font-medium px-3 py-2 rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:bg-orange-300 disabled:cursor-not-allowed transition-colors"
      >
        {label}
      </button>
      {err && <p className="text-xs text-red-600 mt-1 text-center">{err}</p>}
    </div>
  );
}

function LiveSchematic({ code, live, info, catalog }) {
  const pumpState    = live?.pumpState || "off";
  const sourceState  = live?.sourceState  || "dry";
  const hasSource    = info?.hasSource ?? live?.hasSource ?? false;
  const isRunning    = pumpState === "auto" || pumpState === "manual";
  const feedbackFault = !!live?.faults?.feedback;
  const terracePct   = terracePctFromLive(live);
  const terraceFault = live?.terraceState === "sensor_fault";

  // Same pump-state pill labels as PumpCard — Auto/Manual qualifier
  // keeps the mode explicit at a glance.
  const PILL = {
    off:      { label: "Off",              text: "text-gray-700",   dot: "bg-gray-400"  },
    auto:     { label: "Running · Auto",   text: "text-blue-700",   dot: "bg-blue-500"  },
    manual:   { label: "Running · Manual", text: "text-amber-700",  dot: "bg-amber-500" },
    starting: { label: "Starting…",        text: "text-blue-700",   dot: "bg-blue-400"  },
    fault:    { label: "Fault",            text: "text-red-700",    dot: "bg-red-500"   },
    locked:   { label: "Locked",           text: "text-purple-700", dot: "bg-purple-500"},
  }[pumpState] || { label: pumpState, text: "text-gray-600", dot: "bg-gray-400" };

  const sourceCleaningBadge = hasSource ? (
    <CleaningBadge
      lastCleanedAt={catalog?.lastCleanedAtSource}
      cleanIntervalDays={catalog?.cleanIntervalDaysSource}
    />
  ) : null;
  const terraceCleaningBadge = (
    <CleaningBadge
      lastCleanedAt={catalog?.lastCleanedAtTerrace}
      cleanIntervalDays={catalog?.cleanIntervalDaysTerrace}
    />
  );
  const pumpMaintBadge = (
    <CleaningBadge
      lastCleanedAt={catalog?.lastPumpMaintenanceAt}
      cleanIntervalDays={catalog?.pumpMaintenanceIntervalDays}
    />
  );

  const gridCols = hasSource
    ? "auto 36px auto 36px auto"
    : "auto 36px auto";

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-4">
      <h2 className="text-base font-semibold text-gray-800 mb-2">Live state</h2>

      {/* Pump-state pill — sized between card and previous detail. */}
      <div className="flex items-center justify-between mb-3 bg-gray-50 rounded-lg px-3 py-2 max-w-sm mx-auto">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${PILL.dot}`} />
          <span className={`text-sm font-semibold ${PILL.text}`}>{PILL.label}</span>
        </div>
        {feedbackFault && (
          <span className="text-xs text-red-600 font-medium">⚠ feedback fault</span>
        )}
      </div>

      {/* v118.0.13: operMode banner + Clear Fault. operMode is published
          by firmware 118.0.13+ on /live and distinguishes the broader
          operational modes (dry run recovery, safe mode, source dry
          run, panel fault, schedule inactive) that the pumpState enum
          collapses into "off". Fallback for pre-0.13 firmware: use
          pumpState + feedbackFault flag. */}
      {(() => {
        const operMode = live?.operMode;
        // Fault modes that benefit from a Clear Fault button (per Vishal).
        const clearableFault = (operMode === "safe_mode" || operMode === "panel_fault" || operMode === "source_dry_run")
          || (!operMode && (feedbackFault || live?.pumpState === "panel_fault" || live?.pumpState === "safe_mode"));
        // All operMode states (including non-fault like schedule_inactive, dry_run_recovery)
        // that are worth surfacing to the user with a banner.
        const banners = {
          dry_run_recovery:  { bg: "bg-amber-50 border-amber-200 text-amber-800",   icon: "🔄", title: "Dry run — retrying",          body: "Pump stopped: water level didn't rise during the last fill. Will retry automatically." },
          safe_mode:         { bg: "bg-red-50 border-red-200 text-red-800",         icon: "🛟", title: "Safe mode",                   body: "Pump halted after repeated dry-run attempts. Clear the fault to resume." },
          source_dry_run:    { bg: "bg-blue-50 border-blue-200 text-blue-800",      icon: "💧", title: "Source dry",                  body: "Source water not available. Pump will retry when source returns, or clear to resume now." },
          panel_fault:       { bg: "bg-red-50 border-red-200 text-red-800",         icon: "⚠",  title: "Panel fault",                 body: "Contactor feedback error. Check wiring, then clear the fault." },
          schedule_inactive: { bg: "bg-indigo-50 border-indigo-200 text-indigo-800",icon: "⏰", title: "Outside schedule window",     body: "Pump paused — not inside any active schedule window right now." },
          sensor_offline:    { bg: "bg-purple-50 border-purple-200 text-purple-800",icon: "📡", title: "Sensor offline",              body: "Ultrasonic sensor not responding. Pump safety-stopped until a valid reading returns." },
        };
        const banner = banners[operMode];
        if (!banner && !clearableFault && !feedbackFault) return null;
        return (
          <div className="mb-3 space-y-2">
            {banner && (
              <div className={`border rounded-lg p-3 ${banner.bg}`}>
                <div className="font-semibold text-sm mb-0.5">{banner.icon} {banner.title}</div>
                <div className="text-xs opacity-90">{banner.body}</div>
              </div>
            )}
            {clearableFault && <ClearFaultButton code={code} />}
          </div>
        );
      })()}

      {/* Schematic at 1.5× scale — fits detail page without dwarfing */}
      <div
        className="grid items-end justify-center gap-2 py-2"
        style={{ gridTemplateColumns: gridCols }}
      >
        {hasSource && (
          <SourceTank wet={sourceState === "wet"} cleaningBadge={sourceCleaningBadge} scale={1.5} />
        )}
        {hasSource && <WaterFlow running={isRunning} scale={1.5} />}
        <PumpIcon running={isRunning} fault={pumpState === "fault"} scale={1.5} maintenanceBadge={pumpMaintBadge} />
        <WaterFlow running={isRunning} scale={1.5} />
        <TerraceTank
          pct={terracePct}
          isFault={terraceFault}
          running={isRunning}
          cleaningBadge={terraceCleaningBadge}
          scale={1.5}
        />
      </div>
    </div>
  );
}

// ─── History tab: paired-run table ─────────────────────────────────
// Redesigned per user feedback:
//   • Single-line datetime "27-Sep-2026 · 04:43 PM"
//   • Single Type badge (Auto/Manual) — end cause only shown as an
//     extra red chip when it indicates a fault stop
//   • Zero-duration filter toggle at top — those are edge state samples,
//     not real pump runs; hidden by default for cleaner view
//   • Terrace change kept even when no change (per user: real runs
//     legitimately end mid-fill without changing bucket)
//   • Clear History button — owner-only, confirmation required, wipes
//     entire /history/{code} node in RTDB
function HistoryTable({ code, history, canClear }) {
  // v118.0.7: broaden the default-hidden filter from "zero-duration only"
  // to "<1 minute". Panels routinely log 1-30s runs from feedback blips,
  // boot-detected edges, or evaluateMotorState bouncing on the stop
  // threshold — none of which are useful operator events. Customer only
  // wants to see real pump work on the default view.
  const [showShort, setShowShort]   = useState(false);
  const [clearOpen, setClearOpen]   = useState(false);
  const [clearing, setClearing]     = useState(false);
  const [clearErr, setClearErr]     = useState("");

  const sorted = useMemo(() => {
    const rows = (history || []).slice().sort((a, b) => (b.onTs || 0) - (a.onTs || 0));
    if (showShort) return rows;
    return rows.filter((r) => (r.runSec || 0) >= 60);
  }, [history, showShort]);

  const hiddenCount = (history || []).length - sorted.length;

  async function handleClear() {
    setClearing(true);
    setClearErr("");
    try {
      await clearDeviceHistory(code);
      setClearOpen(false);
    } catch (e) {
      console.error("clear history failed:", e);
      setClearErr("Delete failed — try again");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Header row — title left, zero-toggle center-right, clear button right. */}
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-gray-800">Pump runs</h3>
          <span className="text-xs text-gray-400">
            {sorted.length} shown
            {hiddenCount > 0 && ` · ${hiddenCount} hidden`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showShort}
              onChange={(e) => setShowShort(e.target.checked)}
              className="w-3.5 h-3.5"
            />
            Show short events (&lt;1 min)
          </label>
          {canClear && (history || []).length > 0 && (
            <button
              onClick={() => { setClearOpen(true); setClearErr(""); }}
              className="text-xs bg-red-50 text-red-700 border border-red-200 px-3 py-1 rounded-md hover:bg-red-100 font-medium"
            >
              Clear History
            </button>
          )}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="p-6 text-center text-gray-500 text-sm">
          {(history || []).length === 0
            ? "No pump runs recorded yet."
            : "No runs ≥1 min — turn on ‘Show short events (<1 min)’ to see them."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Started</th>
                <th className="text-left px-4 py-2.5 font-semibold">Type</th>
                <th className="text-left px-4 py-2.5 font-semibold">Duration</th>
                <th className="text-left px-4 py-2.5 font-semibold">Terrace</th>
                <th className="text-left px-4 py-2.5 font-semibold">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map((r) => {
                // Type column: primary start badge always shown. End
                // badge only shown when it indicates a fault stop
                // (feedback_timeout / dry_run / max_runtime) — otherwise
                // it's redundant with the start cause and just clutters.
                const isFaultEnd = ["feedback_timeout", "dry_run", "max_runtime"].includes(r.causeEnd);
                return (
                  <tr
                    key={r.key}
                    className={`${r.bufferedReplay ? "bg-amber-50" : "hover:bg-gray-50"} transition-colors`}
                  >
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                      {fmtDateTime(r.onTs)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <CauseBadge cause={r.causeStart} />
                        {isFaultEnd && <CauseBadge cause={r.causeEnd} />}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-700">
                      {fmtDuration(r.runSec)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1 text-xs">
                        <TerraceDot state={r.terraceStart} />
                        <span className="text-gray-400">→</span>
                        <TerraceDot state={r.terraceEnd} />
                        <span className="ml-1 capitalize text-gray-600">
                          {r.terraceStart} → {r.terraceEnd}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">
                      {r.sourceStart === "wet" ? "💧 Present" : "— Not present"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Clear-history confirmation modal */}
      {clearOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !clearing && setClearOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-lg text-gray-900 mb-2">Clear pump history?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This deletes all <strong>{(history || []).length}</strong> pump-run records for this device.
              Live data and settings are not affected. This action can't be undone.
            </p>
            {clearErr && <p className="text-red-600 text-xs mb-3">{clearErr}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setClearOpen(false)}
                disabled={clearing}
                className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >Cancel</button>
              <button
                onClick={handleClear}
                disabled={clearing}
                className="px-4 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >{clearing ? "Deleting…" : "Delete all history"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Device Info panel — always shown below LiveSchematic on the
// Live tab. Consolidates all the "what device is this" data
// (firmware, MAC, class, capabilities) into one section so an
// installer or admin doesn't need to hunt for it. Everything here
// is read from data the firmware already publishes to /info; no
// new writes required.
//
// WiFi signal label mirrors the sensor DeviceDetail's rssiLabel:
// friendly bucket ("Excellent"/"Good"/"Fair"/"Weak") plus the raw
// dBm in parentheses. Offline devices render dimmed with "N/A" —
// same as sensor page — so customers get consistent semantics
// across the whole app.
function rssiLabel(rssi, online) {
  if (!online) return "N/A";
  if (rssi === undefined || rssi === null || rssi === 0) return "N/A";
  if (rssi >= -55) return `Excellent (${rssi} dBm)`;
  if (rssi >= -65) return `Good (${rssi} dBm)`;
  if (rssi >= -75) return `Fair (${rssi} dBm)`;
  return `Weak (${rssi} dBm)`;
}

function DeviceInfoPanel({ code, info, live, catalog, isOnline }) {
  const rows = [
    { label: "Device Code",   value: code, mono: true },
    { label: "Class",         value: "Pump Panel" },
    { label: "Firmware",      value: info?.firmwareVersion || "—", mono: true },
    { label: "MAC Address",   value: info?.macAddress || "—", mono: true },
    // Installer's AP-page label — mirrors the ultrasonic sensor pattern.
    // Firmware pushes this on boot + on rename via AP; cloud never
    // writes to it. Hidden entirely when firmware hasn't sent one yet.
    ...(info?.userAssignedName
      ? [{ label: "Panel Label",   value: info.userAssignedName }]
      : []),
    { label: "Feedback",      value: info?.hasFeedback ? "Enabled" : "Not configured" },
    { label: "Ground source", value: info?.hasSource ? "Enabled" : "Not configured" },
    { label: "WiFi Signal",   value: rssiLabel(live?.rssi, isOnline), dimWhenOffline: true },
    { label: "Status",        value: isOnline ? "Online" : "Offline", valueClass: isOnline ? "text-green-600" : "text-gray-400" },
    ...(catalog?.registeredAt
      ? [{ label: "Registered", value: new Date(catalog.registeredAt.seconds * 1000).toLocaleDateString() }]
      : []),
  ];
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Device Info</h3>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {rows.map((r) => {
          const dim = r.dimWhenOffline && !isOnline;
          const valueClass = r.valueClass
            || (dim ? "text-gray-400" : "text-gray-900")
            + (r.mono ? " font-mono text-xs" : " font-medium");
          return (
            <div key={r.label} className="flex justify-between gap-2 py-1 border-b border-gray-100 last:border-b-0 sm:border-b">
              <dt className="text-gray-500">{r.label}</dt>
              <dd className={`text-right ${valueClass}`}>{r.value}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

// ─── Analytics tab: bucketed stats + PM flag + trend chart ─────────
function AnalyticsPanel({ history, analyticsOn }) {
  const [computed, setComputed] = useState(null);

  const onAnalyze = () => {
    setComputed(computePumpAnalytics(history));
  };

  if (analyticsOn === false) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 text-center text-gray-500">
        Analytics disabled by admin.
      </div>
    );
  }

  if (!computed) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 text-center">
        <p className="text-gray-600 mb-4">Click below to compute pump analytics from history.</p>
        <button
          onClick={onAnalyze}
          className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-5 py-2 rounded-lg"
        >
          Analyze
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* PM alert banner */}
      {computed.pmFlag.active && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4">
          <div className="font-semibold text-amber-900 mb-1">Preventive maintenance recommended</div>
          <div className="text-sm text-amber-800">{computed.pmFlag.reason}</div>
          <div className="text-xs text-amber-700 mt-2">
            Baseline {computed.pmFlag.bucketLabel}: {fmtDuration(computed.pmFlag.baselineSec)} ·
            Recent avg: {fmtDuration(computed.pmFlag.recentAvgSec)}
          </div>
        </div>
      )}

      {/* Totals cards */}
      <div className="grid grid-cols-3 gap-3">
        {["today", "week", "month"].map((k) => (
          <div key={k} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500">{k}</div>
            <div className="mt-1 text-2xl font-semibold text-gray-800">{computed.totals[k].runs}</div>
            <div className="text-xs text-gray-500 mt-0.5">runs</div>
            <div className="text-sm text-gray-600 mt-2">{fmtDuration(computed.totals[k].runtimeSec)} total</div>
          </div>
        ))}
      </div>

      {/* Fill baseline by bucket */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-800 mb-3">Fill time baseline (Empty → Full)</h3>
        <p className="text-xs text-gray-500 mb-4">
          Only Empty→Full runs are counted for baseline. Night window gives cleanest signal (low household consumption).
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(computed.fillBaselineByBucket).map(([key, v]) => (
            <div key={key} className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500">{v.label}</div>
              <div className="mt-1 text-lg font-semibold text-gray-800">
                {v.medianSec != null ? fmtDuration(v.medianSec) : "—"}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {v.sampleCount === 0
                  ? "No data"
                  : v.sampleCount < 14
                  ? `${v.sampleCount} runs · warming up`
                  : `${v.sampleCount} runs`}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Manual vs auto */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-800 mb-3">Manual vs auto runs</h3>
        <div className="flex items-center gap-4">
          <div className="flex-1 bg-gray-100 rounded-full overflow-hidden h-3">
            {computed.manualVsAuto.manual + computed.manualVsAuto.auto > 0 && (
              <div
                className="bg-blue-500 h-full float-left"
                style={{ width: `${(computed.manualVsAuto.auto / (computed.manualVsAuto.manual + computed.manualVsAuto.auto)) * 100}%` }}
              />
            )}
          </div>
          <div className="text-sm">
            <span className="text-blue-700 font-semibold">{computed.manualVsAuto.auto}</span> auto
            {" · "}
            <span className="text-amber-700 font-semibold">{computed.manualVsAuto.manual}</span> manual
          </div>
        </div>
      </div>

      {/* Daily runtime bar chart (inline SVG, no lib) */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-800 mb-3">Daily runtime (last 30 days)</h3>
        {computed.dailyRuntime.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-4">No runs in last 30 days.</div>
        ) : (
          <DailyRuntimeChart data={computed.dailyRuntime} />
        )}
      </div>

      {/* Source availability strip */}
      {computed.sourceAvailability.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
          <h3 className="font-semibold text-gray-800 mb-3">Source water availability</h3>
          <SourceStrip periods={computed.sourceAvailability} />
        </div>
      )}
    </div>
  );
}

// Small dependency-free bar chart. Bars keyed by day.
function DailyRuntimeChart({ data }) {
  const max = Math.max(...data.map((d) => d.runtimeSec), 1);
  const barWidth = 100 / data.length;
  return (
    <div className="w-full">
      <div className="flex items-end h-32 gap-[1px]">
        {data.map((d) => {
          const h = (d.runtimeSec / max) * 100;
          return (
            <div
              key={d.day}
              title={`${d.day}: ${fmtDuration(d.runtimeSec)} · ${d.runs} runs`}
              className="bg-blue-400 hover:bg-blue-600 transition-colors cursor-pointer"
              style={{ width: `${barWidth}%`, height: `${h}%` }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-gray-400 mt-1">
        <span>{data[0].day}</span>
        <span>{data[data.length - 1].day}</span>
      </div>
    </div>
  );
}

// Green/red strip showing source-present intervals over time.
function SourceStrip({ periods }) {
  if (periods.length === 0) return null;
  const start = periods[0].startTs;
  const end   = periods[periods.length - 1].endTs || (start + 1);
  const span  = Math.max(end - start, 1);
  return (
    <div>
      <div className="relative h-6 w-full rounded overflow-hidden bg-gray-100">
        {periods.map((p, i) => {
          const left  = ((p.startTs - start) / span) * 100;
          const width = Math.max(((Math.max(p.endTs, p.startTs) - p.startTs) / span) * 100, 0.5);
          return (
            <div
              key={i}
              className={`absolute top-0 bottom-0 ${p.wet ? "bg-green-400" : "bg-red-300"}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${p.wet ? "Water present" : "Not present"}: ${fmtTs(p.startTs)}${p.endTs !== p.startTs ? ` → ${fmtTs(p.endTs)}` : ""}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-gray-400 mt-1">
        <span>{fmtDate(start)}</span>
        <span>{fmtDate(end)}</span>
      </div>
    </div>
  );
}

// ─── Pump Alerts panel (Live tab, always visible) ──────────────────
// Three grouped sections — one per water-flow stage:
//
//   Terrace tank (destination)
//     • alertLowPct / alertHighPct — pct thresholds. Same fields the
//       sensor alert-eval pipeline uses, so push-notification wiring
//       is automatic.
//   Source tank (ground cistern)
//     • alertSourceDry — bool. Fires when source goes dry. For a
//       future ultrasonic source variant we'll swap this for
//       alertSourceLowPct/alertSourceHighPct (same UX as terrace).
//   Pump (the machine)
//     • alertPumpDryRun     — fires on firmware dry_run causeEnd
//     • alertPumpMaxRuntime — fires on firmware max_runtime causeEnd
//     • alertPumpSafeMode   — fires when pumpStage=="SAFE_MODE"
//
// All flags default false on new devices. Feedback-fault deliberately
// omitted per user request.
function PumpAlertsPanel({ code, catalog, info, refresh }) {
  const [low, setLow]   = useState(catalog?.alertLowPct  ?? "");
  const [high, setHigh] = useState(catalog?.alertHighPct ?? "");
  const [srcDry, setSrcDry]         = useState(!!catalog?.alertSourceDry);
  const [pumpDryRun, setPumpDryRun] = useState(!!catalog?.alertPumpDryRun);
  const [pumpMax, setPumpMax]       = useState(!!catalog?.alertPumpMaxRuntime);
  const [pumpSafe, setPumpSafe]     = useState(!!catalog?.alertPumpSafeMode);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setLow(catalog?.alertLowPct  ?? "");
    setHigh(catalog?.alertHighPct ?? "");
    setSrcDry(!!catalog?.alertSourceDry);
    setPumpDryRun(!!catalog?.alertPumpDryRun);
    setPumpMax(!!catalog?.alertPumpMaxRuntime);
    setPumpSafe(!!catalog?.alertPumpSafeMode);
  }, [catalog]);

  async function save() {
    const l = low  === "" ? null : parseInt(low);
    const h = high === "" ? null : parseInt(high);
    if (l != null && h != null && l >= h) { setErr("Low must be less than High"); return; }
    setSaving(true);
    try {
      await updateDoc(doc(db, "deviceCatalog", code), {
        alertLowPct:          l,
        alertHighPct:         h,
        alertSourceDry:       srcDry,
        alertPumpDryRun:      pumpDryRun,
        alertPumpMaxRuntime:  pumpMax,
        alertPumpSafeMode:    pumpSafe,
      });
      setErr("");
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      refresh?.();
    } catch (e) { setErr("Save failed — try again"); }
    finally    { setSaving(false); }
  }

  const opts = []; for (let v = 0; v <= 100; v += 5) opts.push(v);

  // Small on/off toggle button — visual language matches SensorCard's
  // single-sensor Alert-when-Empty / Alert-when-Present toggles.
  const Toggle = ({ value, onChange, onLabel = "ON", offLabel = "OFF" }) => (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
        value ? "bg-red-500 text-white hover:bg-red-600" : "bg-gray-200 text-gray-600 hover:bg-gray-300"
      }`}
    >{value ? onLabel : offLabel}</button>
  );

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
      <h3 className="font-semibold text-gray-800 mb-4">Alert Settings</h3>

      {/* ── Terrace tank ── */}
      <div className="mb-5">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Terrace Tank</h4>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="text-gray-600 self-center">Low alert (≤)</label>
          <select value={low} onChange={(e) => { setLow(e.target.value); setErr(""); }}
            className="px-2 py-1 border border-gray-200 rounded text-sm bg-white">
            <option value="">Disabled</option>
            {opts.map((v) => <option key={v} value={String(v)}>{v}%</option>)}
          </select>
          <label className="text-gray-600 self-center">High alert (≥)</label>
          <select value={high} onChange={(e) => { setHigh(e.target.value); setErr(""); }}
            className="px-2 py-1 border border-gray-200 rounded text-sm bg-white">
            <option value="">Disabled</option>
            {opts.map((v) => <option key={v} value={String(v)}>{v}%</option>)}
          </select>
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5">Card flashes red when low, green when high.</p>
      </div>

      {/* ── Source tank ── */}
      <div className="mb-5">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Source Tank</h4>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-700">Alert when source is dry</span>
          <Toggle value={srcDry} onChange={setSrcDry} />
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5">
          Fires when the ground cistern runs out of water (wet/dry sensor). Also glows the card if the pump tries to run while the source is dry.
        </p>
      </div>

      {/* ── Pump ── */}
      <div className="mb-5">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Pump</h4>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <div className="min-w-0 pr-2">
              <div className="text-gray-700">Dry-run detected</div>
              <div className="text-[11px] text-gray-400">Pump was running but the source went dry — impeller protection. Firmware auto-stops after 3 dry-runs in a row.</div>
            </div>
            <Toggle value={pumpDryRun} onChange={setPumpDryRun} />
          </div>
          <div className="flex items-center justify-between text-sm">
            <div className="min-w-0 pr-2">
              <div className="text-gray-700">Max runtime hit</div>
              <div className="text-[11px] text-gray-400">
                {(() => {
                  const m = info?.appliedConfig?.maxRunTimeMins;
                  const label = (typeof m === "number" && m > 0)
                    ? `exceeded your ${m}-minute maximum runtime setting`
                    : "exceeded your configured maximum runtime";
                  return `A single pump run ${label}. Usually means the terrace sensor failed, there's a leak, or the source can't keep up with demand. Change this limit from the Panel Settings tab.`;
                })()}
              </div>
            </div>
            <Toggle value={pumpMax} onChange={setPumpMax} />
          </div>
          <div className="flex items-center justify-between text-sm">
            <div className="min-w-0 pr-2">
              <div className="text-gray-700">Safe-mode lockout</div>
              <div className="text-[11px] text-gray-400">Panel has locked itself out after 3 consecutive dry-runs. Pump won't auto-start until you clear it (long-press panel button or force-run from the app).</div>
            </div>
            <Toggle value={pumpSafe} onChange={setPumpSafe} />
          </div>
        </div>
      </div>

      {err && <p className="text-red-500 text-xs mb-2">{err}</p>}
      <button onClick={save} disabled={saving}
        className={`w-full py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
          savedFlash ? "bg-green-100 text-green-700" : "bg-blue-50 text-blue-700 hover:bg-blue-100"
        }`}>
        {saving ? "Saving…" : savedFlash ? "Saved ✓" : "Save Alert Settings"}
      </button>
    </div>
  );
}

// ─── Cleaning + Pump Maintenance panel ─────────────────────────────
// Three independent rows: Terrace tank / Source tank / Pump. Each has
// its own last-service date and interval-days. Pump maintenance overdue
// is the trigger for the pump-alert banner on the card.
function CleaningPanel({ code, catalog, hasSource, refresh }) {
  const [saving, setSaving] = useState(false);
  async function patch(fields) {
    setSaving(true);
    try {
      await updateDoc(doc(db, "deviceCatalog", code), fields);
      refresh?.();
    } catch (e) { console.warn("cleaning patch failed:", e); }
    finally    { setSaving(false); }
  }

  const rows = [
    {
      key: "Terrace",
      lastKey: "lastCleanedAtTerrace",
      intervalKey: "cleanIntervalDaysTerrace",
      last: catalog?.lastCleanedAtTerrace || "",
      interval: catalog?.cleanIntervalDaysTerrace ?? 30,
      cleanEmoji: "🍃",
      cleanLabel: "Cleaned",
    },
    ...(hasSource ? [{
      key: "Source",
      lastKey: "lastCleanedAtSource",
      intervalKey: "cleanIntervalDaysSource",
      last: catalog?.lastCleanedAtSource || "",
      interval: catalog?.cleanIntervalDaysSource ?? 30,
      cleanEmoji: "🍃",
      cleanLabel: "Cleaned",
    }] : []),
    {
      key: "Pump Maintenance",
      lastKey: "lastPumpMaintenanceAt",
      intervalKey: "pumpMaintenanceIntervalDays",
      last: catalog?.lastPumpMaintenanceAt || "",
      interval: catalog?.pumpMaintenanceIntervalDays ?? 90,
      cleanEmoji: "🔧",
      cleanLabel: "Serviced",
    },
  ];

  function statusLabel(last, interval) {
    if (!last) return <span className="text-gray-400">Set date</span>;
    const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    const left = interval - days;
    if (left > 14) return <span className="text-green-600">✅ OK ({days}d ago)</span>;
    if (left > 0)  return <span className="text-yellow-600">⚠ Due in {left}d</span>;
    return <span className="text-red-600">🔴 Overdue by {Math.abs(left)}d</span>;
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
      <h3 className="font-semibold text-gray-800 mb-3">Maintenance</h3>
      <div className="space-y-4">
        {rows.map((r) => (
          <div key={r.key} className="border-b border-gray-100 last:border-b-0 pb-3 last:pb-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">{r.key}</span>
              {statusLabel(r.last, r.interval)}
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <label className="text-gray-500 self-center">Last {r.cleanLabel}</label>
              <input type="date" value={r.last} disabled={saving}
                onChange={(e) => patch({ [r.lastKey]: e.target.value })}
                className="px-2 py-0.5 border border-gray-200 rounded text-sm" />
              <label className="text-gray-500 self-center">Every</label>
              <div className="flex items-center gap-1">
                <input type="number" min="7" max="730" value={r.interval} disabled={saving}
                  onChange={(e) => patch({ [r.intervalKey]: parseInt(e.target.value) || 30 })}
                  className="w-16 px-2 py-0.5 border border-gray-200 rounded text-sm" />
                <span className="text-gray-500 text-xs">days</span>
              </div>
            </div>
            <button
              onClick={() => patch({ [r.lastKey]: new Date().toISOString().split("T")[0] })}
              disabled={saving}
              className="mt-2 w-full bg-green-50 text-green-700 py-1.5 rounded-lg text-xs font-medium hover:bg-green-100 disabled:opacity-50">
              {r.cleanEmoji} Mark {r.cleanLabel} Today
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────
export default function PumpDetail({ code, live, info, isOnline }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState("live");
  const [history, setHistory] = useState([]);
  // Panel Settings tab tracks its own unsaved-edits state and pushes
  // it up here so tab clicks can guard against silent loss. requestTab
  // wraps setTab with a confirmation prompt when settings are dirty.
  const [settingsDirty, setSettingsDirty] = useState(false);
  const requestTab = (nextKey) => {
    if (nextKey === tab) return;
    if (settingsDirty && tab === "settings") {
      const ok = window.confirm(
        "You have unsaved changes on Panel Settings.\n\n" +
        "Leave anyway? Your changes will be lost."
      );
      if (!ok) return;
      setSettingsDirty(false);
    }
    setTab(nextKey);
  };
  // Cloud-side display name lives in Firestore deviceCatalog — same
  // pattern the sensor/valve/motor detail pages use. Firmware never
  // writes deviceName to /info (installer sets it via AP page but
  // that's kept local); the customer-facing name comes from what the
  // admin typed in the dashboard's Edit dialog. Falls back to raw
  // code if catalog doc doesn't exist or hasn't loaded yet.
  const [catalog, setCatalog] = useState(null);

  // Read the applied config (firmware-confirmed) from /info/appliedConfig,
  // not from /config directly — see the analyticsOn declaration below for
  // full rationale. Kept above the history subscription because that
  // subscription is now gated on this value.
  const analyticsOn = info?.appliedConfig?.analyticsOn !== false;

  // Live subscription is already active via useDevice(code) at the parent.
  // Here we subscribe to /history ONLY when analytics is enabled — no
  // point pulling paired-run entries when the firmware wasn't writing
  // any (analyticsOn=false gates the /history push at source). Also
  // saves free-tier customers the bandwidth of a persistent listener
  // when they explicitly opted out of analytics.
  useEffect(() => {
    if (!code || !analyticsOn) {
      setHistory([]);
      return;
    }
    const unsub = listenToDeviceHistory(code, setHistory, 500);
    return unsub;
  }, [code, analyticsOn]);

  // Catalog fetch on mount + refresh helper. Not a listener — the
  // fields on this doc (name, cleaning dates, alert thresholds, pump
  // maintenance) change at most a few times per device lifetime, and
  // any local edit through this page calls refreshCatalog() directly
  // so nobody has to wait for a listener round-trip.
  const refreshCatalog = () => {
    if (!code) return;
    getDoc(doc(db, "deviceCatalog", code))
      .then((snap) => { if (snap.exists()) setCatalog(snap.data()); })
      .catch(() => { /* non-fatal — header falls back to code */ });
  };
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    getDoc(doc(db, "deviceCatalog", code))
      .then((snap) => { if (!cancelled && snap.exists()) setCatalog(snap.data()); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [code]);

  // analyticsOn declared above the history subscription — see rationale
  // there. Also used to gate History + Analytics tabs (hidden when off
  // so customer doesn't see empty tables + "disabled" placeholders).
  const displayName = catalog?.deviceName || code;

  // Rename dialog — customer taps the pencil next to the header title
  // to change the friendly name shown across the dashboard + kiosk.
  // Writes to Firestore deviceCatalog/{code}.deviceName so every
  // viewer sees the new name (matches sensor DeviceDetail's pattern).
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState("");
  async function handleRenameSave() {
    const next = renameValue.trim();
    if (!next) { setRenameError("Name can't be empty"); return; }
    if (next.length > 40) { setRenameError("Name too long (40 chars max)"); return; }
    if (next === (catalog?.deviceName || "")) { setRenameOpen(false); return; }
    setRenameSaving(true);
    try {
      await updateDoc(doc(db, "deviceCatalog", code), { deviceName: next });
      setCatalog((c) => ({ ...(c || {}), deviceName: next }));
      setRenameOpen(false);
      setRenameError("");
    } catch (e) {
      console.error("rename failed:", e);
      setRenameError("Save failed — try again");
    } finally {
      setRenameSaving(false);
    }
  }

  // When analytics flips off while the customer is sitting on one of
  // the analytics-only tabs, quietly snap back to Live so the empty
  // History table / "Analyze" button don't hang around. Runs only on
  // the actual flip, not on every render.
  useEffect(() => {
    if (!analyticsOn && (tab === "history" || tab === "analytics")) {
      setTab("live");   // programmatic — bypass dirty check; user didn't click
    }
  }, [analyticsOn, tab]);

  const hasSource = info?.hasSource ?? live?.hasSource ?? false;

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      {/* Header — matches sensor DeviceDetail's back-link style. */}
      <button
        onClick={() => navigate("/dashboard")}
        className="text-sm text-blue-600 hover:underline inline-block"
      >
        ← Back to Dashboard
      </button>
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-gray-900 truncate">{displayName}</h1>
            <button
              onClick={() => { setRenameValue(catalog?.deviceName || ""); setRenameError(""); setRenameOpen(true); }}
              title="Rename device"
              className="text-gray-400 hover:text-blue-600 p-1 rounded flex-shrink-0"
              aria-label="Rename device"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">{code} · {info?.firmwareVersion || "—"}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`w-2.5 h-2.5 rounded-full ${isOnline ? "bg-green-500" : "bg-gray-300"}`} />
          <span className="text-sm text-gray-600">{isOnline ? "Online" : "Offline"}</span>
        </div>
      </div>

      {/* Rename modal — inline, no external dependency. */}
      {renameOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !renameSaving && setRenameOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-lg text-gray-900 mb-3">Rename device</h3>
            <label className="text-sm text-gray-600 mb-1 block">Display name</label>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => { setRenameValue(e.target.value); setRenameError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleRenameSave(); if (e.key === "Escape") setRenameOpen(false); }}
              placeholder={code}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
              autoFocus
              disabled={renameSaving}
            />
            {renameError && <p className="text-red-600 text-xs mb-2">{renameError}</p>}
            <p className="text-xs text-gray-500 mb-4">
              Shown on your dashboard, kiosk, and everyone else who can see this pump.
              Device code <span className="font-mono">{code}</span> never changes.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRenameOpen(false)}
                disabled={renameSaving}
                className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >Cancel</button>
              <button
                onClick={handleRenameSave}
                disabled={renameSaving}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >{renameSaving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs — history + analytics only appear when analytics is on.
          When analytics is off, firmware isn't writing /history entries,
          so showing an empty History table (and an Analyze button that
          would compute over zero rows) would confuse the customer.
          Hiding entirely keeps the surface honest — turn analytics ON
          from the admin panel and the tabs reappear on the next config
          poll (~10 sec later). */}
      <div className="flex gap-1 border-b border-gray-200">
        {[
          { key: "live",      label: "Live" },
          analyticsOn && { key: "history",   label: "History" },
          analyticsOn && { key: "analytics", label: "Analytics" },
          { key: "settings",  label: "Panel Settings" },
        ].filter(Boolean).map((t) => (
          <button
            key={t.key}
            onClick={() => requestTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "live" && (
        <>
          <LiveSchematic code={code} live={live} info={info} catalog={catalog} />
          {/* Force Run — full-width button under the schematic. Hidden
              entirely when device is offline (see component). Owner-only
              gate is enforced there too. */}
          <ForceRunButton code={code} live={live} isOnline={isOnline} canEdit={true} settings={info?.appliedConfig} />
          <PumpAlertsPanel code={code} catalog={catalog} info={info} refresh={refreshCatalog} />
          <CleaningPanel code={code} catalog={catalog} hasSource={hasSource} refresh={refreshCatalog} />
          <DeviceInfoPanel code={code} info={info} live={live} catalog={catalog} isOnline={isOnline} />
        </>
      )}
      {tab === "history"   && <HistoryTable code={code} history={history} canClear={true} />}
      {tab === "analytics" && <AnalyticsTab code={code} history={history} analyticsOn={analyticsOn} catalog={catalog} info={info} live={live} canEdit={true} refresh={refreshCatalog} />}
      {tab === "settings"  && <PanelSettingsTab code={code} info={info} live={live} isOnline={isOnline} canEdit={true} onDirtyChange={setSettingsDirty} />}
    </div>
  );
}
