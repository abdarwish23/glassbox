// Worker pool for the sandbox sidecar (DESIGN.md §5.3, §8.6).
//
// Model: the pool keeps `size` Pyodide workers warm and ready. A run
// consumes a worker outright — after its single run the worker exits and a
// replacement starts warming in the background — so fresh state per run is
// structural (spike §5: a fresh instance sees nothing of the previous run),
// and the ~10–13 s respawn cost never lands in the request path unless the
// pool is fully drained, in which case runs queue (bounded wait, then a
// structured "busy" contract).
//
// Children are forked with an allowlisted environment: PATH/HOME and the
// proxy variables Pyodide needs for its one-time package fetch on this VM.
// Nothing else crosses — in particular no DB path, no LLM keys, no canaries.
// This process is the security boundary (DESIGN.md §3), so it must never
// hold secrets in the first place.

import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHILD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child.mjs");

const ENV_ALLOWLIST = [
  "PATH", "HOME", "NODE_USE_ENV_PROXY",
  "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
  "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  // CA bundle *paths* (not secrets): on this VM the egress proxy uses a
  // custom CA and Node's fetch ignores the proxy / fails TLS without them —
  // micropip's one-time plotly fetch depends on this (found empirically).
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];

export function childEnv() {
  const env = { GLASSBOX_WORKER_CHILD: "1" };
  for (const k of ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

function errorContract(type, message) {
  return { ok: false, figures: [], summary: {}, stdout: "", error: { type, message, traceback_tail: "" } };
}

export class WorkerPool {
  constructor({ size = 2, runTimeoutMs = 30_000, queueTimeoutMs = 120_000 } = {}) {
    this.size = size;
    this.runTimeoutMs = runTimeoutMs;
    this.queueTimeoutMs = queueTimeoutMs;
    this.readyWorkers = []; // [{child}]
    this.warming = 0;
    this.busy = 0;
    this.queue = []; // [{resolve, timer}]
    this.closed = false;
  }

  start() {
    for (let i = 0; i < this.size; i++) this.spawn();
  }

  spawn() {
    if (this.closed) return;
    this.warming++;
    let counted = true; // this child is included in `warming` until ready/dead
    const settleWarming = () => {
      if (counted) {
        counted = false;
        this.warming--;
      }
    };
    const child = fork(CHILD_PATH, [], { env: childEnv(), silent: true });
    child.stderr.on("data", (d) => process.stderr.write(`[worker] ${d}`));
    child.stdout.on("data", () => {}); // child should not print; drain anyway
    child.on("message", (msg) => {
      if (msg && msg.type === "ready") {
        settleWarming();
        this.offer({ child });
      } else if (msg && msg.type === "bootstrap_error") {
        settleWarming();
        process.stderr.write(`[worker] bootstrap failed: ${msg.message}\n`);
        try { child.kill("SIGKILL"); } catch {}
      }
    });
    child.on("exit", () => {
      // Died while still warming (never became ready): replace it.
      if (counted) {
        settleWarming();
        if (!this.closed) setTimeout(() => this.spawn(), 1000).unref();
      }
    });
  }

  offer(worker) {
    const waiter = this.queue.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(worker);
    } else {
      this.readyWorkers.push(worker);
    }
  }

  acquire() {
    const worker = this.readyWorkers.shift();
    if (worker) return Promise.resolve(worker);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error("queue_timeout"));
      }, this.queueTimeoutMs);
      waiter.timer.unref();
      this.queue.push(waiter);
    });
  }

  // Run one snippet. Always resolves with an execution contract (§6);
  // never rejects — failures are contracts with ok:false.
  async run(code, dataset, { timeoutMs } = {}) {
    let worker;
    try {
      worker = await this.acquire();
    } catch {
      return errorContract("BusyError", "sandbox pool is busy and the queue wait was exceeded; retry shortly");
    }
    this.busy++;
    const limit = timeoutMs ?? this.runTimeoutMs;
    try {
      return await new Promise((resolve) => {
        const { child } = worker;
        let settled = false;
        const finish = (contract) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(contract);
        };
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          finish(errorContract("TimeoutError", `sandbox run exceeded ${Math.round(limit / 1000)}s and the worker was recycled`));
        }, limit);
        timer.unref();
        child.on("message", (msg) => {
          if (msg && msg.type === "result") finish(msg.contract);
        });
        child.on("exit", () => {
          finish(errorContract("WorkerExitError", "sandbox worker exited before returning a result"));
        });
        try {
          child.send({ type: "run", id: Date.now(), code, dataset });
        } catch {
          finish(errorContract("WorkerExitError", "could not deliver the run to the sandbox worker"));
        }
      });
    } finally {
      this.busy--;
      // The worker has served its one run (or died): replace it so the
      // pool returns to full strength in the background.
      setTimeout(() => this.spawn(), 10).unref();
    }
  }

  health() {
    return {
      size: this.size,
      ready: this.readyWorkers.length,
      warming: this.warming,
      busy: this.busy,
      queued: this.queue.length,
    };
  }

  close() {
    this.closed = true;
    for (const w of this.readyWorkers) {
      try { w.child.kill("SIGKILL"); } catch {}
    }
    this.readyWorkers = [];
  }
}
