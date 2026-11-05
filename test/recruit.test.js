import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RECRUIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recruit-test-"));
const { loadConfig, loadBoard, saveBoard, upsertProspect } = await import("../src/board.js");
const { scoreProspect, rankBoard, seniorClass } = await import("../src/scoring.js");
const { findProspects } = await import("../src/agent.js");
const { toCsv, toHtml } = await import("../src/report.js");

const config = loadConfig();
const NOW = new Date("2026-11-05");
const nulls = (keys) => Object.fromEntries(keys.map((k) => [k, null]));
const M = ["fbVelo","fbTopVelo","exitVelo","sixty","ifVelo","ofVelo","cVelo","popTime","heightIn","weightLb","measuredAt"];
const S = ["season","atBats","avg","obp","slg","hr","sb","inningsPitched","era","k9","bb9","whip"];

function player(over = {}) {
  return {
    name: "Test Player", gradYear: 2027, primaryPosition: "RHP", secondaryPosition: null,
    bats: "R", throws: "R", highSchool: "Central HS", city: "Austin", state: "TX", travelTeam: null,
    measurables: { ...nulls(M), ...over.measurables },
    stats: { ...nulls(S), ...over.stats },
    commitment: { status: "uncommitted", school: null, evidence: "PBR profile lists uncommitted", checkedUrl: null, ...over.commitment },
    scoutingNotes: null, sources: ["https://example.com/p"],
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !["measurables","stats","commitment"].includes(k))),
  };
}

test("senior class rolls over in August", () => {
  assert.equal(seniorClass(new Date("2026-11-05")), 2027);
  assert.equal(seniorClass(new Date("2026-05-01")), 2026);
});

test("harder-throwing pitcher ranks higher", () => {
  const a = scoreProspect(player({ measurables: { fbVelo: 90 } }), config, NOW);
  const b = scoreProspect(player({ measurables: { fbVelo: 84 } }), config, NOW);
  assert.ok(a.score > b.score);
  assert.equal(a.group, "pitcher");
});

test("younger class gets an easier velo benchmark", () => {
  const senior = scoreProspect(player({ gradYear: 2027, measurables: { fbVelo: 86 } }), config, NOW);
  const soph = scoreProspect(player({ gradYear: 2029, measurables: { fbVelo: 86 } }), config, NOW);
  assert.ok(soph.measurablesScore > senior.measurablesScore);
});

test("lower-is-better metrics score correctly", () => {
  const fast = scoreProspect(player({ primaryPosition: "OF", measurables: { sixty: 6.5 } }), config, NOW);
  const slow = scoreProspect(player({ primaryPosition: "OF", measurables: { sixty: 7.3 } }), config, NOW);
  assert.ok(fast.measurablesScore > slow.measurablesScore);
});

test("missing data lowers confidence and score; unknown commitment flagged", () => {
  const full = scoreProspect(player({ measurables: { fbVelo: 88, fbTopVelo: 90, heightIn: 74 }, stats: { inningsPitched: 40, era: 1.5, k9: 11, bb9: 2.5, whip: 1.0 } }), config, NOW);
  const thin = scoreProspect(player({ measurables: { fbVelo: 88 }, commitment: { status: "unknown" } }), config, NOW);
  assert.ok(full.confidence > thin.confidence);
  assert.ok(thin.flags.includes("commitment unverified"));
});

test("small stat samples carry less weight", () => {
  const meas = { exitVelo: 90 };
  const big = scoreProspect(player({ primaryPosition: "SS", measurables: meas, stats: { atBats: 80, obp: 0.58, slg: 0.85, avg: 0.48 } }), config, NOW);
  const small = scoreProspect(player({ primaryPosition: "SS", measurables: meas, stats: { atBats: 8, obp: 0.58, slg: 0.85, avg: 0.48 } }), config, NOW);
  assert.ok(big.score > small.score);
  assert.ok(small.flags.includes("small stat sample"));
});

test("rankBoard excludes committed players by default", () => {
  const ranked = rankBoard([
    player({ name: "A", measurables: { fbVelo: 92 }, commitment: { status: "committed", school: "State" } }),
    player({ name: "B", measurables: { fbVelo: 85 } }),
  ], config, { now: NOW });
  assert.deepEqual(ranked.map((p) => p.name), ["B"]);
  assert.equal(rankBoard([player({ commitment: { status: "committed" } })], config, { includeCommitted: true, now: NOW }).length, 1);
});

test("upsert merges instead of duplicating", () => {
  const board = { prospects: [], runs: [] };
  assert.equal(upsertProspect(board, player({ measurables: { fbVelo: 86 } }), "r1"), "added");
  assert.equal(upsertProspect(board, player({ measurables: { exitVelo: 95 }, sources: ["https://example.com/q"] }), "r2"), "updated");
  assert.equal(board.prospects.length, 1);
  const p = board.prospects[0];
  assert.equal(p.measurables.fbVelo, 86);
  assert.equal(p.measurables.exitVelo, 95);
  assert.equal(p.sources.length, 2);
});

