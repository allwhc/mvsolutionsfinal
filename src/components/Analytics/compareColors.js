// Fixed categorical palette for Tank Comparison. The ORDER is the rule —
// a tank keeps its color across the chart, the table, the legend and the
// CSV columns. Removing a tank must not repaint the survivors.
//
// Picked for distinguishability at thin-line widths (2 px) on both light
// and dark surfaces. Not an auto-generated hue cycle — a 11th tank folds
// into the "Other" bucket in UI (the picker caps selection at 10).
//
// Source tank in Source → Terrace mode is drawn in a reserved
// SOURCE_COLOR + dashed stroke, never from the categorical set, so the
// first terrace tank still gets index 0.

export const COMPARE_COLORS = [
  "#2563eb", // blue    — index 0
  "#dc2626", // red
  "#16a34a", // green
  "#9333ea", // purple
  "#ea580c", // orange
  "#0891b2", // cyan
  "#ca8a04", // amber
  "#db2777", // pink
  "#4b5563", // slate
  "#15803d", // dark green
];

export const SOURCE_COLOR = "#0f172a";   // near-black, dashed in chart
