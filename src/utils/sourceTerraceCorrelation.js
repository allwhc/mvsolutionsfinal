// Source → Terrace correlation. Infers pump-fill cycles from level-sensor
// data alone — no pump device needed. For each drain event on the source
// (sump/ground tank), look for refill events on the terrace tank(s) that
// occur within a correlation window and compute the delivery efficiency.
//
// Inputs are already cleaned (spike-filtered + smoothed) — we reuse the
// standalone-mode cleanHistoryForAnalytics() output so the chart and this
// correlation agree.
//
// We DO NOT reuse detectEvents() from analyticsInsights.js here — it is
// tuned for insight-text ("Tank fills around 6 AM") with coarse thresholds
// (REFILL ≥ 25%, DRAIN ≥ 10%). Pump-fill cycles can be smaller (e.g. a
// 5-min top-up of an overhead tank). We use lower thresholds here but
// stricter time windows to avoid picking up slow consumption as a "drain".

const SOURCE_DROP_PCT_MIN      = 5;             // smallest drop that counts as a pump pull
const SOURCE_DROP_WINDOW_MS    = 60 * 60 * 1000; // ≤ 60 min — pump runs rarely longer
const TERRACE_RISE_PCT_MIN     = 5;
const TERRACE_RISE_WINDOW_MS   = 60 * 60 * 1000;
const CORRELATION_WINDOW_MS    = 5 * 60 * 1000;  // ±5 min between source-drop start and terrace-rise start

// Walk a history finding consecutive drops (source-side) OR rises
// (terrace-side) that exceed the min delta within a bounded time window.
// Returns [{startTs, endTs, startPct, endPct, pctDelta}].
function detectDirectionalEvents(history, direction, minPct, maxWindowMs) {
  if (!Array.isArray(history) || history.length < 2) return [];
  const sign = direction === "drop" ? -1 : 1;
  const events = [];
  let i = 0;
  while (i < history.length - 1) {
    const a = history[i];
    const aPct = a.pct ?? 0;
    let bestDelta = 0;
    let bestIdx   = -1;
    for (let j = i + 1; j < history.length; j++) {
      const b = history[j];
      const dt = b.ts - a.ts;
      if (dt > maxWindowMs) break;
      const dp = ((b.pct ?? 0) - aPct) * sign;      // flip sign so we always maximise
      if (dp > bestDelta) {
        bestDelta = dp;
        bestIdx   = j;
      }
    }
    if (bestDelta >= minPct && bestIdx !== -1) {
      events.push({
        startTs:   a.ts,
        endTs:     history[bestIdx].ts,
        startPct:  aPct,
        endPct:    history[bestIdx].pct ?? 0,
        pctDelta:  bestDelta * sign,
      });
      i = bestIdx;
    } else {
      i++;
    }
  }
  return events;
}

// Correlate: for each source drop, find any terrace rises that STARTED
// within ±CORRELATION_WINDOW_MS of the source drop's start. Sum them.
//
// Return per-cycle rows AND aggregates:
//   {
//     cycles: [{ ts, duration, sourceDropL, terraceRiseL, efficiency,
//                perTank: [{deviceCode, deviceName, riseL}], flags: {...} }],
//     unaccountedDraws: [...source drops with no matching terrace rise],
//     totals: { fills, sourceDrawnL, terraceDeliveredL, lostL, avgEfficiency }
//   }
export function correlateSourceToTerraces({ source, terraces, cleanedSourceHistory, cleanedTerraceHistories }) {
  if (!source || !cleanedSourceHistory || !terraces?.length || !cleanedTerraceHistories?.length) {
    return { cycles: [], unaccountedDraws: [], totals: emptyTotals() };
  }

  const sourceDrops   = detectDirectionalEvents(cleanedSourceHistory, "drop", SOURCE_DROP_PCT_MIN, SOURCE_DROP_WINDOW_MS);
  const terraceRises  = terraces.map((t, i) => ({
    device: t,
    rises:  detectDirectionalEvents(cleanedTerraceHistories[i], "rise", TERRACE_RISE_PCT_MIN, TERRACE_RISE_WINDOW_MS),
  }));

  const sourceCap = source.tankCapacityLitres || 0;
  const cycles = [];
  const unaccounted = [];
  const matchedTerraceRiseKeys = new Set();   // "<terraceIdx>|<startTs>" so a rise can only match ONE cycle

  for (const drop of sourceDrops) {
    const perTank = [];
    let terraceRiseL = 0;
    let overflowFlag = false;

    for (const [idx, { device, rises }] of terraceRises.entries()) {
      for (const r of rises) {
        const key = `${idx}|${r.startTs}`;
        if (matchedTerraceRiseKeys.has(key)) continue;
        if (Math.abs(r.startTs - drop.startTs) <= CORRELATION_WINDOW_MS) {
          const riseL = device.tankCapacityLitres > 0
            ? Math.round((r.pctDelta / 100) * device.tankCapacityLitres)
            : null;
          if (riseL != null) terraceRiseL += riseL;
          perTank.push({
            deviceCode: device.deviceCode,
            deviceName: device.deviceName || device.deviceCode,
            risePct:    r.pctDelta,
            riseL,
          });
          if (r.endPct >= 100) overflowFlag = true;
          matchedTerraceRiseKeys.add(key);
          break;
        }
      }
    }

    const sourceDropL = sourceCap > 0 ? Math.round((Math.abs(drop.pctDelta) / 100) * sourceCap) : null;

    if (perTank.length === 0) {
      unaccounted.push({
        ts:          drop.startTs,
        sourceDropL,
        sourceDropPct: drop.pctDelta,
      });
      continue;
    }

    const efficiency = (sourceDropL && terraceRiseL)
      ? Math.round((terraceRiseL / sourceDropL) * 100)
      : null;

    const dryStart = drop.startPct <= 5;

    cycles.push({
      ts:            drop.startTs,
      endTs:         drop.endTs,
      duration:      drop.endTs - drop.startTs,
      sourceDropPct: Math.abs(drop.pctDelta),
      sourceDropL,
      terraceRiseL:  terraceRiseL || null,
      efficiency,
      perTank,
      flags: {
        overflow:     overflowFlag,
        dryStart,
        unaccounted:  false,
      },
    });
  }

  // Aggregates
  const sourceDrawnL   = cycles.reduce((s, c) => s + (c.sourceDropL  || 0), 0)
                       + unaccounted.reduce((s, u) => s + (u.sourceDropL || 0), 0);
  const terraceDelivL  = cycles.reduce((s, c) => s + (c.terraceRiseL || 0), 0);
  const lostL          = Math.max(0, sourceDrawnL - terraceDelivL);
  const avgEff         = cycles.length === 0
    ? null
    : Math.round(cycles.filter((c) => c.efficiency != null).reduce((s, c) => s + c.efficiency, 0)
                 / Math.max(1, cycles.filter((c) => c.efficiency != null).length));

  return {
    cycles,
    unaccountedDraws: unaccounted,
    totals: {
      fills:              cycles.length,
      unaccountedCount:   unaccounted.length,
      sourceDrawnL,
      terraceDeliveredL:  terraceDelivL,
      lostL,
      avgEfficiency:      avgEff,
    },
  };
}

function emptyTotals() {
  return { fills: 0, unaccountedCount: 0, sourceDrawnL: 0, terraceDeliveredL: 0, lostL: 0, avgEfficiency: null };
}
