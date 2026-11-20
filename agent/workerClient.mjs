// HTTP client for the sandbox worker sidecar, used by the agent service.
// The sidecar listens on localhost only (DESIGN.md §9); this client is the
// agent's "sandbox tool" (§4 step 4/5).

export class WorkerClient {
  constructor(baseUrl = process.env.WORKER_URL || "http://127.0.0.1:8079") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async health() {
    const r = await fetch(`${this.baseUrl}/healthz`);
    if (!r.ok) throw new Error(`worker sidecar health check failed: HTTP ${r.status}`);
    return r.json();
  }

  async putDataset(name, columnar) {
    const r = await fetch(`${this.baseUrl}/datasets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, columnar }),
    });
    if (!r.ok) throw new Error(`dataset registration failed: HTTP ${r.status} ${await r.text()}`);
    return r.json(); // { handle, columns, rowCount }
  }

  async run(code, { datasetHandle, timeoutS } = {}) {
    const r = await fetch(`${this.baseUrl}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, dataset_handle: datasetHandle, timeout_s: timeoutS }),
    });
    if (!r.ok) throw new Error(`sandbox run failed: HTTP ${r.status} ${await r.text()}`);
    return r.json(); // execution contract (§6)
  }
}
