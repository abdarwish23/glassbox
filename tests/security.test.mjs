// Security regression test (DESIGN.md §3, corrected model).
//
// Starts the real worker sidecar as a subprocess with a scrubbed
// environment, plants a canary secret in THIS process's environment (the
// "agent service" position), and fires the spike's known escapes at the
// /run endpoint:
//   - import js (the JS bridge)
//   - os.system / os.popen (host shell)
//   - ctypes, direct import and via the attribute crawl that survived the
//     spike's hardening (numpy._core._internal.ctypes → CDLL → system)
//   - env canary reads (os.environ, and printenv via the crawl)
// Assertions: no host marker file is created, the canary never appears in
// any response, and a benign analytics battery still works afterwards
// (hardening must not break the product's real workload).
//
// Run: node tests/security.test.mjs   (takes ~2 min: workers are recycled
// per run, and each replacement pays the Pyodide warm-up.)

import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18101;
const BASE = `http://127.0.0.1:${PORT}`;
const CANARY = "CANARY_TEST_VALUE_9f3k2";
const MARKER = "/tmp/glassbox_sec_marker";
const MARKER2 = "/tmp/glassbox_sec_marker2";
const LEAK = "/tmp/glassbox_sec_leak";
for (const f of [MARKER, MARKER2, LEAK]) if (fs.existsSync(f)) fs.unlinkSync(f);

// The canary lives in the agent-side environment only.
process.env.GLASSBOX_CANARY = CANARY;

// Sidecar env: the same allowlist run.sh uses — crucially WITHOUT the canary.
const sidecarEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_USE_ENV_PROXY: "1",
  NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || "",
  SSL_CERT_FILE: process.env.SSL_CERT_FILE || "",
  http_proxy: process.env.http_proxy || "",
  https_proxy: process.env.https_proxy || "",
  HTTP_PROXY: process.env.HTTP_PROXY || "",
  HTTPS_PROXY: process.env.HTTPS_PROXY || "",
  WORKER_PORT: String(PORT),
  POOL_SIZE: "1",
};
const sidecar = spawn("node", ["worker/server.mjs"], { cwd: ROOT, env: sidecarEnv, stdio: ["ignore", "pipe", "pipe"] });
sidecar.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));

async function waitReady(timeoutMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const h = await (await fetch(`${BASE}/healthz`)).json();
      if (h.ready) return Date.now() - t0;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("sidecar never became ready");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function run(code) {
  const r = await fetch(`${BASE}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, timeout_s: 60 }),
  });
  return r.json();
}

let passed = 0;
function check(name, cond, extra = "") {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log(`  PASS ${name}`);
}

try {
  const warmMs = await waitReady();
  console.log(`sidecar ready in ${(warmMs / 1000).toFixed(1)}s`);

  // One run carrying the whole hostile battery (each attempt isolated in
  // try/except so one success can't mask another).
  const hostile = await run(`
import json
out = {}
def attempt(name, fn):
    try:
        out[name] = "EXECUTED: " + repr(fn())[:120]
    except Exception as e:
        out[name] = "blocked: " + type(e).__name__ + ": " + str(e)[:120]

attempt("import_js", lambda: __import__("js"))
attempt("import_subprocess", lambda: __import__("subprocess"))
attempt("import_ctypes", lambda: __import__("ctypes"))
import os
attempt("os_system", lambda: os.system("touch ${MARKER}"))
attempt("os_popen", lambda: os.popen("touch ${MARKER}"))
attempt("os_getenv_canary", lambda: os.getenv("GLASSBOX_CANARY"))
import numpy._core._internal as _int
attempt("ctypes_crawl_cdll", lambda: _int.ctypes.CDLL(None).system(b"touch ${MARKER2}"))
attempt("ctypes_crawl_printenv", lambda: _int.ctypes.CDLL(None).system(b"printenv GLASSBOX_CANARY > ${LEAK}"))
result = {"figures": [], "summary": out}
`);
  console.log("hostile battery summary:", JSON.stringify(hostile.summary, null, 1));
  check("hostile run itself completed (contract returned)", typeof hostile.ok === "boolean");
  for (const [name, outcome] of Object.entries(hostile.summary || {})) {
    if (name === "os_getenv_canary") {
      check(`canary not visible via os.getenv (${outcome})`, String(outcome).includes("None"));
    } else {
      check(`${name} blocked`, String(outcome).startsWith("blocked"), `→ ${outcome}`);
    }
  }
  check("no host marker from os.system/os.popen", !fs.existsSync(MARKER));
  check("no host marker from the ctypes crawl", !fs.existsSync(MARKER2));
  check("no env leak file from printenv crawl", !fs.existsSync(LEAK));
  check("canary value appears nowhere in the hostile response", !JSON.stringify(hostile).includes(CANARY));

  // Benign battery: the product's real workload must still work.
  const benign = await run(`
import pandas as pd, numpy as np, json
df2 = pd.DataFrame({"a": [1.0, 2.0, 3.0, 4.0], "b": [2.0, 4.0, 6.0, 8.0],
                    "lat": [35.67, 35.68, 34.69, 34.70], "lon": [139.65, 139.66, 135.50, 135.51]})
from scipy import stats
import statsmodels.api as sm
from sklearn.cluster import DBSCAN
import plotly.graph_objects as go, plotly.express as px
figs = [
    json.loads(go.Figure(data=go.Heatmap(z=[[1.0, 0.5], [0.5, 1.0]])).to_json()),
    json.loads(px.scatter_map(df2, lat="lat", lon="lon", map_style="open-street-map").to_json()),
]
result = {"figures": figs, "summary": {
    "corr": float(df2.corr().iloc[0, 1]),
    "spearman": float(stats.spearmanr([1,2,3,4,5],[5,4,3,2,1]).statistic),
    "ols_rsq": float(sm.OLS(np.arange(20, dtype=float) * 2 + 1, sm.add_constant(np.arange(20, dtype=float))).fit().rsquared),
    "dbscan": DBSCAN(eps=0.05, min_samples=2).fit(df2[["lat", "lon"]]).labels_.tolist(),
}}
`);
  check("benign run ok", benign.ok === true, JSON.stringify(benign.error || ""));
  check("benign pandas corr == 1.0", Math.abs(benign.summary.corr - 1.0) < 1e-9);
  check("benign spearman ≈ -1.0", Math.abs(benign.summary.spearman + 1.0) < 1e-9, `got ${benign.summary.spearman}`);
  check("benign statsmodels OLS R² == 1.0", Math.abs(benign.summary.ols_rsq - 1.0) < 1e-9);
  check("benign sklearn DBSCAN labels", benign.summary.dbscan.join() === "0,0,1,1");
  check("benign figures returned (heatmap + scattermap)", benign.figures.length === 2);

  console.log(`\nsecurity.test.mjs: ${passed} checks passed`);
} finally {
  sidecar.kill("SIGTERM");
  setTimeout(() => sidecar.kill("SIGKILL"), 3000).unref();
  for (const f of [MARKER, MARKER2, LEAK]) if (fs.existsSync(f)) fs.unlinkSync(f);
  delete process.env.GLASSBOX_CANARY;
}
