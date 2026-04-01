// Cleaning status badge for tank cards
// 🍃 Green leaf = clean, ⚠️ Yellow = due soon, 🔴 Red = overdue

export function getCleaningStatus(lastCleanedAt, cleanIntervalDays) {
  if (!lastCleanedAt || !cleanIntervalDays) return null;

  const lastCleaned = new Date(lastCleanedAt);
  const now = new Date();
  const daysSince = Math.floor((now - lastCleaned) / (1000 * 60 * 60 * 24));
  const daysLeft = cleanIntervalDays - daysSince;

  if (daysLeft > 14) return { status: "clean", daysLeft, daysSince, label: "Clean" };
  if (daysLeft > 0) return { status: "due", daysLeft, daysSince, label: `Due in ${daysLeft}d` };
  return { status: "overdue", daysLeft: Math.abs(daysLeft), daysSince, label: `Overdue ${Math.abs(daysLeft)}d` };
}

export default function CleaningBadge({ lastCleanedAt, cleanIntervalDays }) {
  const info = getCleaningStatus(lastCleanedAt, cleanIntervalDays);
  if (!info) return null;

  if (info.status === "clean") {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-green-50 text-green-700 font-medium" title={`Cleaned ${info.daysSince} days ago`}>
        🍃 Clean
      </span>
    );
  }

  if (info.status === "due") {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-yellow-50 text-yellow-700 font-medium" title={info.label}>
        ⚠️ {info.daysLeft}d
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-red-50 text-red-700 font-medium" title={info.label}>
      🔴 {info.daysLeft}d
    </span>
  );
}
