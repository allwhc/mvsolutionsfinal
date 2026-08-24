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

// Spike-detection thresholds. A "spike" is an unphysical short-lived
// sensor glitch that snaps up and back down (or vice versa) within a
// small time window — a real fill wouldn't drain again in 5 minutes.
// Firmware v21.1.0+ has its own rate-limiter (physically-impossible
// jump rejection), so these are the belt-and-suspenders cloud layer:
// catches spikes from older firmware AND any that squeak past the
// device filter.
//
// Detection rule: a value that jumps by SPIKE_JUMP_PCT or more,
// and returns to within SPIKE_RETURN_PCT of the pre-jump baseline
// within SPIKE_RETURN_ROWS subsequent rows, is a spike. Both the
// jump and the return are dropped from consumption/fill math.
export const SPIKE_JUMP_PCT       = 15;
export const SPIKE_RETURN_PCT     = 5;
export const SPIKE_RETURN_ROWS    = 5;
// If more than this fraction of rows are spikes, treat the sensor
// as too noisy to safely say "N KL consumed" or "tank fills at 4 AM"
// — we still show min/max and current level, but skip the
// consumption/refill event math entirely. Chose 50% so we degrade
// gracefully only when the sensor is genuinely broken; a normal
// stream of 5-10 spikes stays inside "normal" mode.
export const NOISY_RATIO_THRESHOLD = 0.5;

// Walk the history and identify spike indices. Each spike is a
// (startIdx, endIdx) pair — the rows from startIdx to endIdx-1
// inclusive are the "bad" ones (both the jump AND the return).
// Math should skip these rows and pretend the tank went directly
// from `startIdx - 1` to `endIdx` (the naturally-continuing value).
//
// Returns { spikeIndices: Set<int> } where Set contains every row
// index that should be dropped from math. Callers can also count
// `spikeIndices.size` to decide "too noisy?".
//
// sensorType: 2 = ultrasonic (continuous readings, spikes are
// real glitches). 1 = DIP (discrete probe steps — a 50→75 jump
// is one probe transition, NOT a spike). Anything other than
// ultrasonic returns an empty set — math runs unchanged.
export function detectSpikes(history, sensorType = 2) {
  const spikeIndices = new Set();
  if (sensorType !== 2) return { spikeIndices };   // DIP passes through
  if (history.length < 3) return { spikeIndices };

  let i = 0;
  while (i < history.length - 2) {
    const cur  = history[i].pct;
    if (cur == null) { i++; continue; }

    // Look ahead for a big jump within the next 1-2 rows.
    const next = history[i + 1].pct;
    if (next == null) { i++; continue; }
    const jumpDelta = next - cur;
    if (Math.abs(jumpDelta) < SPIKE_JUMP_PCT) { i++; continue; }

    // Big jump found. Look ahead SPIKE_RETURN_ROWS rows for a
    // return to the pre-jump baseline. If the value snaps back
    // → whole cluster (jump + intermediate rows + return row)
    // are marked as spike.
    let returnIdx = -1;
    for (let k = i + 2; k <= i + 1 + SPIKE_RETURN_ROWS && k < history.length; k++) {
      const v = history[k].pct;
      if (v == null) continue;
      if (Math.abs(v - cur) <= SPIKE_RETURN_PCT) {
        returnIdx = k;
        break;
      }
    }

    if (returnIdx !== -1) {
      // Confirmed spike — mark every row from i+1 to returnIdx-1
      // as bad. The `cur` (i) and the return row (returnIdx) are
      // treated as neighbours in downstream math.
      for (let k = i + 1; k < returnIdx; k++) {
        spikeIndices.add(k);
      }
      i = returnIdx;
      continue;
    }
    i++;
  }
  return { spikeIndices };
}

// Convenience — returns a new array with spike rows filtered out,
// preserving order. Used by calcLitres / generateInsights so the
// math sees a "physically plausible" version of the history.
// Same sensorType semantics as detectSpikes (DIP = no-op).
export function filterSpikesFromHistory(history, sensorType = 2) {
  const { spikeIndices } = detectSpikes(history, sensorType);
  if (spikeIndices.size === 0) return history;
  return history.filter((_, idx) => !spikeIndices.has(idx));
}

