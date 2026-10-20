import { formatTimestamp, cmToFtIn } from "./TankViz";
import CleaningBadge from "./CleaningBadge";

// Firmware publishes these enums as strings on devices/{code}/live.
// See Wired_NAVI_v2_Terrace_cloud.ino cloudPushLive() for the source of truth.
//
// v2 pump-state labels distinguish AUTO from MANUAL running so a viewer
// can tell at a glance whether the pump kicked on via schedule/autofill
// (blue) or was force-started from the panel/dashboard (amber). Both
// are "running" — the qualifier lives in the label suffix rather than
// a separate badge to keep the pill compact.
const PUMP_STATE_STYLE = {
  off:      { label: "Off",              text: "text-gray-700",   dot: "bg-gray-400",   bg: "bg-gray-100 border-gray-200"       },
  auto:     { label: "Running · Auto",   text: "text-blue-700",   dot: "bg-blue-500",   bg: "bg-blue-50 border-blue-200"        },
  manual:   { label: "Running · Manual", text: "text-amber-700",  dot: "bg-amber-500",  bg: "bg-amber-50 border-amber-200"      },
  starting: { label: "Starting…",        text: "text-blue-700",   dot: "bg-blue-400",   bg: "bg-blue-50 border-blue-200"        },
  fault:    { label: "Fault",            text: "text-red-700",    dot: "bg-red-500",    bg: "bg-red-50 border-red-200"          },
  locked:   { label: "Locked",           text: "text-purple-700", dot: "bg-purple-500", bg: "bg-purple-50 border-purple-200"    },
};

// Discrete terrace-tank enum → percent fill. Used as a FALLBACK when
// firmware hasn't started publishing a continuous terracePct yet.
//
// Forward-compat contract with a future ultrasonic terrace-tank variant:
//   • /live/terracePct   — integer 0-100. If present, wins.
//   • /live/terraceState — string enum ("empty"|"half"|"full"|"sensor_fault").
//                          Used only when terracePct is absent.
//   • /info/terraceSensorType — optional "discrete" | "ultrasonic".
//                               Cosmetic only.
// Same tank icon renders for both — vertical fill 0-100% — so the day
// ultrasonic ships, no card rewrite is needed. Discrete variant just
// snaps to 0/50/100.
const TERRACE_ENUM_TO_PCT = {
  empty:        0,
  half:         50,
  full:         100,
  sensor_fault: null,
};

export function terracePctFromLive(live) {
  const p = live?.terracePct;
  if (typeof p === "number" && isFinite(p) && p >= 0 && p <= 100) return p;
  const s = live?.terraceState;
  const mapped = TERRACE_ENUM_TO_PCT[s];
  return mapped === undefined ? 0 : mapped;
}

