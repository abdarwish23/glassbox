# Glassbox — Sandboxed Analytics Agent: Design Document

**Version:** 0.1 (approved in substance by Bahaa, 2026-11-19)
**Name:** **Glassbox** — "the visible sandbox": agent code runs sealed inside WebAssembly, and everything it does is observable. Chosen by Bahaa 2026-11-19 after a GitHub crowding check (chartsmith was the runner-up; faraday/terrarium/airlock/playpen were already occupied in adjacent niches — notably Cohere's terrarium, a Python sandbox for LLM data agents).
**One-liner:** An AI agent that fetches data from a database, runs real Python statistical analysis inside a pure-code WebAssembly sandbox, and returns Plotly JSON that the frontend renders — deployable on a Docker-less FaaS platform from a single `run.sh`.

---

## 1. Problem and constraints

Bahaa is building an AI agent that must:

- Fetch data from a database.
- Run **agent-written Python** for statistical analysis (first workload: **correlations** over daily/hourly time-series data, volume "in the hundreds" — hundreds of thousands of rows at most).
- Handle **geolocation data** (stated by Bahaa, 2026-11-19): latitude/longitude-bearing records (e.g. site/cell-level measurements) — spatial aggregation, clustering, and map visualisations are in scope (§8.5).
- Produce **Plotly figures as JSON**, rendered in the frontend by Plotly.js.
- Ideally also run shell-like commands, the way a coding agent does.

Deployment platform constraints (stated by Bahaa, 2026-11-19):

- **FaaS-style web application instance**: you select CPU and memory, provide a `.sh` file (`run.sh`) that deploys/starts the app in the instance.
- **No Docker** — no containers, and therefore no container-grade isolation, no root, no custom kernel features.
- Everything the sandbox needs must be installed and started by `run.sh` in user space.
- **Platform mechanics (confirmed by Bahaa, 2026-11-20):** deployment = select instance (CPUs, memory) → point the platform at the repo → supply the `run.sh`. The platform **clones the repo and runs `run.sh`**; all library installation happens inside `run.sh`. When it finishes, the platform provides a **local intranet shareable URL** used as the API endpoint the frontend consumes. His existing pattern on this platform is a LangChain **DeepAgent** backend deployed exactly this way. Consequence: everything Glassbox needs — agent service, SQL tool, sandbox workers — lives in the one repo and starts from the one `run.sh` inside the one instance (§9).

**Design consequence:** the sandbox must be *pure code* — isolation has to come from the runtime the code executes in, not from the operating system.

## 2. Decision: WebAssembly (Pyodide) sandbox

Two candidates were evaluated in brainstorm (2026-11-19):

| | A. Pyodide (Python in WASM) | B. Native CPython subprocess |
|---|---|---|
| Isolation | **By construction** — no filesystem, network, env or shell unless explicitly granted | By configuration — rlimits, scrubbed env, jailed cwd; same OS user as the app; network hard to cut without containers |
| Speed | ~2–5× slower, effectively single-threaded | Full native speed, all CPUs |
| Memory | WASM ceiling (GB-scale, but bounded) | Bounded only by instance RAM + rlimits |
| Packages | numpy, pandas, scipy, statsmodels, scikit-learn, plotly available in the Pyodide ecosystem (to be verified in Phase 0) | Anything on PyPI |
| Fit for correlations on ≤ ~500k rows | **Ample** — correlation is light compute | Ample |

**Decision: Option A (Pyodide).** The workload (correlations over daily/hourly series at this volume) does not need native speed, so we spend the difference on the strongest isolation available without Docker. Option B is retained as a documented fallback (§11) if Phase 0 shows a hard blocker (missing package, unacceptable load time, memory ceiling hit).

## 3. Threat model (honest)

- **Primary threat:** the agent makes mistakes, or is steered by malicious instructions hidden in data (prompt injection) into running harmful or wasteful code.
- **Assumed audience:** Bahaa and/or his team (trusted users). **Open question Q2** — if untrusted public users are ever in scope, this design must be revisited.
- **What the sandbox guarantees — CORRECTED by the Phase 0 spike (2026-11-20, see `spike/RESULTS.md` §4):** the earlier draft of this section claimed WASM alone prevents shell/process/network escapes. **That claim is falsified for a default Pyodide-in-Node embedding**: agent code escaped via `import js` (reached host `process.env` and `fetch`), `os.system` (backed by Node `child_process` — a real host shell), and `ctypes` (reachable even after import blocks, via attribute-crawling legitimately loaded modules). The corrected model:
  - **The worker process is the security boundary, not the WASM layer alone.** Agent code must be assumed able to run shell commands *inside the worker process*.
  - Therefore: the worker process holds **no secrets, ever** (the §4 rule "credentials only in the agent service" is now load-bearing, not hygiene); it runs as an unprivileged user with a scrubbed environment; workers are **disposable and recycled** (fresh worker per run or per small batch of runs).
  - Python-layer hardening (scrub host globals after load, purge + import-block `js`, patch `os.system`/`posix.system`, block `ctypes` after a warm-up exercise pass) is applied as **defence-in-depth** — it closes the easy escapes and raises the cost, but is not claimed to be airtight (the ctypes attribute-crawl survived it in the spike).
  - The pure-Python surface *is* well isolated (host files, env via Python APIs, subprocess module, urllib all blocked in tests); the escapes all went through the **host bridge**, which is why process-level separation is the real control.
  - **Residual risk, stated plainly:** worker and agent service run under the same OS user on this platform class, so a fully escaped run could attempt to read the agent service's memory via `/proc`. Mitigations available: secret values kept out of the worker's environment and filesystem reach, short-lived workers, and — if the platform ever allows it — a separate OS user for workers. This residual risk is accepted for the trusted-audience internal tool (§3 assumption) and would block an untrusted-public deployment.
- **What it does not guarantee:** the *host* services (agent service, SQL tool) are ordinary code and must be written carefully; a runaway analysis can still waste its own time/memory budget (mitigated by caps, §6); the agent can encode into its output figures any data it was legitimately given (acceptable — the requester is authorised for that data).
- **Positioning:** this is isolation strong enough for agent-generated code in an internal analytics tool. It is not a multi-tenant hostile-code platform, and the doc will not claim otherwise.

## 4. Architecture

```text
┌────────────┐   question    ┌──────────────────────────────────────────────┐
│  Frontend  │ ────────────▶ │              Agent service                    │
│ (Plotly.js)│               │  LLM loop · session state · tool dispatch     │
│            │ ◀──────────── │                                              │
└────────────┘  figures JSON └──────┬──────────────────┬────────────────────┘
                                    │                  │
                          ┌─────────▼────────┐  ┌──────▼───────────────────┐
                          │    SQL tool      │  │   Sandbox worker (Node)   │
                          │ (trusted code)   │  │   Pyodide / WASM          │
                          │ read-only user   │  │   pandas · scipy ·        │
                          │ parameterised    │  │   statsmodels · plotly    │
                          │ row/time limits  │  │   NO fs · net · env       │
                          └─────────┬────────┘  └──────▲───────────────────┘
                                    │ rows             │ df in · JSON out
                          ┌─────────▼────────┐         │
                          │     Database     │ ────────┘ (via agent service)
                          └──────────────────┘
```

Data flow for one analysis:

1. User asks a question in the frontend.
2. The agent (LLM loop in the agent service) plans: which data, which analysis.
3. The agent calls the **SQL tool** with a query. Trusted service code executes it against a **read-only** DB connection and returns rows (capped).
4. The agent writes Python analysis code and calls the **sandbox tool** with the code + a reference to the fetched data.
5. The sandbox worker loads the data as a ready-made `df`, runs the code, and returns the execution contract (§6): Plotly figure JSON(s), a stats summary, printed output, or a structured error.
6. The agent service **validates** the result (schema, sizes) and passes figures to the frontend; the agent narrates findings in text.
7. Frontend renders each figure with Plotly.js.

**The load-bearing rule:** database credentials and all secrets exist only in the agent service process. The sandbox receives *rows*, never credentials, never a connection string, never network access. The sandbox is a calculator, not a keyholder.

## 5. Components

### 5.1 Agent service
- Hosts the LLM loop and tool definitions; owns all secrets (LLM API key, DB credentials) via environment variables.
- Enforces global budgets per request: max SQL calls, max sandbox runs, max total rows, max wall-clock time.
- Validates every sandbox result before it reaches the frontend (§7).
- Language/framework: **open question Q3** (Python/FastAPI keeps one language end-to-end; TypeScript is equally viable — the sandbox worker is Node either way, communicating over localhost HTTP or stdio JSON-RPC).

### 5.2 SQL tool
- Read-only DB user; SELECT-only enforced twice: by DB grants *and* by a statement check in the tool (single statement, must start with SELECT/WITH, no DDL/DML keywords).
- Parameterised values wherever the query shape allows; the agent supplies SQL text, so the statement check + read-only grants are the real guardrails.
- Hard caps: max rows returned (default 500k), query timeout (default 30s), result size cap. Truncation is reported to the agent, never silent.
- Returns rows in a compact columnar payload (Arrow IPC or JSON columns) and stores the dataset under a short-lived handle the sandbox call can reference, so large data is not copied through the LLM context. **The LLM never sees raw rows beyond a small preview** (schema + first N rows + basic stats) — it writes code against the schema.

### 5.3 Sandbox worker (the core)
- A Node process hosting **Pyodide**. Pool of warm workers (default: 1 per ~1–1.5 GB of instance memory budget, sized at deploy time from the selected instance memory).
- **Fresh state per run:** each execution runs against a clean interpreter state (new Pyodide instance, or a verified state-reset); no variables, files or imports leak between runs or users. Restart cost is measured in Phase 0; if a fresh instance is too slow, the fallback is a worker-per-run process model with a warm spare.
- **Preloaded environment:** numpy, pandas, scipy, statsmodels, plotly (versions pinned; verified in Phase 0). The agent's code starts with `df` (the dataset), plus `pd`, `np`, `scipy`, `plotly` modules available.
- **I/O posture:** the WASM instance gets an empty in-memory filesystem and no *intended* network or environment access — but per the corrected §3, this is enforced as a layered posture (hardened embedding + secret-free, disposable worker process), not claimed as a WASM construction guarantee. Worker bootstrap order is empirical, from the spike: **load → exercise lazy import paths → scrub host globals → purge/import-block bridge modules → patch `os`/`posix` system calls → serve**.
- **Caps per run:** wall-clock timeout (default 30s, configurable), memory ceiling (worker is killed and respawned if exceeded), stdout cap, output JSON size cap (default ~5 MB per figure set, with a clear error telling the agent to aggregate/downsample).
- **Concurrency:** one run at a time per worker; excess runs queue with a short max wait, then a structured "busy" error.

### 5.4 Shell capability (Phase 2, deliberately not in MVP)
A general shell inside this platform cannot be made safe in pure code (it would run as the app's OS user). MVP therefore ships **without** a shell tool. Phase 2 options, in order of preference:
1. **Simulated shell** over the dataset/workspace: `ls`, `head`, `cat`, `grep`, `wc`, `sort`, `cut` implemented in service code against in-memory data — covers most of what an analytics agent actually uses a shell for.
2. **Allowlisted subprocess commands** (e.g. `python`, `date`) with scrubbed env, jailed cwd, rlimits and timeouts — only if a concrete need survives option 1.

### 5.5 Memory (agent layer — noted by Bahaa, 2026-11-20)

Long-term memory attaches at the **agent service layer**, never inside sandbox workers — workers are stateless and disposable by design, and that stays true. Concretely: the agent connects to **dhakira** (Bahaa's existing memory core, an MCP server built harness-agnostic for exactly this) and gains remember/recall across sessions: a user's preferred KPIs and regions, past analyses and their conclusions, schema knowledge (what a table/column means), and corrections. The sandbox still receives only rows + code per run and holds nothing between runs; memory reads/writes happen in the agent service, which is the component allowed credentials and network. No change to the security model — if anything it reinforces it: memory is one more thing the worker never touches. Wiring dhakira in is an integration step after the MVP core loop works, not an MVP blocker.

## 6. Execution contract

Sandbox input:

```json
{ "code": "<agent-written python>", "dataset_handle": "ds_…", "timeout_s": 30 }
```

Sandbox output (always this shape, success or failure):

```json
{
  "ok": true,
  "figures": [ { "data": […], "layout": {…} } ],        // Plotly figure JSON objects
  "summary": { "…": "agent-defined stats results (JSON-safe)" },
  "stdout": "…capped…",
  "error": null                                          // or {"type","message","traceback_tail"}
}
```

Contract rules for agent code (enforced + taught via the tool description):
- End by assigning a dict to `result` with optional `figures` (list of `fig.to_json()`-parsed objects) and `summary`.
- Figures must be built with plotly and converted via `json.loads(fig.to_json())` — the sandbox returns data, never raw strings of code.
- All summary values must be JSON-safe (floats/ints/strings/lists/dicts) — numpy scalars converted (the sandbox provides a `to_jsonable()` helper and applies it as a safety net).

## 7. Validation and the frontend

- The agent service validates each figure: parses as JSON, has a `data` array, trace types within an allowlist (scatter, bar, heatmap, histogram, box, line via scatter, etc.), total data points under a cap; oversized figures are rejected back to the agent with an instruction to aggregate or downsample.
- The frontend treats figure JSON as **data, never code**: `JSON.parse` → `Plotly.newPlot(div, fig.data, fig.layout)`. No `eval`, no HTML injection of payload strings.
- Plotly.js is loaded once by the frontend; figure JSON carries no scripts.

## 8. Statistics: the correlation suite (first workload)

The agent's system prompt and tool examples ship these patterns as the supported, honest ways to correlate daily/hourly series:

1. **Raw correlation** — Pearson (linear) and Spearman (rank/monotonic) matrices over the KPI columns; output as a Plotly **heatmap** + a ranked table of pairs with `r`, `p-value`, and `n`.
2. **Detrended correlation** — the default for hourly data. Raw hourly KPIs share the daily traffic cycle, so raw correlation confuses *seasonality* with *relationship* (two unrelated KPIs can show r ≈ 0.9 because both peak at the same hours). The honest versions: correlate first differences (hour-over-hour changes), or residuals after removing the hour-of-day profile. The agent must state which it used.
3. **Lagged cross-correlation** — for each pair, correlation at lags −24…+24 h, reporting the best lag: "A leads B by 2 h" is the root-cause-shaped answer in performance work. Output as a Plotly line chart of r vs lag.
4. **Discipline rules** taught to the agent: report `n` and p-values with every r; warn on small n; note that many pairs ⇒ some will look significant by chance (multiple comparisons); correlation is a hypothesis generator, not a cause claim.

## 8.5 Geolocation data

- **Data shape:** lat/lon columns ride along in the DataFrame like any other columns — no special storage needed. Distances via haversine (pure numpy); grid aggregation via geohash binning implemented in pure Python (no native dependency), with H3 as a Phase 0 check.
- **Visualisations:** Plotly map figures — `scattermap`/`scatter_map` (points coloured/sized by a KPI), `densitymap` (geographic heat), `choropleth` (per-area aggregates). **The map tiles load in the user's browser** (frontend has network; open-street-map style needs no Mapbox token) — the sandbox still needs no network: it only emits figure JSON containing coordinates and values.
- **Analysis patterns:** spatial clustering of poor/good performers (DBSCAN on coordinates via scikit-learn), per-grid-cell aggregation then correlation on the aggregates, distance-based questions (KPI vs distance bands). 
- **Phase 0 must verify:** plotly map-figure JSON generation inside Pyodide, and availability of geopandas/shapely/h3 in the pinned Pyodide set. If they are unavailable, the pure-Python fallbacks above (haversine + geohash + numpy gridding) cover the MVP geo scope without them — geo does **not** force the Option B fallback by itself.

## 8.6 Multi-user concurrency

Glassbox is multi-user by construction, not by later adaptation:

- **Isolation unit = one run, one worker.** Each analysis executes in its own sandbox worker with fresh state (proven in Phase 0: no variables, modules or files leak between runs). Two users' analyses cannot see each other's data or variables — datasets are passed by handle, namespaced per session/user, and expire.
- **Concurrency = pool size.** Workers are warm-pooled; a run takes the next free worker, and workers recycle in the background (clean worker ≈ 6 s, hidden by the pool). At ~0.85 GB per loaded worker (spike-measured), an instance with 4 GB of sandbox memory sustains ~3 concurrent analyses; 8 GB ≈ 6–7. Size the instance for the team's *simultaneous* analyses, not its headcount — analyses take seconds, so a pool of 3 serves a much larger team in practice.
- **Bursts queue, they don't crash.** When the pool is exhausted, runs wait in a queue with a visible position/timeout rather than failing or sharing a worker. Per-run caps (wall time, output size) stop one user's heavy job from starving everyone else.
- **Per-user database identity.** The SQL tool connects with the requesting user's own read-only DB credentials where the platform supports it, so database permissions — not agent code — decide who sees what. Dataset handles are bound to the user who created them.
- **Scaling path.** Stateless agent service + worker pool per instance; more instances behind the platform's routing if concurrency outgrows one box. The binding constraints at scale are instance memory (workers) and the LLM provider's rate limits — both are capacity knobs, not redesigns.

## 9. Deployment: `run.sh`

**Where the workers live — the question Bahaa asked directly (2026-11-20): inside the same instance.** The worker pool is not a separate service or fleet: the sandbox workers are **child processes of the app that `run.sh` starts**, on the same instance, sharing its selected CPU/memory budget. One repo, one `run.sh`, one instance, one intranet URL.

Process layout inside the instance:
- **Agent service** — the API the frontend calls (if Bahaa's DeepAgent pattern is reused: a Python/LangChain service). Holds the DB credentials and the LLM key.
- **Sandbox worker sidecar** — a small Node process hosting the Pyodide worker pool, listening on **localhost only** (never on the intranet URL). The agent service calls it over local HTTP. Keeping the sandbox in its *own process* is also what the corrected §3 model wants: the process boundary is the security boundary, the sidecar's environment is scrubbed and secret-free, and a crashed/escaped worker cannot take the agent service down with it.
- **Worker pool** — N Pyodide workers inside the sidecar, warmed at startup (§5.3 sizing: ~0.85 GB and ~1 CPU's worth of load work each).

`run.sh` responsibilities, in order:

`run.sh` (idempotent, fail-fast, logs each step) does:

1. Detect/install pinned runtimes into a local directory if not present (no root assumed): Node for the sandbox sidecar, plus Python if the agent service is a DeepAgent/LangChain backend.
2. Install dependencies: agent-service packages, sidecar packages, and the Pyodide Python package set. **All Python wheels — including plotly, which Pyodide only gets via micropip — are vendored in the repo** (a committed `vendor/` directory), per the Phase 0 finding: this removes the ~44 s first-run downloads, the ~6 s/interpreter plotly fetch, and any dependence on internet access at deploy or run time (open question Q1 becomes non-blocking).
3. Start the **sandbox sidecar first** and begin warming the worker pool in parallel.
4. Start the **agent service**, which binds the platform-provided port (e.g. `$PORT`) — this is the process behind the intranet URL. A supervisor loop restarts a dead sidecar/worker.
5. Health endpoint (`/healthz`) on the agent service reporting worker readiness, so the platform's checks pass only once Pyodide is warm; the port binds fast, readiness flips when the pool is warm.

**Sizing guidance:** Pyodide + pandas/scipy/statsmodels resident set is the memory floor (measure in Phase 0; plan ~1–1.5 GB per warm worker) plus headroom for the largest dataset (≤500k rows of hourly KPIs is tens of MB — comfortable). CPU count matters less: WASM analysis is effectively single-threaded, so prefer memory over extra CPUs when selecting the instance; extra CPUs help only via more parallel workers.

**Cold start:** first request pays Pyodide + package load (Phase 0 measures; expected seconds). Mitigation: workers warm at boot, before the health check passes.

**Filesystem:** assume ephemeral. Datasets are per-request and in-memory; nothing in the MVP needs persistence. (If the platform offers a persistent volume, it is unused in MVP.)

## 10. Failure modes and limits (stated plainly)

- **WASM memory ceiling / slow heavy compute:** accepted for MVP scope; the Option B fallback (§2) exists if a future workload (millions of rows, heavy ML) outgrows it.
- **Package availability:** if a needed Python package has no Pyodide build, it cannot be used in the sandbox — Phase 0 verifies the exact list before any commitment.
- **FaaS time limits:** unknown until Q1 is answered (max request/instance duration, idle kill). The design keeps every unit of work ≤ ~30–60s so it fits typical limits; long analyses would need a job/queue pattern (out of MVP scope).
- **State leakage between runs:** prevented by fresh-state-per-run (§5.3); covered by an acceptance test (§12).
- **Agent loops burning budget:** global per-request budgets (§5.1) + structured errors the agent can react to.

## 11. Fallback (Option B) — if Phase 0 blocks

Native CPython in a venv, one subprocess per run: scrubbed environment, jailed temp cwd, `resource.setrlimit` caps (CPU, address space, file size, process count), timeout with process-group kill, stdout/output caps, same execution contract (§6). Weaker isolation (same OS user, network not fully cut) — acceptable only for a trusted-audience internal tool, and the switch must be a conscious, recorded decision.

## 12. Build plan and acceptance tests

**Phase 0 — Spike (verify before building):**
- Pyodide loads with pinned pandas/scipy/statsmodels/plotly; measure cold load + warm run times.
- Correlation (Pearson + Spearman + lagged) over a synthetic 500k-row hourly dataset; measure time and memory.
- Geo check: generate a Plotly `scattermap` figure JSON in Pyodide from lat/lon data; check geopandas/shapely/h3 availability; validate the pure-Python geohash + haversine fallbacks.
- A hostile-code test: attempts to read env, open files, open a socket, spawn a process — all must fail.
- State-isolation test: run 1 defines a variable; run 2 must not see it.

**Phase 1 — MVP:** agent service + SQL tool + sandbox worker + one end-to-end flow (question → SQL → correlation heatmap + lag chart → frontend render), `run.sh`, health check.
Acceptance: the Phase 0 tests green in the deployed shape; a real question against a real (or realistic dummy) DB returns a correct, validated Plotly figure; oversized/unsafe outputs are rejected with agent-recoverable errors.

**Phase 2:** simulated shell (§5.4), more statistics patterns (regression summaries), dataset caching across a session.
**Phase 3:** hardening and polish — budgets UI, run logs/audit, package-set expansion process.

## 13. Open questions for Bahaa

- **Q1 — Platform specifics:** *mostly answered 2026-11-20* — repo + `run.sh` only; platform clones the repo, runs `run.sh`, exposes an intranet URL; instance = selected CPUs/memory; his existing pattern is a DeepAgent backend. Still unknown: internet access during/after `run.sh` (non-blocking — wheels are vendored), max request/instance duration, how the port is assigned, any persistent storage.
- **Q2 — Audience:** only you/your team, or wider? (Sets how hard §3 must be.)
- **Q3 — Agent service stack:** Python/FastAPI or TypeScript? And which LLM/API will the agent use? *(Context added 2026-11-20: Bahaa's existing agent pattern on this platform is a LangChain DeepAgent backend — if Glassbox follows it, the agent service is Python and the Pyodide sandbox runs as the Node sidecar of §9, which the design already accommodates.)*
- **Q4 — Database:** which engine (PostgreSQL, MySQL, BigQuery, …) and is a read-only user available?
- **Q5 — Shell:** is the simulated shell (§5.4 option 1) acceptable for Phase 2, or is there a concrete command need behind "run shell like you"?

---

*Status: approved in substance 2026-11-19 (Bahaa added the geolocation scope himself, §8.5, and directed "let's do that"). Phase 0 — the spike that exists to falsify the Pyodide assumption cheaply — is the authorised next step. Open questions in §13 remain open and do not block Phase 0; Q1/Q4 will matter at MVP/deployment time.*
