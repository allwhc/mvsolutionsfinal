// Four at-a-glance tiles for Tank Comparison: total water used, which
// tank used the most, which used the least, and the peak-consumption
// day of the period.

import { formatLitres } from "../../utils/analyticsInsights";

function Tile({ label, value, sub, tone = "neutral" }) {
  const toneMap = {
    neutral: "bg-white border-gray-200",
    good:    "bg-emerald-50 border-emerald-200",
    warn:    "bg-amber-50 border-amber-200",
  };
  return (
    <div className={`rounded-lg border px-3 py-3 ${toneMap[tone]}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900 tabular-nums mt-0.5 break-words">{value}</div>
      {sub && <div className="text-xs text-gray-600 mt-0.5 truncate" title={sub}>{sub}</div>}
    </div>
  );
}

function istPrettyDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export default function CompareHeadlines({ headlines }) {
  const { tanksCount, totalConsumedL, highest, lowest, peakDay, peakL } = headlines;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Tile
        label="Total water consumed"
        value={totalConsumedL > 0 ? formatLitres(totalConsumedL) : "—"}
        sub={`${tanksCount} tanks compared`}
      />
      <Tile
        label="Highest-use tank"
        value={highest ? formatLitres(highest.consumedL) : "—"}
        sub={highest?.device?.deviceName || ""}
        tone="warn"
      />
      <Tile
        label="Lowest-use tank"
        value={lowest ? formatLitres(lowest.consumedL) : "—"}
        sub={lowest?.device?.deviceName || ""}
        tone="good"
      />
      <Tile
        label="Peak consumption day"
        value={peakDay ? istPrettyDate(peakDay) : "—"}
        sub={peakL > 0 ? formatLitres(peakL) : ""}
      />
    </div>
  );
}
