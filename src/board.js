// The recruiting board: a JSON file of prospects that accumulates across
// searches. Re-finding a player merges new data instead of duplicating.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.RECRUIT_DATA_DIR ?? path.join(ROOT, "data");
const BOARD_FILE = path.join(DATA_DIR, "board.json");

export function loadConfig(file) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "default.json"), "utf8"));
  const localFile = file ?? path.join(ROOT, "config", "local.json");
  if (!fs.existsSync(localFile)) return base;
  return deepMerge(base, JSON.parse(fs.readFileSync(localFile, "utf8")));
}

function deepMerge(a, b) {
  if (typeof a !== "object" || typeof b !== "object" || !a || !b || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}

export function prospectKey(p) {
  const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${norm(p.name)}|${p.gradYear}|${norm(p.state)}`;
}

export function loadBoard() {
  if (!fs.existsSync(BOARD_FILE)) return { prospects: [], runs: [] };
  return JSON.parse(fs.readFileSync(BOARD_FILE, "utf8"));
}

export function saveBoard(board) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${BOARD_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, BOARD_FILE);
}

// Newer non-null values win; sources are unioned.
function mergeObj(oldObj = {}, newObj = {}) {
  const out = { ...oldObj };
  for (const [k, v] of Object.entries(newObj)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export function upsertProspect(board, p, runId) {
  const key = prospectKey(p);
  const now = new Date().toISOString();
  const existing = board.prospects.find((x) => prospectKey(x) === key);
  if (!existing) {
    board.prospects.push({ ...p, commitment: { ...p.commitment, verifiedAt: now }, id: key, firstSeen: now, updatedAt: now, runIds: [runId] });
    return "added";
  }
  Object.assign(existing, mergeObj(existing, { ...p, measurables: undefined, stats: undefined, commitment: undefined, sources: undefined }));
  existing.measurables = mergeObj(existing.measurables, p.measurables);
  existing.stats = mergeObj(existing.stats, p.stats);
  // Commitment is time-sensitive: the latest check always wins.
  existing.commitment = { ...p.commitment, verifiedAt: now };
  existing.sources = [...new Set([...(existing.sources ?? []), ...p.sources])];
  existing.updatedAt = now;
  existing.runIds = [...new Set([...(existing.runIds ?? []), runId])];
  return "updated";
}
