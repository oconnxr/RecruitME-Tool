#!/usr/bin/env node
// recruit - command line for the recruiting agent.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { findProspects, verifyCommitments } from "./agent.js";
import { loadBoard, loadConfig, saveBoard, upsertProspect, prospectKey } from "./board.js";
import { ProspectSchema } from "./schema.js";
import { toSheetTable, fromSheetTable, parseCsv, toCsvText } from "./sheet.js";
import { rankBoard } from "./scoring.js";
import { toCsv, toHtml } from "./report.js";

const HELP = `recruit <command> [options]

Commands:
  find      Run the agent to find uncommitted prospects and add them to the board
              --pos RHP,LHP     positions (RHP LHP C 1B 2B SS 3B MIF INF OF UTIL)
              --class 2027,2028 graduating classes
              --state TX,OK     states (default: config program.states)
              --min-fb 86       minimum fastball (pitchers)
              --min-ev 92       minimum exit velo (hitters)
              --count 20        how many players to look for
              --notes "..."     anything else (e.g. "strong academics, 3.5+ GPA")
  verify    Re-check commitment status for players on the board
              --days 7          only players not checked in this many days
              --limit 15        max players per run
  add       Import players from a JSON file (array of prospect records,
            same fields as the agent records; see src/schema.js)
              --file players.json
  sheet-export  Write the board in the Google Sheet "Players" layout
              --out players.csv | players.json (JSON = 2D array of cell values)
  sheet-import  Replace the board's players with the Sheet's contents (the
              Sheet is the source of truth, including staff edits)
              --file players.csv | values.json (2D array, header row first)
  rank      Print the ranked board
              --class, --state, --pos, --group pitcher|catcher|infield|outfield
              --top 25, --all (include committed players)
  export    Write the ranked board to a file (same filters as rank)
              --out board.csv | board.html
  serve     Start the web dashboard (default http://localhost:5178)
              --port 5178

Options for any command:  --config path/to/config.json`;

const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

function printEvent(e) {
  const out = {
    start: () => (e.verifying ? `Verifying ${e.verifying} players...` : "Searching..."),
    search: () => `  search: ${e.query}`,
    fetch: () => `  fetch:  ${e.url}`,
    text: () => `  > ${e.text.replace(/\n+/g, " ").slice(0, 200)}`,
    info: () => `  ! ${e.text}`,
    prospect: () => `  + ${e.outcome.padEnd(7)} ${e.prospect.name} (${e.prospect.gradYear} ${e.prospect.primaryPosition}, ${e.prospect.state ?? "?"}) [${e.prospect.commitment.status}]`,
    commitment: () => `  = ${e.name}: ${e.from} -> ${e.to}${e.school ? ` (${e.school})` : ""}`,
    done: () => null,
  }[e.type];
  const line = out?.();
  if (line) console.log(line);
}

