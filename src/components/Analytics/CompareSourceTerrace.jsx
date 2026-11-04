// OHT Fill Analysis (rebuilt).
//
// Framing change: we DO NOT compute "pump efficiency" or "water lost" —
// most sumps have municipal/BMC inflow, so sump drop isn't equivalent
// to water drawn. See compareAnalytics.js for the long comment.
//
// Honest layout:
//   1. OHT delivery headline — total litres pumped to OHTs this period,
//      avg per day, pump cycles counted
//   2. Daily chart — dual bars per day: "Sump net level change" + "OHT
//      delivered". Labels explain they are NOT directly comparable
//      (sump has inflow). Click a day to see per-OHT delivery breakdown.
//   3. Delivery share pie — which OHT received what share. Legend moved
//      BELOW the pie so percentage labels don't clip.
//   4. Pump activity by hour — unchanged, still useful.
//   5. CTA — "Connect SenseFlow panel for metered pump analysis."

import { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";
import { formatLitres } from "../../utils/analyticsInsights";
import {
  perTerraceDeliveryShare,
  pumpActivityByHour,
  dailyOhtFillRollup,
  buildOhtFillHeadline,
  formatHour,
} from "../../utils/compareAnalytics";
import CompareLevelTimeline from "./CompareLevelTimeline";

const PIE_COLORS = ["#2563eb", "#0891b2", "#16a34a", "#9333ea", "#ea580c", "#ca8a04", "#db2777", "#4b5563", "#15803d", "#dc2626"];

function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function Tile({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900 tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-xs text-gray-600 mt-0.5">{sub}</div>}
    </div>
  );
}

function OhtDeliveryHeadline({ headline, days }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Tile
        label="Water received by OHTs"
        value={headline.totalDeliveredL > 0 ? formatLitres(headline.totalDeliveredL) : "—"}
        sub={`${headline.terraceCount} OHT${headline.terraceCount !== 1 ? "s" : ""} tracked`}
      />
      <Tile
        label="Average per day"
        value={headline.avgPerDay > 0 ? formatLitres(headline.avgPerDay) : "—"}
        sub={`${days} days`}
      />
      <Tile
        label="Pump fill cycles"
        value={headline.pumpCycles > 0 ? headline.pumpCycles : "—"}
        sub="OHT fill events detected"
      />
      <Tile
        label="Average fill volume"
        value={headline.avgPerCycle > 0 ? formatLitres(headline.avgPerCycle) : "—"}
        sub="per pump cycle"
      />
    </div>
  );
}

