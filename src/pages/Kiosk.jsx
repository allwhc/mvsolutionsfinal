import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useDevices } from "../hooks/useDevices";
import { useDebouncedAlerts } from "../hooks/useDebouncedAlerts";
import { getOrgGroups } from "../firebase/db";

// Level-band palette. Each band has three tones — deep (used litres),
// mid (pct / band label / tile border), soft (out-of-total litres).
// The three tones share the same hue so "12 KL / 40 KL" reads as one
// object instead of two disconnected numbers.
function bandFor(pct) {
  if (pct <= 0) return {
    key: "empty", label: "Empty",
    fill: "#dc2626", text: "#fff",
    deep: "#fca5a5", soft: "#7f1d1d",
  };
  if (pct <= 25) return {
    key: "low", label: "Low",
    fill: "#ea580c", text: "#fff",
    deep: "#fdba74", soft: "#7c2d12",
  };
  if (pct <= 50) return {
    key: "half", label: "Half",
    fill: "#eab308", text: "#111",
    deep: "#fde047", soft: "#713f12",
  };
  if (pct <= 75) return {
    key: "good", label: "Good",
    fill: "#0284c7", text: "#fff",
    deep: "#7dd3fc", soft: "#0c4a6e",
  };
  return {
    key: "full", label: "Full",
    fill: "#16a34a", text: "#fff",
    deep: "#86efac", soft: "#14532d",
  };
}

// Format 750 → "750 L", 1500 → "1.5 KL", 2500000 → "2.5 ML"
function fmtLitres(v) {
  if (!v || v <= 0) return "";
  if (v >= 1000000) return (v / 1000000).toFixed(2) + " ML";
  if (v >= 1000)    return (v / 1000).toFixed(1) + " KL";
  return v + " L";
}

// Water depth in cm for ultrasonic — same logic as SensorCard's
// computeWaterDepthCm. Kept local here so Kiosk doesn't need to
// import from the DeviceCard tree.
function computeDepthKiosk({ rawCm, pct, tankHeightCm, overflowCm, suctionCm }) {
  const tank = Number(tankHeightCm);
  if (!isFinite(tank) || tank <= 0) return null;
  const ovfl    = Number(overflowCm) || 0;
  const suction = Number(suctionCm)  || 0;
  const suctionCutoffCm = suction > 0 && suction < tank ? tank - suction : tank;
  const topCutoffCm     = ovfl    > 0 && ovfl    < tank ? ovfl           : 0;
  const rc = Number(rawCm);
  if (isFinite(rc) && rc > 0) {
    let d = suctionCutoffCm - rc;
    if (d < 0) d = 0;
    if (d > suctionCutoffCm - topCutoffCm) d = suctionCutoffCm - topCutoffCm;
    return d;
  }
  const p = Number(pct);
  if (isFinite(p) && p >= 0 && p <= 100) {
    const usable = suctionCutoffCm - topCutoffCm;
    if (usable <= 0) return null;
    return (p / 100) * usable;
  }
  return null;
}

// cm → "X ft Y in", or "" if depth is null.
function cmToFtInKiosk(cm) {
  if (cm == null || !isFinite(cm) || cm < 0) return "";
  const totalInches = cm / 2.54;
  let ft = Math.floor(totalInches / 12);
  let inches = Math.round(totalInches - ft * 12);
  if (inches === 12) { ft += 1; inches = 0; }
  return `${ft} ft ${inches} in`;
}

// A tank is "in alert" ONLY when the user has explicitly set a threshold
// AND the current value crosses it. Purple/grey states (sensor fault,
// offline) DO NOT push a tank to alert zone — they just tint the tile.
function isTankInAlert(d, isOnline) {
  if (!isOnline) return false;
  const pct = d.live?.confirmedPct;
  if (pct == null) return false;
  const lo = d.alertLowPct;
  const hi = d.alertHighPct;
  if (lo != null && lo !== "" && pct <= lo)  return true;
  if (hi != null && hi !== "" && pct >= hi)  return true;
  return false;
}

// Severity for alert-zone sort: empty (0) worst, then low pct, then high pct.
function alertSeverity(d) {
  const pct = d.live?.confirmedPct ?? 0;
  const lo  = d.alertLowPct;
  const hi  = d.alertHighPct;
  if (lo != null && lo !== "" && pct <= lo) {
    // Low alerts: emptier = more severe. Empty = 0 = lowest score.
    return pct;
  }
  if (hi != null && hi !== "" && pct >= hi) {
    // High alerts: fuller = more severe. Rank after all low alerts.
    return 1000 - pct;
  }
  return 9999;
}

