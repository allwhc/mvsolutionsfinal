// Pump Analytics tab — full graphical rewrite.
//
// Design: one long scrolling page, three semantic sections a society
// secretary / homeowner / support engineer can each find what they
// need in:
//
//   Usage    → how much has the pump been working
//   Health   → is the pump slowing down / failing
//   Efficiency → energy cost + water throughput
//
// All charts are inline SVG (no external chart library) — page stays
// fast, matches the existing sensor-detail pattern, one bundle chunk.
//
// Computation happens on-demand via computePumpAnalytics(history). The
// parent gates the history subscription on analyticsOn so if the flag
// is OFF this tab renders a stub telling the customer it's disabled.

import { useState, useMemo, useEffect } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../../firebase/config";
import {
  computePumpAnalytics,
  estimateEnergyKwh,
  fmtDuration,
  fmtEnergy,
  FAULT_CAUSE_LABEL,
} from "../../utils/pumpAnalytics";
import UnifiedTimelineChart from "./UnifiedTimelineChart";

// ─── Root ──────────────────────────────────────────────────────────
export default function AnalyticsTab({ code, history, analyticsOn, catalog, info, live, canEdit, refresh }) {
  // Wattage lives on Firestore deviceCatalog. Local state mirrors it
  // for the inline input; save is debounced-ish (fires on blur).
  const [wattsInput, setWattsInput] = useState(catalog?.pumpRatedWatts ?? "");
  const [wattsSaving, setWattsSaving] = useState(false);
  useEffect(() => { setWattsInput(catalog?.pumpRatedWatts ?? ""); }, [catalog?.pumpRatedWatts]);

  async function saveWatts() {
    const n = parseInt(wattsInput);
    const val = (Number.isInteger(n) && n > 0 && n < 100000) ? n : null;
    if ((catalog?.pumpRatedWatts ?? null) === val) return;   // no-op
    setWattsSaving(true);
    try {
      await updateDoc(doc(db, "deviceCatalog", code), { pumpRatedWatts: val });
      refresh?.();
    } catch (e) { console.warn("watts save failed:", e); }
    finally    { setWattsSaving(false); }
  }

  const stats = useMemo(() => computePumpAnalytics(history || []), [history]);

  if (analyticsOn === false) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 text-center text-gray-500">
        Analytics disabled by admin. Enable it from Admin → Firmware & Devices.
      </div>
    );
  }

  if (!history || history.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
        <div className="text-3xl mb-2">📊</div>
        <p className="text-gray-600 mb-1">No pump runs recorded yet.</p>
        <p className="text-xs text-gray-400">Analytics unlock as soon as the pump completes its first fill cycle.</p>
      </div>
    );
  }

  const watts = catalog?.pumpRatedWatts;

  return (
    <div className="space-y-6 pb-4">
      {/* PM alert always at the top when active — that's the "act now" signal */}
      {stats.pmFlag.active && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4">
          <div className="font-semibold text-amber-900 mb-1">🔧 Preventive maintenance recommended</div>
          <div className="text-sm text-amber-800">{stats.pmFlag.reason}</div>
          <div className="text-xs text-amber-700 mt-2">
            {stats.pmFlag.bucketLabel} baseline: {fmtDuration(stats.pmFlag.baselineSec)} ·
            Recent avg: {fmtDuration(stats.pmFlag.recentAvgSec)}
          </div>
        </div>
      )}

      {/* Unified timeline — marquee visualization. Overlays tank level,
          pump runs, and source availability on one time axis. Prime
          spot at the top since it's the single most informative chart. */}
      <UnifiedTimelineChart
        history={history}
        live={live}
        deviceLabel={catalog?.customName || catalog?.code || code}
        tankVolumeL={info?.appliedConfig?.tankVolume || catalog?.tankVolume}
        hasSource={info?.hasSource ?? live?.hasSource ?? false}
      />

      {/* ═══ USAGE ═══ */}
      <SectionHeader emoji="📈" title="Usage" subtitle="How much your pump has worked." />

      {/* 4-card totals — Today / Week / Month / All-time */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <TotalCard label="Today" runs={stats.totals.today.runs} runtimeSec={stats.totals.today.runtimeSec} tone="blue" />
        <TotalCard label="This Week"  runs={stats.totals.week.runs}  runtimeSec={stats.totals.week.runtimeSec}  tone="indigo" />
        <TotalCard label="This Month" runs={stats.totals.month.runs} runtimeSec={stats.totals.month.runtimeSec} tone="purple" />
        <TotalCard label="All Time"   runs={stats.allTime.runs}      runtimeSec={stats.allTime.runtimeSec}      tone="slate" />
      </div>

      {/* Daily runtime chart + moving average overlay */}
      <Card title="Daily runtime — last 30 days">
        {stats.dailyRuntime.length === 0 ? (
          <EmptyState msg="No runs in the last 30 days." />
        ) : (
          <>
            <DailyRuntimeChart data={stats.dailyRuntime} />
            <p className="text-xs text-gray-500 mt-3">
              {(() => {
                const total = stats.totals.month.runtimeSec;
                const days  = Math.min(30, stats.dailyRuntime.length);
                const avgPerDay = total / days;
                return `Averaging ${fmtDuration(avgPerDay)} of pump time per day.`;
              })()}
            </p>
          </>
        )}
      </Card>

      {/* Hourly heatmap 7×24 */}
      <Card title="Fill patterns by hour of day"
        subtitle="Darker = more pump starts. Reveals when your pump usually kicks in.">
        <HeatmapChart data={stats.heatmap} max={stats.heatmapMax} />
        <HeatmapInsight heatmap={stats.heatmap} />
      </Card>

      {/* Cause donut */}
      <Card title="Why the pump started"
        subtitle="Auto vs manual runs, with fault stops separated.">
        <div className="flex items-center gap-6 flex-wrap justify-center">
          <DonutChart data={stats.causeBreakdown} />
          <LegendList items={[
            { label: `${stats.causeBreakdown.auto.count} Auto`,     color: stats.causeBreakdown.auto.color   },
            { label: `${stats.causeBreakdown.manual.count} Manual`, color: stats.causeBreakdown.manual.color },
            { label: `${stats.causeBreakdown.fault.count} Fault`,   color: stats.causeBreakdown.fault.color  },
          ]} />
        </div>
        <CauseInsight breakdown={stats.causeBreakdown} />
      </Card>

      {/* ═══ HEALTH ═══ */}
      <SectionHeader emoji="🩺" title="Health" subtitle="Is the pump slowing down or misbehaving?" />

      {/* Fill efficiency trend — the marquee KPI */}
      <Card title="Fill efficiency trend">
        <FillEfficiencyPanel eff={stats.fillEfficiency} />
      </Card>

      {/* Fault events timeline */}
      <Card title="Fault events — last 30 days"
        subtitle={stats.faultEvents.length === 0
          ? "No faults recorded. Pump is healthy."
          : `${stats.faultEvents.length} fault event${stats.faultEvents.length === 1 ? "" : "s"} — investigate if this is growing.`}>
        {stats.faultEvents.length === 0 ? (
          <EmptyState msg="✅ All clear — nothing to look at here." />
        ) : (
          <FaultTimeline events={stats.faultEvents} />
        )}
      </Card>

      {/* ═══ EFFICIENCY ═══ */}
      <SectionHeader emoji="⚡" title="Efficiency" subtitle="Energy consumed by the pump." />

      <Card title="Pump rating">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm text-gray-700">Rated wattage</div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              Enter the pump's rated power (from its nameplate). We use it to estimate electricity consumption below.
              Typical: 750 W (1 HP), 1120 W (1.5 HP), 1500 W (2 HP).
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <input
              type="number" min="1" max="99999"
              value={wattsInput}
              disabled={!canEdit || wattsSaving}
              onChange={(e) => setWattsInput(e.target.value)}
              onBlur={saveWatts}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              className="w-24 px-2 py-1 border border-gray-200 rounded text-sm disabled:bg-gray-50"
              placeholder="e.g. 1120"
            />
            <span className="text-xs text-gray-500">W</span>
          </div>
        </div>
      </Card>

      {watts ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <EnergyCard label="Today" runtimeSec={stats.totals.today.runtimeSec} watts={watts} />
          <EnergyCard label="This Week"  runtimeSec={stats.totals.week.runtimeSec}  watts={watts} />
          <EnergyCard label="This Month" runtimeSec={stats.totals.month.runtimeSec} watts={watts} />
          <EnergyCard label="All Time"   runtimeSec={stats.allTime.runtimeSec}      watts={watts} />
        </div>
      ) : (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
          Set your pump's rated wattage above to see estimated electricity consumption.
        </div>
      )}
    </div>
  );
}

