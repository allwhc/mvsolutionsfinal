// DIP sensor level bar visualization
// Shows individual sensor dots + level percentage bar

const DIP_PERCENT_TABLE = {
  1: [0, 100],
  2: [0, 50, 100],
  3: [0, 33, 66, 100],
  4: [0, 25, 50, 75, 100],
  5: [0, 20, 40, 60, 80, 100],
  6: [0, 17, 33, 50, 67, 83, 100],
};

function getLevelColor(pct) {
  if (pct <= 10) return "bg-red-500";
  if (pct <= 25) return "bg-orange-500";
  if (pct <= 50) return "bg-yellow-500";
  if (pct <= 75) return "bg-green-400";
  return "bg-green-500";
}

function getLevelTextColor(pct) {
  if (pct <= 10) return "text-red-600";
  if (pct <= 25) return "text-orange-600";
  if (pct <= 50) return "text-yellow-600";
  return "text-green-600";
}

export default function LevelBar({ sensorBits, sensorCount, confirmedPct, sensorError }) {
  const count = sensorCount || 4;
  const bits = sensorBits || 0;

  // Parse individual sensor states from bitmask
  const sensors = [];
  for (let i = 0; i < count; i++) {
    sensors.push((bits >> i) & 1);
  }

  return (
    <div className="space-y-2">
      {/* Percentage bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-gray-200 rounded-full h-4 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${getLevelColor(confirmedPct)}`}
            style={{ width: `${Math.min(confirmedPct, 100)}%` }}
          />
        </div>
        <span className={`text-lg font-bold min-w-[3rem] text-right ${getLevelTextColor(confirmedPct)}`}>
          {confirmedPct}%
        </span>
      </div>

      {/* DIP sensor dots */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-gray-500 mr-1">DIP:</span>
        {sensors.map((on, i) => (
          <div
            key={i}
            className={`w-4 h-4 rounded-full border-2 ${
              sensorError
                ? "bg-purple-500 border-purple-600"
                : on
                ? "bg-blue-500 border-blue-600"
                : "bg-gray-200 border-gray-300"
            }`}
            title={`Sensor ${i + 1}: ${on ? "ON" : "OFF"}`}
          />
        ))}
        {sensorError && (
          <span className="text-xs text-purple-600 font-medium ml-2">Sensor Error</span>
        )}
      </div>
    </div>
  );
}

export { DIP_PERCENT_TABLE, getLevelColor, getLevelTextColor };
