// Compare-page analytics: pure JS, no React, no Firebase. Takes an
// array of { device, cleanHistory } (already spike-filtered + smoothed
// by cleanHistoryForAnalytics) and returns ready-to-render numbers.
//
// All math uses the SAME delta-based model as calcLitres() from
// analyticsInsights.js — a positive pct delta is a refill, a negative
// delta is consumption, converted to litres via tankCapacityLitres.
// Tanks without capacity contribute to pct-only aggregates and are
// skipped from the litres math.

import { calcLitres } from "./analyticsInsights";

// ──────────────────────────────────────────────────────────────
// Per-tank period totals + daily series
// ──────────────────────────────────────────────────────────────

// Returns [{ device, consumedL, filledL, hasCapacity, dailyConsumedL: {dateIso: L} }]
export function perTankTotals(tanks) {
  return tanks.map((t) => {
    const cap = t.device.tankCapacityLitres || 0;
    const totals = cap > 0
      ? calcLitres(t.cleanHistory || [], cap, { filterSpikes: false, smooth: false })
      : { filled: 0, consumed: 0 };
    const dailyConsumedL = cap > 0 ? dailyConsumption(t.cleanHistory || [], cap) : {};
    return {
      device:        t.device,
      hasCapacity:   cap > 0,
      consumedL:     totals.consumed,
      filledL:       totals.filled,
      dailyConsumedL,
    };
  });
}

// Walk history and bucket consumption (negative deltas only) by local
// calendar day. Returns { "YYYY-MM-DD": litres }. IST timezone offset
// is applied so the day boundary matches wall-clock midnight.
function dailyConsumption(history, capacity) {
  if (!Array.isArray(history) || history.length < 2) return {};
  const out = {};
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].pct ?? 0;
    const curr = history[i].pct ?? 0;
    const delta = curr - prev;
    if (delta >= 0) continue;
    const litres = (Math.abs(delta) / 100) * capacity;
    const dateIso = istDateKey(history[i].ts);
    out[dateIso] = (out[dateIso] || 0) + litres;
  }
  return out;
}

// Filter a history array to the last N hours, relative to `endTs`
// (defaults to the last timestamp present in the array). Used by the
// timeline overlay chart to cap the number of points sent to Recharts
// so a month of 10,000-point histories doesn't become an unreadable
// hairball. Hours = 0 or null = return full history unchanged.
export function filterHistoryByWindow(history, hours, endTs = null) {
  if (!Array.isArray(history) || history.length === 0) return [];
  if (!hours || hours <= 0) return history;
  const last = endTs || history[history.length - 1].ts;
  const cutoff = last - hours * 3600 * 1000;
  return history.filter((h) => h.ts >= cutoff);
}

export function istDateKey(ts) {
  const d = new Date(ts + 5.5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function istHour(ts) {
  const d = new Date(ts + 5.5 * 3600 * 1000);
  return d.getUTCHours();
}

// ──────────────────────────────────────────────────────────────
// Headlines
// ──────────────────────────────────────────────────────────────

export function buildHeadlines(perTank) {
  const withCap = perTank.filter((p) => p.hasCapacity);
  const totalConsumedL = withCap.reduce((s, p) => s + p.consumedL, 0);

  let highest = null;
  let lowest  = null;
  for (const p of withCap) {
    if (!highest || p.consumedL > highest.consumedL) highest = p;
    if (!lowest  || p.consumedL < lowest.consumedL)  lowest  = p;
  }

  // Peak day across all tanks combined
  const dayTotals = {};
  for (const p of withCap) {
    for (const [day, litres] of Object.entries(p.dailyConsumedL)) {
      dayTotals[day] = (dayTotals[day] || 0) + litres;
    }
  }
  let peakDay = null;
  let peakL   = 0;
  for (const [day, litres] of Object.entries(dayTotals)) {
    if (litres > peakL) { peakL = litres; peakDay = day; }
  }

  return {
    tanksCount:       perTank.length,
    tanksWithCapacity: withCap.length,
    totalConsumedL,
    highest,
    lowest,
    peakDay,
    peakL,
    dayTotals,
  };
}

// ──────────────────────────────────────────────────────────────
// Hour-of-day aggregation (combined across all tanks)
// ──────────────────────────────────────────────────────────────

// Returns [{hour:0..23, consumedL}]. Only tanks with capacity contribute.
export function combinedHourlyConsumption(tanks) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, consumedL: 0 }));
  for (const t of tanks) {
    const cap = t.device.tankCapacityLitres || 0;
    if (cap <= 0) continue;
    const h = t.cleanHistory || [];
    for (let i = 1; i < h.length; i++) {
      const delta = (h[i].pct ?? 0) - (h[i - 1].pct ?? 0);
      if (delta >= 0) continue;
      const litres = (Math.abs(delta) / 100) * cap;
      buckets[istHour(h[i].ts)].consumedL += litres;
    }
  }
  return buckets;
}