function DailyDualBars({ daily }) {
  const [expandedDate, setExpandedDate] = useState(null);

  // Only render days with real activity; otherwise the chart is just
  // a run of 0-height bars.
  const data = useMemo(
    () => daily.filter((d) => d.sumpNetDropL > 0 || d.ohtDeliveredL > 0),
    [daily]
  );

  if (data.length === 0) {
    return <p className="text-sm text-gray-500">No daily activity in this period.</p>;
  }

  const totalSump = data.reduce((s, d) => s + d.sumpNetDropL, 0);
  const totalOht  = data.reduce((s, d) => s + d.ohtDeliveredL, 0);
  const looksLikeInflow = totalSump > 0 && totalOht > 0 && (totalOht / totalSump) < 0.4;
  const expandedDay = expandedDate ? daily.find((d) => d.date === expandedDate) : null;

  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-900 mb-1">Daily water movement — source tank vs OHTs</h3>
      <p className="text-sm text-gray-600 mb-3">
        <span className="font-medium">Source tank delivered</span> is the total drop in the source tank's level that day (converted to litres via the tank capacity set in device settings). <span className="font-medium">OHT received</span> is the total rise across all selected OHTs. Because the source tank is also being refilled from the municipal line during pump operation, these two figures are NOT directly comparable — they are shown together for reference, not as a before/after pair.
        {looksLikeInflow && (
          <span className="block mt-2 text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            ⓘ Source tank "delivered" is much larger than OHT "received" — this is expected when the source tank has municipal/BMC inflow. For accurate pump efficiency, a SenseFlow Flowmeter is needed (see below).
          </span>
        )}
      </p>
      <div className="rounded-lg border border-gray-200 bg-white p-3" style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(d) => prettyDate(d)}
              stroke="#6b7280"
              fontSize={11}
              interval="preserveStartEnd"
              angle={-18}
              textAnchor="end"
              height={50}
            />
            <YAxis
              tickFormatter={(v) => formatLitres(v)}
              stroke="#6b7280"
              fontSize={11}
              width={60}
            />
            <Tooltip
              labelFormatter={(d) => prettyDate(d)}
              formatter={(v, n) => [formatLitres(v), n]}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="sumpNetDropL"
              name="Source tank delivered"
              fill="#64748b"
              radius={[3, 3, 0, 0]}
              onClick={(d) => setExpandedDate((prev) => prev === d.date ? null : d.date)}
              cursor="pointer"
            />
            <Bar
              dataKey="ohtDeliveredL"
              name="OHT received"
              fill="#2563eb"
              radius={[3, 3, 0, 0]}
              onClick={(d) => setExpandedDate((prev) => prev === d.date ? null : d.date)}
              cursor="pointer"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Inline day drill-down. Click any bar OR day chip to open. */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {data.map((d) => {
          const active = expandedDate === d.date;
          return (
            <button
              key={d.date}
              onClick={() => setExpandedDate((prev) => prev === d.date ? null : d.date)}
              className={`text-xs rounded px-2 py-1 border transition ${
                active
                  ? "bg-blue-600 text-white border-blue-700"
                  : "bg-gray-50 text-gray-700 border-gray-200 hover:border-blue-300 hover:bg-blue-50"
              }`}
            >
              {prettyDate(d.date)}
            </button>
          );
        })}
      </div>

      {expandedDay && (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-blue-900">{prettyDate(expandedDay.date)}</h4>
            <button
              onClick={() => setExpandedDate(null)}
              className="text-xs text-blue-700 hover:text-blue-900"
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm mb-3">
            <div className="rounded bg-white border border-blue-100 px-2 py-1.5">
              <div className="text-xs text-gray-500">Source tank delivered</div>
              <div className="font-semibold tabular-nums">{formatLitres(expandedDay.sumpNetDropL)}</div>
            </div>
            <div className="rounded bg-white border border-blue-100 px-2 py-1.5">
              <div className="text-xs text-gray-500">OHT received</div>
              <div className="font-semibold tabular-nums">{formatLitres(expandedDay.ohtDeliveredL)}</div>
            </div>
            <div className="rounded bg-white border border-blue-100 px-2 py-1.5">
              <div className="text-xs text-gray-500">Pump cycles</div>
              <div className="font-semibold tabular-nums">{expandedDay.pumpCycleCount}</div>
            </div>
          </div>
          {expandedDay.perOht.length > 0 && (
            <>
              <div className="text-xs font-medium text-blue-900 mb-1">Delivery by OHT:</div>
              <ul className="text-sm text-blue-900 space-y-0.5">
                {expandedDay.perOht
                  .sort((a, b) => b.deliveredL - a.deliveredL)
                  .map((o) => (
                    <li key={o.deviceCode} className="flex justify-between tabular-nums">
                      <span>{o.deviceName}</span>
                      <span className="font-medium">{formatLitres(o.deliveredL)}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function DeliveryShare({ correlation }) {
  const shares = useMemo(() => perTerraceDeliveryShare(correlation), [correlation]);
  const total  = shares.reduce((s, x) => s + x.deliveredL, 0);
  if (total === 0 || shares.length === 0) {
    return (
      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Delivery share by OHT</h3>
        <p className="text-sm text-gray-500">No delivery volume to report yet.</p>
      </section>
    );
  }

  const top = shares[0];
  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-900 mb-1">Delivery share by OHT</h3>
      <p className="text-sm text-gray-600 mb-3">
        <span className="font-medium">{top.name}</span> received {top.sharePct}% of the water pumped to the OHTs this period.
      </p>
      <div className="rounded-lg border border-gray-200 bg-white p-3" style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer>
          <PieChart margin={{ top: 4, right: 12, left: 12, bottom: 4 }}>
            <Pie
              data={shares}
              dataKey="deliveredL"
              nameKey="name"
              cx="50%"
              cy="42%"
              outerRadius={78}
              label={(e) => `${e.sharePct}%`}
              labelLine={false}
            >
              {shares.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
            </Pie>
            <Legend verticalAlign="bottom" align="center" wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
            <Tooltip formatter={(v, n) => [formatLitres(v), n]} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function PumpByHour({ correlation }) {
  const hourly = useMemo(() => pumpActivityByHour(correlation), [correlation]);
  const total  = hourly.reduce((s, b) => s + b.cycles, 0);
  if (total === 0) {
    return (
      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Pump activity by hour</h3>
        <p className="text-sm text-gray-500">No pump cycles detected yet.</p>
      </section>
    );
  }

  let peakHour = 0;
  for (let i = 1; i < hourly.length; i++) if (hourly[i].cycles > hourly[peakHour].cycles) peakHour = i;
  const quietCount = hourly.filter((b) => b.cycles === 0).length;
  const nightCycles = hourly.slice(23).concat(hourly.slice(0, 5)).reduce((s, b) => s + b.cycles, 0);
  const nightNote = nightCycles > 0
    ? ` ${nightCycles} pump cycle${nightCycles > 1 ? "s" : ""} ran between 11 PM and 5 AM — review if you don't expect night-time refilling.`
    : "";

  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-900 mb-1">Pump activity by hour</h3>
      <p className="text-sm text-gray-600 mb-3">
        Pump runs most around <span className="font-medium">{formatHour(peakHour)}</span>, quiet for {quietCount} hour{quietCount !== 1 ? "s" : ""} of the day.{nightNote}
      </p>
      <div className="rounded-lg border border-gray-200 bg-white p-3" style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <BarChart data={hourly} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="hour"
              tickFormatter={(h) => h % 3 === 0 ? formatHour(h) : ""}
              stroke="#6b7280"
              fontSize={11}
              interval={0}
            />
            <YAxis
              stroke="#6b7280"
              fontSize={11}
              width={50}
              allowDecimals={false}
            />
            <Tooltip
              labelFormatter={(h) => formatHour(h)}
              formatter={(v, n) => [v, n === "cycles" ? "Pump cycles" : n]}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }}
            />
            <Bar dataKey="cycles" fill="#2563eb" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function PanelCta() {
  return (
    <section className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
      <h3 className="text-sm font-semibold text-indigo-900 mb-1">Upgrade your setup for accurate, metered insights</h3>
      <p className="text-sm text-indigo-900 mb-3">
        Tank-level sensors can show water reaching the overhead tank, but can't precisely measure pump draw when the source tank has municipal inflow. The following SenseFlow products close that gap:
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-md bg-white border border-indigo-200 p-3">
          <div className="text-sm font-semibold text-indigo-900 mb-1">SenseFlow Flowmeter</div>
          <p className="text-xs text-indigo-900">
            Inline flow sensor on the delivery pipe. Measures exact litres drawn and delivered — the only way to compute true pump efficiency and detect pipe leaks between source and OHT.
          </p>
        </div>
        <div className="rounded-md bg-white border border-indigo-200 p-3">
          <div className="text-sm font-semibold text-indigo-900 mb-1">SenseFlow Smart Valves</div>
          <p className="text-xs text-indigo-900">
            Remotely open and close inlet valves between sump and OHT, or switch between municipal and tanker fill lines — all from this dashboard. Pair with level-based automation for hands-free operation.
          </p>
        </div>
        <div className="rounded-md bg-white border border-indigo-200 p-3">
          <div className="text-sm font-semibold text-indigo-900 mb-1">SenseFlow Panel Monitoring</div>
          <p className="text-xs text-indigo-900">
            Non-invasive add-on for your existing starter panel. Reports pump run-time, current draw, and fault events. Spot abnormal cycling, dry-run damage, and panel-side issues remotely.
          </p>
        </div>
        <div className="rounded-md bg-white border border-indigo-200 p-3">
          <div className="text-sm font-semibold text-indigo-900 mb-1">SenseFlow Panel Controller</div>
          <p className="text-xs text-indigo-900">
            Full automation replacement: auto start/stop by tank level, schedules, force-run, pause/resume, dry-run protection, safe-mode recovery, and remote control from the dashboard.
          </p>
        </div>
      </div>
      <p className="text-xs text-indigo-800 mt-3">Contact your SenseFlow installer to add any of these to this setup.</p>
    </section>
  );
}

export default function CompareSourceTerrace({ correlation, source, terraces, cleanedSourceHistory, cleanedTerraceHistories, days }) {
  if (!correlation) return null;
  const { cycles } = correlation;

  const daily = useMemo(
    () => dailyOhtFillRollup({ source, terraces, cleanedSourceHistory, cleanedTerraceHistories, correlation }),
    [source, terraces, cleanedSourceHistory, cleanedTerraceHistories, correlation]
  );
  const headline = useMemo(
    () => buildOhtFillHeadline({ terraces, cleanedTerraceHistories, correlation, days }),
    [terraces, cleanedTerraceHistories, correlation, days]
  );

  if (cycles.length === 0 && daily.every((d) => d.ohtDeliveredL === 0 && d.sumpNetDropL === 0)) {
    return (
      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">OHT fill analysis</h3>
        <p className="text-sm text-gray-500">
          No pump activity detected in this period. Either the sump wasn't drained significantly, or the OHTs you selected aren't fed by this source.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <OhtDeliveryHeadline headline={headline} days={days} />
      <DailyDualBars daily={daily} />
      <CompareLevelTimeline
        source={source}
        terraces={terraces}
        cleanedSourceHistory={cleanedSourceHistory}
        cleanedTerraceHistories={cleanedTerraceHistories}
        correlation={correlation}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <DeliveryShare correlation={correlation} />
        <PumpByHour correlation={correlation} />
      </div>
      <PanelCta />
    </div>
  );
}