// Moving-average smoothing to hide fast sensor oscillation. Runs AFTER
// spike removal — the two filters are layered: spikes catch big-and-fast
// glitches (15%+ snap-back), smoothing catches the persistent low-amp
// bounce (e.g. 92↔100 flipping every 20 sec when tank sits at overflow).
//
// Uses a centered ±halfWindow average for every point that has neighbours
// on both sides. Points near the ends of the series fall back to a
// one-sided trailing average so the last N minutes of the chart don't
// look weird ("no future to average with" case). The output preserves
// the same length + timestamps as the input; only the `pct` value is
// replaced. Original values kept as `_rawPct` for optional overlay.
//
// Default 10-min window matches ultrasonic push cadence: fast enough
// that real refill events (usually 5+ min) still look sharp, wide
// enough to average out ~20-second oscillation. Both sensor types get
// this — DIP rarely oscillates but occasional adjacent-level jitter
// benefits too, and it's a no-op when the input is already smooth.
export const SMOOTHING_WINDOW_MS = 10 * 60 * 1000;

export function smoothHistory(history, windowMs = SMOOTHING_WINDOW_MS) {
  if (history.length < 3) return history;
  const halfWindow = windowMs / 2;
  const out = new Array(history.length);
  for (let i = 0; i < history.length; i++) {
    const t = history[i].ts;
    // Try centered window first
    let sum = 0, count = 0;
    for (let j = 0; j < history.length; j++) {
      const dt = history[j].ts - t;
      if (dt < -halfWindow) continue;
      if (dt >  halfWindow) break;
      const v = history[j].pct;
      if (v == null) continue;
      sum += v; count++;
    }
    // Fallback: if the window is one-sided (near start/end of series)
    // and produced <3 samples, widen to a trailing full-window average
    // so smoothed value still reflects a real trend, not just 1 point.
    if (count < 3) {
      sum = 0; count = 0;
      for (let j = 0; j < history.length; j++) {
        const dt = history[j].ts - t;
        if (dt > 0 || dt < -windowMs) continue;
        const v = history[j].pct;
        if (v == null) continue;
        sum += v; count++;
      }
    }
    const smoothed = count > 0 ? Math.round(sum / count) : history[i].pct;
    out[i] = { ...history[i], pct: smoothed, _rawPct: history[i].pct };
  }
  return out;
}

// One-call convenience: spike filter → smoothing. This is what
// analytics math and the default chart line should use. Raw view
// toggle bypasses this entirely and reads the untouched history.
export function cleanHistoryForAnalytics(history, sensorType = 2) {
  const spikeFree = filterSpikesFromHistory(history, sensorType);
  return smoothHistory(spikeFree);
}