// ── Ground / source tank icon ─────────────────────────────────────
// Squat wider-than-tall silhouette signals "underground / basement
// cistern". Filled with blue when water is present; hollow with a red
// outline when dry. Cleaning badge overlays the top-right when
// catalog has a lastCleanedAtSource + cleanIntervalDaysSource.
//
// `scale` prop lets the same icon render at card size (1.0) and
// PumpDetail Live-tab size (~2.0) without duplicating the SVG.
export function SourceTank({ wet, cleaningBadge = null, scale = 1 }) {
  const w = Math.round(70 * scale);
  const h = Math.round(56 * scale);
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative">
        <svg viewBox="0 0 100 80" style={{ width: w, height: h }} preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id={`src-grad-${scale}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#60a5fa" />
              <stop offset="100%" stopColor="#1d4ed8" />
            </linearGradient>
            <clipPath id={`src-clip-${scale}`}>
              <path d="M 10 26 Q 10 20 16 20 L 84 20 Q 90 20 90 26 L 90 62 Q 90 72 78 72 L 22 72 Q 10 72 10 62 Z" />
            </clipPath>
          </defs>
          {/* Manhole / lid on top */}
          <rect x="36" y="10" width="28" height="10" rx="2" fill="#64748b" />
          <rect x="40" y="6"  width="20" height="6"  rx="1.5" fill="#94a3b8" />
          {/* Tank body outline */}
          <path
            d="M 10 26 Q 10 20 16 20 L 84 20 Q 90 20 90 26 L 90 62 Q 90 72 78 72 L 22 72 Q 10 72 10 62 Z"
            fill={wet ? "#eff6ff" : "#fff"}
            stroke={wet ? "#2563eb" : "#dc2626"}
            strokeWidth="2.5"
          />
          {/* Water fill */}
          {wet && (
            <g clipPath={`url(#src-clip-${scale})`}>
              <rect x="0" y="34" width="100" height="40" fill={`url(#src-grad-${scale})`} />
              <ellipse cx="50" cy="34" rx="38" ry="2" fill="#93c5fd" opacity="0.75" />
            </g>
          )}
          {/* Dry indicator drops */}
          {!wet && (
            <g fill="#fca5a5">
              <circle cx="30" cy="50" r="2" />
              <circle cx="50" cy="56" r="2" />
              <circle cx="70" cy="50" r="2" />
            </g>
          )}
        </svg>
        {/* Cleaning badge overlay — tiny, top-right of tank */}
        {cleaningBadge && (
          <div className="absolute -top-1 -right-2 scale-75 origin-top-right">
            {cleaningBadge}
          </div>
        )}
      </div>
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${
        wet ? "text-blue-700" : "text-red-600"
      }`}>
        {wet ? "Water present" : "No water"}
      </span>
    </div>
  );
}

// ── Centrifugal pump silhouette ────────────────────────────────────
// Round housing with an impeller inside + outlet nozzle on top.
// When running, the inner impeller <g> rotates continuously so the
// viewer sees "the pump is doing work" — the water-flow arrows around
// it carry the "direction of flow" story. transform-origin matches
// the SVG-space impeller center so the blades spin cleanly around
// their own axis (default origin would swing them off-axis).
export function PumpIcon({ running, fault, scale = 1, maintenanceBadge = null }) {
  const w = Math.round(56 * scale);
  const h = Math.round(64 * scale);
  const stroke = fault ? "#dc2626" : (running ? "#2563eb" : "#64748b");
  const fill   = fault ? "#fef2f2" : (running ? "#eff6ff" : "#f9fafb");
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative">
      <svg viewBox="0 0 80 90" style={{ width: w, height: h }} preserveAspectRatio="xMidYMid meet">
        {/* Outlet nozzle on top */}
        <rect x="34" y="4" width="12" height="14" rx="1.5" fill={fill} stroke={stroke} strokeWidth="2.5" />
        {/* Round pump housing */}
        <circle cx="40" cy="46" r="26" fill={fill} stroke={stroke} strokeWidth="3" />
        {/* Impeller — 4 curved blades. Rotates when running via CSS.
            transform-box: view-box means transformOrigin uses SVG
            user coordinates (matches the viewBox="0 0 80 90" space)
            instead of the element's own bounding box. That way "40 46"
            correctly maps to the pump housing center regardless of
            the rendered SVG size, and the blades spin IN PLACE
            instead of orbiting off-axis. */}
        <g
          style={{
            transformOrigin: "40px 46px",
            transformBox: "view-box",
            animation: running ? "pump-spin 2s linear infinite" : "none",
          }}
        >
          <g stroke={stroke} strokeWidth="2.5" fill="none" strokeLinecap="round">
            <path d="M 40 26 Q 46 36 40 46" />
            <path d="M 60 46 Q 50 48 40 46" />
            <path d="M 40 66 Q 34 56 40 46" />
            <path d="M 20 46 Q 30 44 40 46" />
          </g>
          <circle cx="40" cy="46" r="4" fill={stroke} />
        </g>
        {/* Base */}
        <rect x="24" y="72" width="32" height="6" rx="1.5" fill={stroke} opacity="0.7" />
        <rect x="18" y="78" width="44" height="4" rx="1" fill={stroke} opacity="0.5" />
      </svg>
      {/* Maintenance-overdue badge overlays top-right of the pump. */}
      {maintenanceBadge && (
        <div className="absolute -top-1 -right-2 scale-75 origin-top-right">
          {maintenanceBadge}
        </div>
      )}
      </div>
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${
        fault ? "text-red-600" : (running ? "text-blue-700" : "text-gray-500")
      }`}>
        {fault ? "Fault" : (running ? "Pumping" : "Idle")}
      </span>
      {/* Impeller keyframes injected once per component instance.
          Simple continuous rotation — 1 revolution per 2 seconds. */}
      <style>{`
        @keyframes pump-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// ── Water-flow arrow between source→pump and pump→terrace ─────────
// Single triangle pointing right (matches the source → pump → terrace
// layout). Pulses when the pump is running.
export function WaterFlow({ running, scale = 1 }) {
  const sz = Math.round(24 * scale);
  return (
    <div className="flex flex-col items-center justify-center h-full pb-6">
      <svg
        viewBox="0 0 24 24"
        style={{ width: sz, height: sz }}
        className={running ? "" : "opacity-25"}
      >
        <path
          d="M 4 12 L 20 12 M 14 6 L 20 12 L 14 18"
          stroke="#2563eb"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          style={{ animation: running ? "pulse 1.2s ease-in-out infinite" : "none" }}
        />
      </svg>
    </div>
  );
}

// ── Terrace tank ───────────────────────────────────────────────────
// Elongated vertical silhouette — matches SensorCard's TankViz style
// for visual consistency across pump + sensor cards. Continuous
// vertical fill driven by pct (0-100) so we're already compatible
// with a future ultrasonic terrace variant. Sensor fault → hollow
// tank with a red X. Cleaning badge overlays top-right when the
// catalog has a lastCleanedAtTerrace + cleanIntervalDaysTerrace.
export function TerraceTank({ pct, isFault, running, cleaningBadge = null, scale = 1 }) {
  const w = Math.round(62 * scale);
  const h = Math.round(104 * scale);
  const innerTop    = 18;
  const innerBottom = 108;
  const innerH      = innerBottom - innerTop;
  const yStart      = innerBottom - Math.round((innerH * (pct || 0)) / 100);
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative">
        <svg viewBox="0 0 70 120" style={{ width: w, height: h }} preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id={`terr-grad-${scale}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#60a5fa" />
              <stop offset="100%" stopColor="#1d4ed8" />
            </linearGradient>
            <clipPath id={`terr-clip-${scale}`}>
              <path d="M 10 20 Q 10 14 16 14 L 54 14 Q 60 14 60 20 L 60 104 Q 60 112 52 112 L 18 112 Q 10 112 10 104 Z" />
            </clipPath>
          </defs>
          {/* Lid + inlet cap */}
          <rect x="8"  y="6" width="54" height="8" rx="2" fill="#64748b" />
          <rect x="26" y="0" width="18" height="8" rx="2" fill="#94a3b8" />
          {/* Tank body outline */}
          <path
            d="M 10 20 Q 10 14 16 14 L 54 14 Q 60 14 60 20 L 60 104 Q 60 112 52 112 L 18 112 Q 10 112 10 104 Z"
            fill="#fff"
            stroke={isFault ? "#dc2626" : "#94a3b8"}
            strokeWidth="2.5"
          />
          {/* Water fill */}
          {!isFault && pct > 0 && (
            <g clipPath={`url(#terr-clip-${scale})`}>
              <rect x="0" y={yStart} width="70" height={120 - yStart} fill={`url(#terr-grad-${scale})`} />
              <ellipse cx="35" cy={yStart} rx="24" ry="2" fill="#93c5fd" opacity="0.85" />
            </g>
          )}
          {/* Fault */}
          {isFault && (
            <text x="35" y="70" fontSize="30" fontWeight="bold" fill="#dc2626" textAnchor="middle">×</text>
          )}
        </svg>
        {/* Cleaning badge overlay */}
        {cleaningBadge && (
          <div className="absolute -top-1 -right-2 scale-75 origin-top-right">
            {cleaningBadge}
          </div>
        )}
      </div>
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${
        isFault ? "text-red-600" : "text-gray-600"
      }`}>
        {isFault ? "Fault" : (running && pct < 100 ? `${pct}% · Filling` : `${pct}%`)}
      </span>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────

// v118.0.9: find the next schedule window that WILL run today or in the
// next 7 days, honoring the per-schedule weekday mask + enabled flag.
// Returns {label, title} or null when no upcoming slot (nothing enabled).
function describeNextSchedule(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayBit = 1 << now.getDay();   // Sun=0..Sat=6, matches firmware dayMask
  // Already inside a window? Show "running soon" style chip instead of next.
  for (const s of schedules) {
    if (!s?.enabled) continue;
    const dm = (s.dayMask ?? 0x7F) & 0x7F;
    if (!(dm & todayBit)) continue;
    const start = s.startHour * 60 + s.startMinute;
    const end   = s.endHour   * 60 + s.endMinute;
    if (nowMin >= start && nowMin <= end) {
      return {
        label: `In schedule · ends ${String(s.endHour).padStart(2,"0")}:${String(s.endMinute).padStart(2,"0")}`,
        title: `Schedule window active until ${String(s.endHour).padStart(2,"0")}:${String(s.endMinute).padStart(2,"0")}`,
      };
    }
  }
  // Walk the next 7 days to find the earliest upcoming slot.
  const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  let best = null;   // {dayOffset, startMin, s}
  for (let d = 0; d < 7; d++) {
    const bit = 1 << ((now.getDay() + d) % 7);
    for (const s of schedules) {
      if (!s?.enabled) continue;
      const dm = (s.dayMask ?? 0x7F) & 0x7F;
      if (!(dm & bit)) continue;
      const start = s.startHour * 60 + s.startMinute;
      if (d === 0 && start <= nowMin) continue;   // already passed today
      if (!best || d < best.dayOffset || (d === best.dayOffset && start < best.startMin)) {
        best = { dayOffset: d, startMin: start, s };
      }
    }
    if (best && best.dayOffset === d) break;
  }
  if (!best) return null;
  const hh = String(best.s.startHour).padStart(2,"0");
  const mm = String(best.s.startMinute).padStart(2,"0");
  const dayLabel = best.dayOffset === 0 ? "today"
                 : best.dayOffset === 1 ? "tomorrow"
                 : DAYS[(now.getDay() + best.dayOffset) % 7];
  return {
    label: `Next ${dayLabel} ${hh}:${mm}`,
    title: `Next scheduled start: ${dayLabel} at ${hh}:${mm}${best.s.fillUntilFull ? " (fill until full)" : ""}`,
  };
}

export default function PumpCard({ deviceCode, deviceName, live, info, catalog, isOnline, alertLowPct, alertHighPct }) {
  const pumpState    = live?.pumpState    || "off";
  const sourceState  = live?.sourceState  || "dry";
  const hasSource    = info?.hasSource ?? live?.hasSource ?? false;
  const feedbackFault = !!live?.faults?.feedback;
  const terracePct   = terracePctFromLive(live);
  const terraceFault = live?.terraceState === "sensor_fault";

  // v118.0.6: terrace sensor offline detection — firmware explicitly
  // reports terraceSensorFault=true after 5-min watchdog trip. Also
  // treat as offline when terraceSensorAgeSec is large (>5 min) in case
  // the fault flag update got rate-limited by /live's 20-sec gap.
  // This is DIFFERENT from the whole device being offline (isOnline) —
  // the panel can be online + reporting, but the ultrasonic sensor
  // itself has lost signal.
  const terraceSensorFault = !!live?.terraceSensorFault ||
    (typeof live?.terraceSensorAgeSec === "number" && live.terraceSensorAgeSec > 300);
  const terraceSensorAgeSec = (typeof live?.terraceSensorAgeSec === "number")
    ? live.terraceSensorAgeSec : -1;
  const terraceSensorAgeLabel = (() => {
    if (terraceSensorAgeSec < 0) return "no valid reading yet";
    if (terraceSensorAgeSec < 60) return `${terraceSensorAgeSec} sec ago`;
    if (terraceSensorAgeSec < 3600) return `${Math.round(terraceSensorAgeSec / 60)} min ago`;
    return `${Math.round(terraceSensorAgeSec / 3600)} h ago`;
  })();

  // Alert flash — pumps have three glow triggers, evaluated in
  // priority order (red > green):
  //   1. Terrace pct crosses low/high thresholds (same as sensor cards)
  //   2. Source dry while pump trying to run (impeller-protection warn)
  //   3. Firmware fault causes flagged by the user (dry_run,
  //      max_runtime, safe_mode) — all red-glow.
  // Skip entirely when offline or on sensor-fault so the card doesn't
  // scream over stale/invalid data.
  const alertFlash = (() => {
    if (!isOnline || terraceFault) return "";
    const hasT   = (v) => v != null && v !== "";
    const runing = pumpState === "auto" || pumpState === "manual" || pumpState === "starting";
    if (catalog?.alertSourceDry      && sourceState === "dry" && runing) return "animate-pulse-red";
    if (catalog?.alertPumpDryRun     && live?.lastCauseEnd === "dry_run")     return "animate-pulse-red";
    if (catalog?.alertPumpMaxRuntime && live?.lastCauseEnd === "max_runtime") return "animate-pulse-red";
    if (catalog?.alertPumpSafeMode   && live?.pumpStage    === "SAFE_MODE")   return "animate-pulse-red";
    if (hasT(alertLowPct)  && terracePct <= Number(alertLowPct))  return "animate-pulse-red";
    if (hasT(alertHighPct) && terracePct >= Number(alertHighPct)) return "animate-pulse-green";
    return "";
  })();

  const pumpStyle = PUMP_STATE_STYLE[pumpState] || PUMP_STATE_STYLE.off;
  const isRunning = pumpState === "auto" || pumpState === "manual";

  // Per-tank cleaning schedules — separate fields on the catalog so a
  // ground cistern (rarely cleaned) and terrace tank (cleaned often)
  // track independently. Falls back to null when either field pair
  // is missing → CleaningBadge quietly returns null and nothing renders.
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
  // Pump maintenance badge — same visual language as CleaningBadge but
  // keyed on the pump-specific fields (lastPumpMaintenanceAt +
  // pumpMaintenanceIntervalDays). Renders on top-right of the PumpIcon
  // when the interval has been reached, so the customer sees the
  // "service due" hint on the tile without having to open the detail page.
  const pumpMaintBadge = (
    <CleaningBadge
      lastCleanedAt={catalog?.lastPumpMaintenanceAt}
      cleanIntervalDays={catalog?.pumpMaintenanceIntervalDays}
    />
  );

  // Schematic grid template — explicit tracks so the icons never wrap
  // or spill outside the card. Two variants:
  //   • hasSource=true  → source | arrow | pump | arrow | terrace
  //   • hasSource=false → pump | arrow | terrace
  const gridCols = hasSource
    ? "auto 24px auto 24px auto"
    : "auto 24px auto";

  return (
    <div
      className={`block bg-white rounded-xl shadow-sm border p-4 transition-all hover:shadow-md ${
        isOnline ? "border-gray-200" : "border-gray-200 opacity-60"
      } ${alertFlash}`}
    >
      {/* Header — mirrors SensorCard exactly: name+code left, only the
          green online dot + text on the right. No "Panel" chip up here —
          that lives below the schematic in the same slot SensorCard
          uses for "Ultrasonic"/"DIP" so both card types have identical
          vertical rhythm. */}
      <div className="flex items-center justify-between mb-1">
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-900 text-sm truncate">{deviceName || deviceCode}</h3>
          <p className="text-xs text-gray-400 truncate">{deviceCode}</p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-green-500" : "bg-gray-300"}`} />
          <span className="text-xs text-gray-500">{isOnline ? "Online" : "Offline"}</span>
        </div>
      </div>

      {/* Pump-state pill — compact colored capsule directly under the
          header, replacing the previous full-width grey bar. */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${pumpStyle.bg} ${pumpStyle.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${pumpStyle.dot}`} />
          {pumpStyle.label}
        </span>
        {/* v118.0.9: schedule-mode chip. When schedule mode is on but
            pump is NOT currently inside an active window, tell the user
            when the next window opens so they don't mistake "pump idle"
            for "pump broken". Shown ONLY when scheduleModeEnabled is
            true AND pump is currently idle (if pump is running the
            pump-state pill already conveys the state). */}
        {info?.appliedConfig?.scheduleModeEnabled && pumpState === "off" && (() => {
          const nextInfo = describeNextSchedule(info?.appliedConfig?.schedules);
          if (!nextInfo) return null;
          return (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700" title={nextInfo.title}>
              <span>📅</span>
              <span>{nextInfo.label}</span>
            </span>
          );
        })()}
        {feedbackFault && (
          <span className="text-[10px] text-red-600 font-medium">⚠ feedback fault</span>
        )}
        {/* v118.0.13: compact operMode chip for fault-ish modes so the
            dashboard reflects dry-run / safe-mode / source-dry without
            needing to open the PumpDetail page. normal/idle/manual_override
            are hidden — the main pump pill already covers those. */}
        {(() => {
          const operMode = live?.operMode;
          const chips = {
            dry_run_recovery:  { bg: "bg-amber-50 border-amber-200 text-amber-700",     label: "🔄 Dry run · retrying" },
            safe_mode:         { bg: "bg-red-50 border-red-200 text-red-700",           label: "🛟 Safe mode" },
            source_dry_run:    { bg: "bg-blue-50 border-blue-200 text-blue-700",        label: "💧 Source dry" },
            panel_fault:       { bg: "bg-red-50 border-red-200 text-red-700",           label: "⚠ Panel fault" },
            sensor_offline:    { bg: "bg-purple-50 border-purple-200 text-purple-700",  label: "📡 Sensor offline" },
            paused:            { bg: "bg-amber-50 border-amber-200 text-amber-700",     label: "⏸ Paused" },
          };
          const chip = chips[operMode];
          if (!chip) return null;
          return (
            <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${chip.bg}`}>
              {chip.label}
            </span>
          );
        })()}
      </div>

      {/* Schematic — CSS grid with explicit tracks */}
      <div
        className="grid items-end justify-center gap-2 mb-3 py-1"
        style={{ gridTemplateColumns: gridCols }}
      >
        {hasSource && <SourceTank wet={sourceState === "wet"} cleaningBadge={sourceCleaningBadge} />}
        {hasSource && <WaterFlow running={isRunning} />}
        <PumpIcon running={isRunning} fault={pumpState === "fault"} maintenanceBadge={pumpMaintBadge} />
        <WaterFlow running={isRunning} />
        <TerraceTank pct={terracePct} isFault={terraceFault} running={isRunning} cleaningBadge={terraceCleaningBadge} />
      </div>

      {/* v118.0.6: sensor-offline banner — ONLY shows when the terrace
          ultrasonic sensor itself is dead (NOT when the whole device is
          offline — that's a separate signal in the header dot). Pump
          operations are suspended by firmware safety path when this
          state is true; banner tells the customer why and how old the
          last valid reading is. */}
      {terraceSensorFault && isOnline && (
        <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 flex items-start gap-2">
          <span className="text-base leading-none mt-0.5">⚠</span>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-red-700">Tank sensor offline</div>
            <div className="text-[11px] text-red-600 mt-0.5">
              Last valid reading: {terraceSensorAgeLabel}. Pump operations suspended until sensor recovers.
            </div>
          </div>
        </div>
      )}

      {/* v118 ultrasonic variant — stat pills row (LEVEL / VOLUME / DEPTH).
          Shown only when the panel is reporting an ultrasonic terrace
          sensor (info.terraceSensorType === "ultrasonic" OR firmware
          publishes live.rawCm / live.tankHeightCm — presence of either
          is enough to compute depth + volume).

          Discrete-probe panels (v117 line) skip this entirely — their
          terrace data is just empty/half/full enum, no depth/volume
          math makes sense. */}
      {(() => {
        const isUltrasonic = (info?.terraceSensorType === "ultrasonic") ||
                             (typeof live?.rawCm === "number");
        if (!isUltrasonic) return null;
        const tankHeightCm   = info?.tankHeightCm   ?? live?.tankHeightCm   ?? null;
        const sensorOffsetCm = info?.sensorOffsetCm ?? live?.sensorOffsetCm ?? 0;
        const rawCm          = (typeof live?.rawCm === "number") ? live.rawCm : null;
        // Depth = tankHeightCm - rawCm (both from tank bottom reference).
        // Sensor offset defines where the "100%" water line is but doesn't
        // change the water depth formula: distance-from-sensor-to-water
        // IS the air column; column minus that = water depth.
        const waterDepthCm = (tankHeightCm != null && rawCm != null)
          ? Math.max(0, tankHeightCm - rawCm)
          : null;
        const depthDisplay = waterDepthCm != null ? cmToFtIn(waterDepthCm) : null;
        // Volume from capacity × pct. v118.0.7: prefer the firmware-
        // confirmed tankVolume (info.appliedConfig.tankVolume — written
        // by the panel after the user saves on the Settings tab) over
        // the legacy catalog.tankCapacityLitres field, which required a
        // separate manual entry per device. Falls back to catalog for
        // backward compat on older panels.
        const tankCap = info?.appliedConfig?.tankVolume || catalog?.tankCapacityLitres || 0;
        const litres = (tankCap > 0 && !terraceFault)
          ? Math.round((terracePct / 100) * tankCap)
          : null;
        const volDisplay = (() => {
          if (litres == null) return null;
          const total = tankCap;
          const useKL = litres >= 1000 || total >= 1000;
          if (useKL) {
            const p = (litres / 1000).toFixed(litres % 1000 === 0 ? 0 : 1);
            const t = (total  / 1000).toFixed(total  % 1000 === 0 ? 0 : 1);
            return { present: p, total: `/${t}KL` };
          }
          return { present: String(litres), total: `/${total}L` };
        })();
        return (
          <div className="flex items-stretch gap-1.5 w-full mb-3">
            {/* LEVEL — always shown on ultrasonic variant */}
            <div className={`flex-1 min-w-0 overflow-hidden rounded-lg px-2 py-1.5 text-center shadow-sm ${
              terraceFault
                ? "bg-gradient-to-br from-purple-50 to-purple-100 ring-1 ring-purple-200"
                : "bg-gradient-to-br from-blue-50 to-blue-100 ring-1 ring-blue-200"
            }`}>
              <div className={`text-[9px] uppercase tracking-wider font-semibold ${terraceFault ? "text-purple-600" : "text-blue-600"}`}>Level</div>
              <div className={`text-base font-extrabold leading-tight ${terraceFault ? "text-purple-700" : "text-blue-700"}`}>
                {terraceFault ? "ERR" : `${terracePct}%`}
              </div>
            </div>
            {/* VOLUME — when catalog has capacity */}
            {volDisplay && (
              <div className="flex-1 min-w-0 overflow-hidden rounded-lg px-1.5 py-1.5 text-center shadow-sm bg-gradient-to-br from-cyan-50 to-cyan-100 ring-1 ring-cyan-200">
                <div className="text-[9px] uppercase tracking-wider font-semibold text-cyan-600">Volume</div>
                <div className="text-sm font-extrabold leading-tight text-cyan-700 truncate">
                  {volDisplay.present}
                  <span className="text-[10px] font-semibold text-cyan-600 ml-0.5">{volDisplay.total}</span>
                </div>
              </div>
            )}
            {/* DEPTH — when geometry is known */}
            {depthDisplay && (
              <div className="flex-1 min-w-0 overflow-hidden rounded-lg px-2 py-1.5 text-center shadow-sm bg-gradient-to-br from-purple-50 to-purple-100 ring-1 ring-purple-200">
                <div className="text-[9px] uppercase tracking-wider font-semibold text-purple-600">Depth</div>
                <div className={`font-extrabold leading-tight text-purple-700 ${depthDisplay.length > 9 ? "text-xs" : "text-sm"}`}>
                  {depthDisplay}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Device-kind label — same slot SensorCard uses for "Ultrasonic".
          Keeps the two card types visually aligned when stacked side
          by side in the Dashboard grid. v118 variant adds "· Ultrasonic"
          so customer can tell at a glance which sensor type is wired. */}
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>{info?.terraceSensorType === "ultrasonic" ? "Panel · Ultrasonic" : "Panel"}</span>
      </div>

      {/* Footer — timestamp only, matches SensorCard's minimalist bottom */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100">
        <span className="text-xs text-gray-400">
          {live?.ts ? formatTimestamp(live.ts) : "No data yet"}
        </span>
      </div>
    </div>
  );
}