// Presentational tile. Two layouts:
//   compact = false (default) — SVG tank + name + pct + capacity
//   compact = true            — no SVG; name + big pct + capacity only
function TankTile({ d, isOnline, colorByLevel, compact, isAlert }) {
  const pct        = d.live?.confirmedPct ?? 0;
  const flags      = d.live?.flags ?? 0;
  // Sensor-fault bit (flags & 0x01) is meaningful for ultrasonic
  // (transducer failure, out-of-range distance, hardware issue that
  // needs attention). For DIP it also fires on inconsistent probe
  // patterns — a wiring quirk that's a technician problem, not a
  // customer problem. Kiosk hides DIP faults entirely so the
  // customer doesn't see purple panic tiles for what is really a
  // "please call your installer" state; the tile shows the resolved
  // level like normal. Ultrasonic faults still surface because they
  // mean the reading itself is not trustworthy.
  const sType      = d.info?.sensorType ?? d.catalog?.sensorType;
  const sensorErr  = (flags & 0x01) === 0x01 && sType === 2;
  const band       = bandFor(pct);
  const capL       = d.tankCapacityLitres || d.catalog?.tankCapacityLitres || 0;
  const litres     = capL > 0 ? Math.round((pct * capL) / 100) : 0;
  // Name hierarchy: cloud-side deviceName wins because that's what the
  // customer/admin curated on the DeviceDetail page knowing it appears
  // on kiosk + dashboard. Installer's AP-page userAssignedName is only
  // a bootstrap default — fall back to it only if the cloud name is
  // missing, then to the raw device code as the last resort. Matches
  // SensorCard on the Dashboard so both surfaces show the same name
  // for the same tank.
  const displayName = d.deviceName || d.info?.userAssignedName || d.deviceCode;

  // Water depth for ultrasonic devices. Same source-of-truth
  // priority as SensorCard: prefer live.rawCm (exact), fall back to
  // pct + geometry math. Null when device is DIP, offline, errored,
  // or geometry not yet reported. sType is declared above for the
  // sensor-fault gate.
  const depthText = (sType === 2 && isOnline && !sensorErr)
    ? cmToFtInKiosk(computeDepthKiosk({
        rawCm:        d.live?.rawCm,
        pct,
        tankHeightCm: d.info?.tankHeightCm,
        overflowCm:   d.info?.overflowCm,
        suctionCm:    d.info?.suctionCm,
      }))
    : "";

  // Tile-level status color. Alert flashing wins visually via the outer
  // ring; below the ring the tile still shows its band color so a viewer
  // can tell WHICH kind of alert (empty vs low-25 vs high-90).
  //
  // Offline tiles keep the band color (green/amber/orange/red) so the
  // customer at the kiosk still sees the last-known level at a glance
  // — a grey "OFFLINE" wall would panic them into thinking the tank
  // itself is gone. Only sensor faults get the purple flag (that IS a
  // real hardware problem worth surfacing). Never-reported devices are
  // filtered out entirely upstream in filteredDevices, so we never
  // reach this branch with no data.
  let tileTint = band.fill;
  if (sensorErr) tileTint = "#7e22ce";     // purple

  // Water fill color for the SVG. Off → traditional blue. On → level band.
  const waterFill = colorByLevel ? band.fill : "#2563eb";
  const waterTop  = colorByLevel ? band.fill : "#60a5fa";

  // Tank SVG geometry (matches the AP page silhouette).
  const innerTop    = 50;
  const innerBottom = 240;
  const innerH      = innerBottom - innerTop;
  const yStart      = innerBottom - Math.round((innerH * pct) / 100);

  return (
    <div
      className={
        "relative flex flex-col rounded-xl border-2 overflow-hidden w-full " +
        (isAlert ? "animate-pulse ring-4 ring-red-500 ring-offset-2 ring-offset-neutral-900" : "")
      }
      style={{
        background: "#111827",
        borderColor: tileTint,
      }}
    >
      {/* Top band with band color + label. Offline devices keep the
          band label (FULL/HALF/etc) with a clock icon in the corner —
          the customer sees the last-known state was normal, and the
          clock signals "this is a snapshot, not live". No duration
          text (deliberate — invites less panic than "OFFLINE 3 hr").
          Device code moved to the bottom-right, tiny grey — visible
          for a technician standing at the kiosk but doesn't clutter
          the customer view. */}
      <div
        className="px-2 py-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider"
        style={{ background: tileTint, color: band.text }}
      >
        <span>{sensorErr ? "Sensor Fault" : band.label}</span>
        {!isOnline && !sensorErr && (
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-label="Last-known snapshot — device is offline">
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 14" />
          </svg>
        )}
      </div>

      {compact ? (
        // Compact: name on top, big pct, then litres as two harmonised
        // tones of the same hue — deep (used) + soft badge (of total)
        // so both numbers stay legible + visually connected. Offline
        // tiles still render the last-known pct + litres in full color
        // — the clock icon in the top band is the only offline signal.
        <div className="flex-1 flex flex-col justify-center items-center py-4 px-2 gap-1.5">
          <div className="text-sm text-neutral-200 text-center line-clamp-1 w-full font-semibold">
            {displayName}
          </div>
          <div className="text-5xl font-black leading-none tracking-tight" style={{ color: tileTint }}>
            {pct}%
          </div>
          {capL > 0 && (
            <div
              className="mt-1 flex items-baseline gap-1.5 px-3 py-1.5 rounded-full whitespace-nowrap"
              style={{ background: band.soft }}
            >
              <span
                className="text-xl font-extrabold leading-none"
                style={{ color: band.deep }}
              >
                {fmtLitres(litres)}
              </span>
              <span
                className="text-xs font-bold leading-none"
                style={{ color: band.deep, opacity: 0.7 }}
              >
                /
              </span>
              <span
                className="text-sm font-bold leading-none"
                style={{ color: band.deep, opacity: 0.85 }}
              >
                {fmtLitres(capL)}
              </span>
            </div>
          )}
          {/* Depth pill for ultrasonic — indigo tone to distinguish
              from the level-band litres pill. Only when we have real
              geometry data. */}
          {depthText && (
            <div className="mt-1 px-2.5 py-1 rounded-full whitespace-nowrap bg-indigo-900/60">
              <span className="text-sm font-bold text-indigo-200 leading-none">
                Depth {depthText}
              </span>
            </div>
          )}
        </div>
      ) : (
        // Normal layout: SVG tank on left, readout on right.
        <div className="flex-1 flex items-stretch p-2 gap-2">
          <svg viewBox="0 0 150 260" className="h-24 w-16 flex-shrink-0" preserveAspectRatio="xMidYMid meet">
            <defs>
              <clipPath id={`clip-${d.deviceCode}`}>
                <path d="M 15 60 Q 15 50 25 50 L 125 50 Q 135 50 135 60 L 135 220 Q 135 240 115 240 L 35 240 Q 15 240 15 220 Z" />
              </clipPath>
              <linearGradient id={`grad-${d.deviceCode}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={waterTop} />
                <stop offset="100%" stopColor={waterFill} />
              </linearGradient>
            </defs>
            {/* body */}
            <path
              d="M 15 60 Q 15 50 25 50 L 125 50 Q 135 50 135 60 L 135 220 Q 135 240 115 240 L 35 240 Q 15 240 15 220 Z"
              fill="#1f2937"
              stroke="#94a3b8"
              strokeWidth="3"
            />
            {/* lid */}
            <rect x="10" y="30" width="130" height="14" rx="4" fill="#475569" />
            <rect x="35" y="20" width="80" height="12" rx="3" fill="#64748b" />
            {/* water — draws last-known level whether online or not.
                Empty tank (pct 0) has nothing to fill. */}
            {pct > 0 && (
              <g clipPath={`url(#clip-${d.deviceCode})`}>
                <rect x="0" y={yStart} width="150" height={innerBottom - yStart} fill={`url(#grad-${d.deviceCode})`} />
                <ellipse cx="75" cy={yStart} rx="65" ry="3" fill={waterTop} opacity="0.7" />
              </g>
            )}
          </svg>

          <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
            <div className="text-xs text-neutral-300 line-clamp-2 font-medium leading-tight">
              {displayName}
            </div>
            <div className="text-3xl font-black leading-none" style={{ color: tileTint }}>
              {pct}%
            </div>
            {capL > 0 && (
              <div className="text-[10px] text-neutral-400 truncate">
                {fmtLitres(litres)} / {fmtLitres(capL)}
              </div>
            )}
            {/* Ultrasonic-only depth line — matches the compact-mode
                indigo tone so both layouts read the same. */}
            {depthText && (
              <div className="text-[10px] text-indigo-300 truncate font-semibold">
                Depth {depthText}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Tiny device-code footer — used to sit in the top-right of the
          banner; moved here so the customer-facing header stays clean
          (they don't care about SF-XXX codes). Small grey text still
          lets a technician standing at the kiosk identify a specific
          tank without hunting through /admin/devices. */}
      <div className="absolute bottom-1 right-1.5 text-[8px] text-neutral-500 font-mono leading-none opacity-70 pointer-events-none">
        {d.deviceCode.split("-")[1]}
      </div>
    </div>
  );
}

export default function Kiosk() {
  const { user, userData, isOrgAdmin, isOrgMember } = useAuth();
  const { devices: rawDevices, loading } = useDevices();
  const navigate = useNavigate();

  // 1-min sustained-state debounce for level threshold alerts. Same
  // hook Dashboard uses — keeps kiosk in sync with the dashboard's
  // alert state so the wall display and the operator's laptop don't
  // disagree about whether a tank is "in alert" right now. Devices
  // whose crossings haven't committed yet get alertLowPct/alertHighPct
  // nulled, which makes isTankInAlert(), alertSeverity() and the
  // ring-4 red pulse all fall through as "no alert" until the flip
  // has held for 1 min.
  const debouncedAlerts = useDebouncedAlerts(rawDevices);
  const devices = useMemo(() => {
    return rawDevices.map((d) => {
      if (debouncedAlerts.get(d.deviceCode)) return d;
      return { ...d, alertLowPct: null, alertHighPct: null };
    });
  }, [rawDevices, debouncedAlerts]);

  // Preferences persisted per-browser. Not synced to Firestore — the
  // kiosk display setup lives on the TV/monitor that's running it, and
  // owner might want different tiles on their laptop vs the wall display.
  const [colorByLevel, setColorByLevel] = useState(
    () => localStorage.getItem("kiosk.colorByLevel") === "true"
  );
  const [compact, setCompact] = useState(
    () => localStorage.getItem("kiosk.compact") === "true"
  );
  const [groupFilter, setGroupFilter] = useState(
    () => localStorage.getItem("kiosk.groupFilter") || "all"
  );

  useEffect(() => { localStorage.setItem("kiosk.colorByLevel", String(colorByLevel)); }, [colorByLevel]);
  useEffect(() => { localStorage.setItem("kiosk.compact",      String(compact));      }, [compact]);
  useEffect(() => { localStorage.setItem("kiosk.groupFilter",  groupFilter);          }, [groupFilter]);

  // Groups for org accounts — reuse existing helper.
  const isOrg = isOrgAdmin || isOrgMember;
  const orgId = userData?.orgId;
  const [groups, setGroups] = useState([]);
  useEffect(() => {
    if (isOrg && orgId) getOrgGroups(orgId).then(setGroups);
  }, [isOrg, orgId]);

  // Request browser fullscreen on entry. Chrome/Edge/Firefox all support
  // requestFullscreen; iOS Safari doesn't but the kiosk view still works
  // — the browser chrome just stays visible.
  useEffect(() => {
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen().catch(() => {
        // User denied or browser blocked — ignore, page still works.
      });
    }
    // Auto-exit on route change / unmount.
    return () => {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  // Esc key exits kiosk mode (in addition to browser's native Esc for
  // fullscreen — we also navigate away so user isn't stuck staring at
  // the kiosk view with browser chrome back).
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") handleExit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleExit() {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    navigate("/dashboard");
  }

  // Online = has heartbeat within the last 15 min. Matches Dashboard.jsx.
  const isDeviceOnline = (d) => {
    const lastSeen = d.info?.lastSeen;
    const isStale  = lastSeen ? (Date.now() - lastSeen) > 900000 : true;
    return d.info?.online && !isStale;
  };

  // Apply group filter same way Dashboard does. Individual accounts skip
  // this entirely — the dropdown is hidden for them.
  //
  // Also drop never-reported devices from the kiosk grid entirely — no
  // /live payload means we have nothing meaningful to display (no
  // last-known pct, no fill color, no litres). A "?" placeholder tile
  // would invite the customer to ask "what's wrong with that tank?"
  // — worse than not showing it at all. Admin / installer can still
  // see never-reported devices on /admin/devices and the regular
  // Dashboard for diagnostic purposes. The moment first data arrives
  // the tile appears in the kiosk on the next real-time update.
  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      if (!d.live) return false;
      if (groupFilter === "all") return true;
      const g = groups.find((x) => x.groupId === groupFilter);
      if (g) return g.deviceCodes?.includes(d.deviceCode);
      return true;
    });
  }, [devices, groupFilter, groups]);

  // Split into alert vs normal buckets. Alert bucket sorted by severity
  // (empty first). Normal bucket alphabetical by displayed name for
  // predictable wall-of-tanks scanning.
  const { alertTanks, normalTanks } = useMemo(() => {
    const alerts = [];
    const normal = [];
    for (const d of filteredDevices) {
      const online = isDeviceOnline(d);
      if (isTankInAlert(d, online)) alerts.push(d);
      else normal.push(d);
    }
    alerts.sort((a, b) => alertSeverity(a) - alertSeverity(b));
    normal.sort((a, b) => {
      const na = (a.info?.userAssignedName || a.deviceName || a.deviceCode).toLowerCase();
      const nb = (b.info?.userAssignedName || b.deviceName || b.deviceCode).toLowerCase();
      return na.localeCompare(nb);
    });
    return { alertTanks: alerts, normalTanks: normal };
  }, [filteredDevices]);

  // Grid sizing: normal tiles 180px min, compact 140px min. auto-fill wraps.
  const gridClass = compact
    ? "grid gap-3"
    : "grid gap-3";
  const gridStyle = {
    gridTemplateColumns: compact
      ? "repeat(auto-fill, minmax(160px, 1fr))"
      : "repeat(auto-fill, minmax(200px, 1fr))",
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-900 text-white flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-neutral-700 bg-neutral-950 flex-shrink-0">
        {/* Logo + brand */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-black text-white text-sm">
            SF
          </div>
          <div>
            <div className="text-sm font-bold leading-none">SenseFlow</div>
            <div className="text-[10px] text-neutral-400 leading-none mt-0.5">Kiosk</div>
          </div>
        </div>

        {/* Group filter (org accounts only) */}
        {isOrg && groups.length > 0 && (
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            className="ml-2 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            <option value="all">All Groups</option>
            {groups.map((g) => (
              <option key={g.groupId} value={g.groupId}>{g.name}</option>
            ))}
          </select>
        )}

        {/* Toggles */}
        <div className="flex items-center gap-2 ml-2">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none bg-neutral-800 px-2.5 py-1.5 rounded-lg border border-neutral-700 hover:border-neutral-600">
            <input
              type="checkbox"
              checked={colorByLevel}
              onChange={(e) => setColorByLevel(e.target.checked)}
              className="accent-blue-500"
            />
            Color by level
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none bg-neutral-800 px-2.5 py-1.5 rounded-lg border border-neutral-700 hover:border-neutral-600">
            <input
              type="checkbox"
              checked={compact}
              onChange={(e) => setCompact(e.target.checked)}
              className="accent-blue-500"
            />
            Compact tiles
          </label>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* User + exit */}
        <div className="text-right leading-tight">
          <div className="text-sm font-medium">{userData?.displayName || user?.email}</div>
          {isOrg && (
            <div className="text-[10px] text-neutral-400">{userData?.orgName || orgId}</div>
          )}
        </div>
        <button
          onClick={handleExit}
          className="ml-2 flex items-center gap-1.5 bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded-lg text-sm font-semibold"
          title="Exit kiosk (Esc)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          Exit
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {filteredDevices.length === 0 ? (
          <div className="h-full flex items-center justify-center text-neutral-500">
            No devices to display
          </div>
        ) : (
          <>
            {/* Alert zone — only renders when at least one tank is in alert. */}
            {alertTanks.length > 0 && (
              <div className="mb-6 rounded-xl border-2 border-red-600 bg-red-950/30 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <svg className="w-5 h-5 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                  <span className="text-sm font-bold uppercase tracking-wider text-red-400">
                    Alerts &mdash; {alertTanks.length} tank{alertTanks.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className={gridClass} style={gridStyle}>
                  {alertTanks.map((d) => (
                    <TankTile
                      key={d.deviceCode}
                      d={d}
                      isOnline={isDeviceOnline(d)}
                      colorByLevel={colorByLevel}
                      compact={compact}
                      isAlert={true}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Normal zone */}
            {normalTanks.length > 0 && (
              <div className={gridClass} style={gridStyle}>
                {normalTanks.map((d) => (
                  <TankTile
                    key={d.deviceCode}
                    d={d}
                    isOnline={isDeviceOnline(d)}
                    colorByLevel={colorByLevel}
                    compact={compact}
                    isAlert={false}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
