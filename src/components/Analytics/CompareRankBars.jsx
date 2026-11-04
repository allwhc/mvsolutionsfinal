// Ranked consumption bar chart: vertical bars, single-blue, one bar
// per tank, sorted highest → lowest. Clicking a tank's row expands
// an inline hour-of-day pattern mini-chart for that tank only.
//
// Tanks without capacity set appear in a muted sidebar list beneath
// the chart — can't mix pct-only with litres on one axis.

import { useState, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
import { formatLitres } from "../../utils/analyticsInsights";
import { perTankHourlyConsumption, formatHour } from "../../utils/compareAnalytics";

function HourMiniChart({ tank }) {
  const hourly = useMemo(() => perTankHourlyConsumption(tank), [tank]);
  const total  = hourly.reduce((s, b) => s + b.consumedL + b.consumedPct, 0);
  if (total === 0) {
    return <p className="text-xs text-gray-500 py-3">No usage pattern detected for this tank in the period.</p>;
  }
  const hasCap = tank.device.tankCapacityLitres > 0;
  return (
    <div style={{ width: "100%", height: 160 }}>
      <ResponsiveContainer>
        <BarChart data={hourly} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis
            dataKey="hour"
            tickFormatter={(h) => h % 4 === 0 ? formatHour(h) : ""}
            stroke="#6b7280"
            fontSize={10}
            interval={0}
          />
          <YAxis
            stroke="#6b7280"
            fontSize={10}
            width={50}
            tickFormatter={(v) => hasCap ? formatLitres(v) : `${Math.round(v)}%`}
          />
          <Tooltip
            labelFormatter={(h) => formatHour(h)}
            formatter={(v) => [hasCap ? formatLitres(v) : `${Math.round(v)}%`, "Consumed"]}
            contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e5e7eb" }}
          />
          <Bar dataKey={hasCap ? "consumedL" : "consumedPct"} fill="#60a5fa" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function CompareRankBars({ tanks, perTank }) {
  const [expandedCode, setExpandedCode] = useState(null);

  // Rank tanks by litres consumed, high → low. Pct-only tanks shown
  // separately below so axis isn't mixed.
  const withCap = useMemo(
    () => perTank.filter((p) => p.hasCapacity).sort((a, b) => b.consumedL - a.consumedL),
    [perTank]
  );
  const noCap = useMemo(() => perTank.filter((p) => !p.hasCapacity), [perTank]);

  const chartData = withCap.map((p) => ({
    name:      p.device.deviceName || p.device.deviceCode,
    code:      p.device.deviceCode,
    consumedL: p.consumedL,
  }));

  const takeaway = (() => {
    if (withCap.length < 2) return "";
    const top = withCap[0];
    const bot = withCap[withCap.length - 1];
    if (top.consumedL === 0) return "No measured consumption in this period.";
    const ratio = bot.consumedL > 0 ? Math.round(top.consumedL / bot.consumedL) : null;
    const topName = top.device.deviceName || top.device.deviceCode;
    const botName = bot.device.deviceName || bot.device.deviceCode;
    if (ratio && ratio >= 2) {
      return `${topName} used ${ratio}× more water than ${botName} this period.`;
    }
    return `${topName} is the top consumer; usage across tanks is otherwise balanced.`;
  })();

  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-900 mb-1">Consumption by tank</h3>
      {takeaway && <p className="text-sm text-gray-600 mb-3">{takeaway}</p>}

      {withCap.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <div style={{ width: "100%", height: Math.max(260, chartData.length * 32) }}>
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis
                  dataKey="name"
                  stroke="#6b7280"
                  fontSize={11}
                  interval={0}
                  angle={-18}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  tickFormatter={(v) => formatLitres(v)}
                  stroke="#6b7280"
                  fontSize={11}
                  width={60}
                />
                <Tooltip
                  formatter={(v) => [formatLitres(v), "Consumed"]}
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }}
                />
                <Bar
                  dataKey="consumedL"
                  radius={[3, 3, 0, 0]}
                  onClick={(d) => setExpandedCode((prev) => prev === d.code ? null : d.code)}
                  cursor="pointer"
                >
                  {chartData.map((d) => (
                    <Cell key={d.code} fill={expandedCode === d.code ? "#1d4ed8" : "#2563eb"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Expand list: click a name to see its hour pattern. Mirrors
              the chart click so admins can also reach it from the list. */}
          <div className="mt-3 border-t border-gray-100 pt-3">
            <div className="text-xs text-gray-500 mb-1.5">Tap any tank for its hour-of-day pattern:</div>
            <div className="flex flex-wrap gap-1.5">
              {withCap.map((p) => {
                const code = p.device.deviceCode;
                const active = expandedCode === code;
                return (
                  <button
                    key={code}
                    onClick={() => setExpandedCode((prev) => prev === code ? null : code)}
                    className={`text-xs rounded px-2 py-1 border transition ${
                      active
                        ? "bg-blue-600 text-white border-blue-700"
                        : "bg-gray-50 text-gray-700 border-gray-200 hover:border-blue-300 hover:bg-blue-50"
                    }`}
                  >
                    {p.device.deviceName || code}
                  </button>
                );
              })}
            </div>
            {expandedCode && (
              <div className="mt-3">
                <div className="text-xs font-medium text-gray-700 mb-1">
                  Hour-of-day pattern — {perTank.find((p) => p.device.deviceCode === expandedCode)?.device.deviceName || expandedCode}
                </div>
                <HourMiniChart tank={tanks.find((t) => t.device.deviceCode === expandedCode)} />
              </div>
            )}
          </div>
        </div>
      )}

      {noCap.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="text-xs font-semibold text-amber-900 mb-1">Tanks without capacity set</div>
          <p className="text-xs text-amber-800 mb-1">
            These tanks are shown only in the chart below because volume (litres) requires a tank capacity in device settings.
          </p>
          <ul className="text-xs text-amber-900 list-disc list-inside">
            {noCap.map((p) => <li key={p.device.deviceCode}>{p.device.deviceName || p.device.deviceCode}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
