// Glassbox sandbox worker sidecar (DESIGN.md §5.3, §9).
//
// A localhost-only HTTP service hosting the Pyodide worker pool and the
// dataset registry. It is a separate process from the agent service on
// purpose: the worker process is the security boundary (§3), so this
// process holds NO secrets — it never reads DB paths or LLM keys, and
// run.sh starts it with a scrubbed environment.
//
// API:
//   GET    /healthz            → { ok, ready, pool: {...} }
//   POST   /datasets           → { name, columnar } or { name, columns, rows }
//                                returns { handle, columns, rowCount }
//   GET    /datasets/:handle   → dataset metadata (404 if unknown/expired)
//   DELETE /datasets/:handle   → { removed }
//   POST   /run                → { code, dataset_handle?, dataset?, timeout_s? }
//                                returns the §6 execution contract

import http from "node:http";
import { WorkerPool } from "./pool.mjs";
import { DatasetRegistry, rowsToColumnar } from "./datasets.mjs";

const PORT = Number(process.env.WORKER_PORT || 8079);
const POOL_SIZE = Number(process.env.POOL_SIZE || 2);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 30_000);
const DATASET_TTL_MS = Number(process.env.DATASET_TTL_MS || 600_000);
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const pool = new WorkerPool({ size: POOL_SIZE, runTimeoutMs: RUN_TIMEOUT_MS });
const datasets = new DatasetRegistry({ ttlMs: DATASET_TTL_MS });
pool.start();

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
      if (total > MAX_BODY_BYTES) {
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
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      const p = pool.health();
      return sendJson(res, 200, { ok: true, ready: p.ready > 0, pool: p });
    }

    if (req.method === "POST" && url.pathname === "/datasets") {
      const body = await readBody(req);
      let columnar = body.columnar;
      if (!columnar && Array.isArray(body.columns) && Array.isArray(body.rows)) {
        columnar = rowsToColumnar(body.columns, body.rows);
      }
      if (!columnar) {
        return sendJson(res, 400, { error: "provide { columnar } or { columns, rows }" });
      }
      const info = datasets.put(body.name, columnar);
      return sendJson(res, 201, info);
    }

    const dsMatch = url.pathname.match(/^\/datasets\/(ds_[a-z0-9]+)$/);
    if (dsMatch && req.method === "GET") {
      const info = datasets.describe(dsMatch[1]);
      if (!info) return sendJson(res, 404, { error: "dataset handle unknown or expired" });
      return sendJson(res, 200, info);
    }
    if (dsMatch && req.method === "DELETE") {
      return sendJson(res, 200, { removed: datasets.remove(dsMatch[1]) });
    }

    if (req.method === "POST" && url.pathname === "/run") {
      const body = await readBody(req);
      if (typeof body.code !== "string" || body.code.trim() === "") {
        return sendJson(res, 400, { error: "code is required" });
      }
      let dataset = null;
      if (body.dataset_handle) {
        const entry = datasets.get(body.dataset_handle);
        if (!entry) {
          return sendJson(res, 200, {
            ok: false,
            figures: [],
            summary: {},
            stdout: "",
            error: {
              type: "DatasetNotFound",
              message: `dataset handle ${body.dataset_handle} is unknown or expired; re-run the SQL query to register it again`,
              traceback_tail: "",
            },
          });
        }
        dataset = entry.columnar;
      } else if (body.dataset) {
        dataset = body.dataset;
      }
      const timeoutMs = body.timeout_s ? Math.round(body.timeout_s * 1000) : undefined;
      const contract = await pool.run(body.code, dataset, { timeoutMs });
      return sendJson(res, 200, contract);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[glassbox-worker] sidecar listening on http://127.0.0.1:${PORT} (pool=${POOL_SIZE}, warming…)`);
});

function shutdown() {
  pool.close();
  datasets.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
