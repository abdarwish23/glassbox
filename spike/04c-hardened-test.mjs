// 04c — Hardened-configuration test (driver).
// Spawns hardened-worker.mjs in four modes and checks, from the host side,
// which escapes survive each layer of mitigation.
// Run: node 04c-hardened-test.mjs
import { writeResult } from "./lib.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";

function runWorker(env, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const child = spawn("node", ["hardened-worker.mjs"], { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: code === null });
    });
  });
}

const CANARY = "CANARY_TEST_VALUE_9f3k2";
const PORT = 18713;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ canary: "HTTP_CANARY_7d2e" }));
});
await new Promise((r) => httpServer.listen(PORT, "127.0.0.1", r));

const modes = ["naive", "scrub", "full", "full-nocanary", "fullplus"];
const results = {};

for (const mode of modes) {
  const marker = `/tmp/glassbox_hardened_${mode}_marker`;
  const marker2 = `/tmp/glassbox_hardened_${mode}_reload_marker`;
  const ctypesMarker = `/tmp/glassbox_hardened_${mode}_ctypes_marker`;
  const leakFile = `/tmp/glassbox_hardened_${mode}_leak.txt`;
  for (const f of [marker, marker2, ctypesMarker, leakFile]) if (fs.existsSync(f)) fs.unlinkSync(f);

  // Pass through the host's network plumbing (proxy + CA) and HOME, as a real
  // service supervisor would. (Spike finding: without the proxy vars, the
  // worker's micropip cannot reach PyPI on this VM and warm-up crashes.)
  const passthrough = {};
  for (const k of ["http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HOME", "NODE_USE_ENV_PROXY", "all_proxy", "ALL_PROXY"]) {
    if (process.env[k]) passthrough[k] = process.env[k];
  }
  const env = {
    PATH: process.env.PATH,
    ...passthrough,
    SPIKE_MODE: mode,
    SPIKE_HTTP_PORT: String(PORT),
    SPIKE_MARKER: marker,
    SPIKE_MARKER2: marker2,
    SPIKE_CTYPES_MARKER: ctypesMarker,
    SPIKE_LEAK_FILE: leakFile,
  };
  if (mode !== "full-nocanary") env.GLASSBOX_CANARY = CANARY;

  const run = await runWorker(env);
  fs.writeFileSync(`logs/04c-${mode}-stderr.log`, run.stderr || "");
  fs.writeFileSync(`logs/04c-${mode}-stdout.log`, run.stdout || "");
  const lastLine = (run.stdout || "").trim().split("\n").pop();
  let worker;
  try {
    worker = JSON.parse(lastLine);
  } catch {
    worker = {
      driver_error:
        "exit code " + run.code + "; stderr tail: " + (run.stderr || "").slice(-500) + "; stdout tail: " + (run.stdout || "").slice(-200),
    };
  }
  results[mode] = {
    worker,
    host_checks: {
      os_system_marker_created_on_host: fs.existsSync(marker),
      reload_os_system_marker_created_on_host: fs.existsSync(marker2),
      ctypes_marker_created_on_host: fs.existsSync(ctypesMarker),
      printenv_leak_file_contents:
        fs.existsSync(leakFile) ? fs.readFileSync(leakFile, "utf8").trim().slice(0, 60) : null,
    },
  };
}

httpServer.close();
writeResult("logs/04c-hardened-test.json", { test: "04c-hardened-test", modes: results });
