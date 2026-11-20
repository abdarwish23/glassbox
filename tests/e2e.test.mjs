// End-to-end test: the real deployment path. Starts the whole product via
// `bash run.sh` (exactly as the platform does), then:
//   - GET /healthz is green and reports a ready worker pool
//   - GET / serves the demo page
//   - POST /ask with the canonical question returns >= 2 figures that pass
//     the shared validator, and the lag analysis reports the planted +2h lag
//   - 3 simultaneous /ask calls all succeed (pool=2 → the third queues)
//
// Run: node tests/e2e.test.mjs   (takes several minutes on a cold cache:
// run.sh warms a 2-worker pool, and each /ask consumes a worker.)

import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateFigures } from "../shared/validator.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18080;
const WORKER_PORT = 18079;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, "demo", "glassbox-demo.db");
const QUESTION =
  "Which KPIs are correlated, and does any KPI lead another? Show the correlation heatmaps, the lag analysis, and a map of the sites.";

// Fresh seed via run.sh: remove any existing demo DB first.
if (fs.existsSync(DB)) fs.unlinkSync(DB);

const env = {
  ...process.env,
  PORT: String(PORT),
  WORKER_PORT: String(WORKER_PORT),
  POOL_SIZE: "2",
};
const proc = spawn("bash", ["run.sh"], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
proc.stdout.on("data", (d) => process.stderr.write(`[run.sh] ${d}`));
proc.stderr.on("data", (d) => process.stderr.write(`[run.sh:err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function check(name, cond, extra = "") {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log(`  PASS ${name}`);
}

async function waitAgent(timeoutMs = 420_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const h = await (await fetch(`${BASE}/healthz`)).json();
      if (h.ok && h.worker && h.worker.ready) return { health: h, ms: Date.now() - t0 };
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("agent never became healthy");
    await sleep(2000);
  }
}

async function ask(question) {
  const r = await fetch(`${BASE}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const body = await r.json();
  return { status: r.status, body };
}

try {
  const { health, ms } = await waitAgent();
  console.log(`stack healthy in ${(ms / 1000).toFixed(1)}s via run.sh`);
  check("healthz green with ready worker pool", health.ok && health.worker.ready === true);
  check("demo planner active (no LLM keys in test env)", health.planner === "demo", `planner=${health.planner}`);

  const page = await (await fetch(`${BASE}/`)).text();
  check("demo page served at GET /", page.includes("Glassbox") && page.includes("Plotly"));

  const t0 = Date.now();
  const { status, body } = await ask(QUESTION);
  console.log(`/ask answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  check("/ask returns HTTP 200", status === 200, JSON.stringify(body).slice(0, 300));
  check("/ask returns >= 2 figures", Array.isArray(body.figures) && body.figures.length >= 2,
    `got ${body.figures?.length}`);
  const v = validateFigures(body.figures);
  check("all returned figures pass the shared validator", v.ok, v.errors.join("; "));
  check("answer summary mentions the analysed rows", /hourly rows/.test(body.answer_summary || ""));
  check(
    "planted +2h lag found (best_lag.lag_hours === 2)",
    body.stats?.best_lag?.lag_hours === 2,
    `best_lag=${JSON.stringify(body.stats?.best_lag)}`
  );
  check(
    "lag interpretation names the pair (throughput leads latency)",
    body.stats?.best_lag?.a === "throughput_mbps" && body.stats?.best_lag?.b === "latency_ms",
    JSON.stringify(body.stats?.best_lag)
  );
  const types = body.figures.flatMap((f) => f.data.map((t) => t.type));
  check("figures include heatmaps and a scattermap", types.includes("heatmap") && types.includes("scattermap"),
    types.join(","));

  console.log("concurrency smoke: 3 simultaneous /ask against pool=2…");
  const t1 = Date.now();
  const results = await Promise.all([ask(QUESTION), ask(QUESTION), ask(QUESTION)]);
  console.log(`3 concurrent /ask finished in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  results.forEach((r, i) => {
    check(`concurrent /ask #${i + 1} succeeded`, r.status === 200 && r.body.figures?.length >= 2,
      `status=${r.status}`);
    check(`concurrent /ask #${i + 1} also finds the +2h lag`, r.body.stats?.best_lag?.lag_hours === 2);
  });

  console.log(`\ne2e.test.mjs: ${passed} checks passed`);
} finally {
  try { process.kill(-proc.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} }, 5000).unref();
}
