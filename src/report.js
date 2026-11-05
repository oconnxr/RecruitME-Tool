import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Export the ranked board as CSV (for spreadsheets) or a standalone HTML page.

const COLUMNS = [
  ["rank", (p) => p.rank],
  ["score", (p) => p.ranking.score],
  ["measurables", (p) => p.ranking.measurablesScore],
  ["performance", (p) => p.ranking.performanceScore],
  ["confidence", (p) => p.ranking.confidence],
  ["name", (p) => p.name],
  ["class", (p) => p.gradYear],
  ["pos", (p) => p.primaryPosition],
  ["pos2", (p) => p.secondaryPosition],
  ["B/T", (p) => `${p.bats ?? "?"}/${p.throws ?? "?"}`],
  ["high_school", (p) => p.highSchool],
  ["city", (p) => p.city],
  ["state", (p) => p.state],
  ["travel_team", (p) => p.travelTeam],
  ["height_in", (p) => p.measurables?.heightIn],
  ["weight_lb", (p) => p.measurables?.weightLb],
  ["fb_velo", (p) => p.measurables?.fbVelo],
  ["fb_top", (p) => p.measurables?.fbTopVelo],
  ["exit_velo", (p) => p.measurables?.exitVelo],
  ["sixty", (p) => p.measurables?.sixty],
  ["if_velo", (p) => p.measurables?.ifVelo],
  ["of_velo", (p) => p.measurables?.ofVelo],
  ["c_velo", (p) => p.measurables?.cVelo],
  ["pop", (p) => p.measurables?.popTime],
  ["measured_at", (p) => p.measurables?.measuredAt],
  ["stat_season", (p) => p.stats?.season],
  ["AB", (p) => p.stats?.atBats],
  ["AVG", (p) => p.stats?.avg],
  ["OBP", (p) => p.stats?.obp],
  ["SLG", (p) => p.stats?.slg],
  ["IP", (p) => p.stats?.inningsPitched],
  ["ERA", (p) => p.stats?.era],
  ["K9", (p) => p.stats?.k9],
  ["BB9", (p) => p.stats?.bb9],
  ["commitment", (p) => p.commitment?.status],
  ["commit_checked", (p) => p.commitment?.verifiedAt?.slice(0, 10)],
  ["flags", (p) => p.ranking.flags.join("; ")],
  ["notes", (p) => p.scoutingNotes],
  ["sources", (p) => (p.sources ?? []).join(" ")],
];

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(ranked) {
  const head = COLUMNS.map(([h]) => h).join(",");
  const rows = ranked.map((p) => COLUMNS.map(([, f]) => csvCell(f(p))).join(","));
  return [head, ...rows].join("\n") + "\n";
}

export function toHtml(ranked) {
  // Reuse the dashboard page with the board embedded, so the file works
  // offline and can be emailed to the staff.
  const page = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const data = JSON.stringify(ranked).replace(/</g, "\\u003c");
  return page.replace("<!--BOARD-->", () => `<script>window.__BOARD__=${data};</script>`);
}
