// Pump analytics — pure functions of a paired-run history array.
// Each history entry is what the firmware pushes to
// devices/{code}/history via pushPairedHistory():
// {
//   runId, type: "run", causeStart, causeEnd,
//   terraceStart, terraceEnd, sourceStart, sourceEnd,
//   onTs, offTs, runSec, bufferedReplay?
// }
//
// Client-side computation (per user: "instead of directly doing it click
// analyze button to get details") — kept in a util module so it's cheap
// to unit-test and swap for a Cloud Function later.

// ── Time buckets ────────────────────────────────────────────────────
// Windows are local-time hours-of-day. Baseline "fill time" comes only
// from Empty→Full runs so partial or interrupted fills don't skew the
// baseline. When ultrasonic pumps arrive (continuous levels), the same
// helper can widen to Empty→X→Full paths without breaking callers.
const BUCKETS = [
  { key: "night",     label: "Night (23-05)",     inWindow: h => h >= 23 || h < 5 },
  { key: "morning",   label: "Morning (05-12)",   inWindow: h => h >= 5  && h < 12 },
  { key: "afternoon", label: "Afternoon (12-18)", inWindow: h => h >= 12 && h < 18 },
  { key: "evening",   label: "Evening (18-23)",   inWindow: h => h >= 18 && h < 23 },
];

function hourOfLocalTs(unixSec) {
  if (!unixSec) return null;
  return new Date(unixSec * 1000).getHours();
}

function bucketFor(unixSec) {
  const h = hourOfLocalTs(unixSec);
  if (h == null) return null;
  return BUCKETS.find(b => b.inWindow(h))?.key || null;
}

// Median (avoids outlier-domination from a stuck/partial run that
// slipped through the Empty→Full filter due to sensor jitter).
function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Runs that started Empty and ended Full — the clean baseline signal.
function isCleanFullFill(run) {
  return run.terraceStart === "empty" && run.terraceEnd === "full";
}

