// Glassbox agent service (DESIGN.md §5.1, §9).
//
// The public face of Glassbox: binds $PORT (default 8080) — on Bahaa's
// platform this is the process behind the intranet URL. It is the ONLY
// component that reads the database path/config and the LLM API keys;
// the sandbox sidecar it talks to (localhost) holds no secrets.
//
// Endpoints:
//   GET  /healthz  → { ok, planner, worker: { ok, ready, pool } }
//   POST /ask      → { question, user_id? }
//                    returns { answer_summary, figures, stats, planner }
//   GET  /         → the demo page

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqlTool } from "./sqltool.mjs";
import { WorkerClient } from "./workerClient.mjs";
import { createPlanner } from "./planner.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.GLASSBOX_DB_PATH || path.join(ROOT, "demo", "glassbox-demo.db");

const sql = new SqlTool(DB_PATH);
const worker = new WorkerClient();
const planner = createPlanner({ sql, worker });
const demoPage = fs.readFileSync(path.join(ROOT, "demo", "index.html"), "utf8");

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(new Error("invalid JSON body: " + e.message));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(demoPage);
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      let workerHealth = null;
      try {
        workerHealth = await worker.health();
      } catch (e) {
        workerHealth = { ok: false, ready: false, error: String(e && e.message ? e.message : e) };
      }
      return sendJson(res, 200, {
        ok: true,
        planner: planner.name,
        db: path.basename(DB_PATH),
        worker: workerHealth,
      });
    }
    if (req.method === "POST" && url.pathname === "/ask") {
      const body = await readBody(req);
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (!question) return sendJson(res, 400, { error: "question is required" });
      const t0 = Date.now();
      const result = await planner.ask(question, { userId: body.user_id });
      return sendJson(res, 200, { ...result, elapsed_ms: Date.now() - t0 });
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, () => {
  console.log(`[glassbox-agent] listening on port ${PORT} (planner=${planner.name}, db=${DB_PATH})`);
});