// Short natural-language sentence summarising the hourly pattern. Picks
// the single peak hour. Soft-grouped into morning / afternoon / evening /
// night for human-readable framing.
export function describeHourlyPattern(hourly) {
  if (!hourly || hourly.length === 0) return "";
  let peak = 0;
  for (let i = 1; i < hourly.length; i++) {
    if (hourly[i].consumedL > hourly[peak].consumedL) peak = i;
  }
  const total = hourly.reduce((s, b) => s + b.consumedL, 0);
  if (total === 0) return "No consumption pattern detected in this period.";
  const peakShare = Math.round((hourly[peak].consumedL / total) * 100);
  const bucket    = peak < 5 ? "late night / early morning" :
                    peak < 12 ? "morning" :
                    peak < 17 ? "afternoon" :
                    peak < 21 ? "evening" : "night";
  return `Water use peaks around ${formatHour(peak)} (${bucket}) — about ${peakShare}% of total use happens in that hour.`;
}

export function formatHour(h) {
  if (h === 0) return "12 AM";
  if (h < 12)  return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

// ──────────────────────────────────────────────────────────────
// Per-tank heatmap data: hour-of-day consumption (for click-expand view)
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// OHT Fill Analysis — day-level roll-ups built DIRECTLY from the
// cleaned source + OHT histories, NOT from pump-cycle correlation.
//
// Why not correlation: most sumps in the field have municipal/BMC
// inflow, so a sump drop isn't "water drawn" — it's drop minus inflow.
// Trying to compute efficiency from level sensors alone gives
// pathological numbers (we had a 17% efficiency / 1.78 ML "lost"
// which was really "sump kept getting refilled during pump run").
//
// Honest framing: show side-by-side daily totals so the admin SEES
// why these two numbers can't be subtracted. "Sump level change"
// is captioned as a NET change (drop minus inflow). OHT delivery is
// a real metered number of litres added.
// ──────────────────────────────────────────────────────────────

// Sum of downward pct deltas over a window of (clean) history, in
// litres. Used both for OHT delivery (positive-delta sum, see
// positiveDeltaLitres) and sump "net drop" (negative-delta sum).
function negativeDeltaLitres(history, capacity) {
  if (!capacity || !Array.isArray(history) || history.length < 2) return 0;
  let out = 0;
  for (let i = 1; i < history.length; i++) {
    const delta = (history[i].pct ?? 0) - (history[i - 1].pct ?? 0);
    if (delta < 0) out += (Math.abs(delta) / 100) * capacity;
  }
  return Math.round(out);
}

function positiveDeltaLitres(history, capacity) {
  if (!capacity || !Array.isArray(history) || history.length < 2) return 0;
  let out = 0;
  for (let i = 1; i < history.length; i++) {
    const delta = (history[i].pct ?? 0) - (history[i - 1].pct ?? 0);
    if (delta > 0) out += (delta / 100) * capacity;
  }
  return Math.round(out);
}

// Build a day-by-day roll-up for OHT fill analysis. For each date in
// the period:
//   • sumpNetDropL     = sum of downward pct deltas on the source tank
//                        (NOT the same as "water drawn" because sump
//                         inflow partially offsets drops — label honestly)
//   • ohtDeliveredL    = sum of upward pct deltas across ALL OHT tanks
//                        (real litres added to overhead tanks that day)
//   • pumpCycleCount   = number of distinct OHT fill events that day
//                        (counted via existing correlation.cycles)
//
// Returns [{ date, sumpNetDropL, ohtDeliveredL, pumpCycleCount,
//            perOht: [{deviceCode, deviceName, deliveredL}] }]
// sorted ascending.
export function dailyOhtFillRollup({ source, terraces, cleanedSourceHistory, cleanedTerraceHistories, correlation }) {
  const map = {};

  const ensure = (date) => {
    if (!map[date]) map[date] = { date, sumpNetDropL: 0, ohtDeliveredL: 0, pumpCycleCount: 0, perOht: {} };
    return map[date];
  };

  const sumpCap = source?.tankCapacityLitres || 0;
  // Per-day sump negative-delta → "net drop"
  if (sumpCap > 0 && Array.isArray(cleanedSourceHistory)) {
    for (let i = 1; i < cleanedSourceHistory.length; i++) {
      const prev = cleanedSourceHistory[i - 1].pct ?? 0;
      const curr = cleanedSourceHistory[i].pct ?? 0;
      const delta = curr - prev;
      if (delta < 0) {
        const litres = (Math.abs(delta) / 100) * sumpCap;
        const key = istDateKey(cleanedSourceHistory[i].ts);
        ensure(key).sumpNetDropL += litres;
      }
    }
  }

  // Per-day OHT positive-delta → delivery
  for (let t = 0; t < (terraces || []).length; t++) {
    const dev = terraces[t];
    const cap = dev.tankCapacityLitres || 0;
    const hist = cleanedTerraceHistories[t] || [];
    if (cap <= 0) continue;
    for (let i = 1; i < hist.length; i++) {
      const prev = hist[i - 1].pct ?? 0;
      const curr = hist[i].pct ?? 0;
      const delta = curr - prev;
      if (delta > 0) {
        const litres = (delta / 100) * cap;
        const key = istDateKey(hist[i].ts);
        const d = ensure(key);
        d.ohtDeliveredL += litres;
        if (!d.perOht[dev.deviceCode]) d.perOht[dev.deviceCode] = { deviceCode: dev.deviceCode, deviceName: dev.deviceName || dev.deviceCode, deliveredL: 0 };
        d.perOht[dev.deviceCode].deliveredL += litres;
      }
    }
  }

  // Pump-cycle count (one count per correlation cycle on its start-day)
  if (correlation?.cycles) {
    for (const c of correlation.cycles) {
      const key = istDateKey(c.ts);
      ensure(key).pumpCycleCount += 1;
    }
  }

  return Object.values(map)
    .map((d) => ({
      date:            d.date,
      sumpNetDropL:    Math.round(d.sumpNetDropL),
      ohtDeliveredL:   Math.round(d.ohtDeliveredL),
      pumpCycleCount:  d.pumpCycleCount,
      perOht:          Object.values(d.perOht).map((o) => ({ ...o, deliveredL: Math.round(o.deliveredL) })),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Top-line headline for OHT fill analysis. Everything is OHT-side.
export function buildOhtFillHeadline({ terraces, cleanedTerraceHistories, correlation, days }) {
  let totalDeliveredL = 0;
  for (let t = 0; t < terraces.length; t++) {
    const cap = terraces[t].tankCapacityLitres || 0;
    if (cap <= 0) continue;
    totalDeliveredL += positiveDeltaLitres(cleanedTerraceHistories[t], cap);
  }
  const pumpCycles  = correlation?.cycles?.length || 0;
  const avgPerCycle = pumpCycles > 0 ? Math.round(totalDeliveredL / pumpCycles) : 0;
  const avgPerDay   = days > 0 ? Math.round(totalDeliveredL / days) : 0;
  return {
    totalDeliveredL,
    pumpCycles,
    avgPerCycle,
    avgPerDay,
    terraceCount: terraces.length,
  };
}

// ──────────────────────────────────────────────────────────────
// Source → Terrace aggregations (built from correlation.cycles)
// Kept for the hour-of-day pump activity chart (still useful).
// Daily lost-water + per-terrace share retained for callers that
// need them, though lostWater is no longer surfaced in UI.
// ──────────────────────────────────────────────────────────────

// Daily lost-water series. Each cycle's lostL = sourceDropL - terraceRiseL
// (capped at 0 so negative "gains" from measurement noise don't inflate).
// Returns [{dateIso, lostL}] sorted by date ascending.
export function dailyLostWater(correlation) {
  if (!correlation?.cycles) return [];
  const map = {};
  for (const c of correlation.cycles) {
    const lost = Math.max(0, (c.sourceDropL || 0) - (c.terraceRiseL || 0));
    const key  = istDateKey(c.ts);
    map[key] = (map[key] || 0) + lost;
  }
  // Also account for unaccounted draws — those are 100% lost by definition.
  for (const u of (correlation.unaccountedDraws || [])) {
    const key = istDateKey(u.ts);
    map[key]  = (map[key] || 0) + (u.sourceDropL || 0);
  }
  return Object.entries(map)
    .map(([date, lostL]) => ({ date, lostL: Math.round(lostL) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Per-terrace delivery share. Sum of riseL per terrace device across
// every cycle, converted to % of total delivered.
// Returns [{name, deviceCode, deliveredL, sharePct}] descending.
export function perTerraceDeliveryShare(correlation) {
  if (!correlation?.cycles) return [];
  const map = {};
  for (const c of correlation.cycles) {
    for (const p of (c.perTank || [])) {
      if (p.riseL == null) continue;
      if (!map[p.deviceCode]) map[p.deviceCode] = { name: p.deviceName || p.deviceCode, deviceCode: p.deviceCode, deliveredL: 0 };
      map[p.deviceCode].deliveredL += p.riseL;
    }
  }
  const arr = Object.values(map);
  const total = arr.reduce((s, x) => s + x.deliveredL, 0);
  return arr
    .map((x) => ({ ...x, sharePct: total > 0 ? Math.round((x.deliveredL / total) * 100) : 0 }))
    .sort((a, b) => b.deliveredL - a.deliveredL);
}

// Pump activity by hour: for each source-drop cycle, count 1 against
// the hour it started AND the amount of water drawn in that hour.
// Returns [{hour, drawnL, cycles}].
export function pumpActivityByHour(correlation) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, drawnL: 0, cycles: 0 }));
  if (!correlation?.cycles) return buckets;
  for (const c of correlation.cycles) {
    const h = istHour(c.ts);
    buckets[h].drawnL += (c.sourceDropL || 0);
    buckets[h].cycles += 1;
  }
  return buckets;
}

export function perTankHourlyConsumption(tank) {
  const cap = tank.device.tankCapacityLitres || 0;
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, consumedL: 0, consumedPct: 0 }));
  const h = tank.cleanHistory || [];
  for (let i = 1; i < h.length; i++) {
    const delta = (h[i].pct ?? 0) - (h[i - 1].pct ?? 0);
    if (delta >= 0) continue;
    const absPct = Math.abs(delta);
    buckets[istHour(h[i].ts)].consumedPct += absPct;
    if (cap > 0) buckets[istHour(h[i].ts)].consumedL += (absPct / 100) * cap;
  }
  return buckets;
}
