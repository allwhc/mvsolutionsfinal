// Resolves the "true" tank level from raw firmware bits.
//
// Physics: if a HIGHER probe reads wet, all probes BELOW it must be wet
// (water can't hover mid-tank). So the highest wet probe = actual water
// height, and any dry-reading probe below it is a fault (oxidation, poor
// contact, cable damage) — not real state.
//
// Normal users should see the resolved level so a probe fault doesn't
// destroy trust in the data. Installers / admins can flip on debug mode
// (session-only toggle in the dashboard header) to see the raw firmware
// state and diagnose which probe is misbehaving.
//
// Returns:
//   pct       — resolved level (highest wet probe's percentage)
//   filledBits — bits with the "fill down" applied (all bits below highest
//                wet set to 1); use this for tank viz dots
//   hasFault  — true when raw bits are non-consecutive (dry probe below
//                a wet one). Present for internal diagnostics only — the
//                UI intentionally does NOT show any indicator to normal
//                users (Vishal's spec).

const PCT_TABLE = {
  1: [100],
  2: [50, 100],
  3: [33, 67, 100],
  4: [25, 50, 75, 100],
  5: [20, 40, 60, 80, 100],
  6: [17, 33, 50, 67, 83, 100],
};

// Find the index of the highest set bit in `bits` within the first
// `count` positions. Returns -1 if none are set.
function highestWetIndex(bits, count) {
  for (let i = count - 1; i >= 0; i--) {
    if ((bits >> i) & 1) return i;
  }
  return -1;
}

export function resolveLevel(bits, count) {
  const c = count || 4;
  const table = PCT_TABLE[c] || PCT_TABLE[4];
  const highest = highestWetIndex(bits, c);

  // Detect fault: any 0 bit below the highest set bit
  let hasFault = false;
  for (let i = 0; i < highest; i++) {
    if (!((bits >> i) & 1)) { hasFault = true; break; }
  }

  if (highest === -1) {
    return { pct: 0, filledBits: 0, hasFault: false };
  }
  const filledBits = (1 << (highest + 1)) - 1;   // all bits from 0..highest set
  return { pct: table[highest], filledBits, hasFault };
}