// ─── Section header ────────────────────────────────────────────────
function SectionHeader({ emoji, title, subtitle }) {
  return (
    <div className="pt-2">
      <h2 className="text-lg font-semibold text-gray-800">{emoji} {title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}

// ─── Card wrapper ──────────────────────────────────────────────────
function Card({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
      <h3 className="font-semibold text-gray-800">{title}</h3>
      {subtitle && <p className="text-xs text-gray-500 mt-0.5 mb-3">{subtitle}</p>}
      {!subtitle && <div className="mb-3" />}
      {children}
    </div>
  );
}
function EmptyState({ msg }) {
  return <p className="text-sm text-gray-500 text-center py-4">{msg}</p>;
}

// ─── Total card (usage section) ────────────────────────────────────
function TotalCard({ label, runs, runtimeSec, tone }) {
  const TONE = {
    blue:   "border-blue-200",
    indigo: "border-indigo-200",
    purple: "border-purple-200",
    slate:  "border-slate-200",
  }[tone] || "border-gray-200";
  return (
    <div className={`bg-white rounded-xl shadow-sm border ${TONE} p-4`}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-800">{runs}</div>
      <div className="text-xs text-gray-500 mt-0.5">runs</div>
      <div className="text-sm text-gray-700 mt-2 font-medium">{fmtDuration(runtimeSec)}</div>
    </div>
  );
}
function EnergyCard({ label, runtimeSec, watts }) {
  const kwh = estimateEnergyKwh(runtimeSec, watts);
  return (
    <div className="bg-gradient-to-br from-amber-50 to-yellow-50 border border-amber-200 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wide text-amber-800">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-amber-900">{fmtEnergy(kwh)}</div>
      <div className="text-[11px] text-amber-700 mt-1">{fmtDuration(runtimeSec)} @ {watts}W</div>
    </div>
  );
}

// ─── Daily runtime bar chart (with moving-average overlay) ────────
function DailyRuntimeChart({ data }) {
  const max = Math.max(1, ...data.map((d) => d.runtimeSec));
  const barW = 100 / data.length;

  // 7-day trailing moving-average line — smooths out daily noise so a
  // trend (going up = pump working harder over time) is visible.
  const avg = data.map((_, i) => {
    const win = data.slice(Math.max(0, i - 6), i + 1);
    return win.reduce((s, d) => s + d.runtimeSec, 0) / win.length;
  });

  return (
    <div className="w-full">
      <div className="relative h-40 border-b border-gray-200">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
          {/* Bars — one per day. */}
          {data.map((d, i) => {
            const h = (d.runtimeSec / max) * 100;
            return (
              <rect
                key={d.day}
                x={i * barW + barW * 0.1}
                y={100 - h}
                width={barW * 0.8}
                height={h}
                fill="#93c5fd"
              >
                <title>{`${d.day}: ${fmtDuration(d.runtimeSec)} · ${d.runs} runs`}</title>
              </rect>
            );
          })}
          {/* 7-day moving average line */}
          <polyline
            fill="none"
            stroke="#1d4ed8"
            strokeWidth="0.6"
            vectorEffect="non-scaling-stroke"
            points={avg.map((v, i) => `${i * barW + barW / 2},${100 - (v / max) * 100}`).join(" ")}
          />
        </svg>
      </div>
      <div className="flex justify-between text-xs text-gray-400 mt-1">
        <span>{data[0]?.day}</span>
        <span className="text-blue-700">— 7-day moving average</span>
        <span>{data[data.length - 1]?.day}</span>
      </div>
    </div>
  );
}

// ─── 7×24 hourly heatmap ──────────────────────────────────────────
function HeatmapChart({ data, max }) {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Cell colour scales opacity of a single blue against the max value
  // seen in the whole grid. Consistent hue makes hot spots pop.
  const cellColor = (v) => v === 0 ? "transparent" : `rgba(37, 99, 235, ${0.15 + 0.85 * (v / max)})`;

  return (
    <div className="overflow-x-auto">
      <div className="inline-block min-w-full">
        <div className="grid gap-[1px]" style={{ gridTemplateColumns: "auto repeat(24, 1fr)" }}>
          {/* Header row — hour labels 0-23 (only show every 4 to keep it clean) */}
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={`h-${h}`} className="text-[9px] text-gray-400 text-center">
              {h % 4 === 0 ? h : ""}
            </div>
          ))}
          {/* Day rows */}
          {DAYS.map((day, dow) => (
            <>
              <div key={`d-${dow}`} className="text-[10px] text-gray-500 pr-2 flex items-center">{day}</div>
              {Array.from({ length: 24 }, (_, h) => {
                const v = data[dow][h];
                return (
                  <div
                    key={`c-${dow}-${h}`}
                    className="h-5 border border-gray-100 rounded-sm"
                    style={{ backgroundColor: cellColor(v) }}
                    title={`${day} ${h}:00 — ${v} runs`}
                  />
                );
              })}
            </>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1 text-[10px] text-gray-500 justify-end">
          <span>less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f} className="w-3 h-3 rounded-sm border border-gray-200"
              style={{ backgroundColor: `rgba(37, 99, 235, ${0.15 + 0.85 * f})` }} />
          ))}
          <span>more</span>
        </div>
      </div>
    </div>
  );
}