test("exports escape CSV and embed HTML safely", () => {
  const ranked = rankBoard([player({ name: 'O"Neil, Jr', scoutingNotes: "</script><b>$&" })], config, { now: NOW });
  const csv = toCsv(ranked);
  assert.match(csv, /"O""Neil, Jr"/);
  const html = toHtml(ranked);
  assert.ok(!html.includes("</script><b>"));
  assert.ok(html.includes("window.__BOARD__="));
  assert.ok(html.includes("$&"));
});

// A scripted fake of client.beta.messages.stream, to exercise the agent
// loop (tool validation, pause_turn, persistence) without the network.
function fakeClient(turns) {
  const requests = [];
  return {
    requests,
    beta: { messages: { stream(params) {
      requests.push(structuredClone(params));
      const msg = turns.shift();
      return {
        on(ev, fn) { if (ev === "contentBlock") msg.content.forEach(fn); return this; },
        finalMessage: async () => ({ usage: { input_tokens: 10, output_tokens: 5 }, ...msg }),
      };
    } } },
  };
}

test("agent loop records valid prospects, rejects invalid, resumes pause_turn", async () => {
  saveBoard({ prospects: [], runs: [] });
  const good = player({ name: "Jake Real", measurables: { fbVelo: 88 } });
  const client = fakeClient([
    { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "2027 RHP Texas uncommitted" } }] },
    { stop_reason: "tool_use", content: [
      { type: "tool_use", id: "t1", name: "record_prospect", input: good },
      { type: "tool_use", id: "t2", name: "record_prospect", input: { name: "Bad" } },
    ] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t3", name: "finish_search", input: { summary: "Covered TX." } }] },
  ]);
  const events = [];
  const r = await findProspects({ positions: ["RHP"], states: ["TX"], count: 5 }, config, { client, onEvent: (e) => events.push(e) });

  assert.equal(r.added, 1);
  assert.equal(r.rejected, 1);
  assert.equal(r.summary, "Covered TX.");
  assert.equal(client.requests.length, 3);
  // pause_turn: assistant content re-sent with no extra user message
  assert.equal(client.requests[1].messages.at(-1).role, "assistant");
  // invalid input came back as an error tool_result
  const results = client.requests[2].messages.at(-1).content;
  assert.equal(results.find((x) => x.tool_use_id === "t2").is_error, true);
  assert.ok(events.some((e) => e.type === "search"));
  const board = loadBoard();
  assert.equal(board.prospects[0].name, "Jake Real");
  assert.equal(board.runs.length, 1);
  assert.equal(client.requests[0].fallbacks, "default");
});

test("one strong number can't outrank a complete strong profile", () => {
  const heightOnly = scoreProspect(player({ measurables: { heightIn: 78 } }), config, NOW);
  const complete = scoreProspect(player({ measurables: { fbVelo: 87, fbTopVelo: 89, heightIn: 73 }, stats: { inningsPitched: 45, era: 1.8, k9: 11, bb9: 2.5, whip: 1.0 } }), config, NOW);
  const nothing = scoreProspect(player(), config, NOW);
  assert.ok(complete.score > heightOnly.score);
  assert.equal(nothing.score, config.ranking.priorScore);
});

test("Sheet layout round-trips a player exactly", async () => {
  const { toSheetTable, fromSheetTable, parseCsv, toCsvText } = await import("../src/sheet.js");
  const p = { ...player({ name: 'Al "Ace" Smith, Jr', measurables: { fbVelo: 88.5, heightIn: 74 }, stats: { avg: 0.412, atBats: 60 } }),
    id: "x|2027|tx", sources: ["https://a.example/1", "https://b.example/2"], scoutingNotes: "Line one\nline two" };
  const [back] = fromSheetTable(parseCsv(toCsvText(toSheetTable([p]))));
  for (const k of ["name", "gradYear", "primaryPosition", "state", "scoutingNotes", "id"]) assert.equal(back[k], p[k]);
  assert.deepEqual(back.measurables, p.measurables);
  assert.deepEqual(back.stats, p.stats);
  assert.deepEqual(back.sources, p.sources);
  assert.equal(back.commitment.status, "uncommitted");
  // Columns are matched by header, so a reordered Sheet with extra columns still reads.
  const table = toSheetTable([p]);
  const reordered = table.map((r) => ["staff note", ...r.slice().reverse()]);
  reordered[0][0] = "Coach notes";
  assert.equal(fromSheetTable(reordered)[0].measurables.fbVelo, 88.5);
});

test("staff columns round-trip and survive an agent update", async () => {
  const { toSheetTable, fromSheetTable } = await import("../src/sheet.js");
  const p = { ...player({ name: "Staff Test" }), id: "stafftest|2027|tx", staff: { priority: "A", contacted: true, coach: "Coach O", nextStep: "Call Monday", notes: "Loved the arm" } };
  const table = toSheetTable([p]);
  table[1] = table[1].map((c) => (c === true ? "TRUE" : c)); // Sheets displays checkboxes as TRUE/FALSE
  const [back] = fromSheetTable(table);
  assert.deepEqual(back.staff, p.staff);
  const board = { prospects: [back], runs: [] };
  upsertProspect(board, player({ name: "Staff Test", measurables: { fbVelo: 90 } }), "r9");
  assert.deepEqual(board.prospects[0].staff, p.staff);
  assert.equal(board.prospects[0].measurables.fbVelo, 90);
});