// Sum of all upward and downward swings, scaled to tank capacity. Different
// from "net change" because a 75 → 100 → 50 day is 25% filled + 50% drained
// even though net is -25%.
//
// Applies BOTH cleaning layers by default: spike removal + moving-average
// smoothing. Spikes catch big-and-fast glitches; smoothing catches the
// persistent low-amplitude oscillation (e.g. 92↔100 flipping every 20 sec
// at overflow). Without smoothing this loop would double-count each bounce
// as ~2,720 L "refill" + "consumption" — a 20-min oscillation could log
// hundreds of KL that never actually moved.
//
// filterSpikes / smooth flags exist for debugging + admin only; default
// production path always cleans on both layers.
export function calcLitres(history, tankCapacity, { filterSpikes = true, smooth = true, sensorType = 2 } = {}) {
  if (!tankCapacity || history.length < 2) return { filled: 0, consumed: 0 };
  let rows = filterSpikes ? filterSpikesFromHistory(history, sensorType) : history;
  if (smooth) rows = smoothHistory(rows);
  let filled = 0;
  let consumed = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].pct ?? 0;
    const curr = rows[i].pct ?? 0;
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
//
// Now spike-aware: math runs on a filtered copy of history, and if
// too many spikes are detected the language is suppressed entirely
// (chart still shows raw truth so user can see the anomalies).
// Returns { bullets, noisy, spikeCount } — callers render the
// appropriate variant. Older callers using .bullets keep working.
export function generateInsights(history, tankCapacity, currentPct = null, sensorType = 2) {
  // Spike-detection pass — the "too noisy" gate. We compute this
  // BEFORE the sparse-data branch so even short spike-riddled
  // histories get the noisy warning instead of pretending things
  // were steady. For DIP (sensorType !== 2) detectSpikes returns
  // an empty set — probe transitions aren't glitches.
  const { spikeIndices } = detectSpikes(history, sensorType);
  const spikeCount = spikeIndices.size;
  const noisy = history.length > 0 && (spikeCount / history.length) > NOISY_RATIO_THRESHOLD;

  if (noisy) {
    // Heavy-spike mode — sensor is unreliable. Don't panic the
    // customer with warning banners; just quietly degrade to the
    // handful of facts we CAN still state honestly (extremes +
    // current). Refill/consumption math would be nonsense so it's
    // skipped. Disclaimer at the bottom (rendered by the caller)
    // still nudges toward flowmeters for accurate metering.
    const cleanRows = cleanHistoryForAnalytics(history, sensorType);
    const bullets = [];
    if (cleanRows.length > 0) {
      const pcts = cleanRows.map((h) => h.pct ?? 0);
      const lowest  = Math.min(...pcts);
      const highest = Math.max(...pcts);
      bullets.push(`📉 Lowest level: ${lowest}%   |   📈 Highest: ${highest}%`);
    }
    if (currentPct != null) {
      bullets.push(`✓ Current tank level: ${currentPct}%`);
      if (tankCapacity > 0) {
        bullets.push(`💧 Volume held right now: ${formatLitres((currentPct / 100) * tankCapacity)}`);
      }
    }
    if (bullets.length === 0) {
      bullets.push("Tank status unavailable right now.");
    }
    return { enough: true, bullets, noisy: true, spikeCount };
  }

  // Use spike-filtered + smoothed history for all downstream math and
  // language. Raw `history` stays intact for the chart itself when the
  // user toggles "Actual values". Smoothing hides sensor oscillation
  // (e.g. 92↔100 flipping at overflow) that would otherwise double-count
  // as fake refills + consumption in the KL totals.
  const cleanHistory = cleanHistoryForAnalytics(history, sensorType);

  // Sparse-data path — a range with 0-4 entries means the tank stayed
  // mostly steady. Frame it as tank status — never expose "N readings"
  // or "sparse history" to the customer.
  if (cleanHistory.length < MIN_POINTS_FOR_INSIGHTS) {
    const bullets = [];
    if (history.length === 0) {
      // Zero entries in this window — could be a brand new device, or
      // a device that was steady from before. Don't claim "steady
      // throughout the period" (misleading if device is new). Just
      // report the current level as a live snapshot.
      if (currentPct != null) {
        bullets.push(`✓ Current tank level: ${currentPct}%`);
        if (tankCapacity > 0) {
          bullets.push(`💧 Volume held right now: ${formatLitres((currentPct / 100) * tankCapacity)}`);
        }
      }
      bullets.push("ℹ No refills or heavy usage detected in this window yet");
    } else if (history.length === 1) {
      const only = history[0];
      const pct  = only.pct ?? 0;
      bullets.push(`✓ Tank has stayed steady at ${pct}%`);
      if (tankCapacity > 0) {
        bullets.push(`💧 Volume held: ${formatLitres((pct / 100) * tankCapacity)}`);
      }
      bullets.push("ℹ No refills or heavy usage detected in this window");
    } else {
      // 2-4 changes — partial story. Show what we DO know.
      const pcts = cleanHistory.map((h) => h.pct ?? 0);
      const lowest = Math.min(...pcts);
      const highest = Math.max(...pcts);
      const totals = calcLitres(cleanHistory, tankCapacity, { filterSpikes: false, smooth: false });
      if (tankCapacity > 0) {
        if (totals.filled > 0)   bullets.push(`💧 Refilled ${formatLitres(totals.filled)} in this period`);
        if (totals.consumed > 0) bullets.push(`🚰 Consumed ${formatLitres(totals.consumed)} in this period`);
      }
      bullets.push(`📉 Lowest level: ${lowest}%   |   📈 Highest: ${highest}%`);
      bullets.push("ℹ Tank was mostly steady during this period");
    }
    return { enough: true, bullets, noisy: false, spikeCount };
  }

  const bullets = [];
  // `cleanHistory` already has spikes removed — pass filterSpikes:false
  // to avoid a second (redundant) filter pass inside calcLitres.
  const totals = calcLitres(cleanHistory, tankCapacity, { filterSpikes: false, smooth: false });

  if (tankCapacity > 0) {
    bullets.push(`💧 Refilled ${formatLitres(totals.filled)} in this period`);
    bullets.push(`🚰 Consumed ${formatLitres(totals.consumed)} in this period`);
  } else {
    bullets.push(`💧 Filled ${totals.filled}% worth of tank levels`);
    bullets.push(`🚰 Drained ${totals.consumed}% worth of tank levels`);
  }

  const spanMs = cleanHistory[cleanHistory.length - 1].ts - cleanHistory[0].ts;
  const days = Math.max(1, spanMs / 86400000);
  if (tankCapacity > 0 && days >= 1) {
    bullets.push(`📅 Daily average consumption: ${formatLitres(totals.consumed / days)}`);
  }

  const events = detectEvents(cleanHistory);
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

  const pcts = cleanHistory.map((h) => h.pct ?? 0);
  const lowest  = Math.min(...pcts);
  const highest = Math.max(...pcts);
  bullets.push(`📉 Lowest level reached: ${lowest}%   |   📈 Highest: ${highest}%`);

  let longestDry = 0;
  let dryStart = null;
  for (const h of cleanHistory) {
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

  return { enough: true, bullets, noisy: false, spikeCount };
}
