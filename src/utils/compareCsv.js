// Combined CSV builder for Tank Comparison.
//
// Input: an array of { device: { deviceCode, deviceName, tankCapacityLitres }, history: [{ts, pct}] }
// Output: a Blob with timestamp-aligned rows.
//
// Each unique timestamp from any tank gets a row; missing cells stay empty.
// Values are the already-cleaned (spike-filtered + smoothed) pct the UI
// shows, so what the user downloads matches what they saw on screen.
// Litres column is omitted for tanks with no tankCapacityLitres set.

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// IST = UTC+5:30. Users are in India so we render timestamps in local IST
// rather than ISO UTC — matches the dashboard clock + the firmware's own
// time stamps.
function fmtIst(ts) {
  const d = new Date(ts + 5.5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function buildCompareCsv({ orgName, periodLabel, tanks }) {
  const safeTanks = tanks.filter((t) => t?.device?.deviceCode);
  if (safeTanks.length === 0) return new Blob([""], { type: "text/csv" });

  // Union of all timestamps across all tanks.
  const tsSet = new Set();
  for (const t of safeTanks) for (const h of (t.history || [])) tsSet.add(h.ts);
  const tsAll = [...tsSet].sort((a, b) => a - b);

  // Fast index: per-tank Map<ts, pct>
  const idx = safeTanks.map((t) => {
    const m = new Map();
    for (const h of (t.history || [])) m.set(h.ts, h.pct);
    return m;
  });

  // Header row
  const header = ["ts_epoch_ms", "ts_ist"];
  for (const t of safeTanks) {
    const slug = (t.device.deviceName || t.device.deviceCode).replace(/[,"\n]/g, "_");
    header.push(`${slug}_pct`);
    if (t.device.tankCapacityLitres > 0) {
      header.push(`${slug}_litres`);
    }
  }

  const rows = [header.map(csvEscape).join(",")];

  for (const ts of tsAll) {
    const row = [ts, fmtIst(ts)];
    for (let i = 0; i < safeTanks.length; i++) {
      const pct = idx[i].get(ts);
      row.push(pct == null ? "" : pct);
      const cap = safeTanks[i].device.tankCapacityLitres;
      if (cap > 0) {
        row.push(pct == null ? "" : Math.round((pct / 100) * cap));
      }
    }
    rows.push(row.map(csvEscape).join(","));
  }

  // Trailing metadata line (prefixed `#` — Excel treats as a row, but
  // common spreadsheet parsers ignore it; small enough to accept).
  rows.push("");
  rows.push(csvEscape(`# Tank Comparison export`));
  rows.push(csvEscape(`# Org: ${orgName || "-"}`));
  rows.push(csvEscape(`# Period: ${periodLabel || "-"}`));
  rows.push(csvEscape(`# Generated: ${fmtIst(Date.now())} IST`));
  rows.push(csvEscape(`# Values are spike-filtered + 10-min moving average smoothed.`));

  return new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
}

// Build a shared slug stem used by both CSV and PDF filenames so the
// pair stays consistent when admins export both from the same session.
// Format: tankcompare_<orgSlug>_<periodSlug>_<yyyymmdd_HHMM>
function slugStem(orgName, periodLabel) {
  const org = (orgName || "tanks").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const period = (periodLabel || "period").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `tankcompare_${org || "tanks"}_${period}_${stamp}`;
}

export function suggestedCsvFilename(orgName, periodLabel) {
  return `${slugStem(orgName, periodLabel)}.csv`;
}

// PDF filename — no extension; the browser Save-As dialog adds .pdf.
// Used by setting document.title right before window.print(); browsers
// pick up the title as the default filename.
export function suggestedPdfFilename(orgName, periodLabel) {
  return slugStem(orgName, periodLabel);
}