// Days-of-runtime bucketing keyed by local-date YYYY-MM-DD. Uses
// run start ts because a run spanning midnight is more naturally
// attributed to when it began.
function dayKey(unixSec) {
  if (!unixSec) return null;
  const d = new Date(unixSec * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Main compute — given N history entries, produce:
//   totals: runs, runtimeSec (today / week / month)
//   fillBaselineByBucket: { night, morning, afternoon, evening } → median seconds
//   pmFlag: { active, reason } — set when a bucket's recent runs consistently
//                                exceed 130% of its own baseline
//   dailyRuntime: [{ day, runtimeSec, runs }] for the trend chart
//   sourceAvailability: [{ startTs, endTs, wet }] periods for the source strip
//   manualVsAuto: { manual: N, auto: N }
export function computePumpAnalytics(history, now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const dayAgo   = nowSec - 24 * 3600;
  const weekAgo  = nowSec - 7  * 24 * 3600;
  const monthAgo = nowSec - 30 * 24 * 3600;

  // Sanitise + sort chronologically. Firmware pushes in event order but
  // paired writes can arrive out of order (offline replay). Sort by onTs.
  const runs = (history || [])
    .filter(r => r && r.onTs && r.runSec != null)
    .slice()
    .sort((a, b) => (a.onTs || 0) - (b.onTs || 0));

  // ── Totals ──
  const filterBy = (afterTs) => runs.filter(r => (r.onTs || 0) >= afterTs);
  const totals = {
    today: {
      runs: filterBy(dayAgo).length,
      runtimeSec: filterBy(dayAgo).reduce((s, r) => s + (r.runSec || 0), 0),
    },
    week: {
      runs: filterBy(weekAgo).length,
      runtimeSec: filterBy(weekAgo).reduce((s, r) => s + (r.runSec || 0), 0),
    },
    month: {
      runs: filterBy(monthAgo).length,
      runtimeSec: filterBy(monthAgo).reduce((s, r) => s + (r.runSec || 0), 0),
    },
  };

  // ── Fill-time baseline by time-of-day bucket (Empty→Full only) ──
  const cleanFills = runs.filter(isCleanFullFill);
  const fillBaselineByBucket = {};
  const bucketedFills = {};
  for (const b of BUCKETS) {
    const inBucket = cleanFills.filter(r => bucketFor(r.onTs) === b.key);
    const secs = inBucket.map(r => r.runSec);
    fillBaselineByBucket[b.key] = {
      label: b.label,
      medianSec: median(secs),
      sampleCount: secs.length,
    };
    bucketedFills[b.key] = inBucket;
  }

  // ── Preventive-maintenance flag ──
  // Fires when 3+ of the last 5 runs in a bucket exceed 130% of that
  // bucket's baseline median. "Last 5" is short enough to react but
  // long enough to swallow one bad reading. 14-run warmup required.
  const PM_THRESHOLD = 1.30;
  const PM_MIN_BASELINE_SAMPLES = 14;
  const PM_RECENT_COUNT = 5;
  const PM_MIN_HITS = 3;

  let pmFlag = { active: false };
  for (const b of BUCKETS) {
    const base = fillBaselineByBucket[b.key];
    if (!base.medianSec || base.sampleCount < PM_MIN_BASELINE_SAMPLES) continue;
    const recent = bucketedFills[b.key].slice(-PM_RECENT_COUNT);
    const hits = recent.filter(r => r.runSec > base.medianSec * PM_THRESHOLD).length;
    if (hits >= PM_MIN_HITS) {
      pmFlag = {
        active: true,
        bucket: b.key,
        bucketLabel: b.label,
        baselineSec: Math.round(base.medianSec),
        recentAvgSec: Math.round(recent.reduce((s, r) => s + r.runSec, 0) / recent.length),
        reason: `${hits}/${PM_RECENT_COUNT} recent ${b.label.toLowerCase()} runs exceeded 130% of baseline`,
      };
      break; // first bucket that trips wins — enough to alert
    }
  }

  // ── Daily runtime for trend chart (last 30 days) ──
  const dailyMap = new Map();
  for (const r of runs) {
    if ((r.onTs || 0) < monthAgo) continue;
    const k = dayKey(r.onTs);
    if (!k) continue;
    const cur = dailyMap.get(k) || { day: k, runtimeSec: 0, runs: 0 };
    cur.runtimeSec += r.runSec || 0;
    cur.runs      += 1;
    dailyMap.set(k, cur);
  }
  const dailyRuntime = Array.from(dailyMap.values())
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  // ── Source availability timeline ──
  // Per user: source card graph should also show whether water was
  // present or not. History captures source at run start + end so we
  // sample twice per run. Consecutive same-state samples are merged
  // into single spans for cleaner rendering.
  const sourceSamples = [];
  for (const r of runs) {
    if (r.sourceStart != null && r.onTs)
      sourceSamples.push({ ts: r.onTs, wet: r.sourceStart === "wet" });
    if (r.sourceEnd != null && r.offTs)
      sourceSamples.push({ ts: r.offTs, wet: r.sourceEnd === "wet" });
  }
  sourceSamples.sort((a, b) => a.ts - b.ts);
  const sourceAvailability = [];
  for (const s of sourceSamples) {
    const last = sourceAvailability[sourceAvailability.length - 1];
    if (last && last.wet === s.wet) {
      last.endTs = s.ts;
    } else {
      sourceAvailability.push({ startTs: s.ts, endTs: s.ts, wet: s.wet });
    }
  }

  // ── Manual vs auto (per user: history should mark run type) ──
  let manualCount = 0;
  let autoCount = 0;
  for (const r of runs) {
    if (r.causeStart === "force" || r.causeStart === "manual_button") manualCount++;
    else if (r.causeStart === "auto" || r.causeStart === "schedule")  autoCount++;
  }

  // ── All-time totals (society secretary loves a "lifetime" number) ──
  const allTime = {
    runs: runs.length,
    runtimeSec: runs.reduce((s, r) => s + (r.runSec || 0), 0),
  };

  // ── Hourly heatmap: [dayOfWeek 0-6][hour 0-23] → runs count ──
  // Reveals fill patterns at a glance — "we mostly fill Mon 6am and
  // Thu 9pm" is instantly visible as bright cells. Society secretary
  // uses this to reason about municipal water timing.
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of runs) {
    if (!r.onTs) continue;
    const d = new Date(r.onTs * 1000);
    heatmap[d.getDay()][d.getHours()] += 1;
  }
  const heatmapMax = Math.max(1, ...heatmap.flat());

  // ── Cause breakdown: Auto / Manual / Fault stops ──
  // Fault stops key off causeEnd since that's what firmware writes when
  // the run terminated abnormally (feedback timeout, dry-run trip,
  // max-runtime cap). Auto/Manual key off causeStart.
  let causeAuto = 0, causeManual = 0, causeFault = 0;
  const FAULT_CAUSES_END = new Set(["feedback_timeout", "dry_run", "max_runtime"]);
  for (const r of runs) {
    if (FAULT_CAUSES_END.has(r.causeEnd)) {
      causeFault++;
    } else if (r.causeStart === "force" || r.causeStart === "manual_button") {
      causeManual++;
    } else {
      causeAuto++;
    }
  }
  const causeBreakdown = {
    auto:   { count: causeAuto,   label: "Auto",   color: "#3b82f6" },
    manual: { count: causeManual, label: "Manual", color: "#f59e0b" },
    fault:  { count: causeFault,  label: "Fault",  color: "#ef4444" },
  };

  // ── Fault events timeline (last 30 days) ──
  // Just history rows with a fault causeEnd, chronologically. Empty =
  // healthy pump. Growing = trouble. Used for a small vertical timeline
  // with type + timestamp per event.
  const faultEvents = runs
    .filter(r => (r.onTs || 0) >= monthAgo && FAULT_CAUSES_END.has(r.causeEnd))
    .map(r => ({
      ts: r.offTs || r.onTs,
      cause: r.causeEnd,
      runSec: r.runSec || 0,
    }))
    .sort((a, b) => b.ts - a.ts);   // newest first for timeline display

  // ── Fill efficiency trend — this-month vs all-time baseline ──
  // Single number the customer can act on: "your pump is 50% slower
  // this month than its all-time average". Uses clean Empty→Full runs
  // only — same signal as the bucket baselines. Health section prime
  // KPI.
  const allTimeCleanSec  = cleanFills.map(r => r.runSec);
  const monthCleanSec    = cleanFills.filter(r => (r.onTs || 0) >= monthAgo).map(r => r.runSec);
  const baselineMedian   = median(allTimeCleanSec);
  const recentMedian     = median(monthCleanSec);
  const fillEfficiency = {
    baselineMedianSec: baselineMedian,
    recentMedianSec:   recentMedian,
    baselineSamples:   allTimeCleanSec.length,
    recentSamples:     monthCleanSec.length,
    // Only compute pct change when we have BOTH sides with enough samples.
    // Positive pct = slower (worse), negative = faster (better).
    pctChange: (baselineMedian && recentMedian && allTimeCleanSec.length >= 10 && monthCleanSec.length >= 3)
      ? Math.round(((recentMedian - baselineMedian) / baselineMedian) * 100)
      : null,
  };

  return {
    totals,
    allTime,
    fillBaselineByBucket,
    pmFlag,
    dailyRuntime,
    sourceAvailability,
    manualVsAuto: { manual: manualCount, auto: autoCount },
    totalRuns: runs.length,
    cleanFillCount: cleanFills.length,
    heatmap,
    heatmapMax,
    causeBreakdown,
    faultEvents,
    fillEfficiency,
  };
}

// Estimate energy consumption from runtime + rated wattage.
// energyKwh = (runtimeSec × ratedWatts) / (3600 × 1000)
// ratedWatts comes from customer input on the Analytics tab (stored
// on deviceCatalog.pumpRatedWatts). Returns null when no wattage set
// so the UI can render an "add pump rating" CTA instead of "0 kWh".
export function estimateEnergyKwh(runtimeSec, ratedWatts) {
  if (!ratedWatts || !runtimeSec) return null;
  return (runtimeSec * ratedWatts) / 3600000;
}

// Human-friendly energy formatter — "1.4 kWh", "823 Wh"
export function fmtEnergy(kwh) {
  if (kwh == null || !isFinite(kwh)) return "—";
  if (kwh < 1)   return `${Math.round(kwh * 1000)} Wh`;
  if (kwh < 100) return `${kwh.toFixed(1)} kWh`;
  return `${Math.round(kwh)} kWh`;
}

// Human labels for fault-cause codes.
export const FAULT_CAUSE_LABEL = {
  feedback_timeout: "Feedback fault",
  dry_run:          "Dry-run trip",
  max_runtime:      "Max runtime hit",
};

// Human-friendly duration formatter — "42 min 18s", "3h 12m", "18s"
export function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
