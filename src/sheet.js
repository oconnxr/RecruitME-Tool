// Google Sheet layout for the board: one row per player, flat columns.
// No imports, so the Apps Script build can inline this file as-is.

// [header, field path, type]
export const SHEET_COLUMNS = [
  ["ID", "id", "text"],
  ["Name", "name", "text"],
  // Staff working columns: filled in by coaches in the Sheet, never by
  // the agent. They round-trip with the player so updates don't erase them.
  ["Priority", "staff.priority", "text"],
  ["Contacted", "staff.contacted", "bool"],
  ["Assigned coach", "staff.coach", "text"],
  ["Next step", "staff.nextStep", "text"],
  ["Coach notes", "staff.notes", "text"],
  ["Class", "gradYear", "int"],
  ["Pos", "primaryPosition", "text"],
  ["Pos 2", "secondaryPosition", "text"],
  ["Bats", "bats", "text"],
  ["Throws", "throws", "text"],
  ["High school", "highSchool", "text"],
  ["City", "city", "text"],
  ["State", "state", "text"],
  ["Travel team", "travelTeam", "text"],
  ["Height (in)", "measurables.heightIn", "num"],
  ["Weight (lb)", "measurables.weightLb", "num"],
  ["FB (mph)", "measurables.fbVelo", "num"],
  ["FB top (mph)", "measurables.fbTopVelo", "num"],
  ["Exit velo (mph)", "measurables.exitVelo", "num"],
  ["60 yd (s)", "measurables.sixty", "num"],
  ["IF velo (mph)", "measurables.ifVelo", "num"],
  ["OF velo (mph)", "measurables.ofVelo", "num"],
  ["C velo (mph)", "measurables.cVelo", "num"],
  ["Pop (s)", "measurables.popTime", "num"],
  ["Measured at", "measurables.measuredAt", "text"],
  ["Stat season", "stats.season", "text"],
  ["AB", "stats.atBats", "num"],
  ["AVG", "stats.avg", "num"],
  ["OBP", "stats.obp", "num"],
  ["SLG", "stats.slg", "num"],
  ["HR", "stats.hr", "num"],
  ["SB", "stats.sb", "num"],
  ["IP", "stats.inningsPitched", "num"],
  ["ERA", "stats.era", "num"],
  ["K/9", "stats.k9", "num"],
  ["BB/9", "stats.bb9", "num"],
  ["WHIP", "stats.whip", "num"],
  ["Commitment", "commitment.status", "text"],
  ["Committed to", "commitment.school", "text"],
  ["Commitment evidence", "commitment.evidence", "text"],
  ["Commitment source", "commitment.checkedUrl", "text"],
  ["Commitment checked", "commitment.verifiedAt", "date"],
  ["Scouting notes", "scoutingNotes", "text"],
  ["Sources", "sources", "list"],
  ["First seen", "firstSeen", "date"],
  ["Updated", "updatedAt", "date"],
];

const getPath = (o, path) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
function setPath(o, path, v) {
  const keys = path.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = v;
}

// Prospect -> row of cell values (strings and numbers, ready for the Sheet).
export function toSheetRow(p) {
  return SHEET_COLUMNS.map(([, path, type]) => {
    const v = getPath(p, path);
    if (v == null) return "";
    if (type === "list") return v.join("\n");
    if (type === "bool") return v === true;
    if (type === "date") return String(v).slice(0, 10);
    return v;
  });
}

export function toSheetTable(prospects) {
  return [SHEET_COLUMNS.map(([h]) => h), ...prospects.map(toSheetRow)];
}

// Displayed cell text (as Sheets returns it) -> prospect objects. Columns
// are matched by header, so staff can reorder or add their own columns.
export function fromSheetTable(rows) {
  if (!rows?.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  const idx = SHEET_COLUMNS.map(([h]) => header.indexOf(h));
  const out = [];
  for (const row of rows.slice(1)) {
    if (!row.some((c) => String(c ?? "").trim())) continue;
    const p = { measurables: {}, stats: {}, commitment: {}, staff: {}, sources: [] };
    SHEET_COLUMNS.forEach(([, path, type], i) => {
      const raw = idx[i] >= 0 ? String(row[idx[i]] ?? "").trim() : "";
      let v = null;
      if (raw !== "") {
        if (type === "num" || type === "int") {
          const n = Number(raw.replace(/[,\s]/g, ""));
          v = Number.isFinite(n) ? (type === "int" ? Math.round(n) : n) : null;
        } else if (type === "bool") v = /^(true|yes|1|x)$/i.test(raw);
        else if (type === "list") v = raw.split(/\n|\s\|\s/).map((s) => s.trim()).filter(Boolean);
        else if (type === "date") {
          const d = new Date(raw);
          v = isNaN(d) ? raw : d.toISOString();
        } else v = raw;
      }
      if (type === "list" && v == null) v = [];
      setPath(p, path, v);
    });
    if (!p.name || !p.gradYear) continue;
    p.commitment.status = ["uncommitted", "committed", "unknown"].includes(String(p.commitment.status).toLowerCase())
      ? String(p.commitment.status).toLowerCase()
      : "unknown";
    out.push(p);
  }
  return out;
}

// Minimal RFC 4180 CSV parser (quoted fields may contain commas/newlines).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toCsvText(table) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return table.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
