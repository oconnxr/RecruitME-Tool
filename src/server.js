// Web dashboard: serves the board UI and runs agent jobs with live
// progress over Server-Sent Events. No auth - it binds to localhost by
// default because every search spends API credits.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProspects, verifyCommitments } from "./agent.js";
import { loadBoard, loadConfig } from "./board.js";
import { rankBoard } from "./scoring.js";
import { toCsv } from "./report.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function startServer(port, configPath, host = process.env.HOST ?? "127.0.0.1") {
  let job = null; // { id, kind, events: [], done }
  const listeners = new Set();

  const emit = (e) => {
    const ev = { ...e, at: Date.now() };
    job.events.push(ev);
    for (const res of listeners) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  const startJob = (kind, fn) => {
    if (job && !job.done) return null;
    job = { id: `${kind}_${Date.now()}`, kind, events: [], done: false };
    fn()
      .catch((err) => emit({ type: "error", text: err?.message ?? String(err) }))
      .finally(() => {
        job.done = true;
        emit({ type: "jobEnd" });
      });
    return job.id;
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    });

  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const config = loadConfig(configPath);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        const page = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
        return send(res, 200, page.replace("<!--BOARD-->", ""), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/api/board") {
        const board = loadBoard();
        return send(res, 200, {
          program: config.program,
          prospects: rankBoard(board.prospects, config, { includeCommitted: true }),
          runs: board.runs.slice(-10).reverse(),
          job: job && { id: job.id, kind: job.kind, done: job.done },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/export.csv") {
        const ranked = rankBoard(loadBoard().prospects, config);
        res.setHeader("content-disposition", 'attachment; filename="recruiting-board.csv"');
        return send(res, 200, toCsv(ranked), "text/csv");
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const ev of job?.events ?? []) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        listeners.add(res);
        req.on("close", () => listeners.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/find") {
        const criteria = await readJson(req);
        const id = startJob("find", () => findProspects(criteria, config, { onEvent: emit }));
        return id ? send(res, 202, { id }) : send(res, 409, { error: "A job is already running." });
      }
      if (req.method === "POST" && url.pathname === "/api/verify") {
        const opts = await readJson(req);
        const id = startJob("verify", () => verifyCommitments(config, { olderThanDays: Number(opts.days ?? 7), limit: Number(opts.limit ?? 15), onEvent: emit }));
        return id ? send(res, 202, { id }) : send(res, 409, { error: "A job is already running." });
      }
      send(res, 404, { error: "Not found" });
    } catch (err) {
      send(res, 500, { error: err?.message ?? String(err) });
    }
  });

  server.listen(port, host, () => console.log(`Recruiting dashboard: http://${host}:${port}`));
  return server;
}
