// Hour-of-day combined consumption bar chart. 24 vertical SVG bars.
// Single blue for the whole chart (identity is "water use", not
// categorical). Natural-language takeaway below.

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { formatLitres } from "../../utils/analyticsInsights";
import { describeHourlyPattern, formatHour } from "../../utils/compareAnalytics";

export default function CompareHourChart({ hourly }) {
  const total = hourly.reduce((s, b) => s + b.consumedL, 0);
  if (total === 0) {
    return (
      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">When your water is used</h3>
        <p className="text-sm text-gray-500">No consumption data for this period yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-900 mb-1">When your water is used</h3>
      <p className="text-sm text-gray-600 mb-3">{describeHourlyPattern(hourly)}</p>
      <div className="rounded-lg border border-gray-200 bg-white p-3" style={{ width: "100%", height: 240 }}>
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
              tickFormatter={(v) => formatLitres(v)}
              stroke="#6b7280"
              fontSize={11}
              width={60}
            />
            <Tooltip
              labelFormatter={(h) => formatHour(h)}
              formatter={(v) => [formatLitres(v), "Consumed"]}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }}
            />
            <Bar dataKey="consumedL" fill="#2563eb" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