function HeatmapInsight({ heatmap }) {
  // Find the (day, hour) cell with the highest count — surface as a
  // short "your pump usually fires around X" text under the grid.
  let maxV = 0, maxDow = 0, maxHour = 0;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (heatmap[d][h] > maxV) { maxV = heatmap[d][h]; maxDow = d; maxHour = h; }
    }
  }
  if (maxV === 0) return null;
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const ampm = (h) => {
    const hh = h % 12 || 12;
    return `${hh} ${h < 12 ? "AM" : "PM"}`;
  };
  return (
    <p className="text-xs text-gray-500 mt-3">
      Peak: <strong className="text-gray-700">{DAYS[maxDow]}s around {ampm(maxHour)}</strong> ({maxV} runs).
    </p>
  );
}

// ─── Donut chart (cause breakdown) ────────────────────────────────
function DonutChart({ data }) {
  const total = data.auto.count + data.manual.count + data.fault.count;
  if (total === 0) return <div className="text-sm text-gray-500 py-4">No runs to break down yet.</div>;

  // SVG donut assembled from 3 arcs. Angles cumulate around a unit
  // circle centered at (50,50) with r=40 (inner cutout r=24).
  const R = 40, C = 50, RI = 24;
  let start = 0;
  const segments = ["auto", "manual", "fault"].map((k) => {
    const seg = data[k];
    const frac = seg.count / total;
    const angle = frac * 360;
    const end = start + angle;
    const large = angle > 180 ? 1 : 0;
    const rad = (a) => (a - 90) * Math.PI / 180;
    const x1 = C + R * Math.cos(rad(start));
    const y1 = C + R * Math.sin(rad(start));
    const x2 = C + R * Math.cos(rad(end));
    const y2 = C + R * Math.sin(rad(end));
    const xi1 = C + RI * Math.cos(rad(end));
    const yi1 = C + RI * Math.sin(rad(end));
    const xi2 = C + RI * Math.cos(rad(start));
    const yi2 = C + RI * Math.sin(rad(start));
    const d = frac === 1
      ? `M${C - R},${C} A${R},${R} 0 1,1 ${C + R},${C} A${R},${R} 0 1,1 ${C - R},${C} M${C - RI},${C} A${RI},${RI} 0 1,0 ${C + RI},${C} A${RI},${RI} 0 1,0 ${C - RI},${C} Z`
      : `M${x1},${y1} A${R},${R} 0 ${large},1 ${x2},${y2} L${xi1},${yi1} A${RI},${RI} 0 ${large},0 ${xi2},${yi2} Z`;
    start = end;
    return { d, color: seg.color, key: k };
  }).filter(s => data[s.key].count > 0);

  return (
    <div className="relative" style={{ width: 140, height: 140 }}>
      <svg viewBox="0 0 100 100" width="140" height="140">
        {segments.map((s) => (
          <path key={s.key} d={s.d} fill={s.color} />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-xl font-semibold text-gray-800">{total}</div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wide">runs</div>
      </div>
    </div>
  );
}
function LegendList({ items }) {
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2 text-sm text-gray-700">
          <span className="w-3 h-3 rounded" style={{ backgroundColor: it.color }} />
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  );
}
function CauseInsight({ breakdown }) {
  const total = breakdown.auto.count + breakdown.manual.count + breakdown.fault.count;
  if (total === 0) return null;
  const manualPct = Math.round((breakdown.manual.count / total) * 100);
  const faultPct  = Math.round((breakdown.fault.count  / total) * 100);
  const insights = [];
  if (manualPct > 40) insights.push(`${manualPct}% of runs are manual — check if auto-mode is misconfigured.`);
  if (faultPct  > 10) insights.push(`${faultPct}% ended in fault — worth checking sensor wiring or supply.`);
  if (insights.length === 0 && total >= 10) insights.push("Pump is operating cleanly — mostly auto runs with few faults.");
  if (insights.length === 0) return null;
  return (
    <div className="mt-3 text-xs text-gray-600 bg-gray-50 rounded px-3 py-2">
      {insights.map((s, i) => <div key={i}>• {s}</div>)}
    </div>
  );
}

// ─── Fill efficiency panel (health section marquee KPI) ──────────
function FillEfficiencyPanel({ eff }) {
  if (!eff.baselineMedianSec || eff.baselineSamples < 10) {
    return (
      <p className="text-sm text-gray-500">
        Not enough clean fill data yet. Need at least 10 Empty→Full runs (currently {eff.baselineSamples}) to establish a baseline.
      </p>
    );
  }
  if (!eff.recentMedianSec || eff.recentSamples < 3) {
    return (
      <>
        <div className="text-sm text-gray-700 mb-1">
          Baseline established: <strong>{fmtDuration(eff.baselineMedianSec)}</strong> per Empty→Full fill
          <span className="text-gray-500"> (from {eff.baselineSamples} runs)</span>.
        </div>
        <p className="text-xs text-gray-500">
          Not enough recent fills to compute a trend yet ({eff.recentSamples} in the last 30 days — need at least 3).
        </p>
      </>
    );
  }
  const pct = eff.pctChange;
  const worse = pct != null && pct > 10;
  const better = pct != null && pct < -10;
  const stable = !worse && !better;

  const tone = worse ? "text-red-700 bg-red-50 border-red-200"
             : better ? "text-green-700 bg-green-50 border-green-200"
             : "text-gray-700 bg-gray-50 border-gray-200";
  const badge = worse ? `⚠ ${pct}% slower`
              : better ? `✓ ${Math.abs(pct)}% faster`
              : `~ stable (${pct > 0 ? "+" : ""}${pct}%)`;

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Baseline (all-time)</div>
          <div className="text-lg font-semibold text-gray-800 mt-1">{fmtDuration(eff.baselineMedianSec)}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">{eff.baselineSamples} runs</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-xs text-gray-500 uppercase tracking-wide">This month</div>
          <div className="text-lg font-semibold text-gray-800 mt-1">{fmtDuration(eff.recentMedianSec)}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">{eff.recentSamples} runs</div>
        </div>
      </div>
      <div className={`inline-block text-sm font-semibold px-3 py-1.5 rounded-lg border ${tone}`}>
        {badge}
      </div>
      <p className="text-xs text-gray-600 mt-3">
        {worse && "Fills are taking longer this month — impeller wear, partial clog, or reduced source pressure are common causes. Consider inspection."}
        {better && "Pump is filling faster than usual — likely after recent maintenance or improved source supply."}
        {stable && "Pump is filling at its normal pace. No action needed."}
      </p>
    </div>
  );
}

// ─── Fault events timeline ────────────────────────────────────────
function FaultTimeline({ events }) {
  const CAUSE_COLOR = {
    feedback_timeout: "bg-red-100 text-red-700 border-red-200",
    dry_run:          "bg-amber-100 text-amber-700 border-amber-200",
    max_runtime:      "bg-purple-100 text-purple-700 border-purple-200",
  };
  return (
    <div className="space-y-2">
      {events.slice(0, 25).map((e, i) => {
        const d = new Date(e.ts * 1000);
        const dateStr = d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
        const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return (
          <div key={i} className="flex items-center gap-3 text-sm">
            <div className="text-xs text-gray-500 w-32 flex-shrink-0">{dateStr} · {timeStr}</div>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${CAUSE_COLOR[e.cause] || "bg-gray-100 text-gray-700 border-gray-200"}`}>
              {FAULT_CAUSE_LABEL[e.cause] || e.cause}
            </span>
            <span className="text-xs text-gray-500">after {fmtDuration(e.runSec)}</span>
          </div>
        );
      })}
      {events.length > 25 && (
        <p className="text-xs text-gray-400 pt-2">…and {events.length - 25} older events</p>
      )}
    </div>
  );
}