function rankFromArgs(v, config) {
  return rankBoard(loadBoard().prospects, config, {
    includeCommitted: v.all,
    filters: { gradYear: v.class, state: v.state, position: v.pos, group: v.group },
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values: v } = parseArgs({
    args: rest,
    options: {
      pos: { type: "string" }, class: { type: "string" }, state: { type: "string" },
      group: { type: "string" }, "min-fb": { type: "string" }, "min-ev": { type: "string" },
      count: { type: "string" }, notes: { type: "string" }, days: { type: "string" },
      limit: { type: "string" }, top: { type: "string" }, all: { type: "boolean" },
      out: { type: "string" }, port: { type: "string" }, config: { type: "string" },
      file: { type: "string" },
    },
  });
  const config = loadConfig(v.config);

  switch (cmd) {
    case "find": {
      const r = await findProspects({
        positions: list(v.pos), gradYears: list(v.class)?.map(Number), states: list(v.state),
        minFbVelo: v["min-fb"] && Number(v["min-fb"]), minExitVelo: v["min-ev"] && Number(v["min-ev"]),
        count: v.count && Number(v.count), notes: v.notes,
      }, config, { onEvent: printEvent });
      console.log(`\nDone: ${r.added} added, ${r.updated} updated, ${r.rejected} rejected.`);
      if (r.summary) console.log(`\n${r.summary}`);
      console.log(`Tokens: ${r.usage.input} in (${r.usage.cacheRead} cached), ${r.usage.output} out. Run "recruit rank" to see the board.`);
      break;
    }
    case "verify": {
      const r = await verifyCommitments(config, { olderThanDays: Number(v.days ?? 7), limit: Number(v.limit ?? 15), onEvent: printEvent });
      console.log(`\nChecked ${r.checked}, ${r.changed} changed status.`);
      break;
    }
    case "add": {
      if (!v.file) throw new Error("add needs --file players.json");
      const items = JSON.parse(fs.readFileSync(v.file, "utf8"));
      const board = loadBoard();
      const runId = `import_${Date.now()}`;
      const counts = { added: 0, updated: 0, rejected: 0, statusChanges: 0 };
      for (const [i, item] of (Array.isArray(items) ? items : [items]).entries()) {
        const parsed = ProspectSchema.safeParse(item);
        if (!parsed.success) {
          counts.rejected++;
          console.log(`  x #${i + 1} ${item?.name ?? "?"}: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
          continue;
        }
        const before = board.prospects.find((x) => prospectKey(x) === prospectKey(parsed.data))?.commitment?.status;
        const outcome = upsertProspect(board, parsed.data, runId);
        counts[outcome]++;
        const changed = before && before !== parsed.data.commitment.status;
        if (changed) counts.statusChanges++;
        console.log(`  + ${outcome.padEnd(7)} ${parsed.data.name} [${changed ? `${before} -> ` : ""}${parsed.data.commitment.status}]`);
      }
      board.runs.push({ id: runId, at: new Date().toISOString(), source: v.file, ...counts });
      saveBoard(board);
      console.log(`\n${counts.added} added, ${counts.updated} updated, ${counts.statusChanges} status changes, ${counts.rejected} rejected.`);
      break;
    }
    case "sheet-export": {
      const out = v.out ?? "players.csv";
      const table = toSheetTable(loadBoard().prospects);
      fs.writeFileSync(out, out.endsWith(".json") ? JSON.stringify(table) : toCsvText(table));
      console.log(`Wrote ${table.length - 1} players to ${out}`);
      break;
    }
    case "sheet-import": {
      if (!v.file) throw new Error("sheet-import needs --file");
      const text = fs.readFileSync(v.file, "utf8");
      let table = v.file.endsWith(".json") ? JSON.parse(text) : parseCsv(text);
      if (table && !Array.isArray(table) && Array.isArray(table.values)) table = table.values; // raw get_values reply
      const prospects = fromSheetTable(table);
      const board = loadBoard();
      for (const p of prospects) p.id = p.id || prospectKey(p);
      board.prospects = prospects;
      board.runs.push({ id: `sheet_${Date.now()}`, at: new Date().toISOString(), source: "sheet-import", players: prospects.length });
      saveBoard(board);
      console.log(`Loaded ${prospects.length} players from the Sheet.`);
      break;
    }
    case "rank": {
      const ranked = rankFromArgs(v, config).slice(0, Number(v.top ?? 25));
      if (!ranked.length) return console.log('Board is empty. Run "recruit find" first.');
      const blank = (row) => Object.fromEntries(Object.entries(row).map(([k, x]) => [k, x ?? ""]));
      console.table(ranked.map((p) => blank({
        "#": p.rank, score: p.ranking.score, name: p.name, cls: p.gradYear, pos: p.primaryPosition,
        st: p.state, FB: p.measurables?.fbVelo, EV: p.measurables?.exitVelo, "60yd": p.measurables?.sixty,
        meas: p.ranking.measurablesScore, perf: p.ranking.performanceScore, conf: `${p.ranking.confidence}%`,
        status: p.commitment?.status, flags: p.ranking.flags.join(", "),
      })));
      break;
    }
    case "export": {
      const out = v.out ?? "board.csv";
      const ranked = rankFromArgs(v, config);
      fs.writeFileSync(out, out.endsWith(".html") ? toHtml(ranked) : toCsv(ranked));
      console.log(`Wrote ${ranked.length} players to ${out}`);
      break;
    }
    case "serve": {
      const { startServer } = await import("./server.js");
      startServer(Number(v.port ?? process.env.PORT ?? 5178), v.config);
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
