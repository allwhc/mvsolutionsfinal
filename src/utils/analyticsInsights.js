// Shared analytics helpers used by both the full AnalyticsChart page and
// the lightweight DeviceAnalyticsModal that pops up from the dashboard
// chart icon. Keep these pure — no React, no Firebase. The modal can be
// reused anywhere a history array + tank capacity are available.

export const RANGES = {
  "24h": { ms: 86400000,      stepMs: 15 * 60000,      label: "Last 24 hours" },
  "7d":  { ms: 7 * 86400000,  stepMs: 60 * 60000,      label: "Last 7 days"  },
  "30d": { ms: 30 * 86400000, stepMs: 6 * 60 * 60000,  label: "Last 30 days" },
};

// Event detection thresholds — tune here if customer usage patterns differ.
//   Refill = level rose >= 25% within 30 minutes (motor pump / tanker)
//   Drain  = level dropped >= 10% within 2 hours (household consumption)
export const REFILL_PCT_THRESHOLD   = 25;
export const REFILL_MAX_DURATION_MS = 30 * 60 * 1000;
export const DRAIN_PCT_THRESHOLD    = 10;
export const DRAIN_MAX_DURATION_MS  = 2 * 60 * 60 * 1000;
export const MIN_POINTS_FOR_INSIGHTS = 5;

// Sum of all upward and downward swings, scaled to tank capacity. Different
// from "net change" because a 75 → 100 → 50 day is 25% filled + 50% drained
// even though net is -25%.
export function calcLitres(history, tankCapacity) {
  if (!tankCapacity || history.length < 2) return { filled: 0, consumed: 0 };
  let filled = 0;
  let consumed = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].pct ?? 0;
    const curr = history[i].pct ?? 0;
    const delta = curr - prev;
    const litres = (Math.abs(delta) / 100) * tankCapacity;
    if (delta > 0) filled   += litres;
    else if (delta < 0) consumed += litres;
  }
  return { filled: Math.round(filled), consumed: Math.round(consumed) };
}

// Walk history greedily looking for fast rises (refill) and steady drops
// (drain). Returns chronological event list — used to count and time-bucket
// pump runs and heavy-use hours.
export function detectEvents(history) {
  if (history.length < 2) return [];
  const events = [];
  let i = 0;
  while (i < history.length - 1) {
    const a = history[i];
    const aPct = a.pct ?? 0;
    let j = i + 1;
    let bestDelta = 0;
    let bestIdx = i + 1;
    while (j < history.length) {
      const b = history[j];
      const dt = b.ts - a.ts;
      const dp = (b.pct ?? 0) - aPct;
      if (dp > bestDelta && dt <= REFILL_MAX_DURATION_MS) {
        bestDelta = dp;
        bestIdx = j;
      }
      if (dt > DRAIN_MAX_DURATION_MS) break;
      j++;
    }
    if (bestDelta >= REFILL_PCT_THRESHOLD) {
      events.push({ type: "refill", startTs: a.ts, endTs: history[bestIdx].ts, pctDelta: bestDelta });
      i = bestIdx;
      continue;
    }
    let worstDelta = 0;
    let worstIdx = i + 1;
    j = i + 1;
    while (j < history.length) {
      const b = history[j];
      const dt = b.ts - a.ts;
      if (dt > DRAIN_MAX_DURATION_MS) break;
      const dp = (b.pct ?? 0) - aPct;
      if (dp < worstDelta) {
        worstDelta = dp;
        worstIdx = j;
      }
      j++;
    }
    if (-worstDelta >= DRAIN_PCT_THRESHOLD) {
      events.push({ type: "drain", startTs: a.ts, endTs: history[worstIdx].ts, pctDelta: worstDelta });
      i = worstIdx;
      continue;
    }
    i++;
  }
  return events;
}

export function formatHour(hour) {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

export function formatLitres(l) {
  if (l >= 1000000) return `${(l / 1000000).toFixed(2)} ML`;
  if (l >= 1000)    return `${(l / 1000).toFixed(1)} KL`;
  return `${Math.round(l)} L`;
}

function mode(arr) {
  if (arr.length === 0) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  let best = null, bestCount = 0;
  for (const k in counts) {
    if (counts[k] > bestCount) { bestCount = counts[k]; best = parseInt(k); }
  }
  return best;
}

// Natural-language bullets summarising the history in the chosen range.
// Used both by the AnalyticsChart insights panel (Device Detail) and by
// the dashboard chart-icon popup.
export function generateInsights(history, tankCapacity) {
  if (history.length < MIN_POINTS_FOR_INSIGHTS) {
    return {
      enough: false,
      bullets: [`Not enough data to talk about yet — only ${history.length} reading${history.length === 1 ? "" : "s"} in this period. Insights need at least ${MIN_POINTS_FOR_INSIGHTS}.`],
    };
  }

  const bullets = [];
  const totals = calcLitres(history, tankCapacity);

  if (tankCapacity > 0) {
    bullets.push(`💧 Refilled ${formatLitres(totals.filled)} in this period`);
    bullets.push(`🚰 Consumed ${formatLitres(totals.consumed)} in this period`);
  } else {
    bullets.push(`💧 Filled ${totals.filled}% worth of tank levels`);
    bullets.push(`🚰 Drained ${totals.consumed}% worth of tank levels`);
  }

  const spanMs = history[history.length - 1].ts - history[0].ts;
  const days = Math.max(1, spanMs / 86400000);
  if (tankCapacity > 0 && days >= 1) {
    bullets.push(`📅 Daily average consumption: ${formatLitres(totals.consumed / days)}`);
  }

  const events = detectEvents(history);
  const refills = events.filter((e) => e.type === "refill");
  const drains  = events.filter((e) => e.type === "drain");

  if (refills.length > 0) {
    bullets.push(`🔁 ${refills.length} refill event${refills.length > 1 ? "s" : ""}`);
    const refillHours = refills.map((e) => new Date(e.startTs).getHours());
    const refillPeak = mode(refillHours);
    if (refillPeak != null) bullets.push(`⏰ Tank usually fills around ${formatHour(refillPeak)}`);
  } else {
    bullets.push(`🔁 No refill events detected`);
  }

  if (drains.length > 0) {
    const drainHours = drains.map((e) => new Date(e.startTs).getHours());
    const drainPeak = mode(drainHours);
    if (drainPeak != null) bullets.push(`🔥 Heaviest use around ${formatHour(drainPeak)}`);
  }

  const pcts = history.map((h) => h.pct ?? 0);
  const lowest  = Math.min(...pcts);
  const highest = Math.max(...pcts);
  bullets.push(`📉 Lowest level reached: ${lowest}%   |   📈 Highest: ${highest}%`);

  let longestDry = 0;
  let dryStart = null;
  for (const h of history) {
    if ((h.pct ?? 100) === 0) {
      if (dryStart == null) dryStart = h.ts;
      longestDry = Math.max(longestDry, h.ts - dryStart);
    } else {
      dryStart = null;
    }
  }
  if (longestDry > 60 * 60 * 1000) {
    const dryHrs = (longestDry / (60 * 60 * 1000)).toFixed(1);
    bullets.push(`⚠ Longest dry stretch: ${dryHrs} hours at 0%`);
  }

  bullets.push(`ℹ Based on ${history.length} data point${history.length > 1 ? "s" : ""} from cloud history.`);

  return { enough: true, bullets };
}
