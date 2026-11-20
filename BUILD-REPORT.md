# Glassbox — Phase 1 MVP Build Report

**Date:** 2026-11-20 · **Environment:** Node v24.22.1, this VM · **Design:** [DESIGN.md](DESIGN.md) (v0.1, incl. corrected §3) · **Spike:** [spike/RESULTS.md](spike/RESULTS.md)

## Verdict

**Phase 1 MVP is built and working.** The full flow — question → read-only
SQL → Pyodide sandbox correlation suite → validated Plotly figures — runs
end-to-end via `bash run.sh`, and a clean-copy **platform simulation passes
(§6 below)**. All three test suites are green: **19 unit + 19 security +
16 end-to-end checks**, plus **10/10 platform-sim checks**.

## 1. What was built

| Component | Where | Notes |
|---|---|---|
| Sandbox worker sidecar | `worker/server.mjs` | Localhost-only HTTP: `/healthz`, `/datasets` (POST/GET/DELETE), `/run`. Holds no secrets; never reads DB or LLM config. |
| Worker pool | `worker/pool.mjs` | Keeps `POOL_SIZE` (default 2) Pyodide workers warm. **One worker = one run**, then it exits and a replacement warms in the background — fresh state per run is structural. Runs queue (bounded) when the pool is drained; per-run timeout kills + recycles the worker. Children are forked with an allowlisted env (PATH/HOME, proxy vars, CA-bundle paths — nothing else). |
| Pyodide child | `worker/child.mjs` | Spike bootstrap recipe: load → packages → plotly via micropip → **exercise** lazy paths → scrub host globals → purge + import-block `js`/`pyodide_js`/`subprocess`/`ctypes`/`_ctypes` → patch `os`/`posix` system calls → **neuter the ctypes module object in place** (see §4). Executes the §6 contract: code in → `{ok, figures, summary, stdout, error}` out; `df`, `pd`, `np`, `to_jsonable()` provided. |
| Dataset registry | `worker/datasets.mjs` | Columnar datasets under random handles, TTL expiry (default 10 min), ragged-column rejection at registration. |
| Figure validator | `shared/validator.mjs` | §7 rules: plain-object figures, top-level keys ⊆ {data, layout, frames}, trace-type allowlist (incl. `scattermap`/`densitymap`/`choropleth` family), per-figure point cap 200k, response cap 500k, per-figure size cap 5 MB — rejections carry agent-actionable reasons ("aggregate or downsample…"). |
| SQL tool | `agent/sqltool.mjs`, `agent/sql-runner.mjs` | Read-only by construction: single-statement check (must start with SELECT/WITH; any DDL/DML keyword anywhere rejects — kills the SQLite `WITH … DELETE` trick), DB opened `{readOnly: true}`, parameterised, row cap default 100k with truncation reported. Each query runs in a **throwaway child process** so the timeout (default 30 s) is enforced by SIGKILL (see §4). Backend: SQLite via `node:sqlite`; the `query()` interface is the seam for a future Postgres/MySQL adapter (DESIGN Q4 still open). |
| Agent service | `agent/server.mjs` | Binds `$PORT` (default 8080). `GET /healthz` (incl. worker readiness), `POST /ask`, `GET /` demo page. The only component that reads the DB path and LLM keys. |
| Planners | `agent/planner.mjs` | **Demo planner (default, fully working):** schema introspection → SQL fetch → dataset registration → generated sandbox code for the §8 suite (raw + detrended heatmaps, ranked detrended pairs with p-values, all-pairs lagged cross-correlation scan, per-site scattermap) → validated figures + a composed text summary. **LLM planner (working wiring):** tool-calling loop over the official `@anthropic-ai/sdk` / `openai` SDKs (selected by which key is set), tools `sql_query`/`run_python`, §8 discipline rules in the system prompt, figures validated per tool call with validation errors fed back to the model. **Not exercised live** — no API keys exist in this environment (see §5). |
| Demo data + page | `demo/seed.mjs`, `demo/index.html` | Deterministic seed: 30 sites × 60 days hourly = **43,200 rows**, 5 KPIs + lat/lon around Tokyo, shared daily cycle, `users` given an independent wander, and the plant: **each site's `latency_ms` is driven by its own `throughput_mbps` exactly 2 h earlier**. Demo page: prefilled canonical question, renders figures via Plotly.js (CDN — vendoring noted as production TODO). |
| Deployment | `run.sh` | Idempotent, fail-fast: `npm ci` when `node_modules` is absent → seed if DB absent → start sidecar under `env -i` with an allowlist → wait for a warm worker (≤300 s) → start the agent in the foreground. |

## 2. How to run it

```bash
bash run.sh                    # serves on $PORT (default 8080)
# or piecewise:  node demo/seed.mjs && node worker/server.mjs & node agent/server.mjs
node tests/unit.test.mjs       # 19 checks, ~2 s
node tests/security.test.mjs   # 19 checks, ~80 s (worker warm-up dominates)
node tests/e2e.test.mjs        # 16 checks, ~2 min (full stack via run.sh)
```

## 3. Test results (real output)

**Unit — 19/19 PASS (~1.3 s).** SQL tool rejects INSERT / DELETE /
multi-statement / `WITH … DELETE` / disguised DROP; parameterised SELECT
works; row cap truncates and reports; a runaway recursive-CTE aggregate is
terminated by the timeout; schema reads via `pragma_table_info`. Validator
accepts heatmap + scattermap, rejects a disallowed trace type, an oversized
figure (with the downsample instruction), unexpected top-level keys, and a
non-array payload. Registry: round-trip, TTL expiry, unknown handle, ragged
columns rejected.

**Security — 19/19 PASS (~82 s).** Sidecar started with a scrubbed env;
canary planted in the *test* (agent-position) env only. Hostile battery via
the real `/run` endpoint:

```
import_js            blocked: ImportError: blocked import: js
import_subprocess    blocked: ImportError: blocked import: subprocess
import_ctypes        blocked: ImportError: blocked import: ctypes
os_system            blocked: OSError: blocked by sandbox policy
os_popen             blocked: OSError: blocked by sandbox policy
os_getenv_canary     EXECUTED: None        (canary not visible — correct)
ctypes_crawl_cdll    blocked: OSError: ctypes foreign-function access is disabled
ctypes_crawl_printenv blocked: OSError: ctypes foreign-function access is disabled
```
No host marker files created; the canary string appears nowhere in any
response. Benign battery afterwards: pandas corr = 1.0, Spearman ≈ −1.0,
statsmodels OLS R² = 1.0, sklearn DBSCAN labels correct, heatmap +
scattermap figures returned. **Note:** the ctypes *attribute crawl*
(`numpy._core._internal.ctypes → CDLL(None).system`) — which **executed on
the host in the Phase 0 spike** despite import blocks — is **blocked here**
by neutering the shared ctypes module object in place (its
`CDLL`/`PyDLL`/`CFUNCTYPE` constructors replaced with stubs, `pythonapi`
removed) before purging it from `sys.modules`. This closes the specific
crawl the spike demonstrated; per §3 it remains defence-in-depth, not the
boundary — the boundary is still the secret-free, disposable worker
process.

**End-to-end — 16/16 PASS (~117 s).** Via `bash run.sh`: stack healthy in
**52.2 s** (warm caches), `/ask` answered in **2.2 s** with **4 figures**
(raw heatmap, detrended heatmap, lag chart, scattermap), all passing the
shared validator; **`best_lag = {a: throughput_mbps, b: latency_ms,
lag_hours: 2, r_at_best_lag: 0.99…, margin_over_lag_0: …}`** — the planted
+2 h lag found, correctly attributed. Concurrency smoke: 3 simultaneous
`/ask` against pool = 2 all succeeded in **62.3 s** (the third queued for a
recycled worker), each independently finding the +2 h lag.

## 4. Bugs found during the build (and fixed)

1. **JS `null` ≠ Python `None` across the Pyodide bridge** — setting a null
   dataset global produced `JsNull`, and `pd.DataFrame(JsNull)` failed
   every run. Fixed: the global is omitted when there is no dataset, and
   the preamble treats `JsNull` as empty.
2. **`import subprocess` survived the import block** — the exercise pass
   leaves `subprocess` cached in `sys.modules` (via sklearn/joblib), and
   cached modules bypass `meta_path` blockers. Fixed: blocked modules are
   also **purged** from `sys.modules` during hardening.
3. **Blocker raised `NameError` after `del` of its globals** — the blocker
   referenced a deleted global. Fixed: it carries the blocked tuple as an
   instance attribute.
4. **SQL timeout could not interrupt SQLite in-process** —
   `worker.terminate()` cannot stop a single long native `sqlite3_step`
   (an aggregate over an unbounded recursive CTE), and the stuck thread
   kept the process alive. Fixed: queries execute in a throwaway **child
   process**, timeout enforced by SIGKILL (verified by the unit test).
5. **Micropip failed under the scrubbed env on this VM** — Node's fetch
   needs `NODE_EXTRA_CA_CERTS` (the egress proxy's custom CA) in addition
   to the proxy vars (the spike's §6 note, one level deeper). Added the
   CA-bundle *paths* to the env allowlist in `pool.mjs` and `run.sh`.
6. **Lag-pair selection method** — picking the top *detrended* pair for
   lag analysis is methodologically wrong (first differences destroy lag
   structure in smooth signals; the first e2e run dutifully reported
   users↔throughput at lag 0). Fixed: the demo flow scans **all pairs**;
   a pair qualifies only if its best non-zero-lag |r| beats its lag-0 |r|
   by ≥ 0.03, and among qualifiers the strongest peak wins. The seed plant
   was also sharpened (latency follows the site's *own* throughput,
   noise included) so the relationship is pair-specific, not just
   cycle-shared.

## 5. What is stubbed, deferred, or untested

- **LLM planner: implemented, not live-tested.** The Anthropic/OpenAI
  tool-calling loops are complete code against the official SDKs (client
  surfaces verified at install), but no API keys exist in this environment,
  so no live LLM run has been made. The demo planner is the default and
  the fully tested path.
- **Wheel vendoring (production step, deliberately not done here):**
  Pyodide lock wheels are cached into `node_modules` on first warm-up and
  plotly is fetched by micropip per worker bootstrap (~6 s of the ~35 s
  warm-up). On Bahaa's platform this means first deploy needs internet;
  vendoring the wheels into the repo (DESIGN §9) removes that. Worker
  warm-up measured here: **~35 s** per worker (two warm in parallel in
  ~52–60 s of stack start).
- **Demo page loads Plotly.js from a CDN** — production frontends should
  bundle/vendor it.
- **SQLite only.** Postgres/MySQL adapters, per-user DB credentials
  (§8.6), dataset caching across a session, the Phase 2 simulated shell,
  and dhakira memory integration (§5.5) are designed, not built.
- **Timeouts/budgets:** per-run sandbox timeout and SQL timeout/row cap
  are enforced; the §5.1 global per-request budgets (max SQL calls / runs
  per question) are not yet enforced for the LLM planner (its loop is
  capped at 10 steps).

## 6. Platform simulation — PASS

Bahaa's platform ritual, simulated from a clean copy (2026-11-20):

**Setup.** The project was copied to `~/workspace/glassbox-platform-sim/`
excluding `node_modules`, all caches, and the seeded demo DB — i.e. only
what a git clone of the repo would contain (400 KB). From that copy,
`bash run.sh` was executed exactly as the platform would (fresh
`npm ci` from the lockfile, seed from scratch, sidecar start, agent start;
`PORT=18090`, `WORKER_PORT=18089`, `POOL_SIZE=2`).

**Run log (verbatim sequence):**
```
[glassbox run.sh] installing dependencies (npm ci)…
added 12 packages in 3s
[glassbox run.sh] seeding demo database at demo/glassbox-demo.db…
seeded 43200 rows (30 sites x 1440 hours) into demo/glassbox-demo.db
[glassbox run.sh] starting worker sidecar on 127.0.0.1:18089 (pool=2)…
[glassbox-worker] sidecar listening on http://127.0.0.1:18089 (pool=2, warming…)
[glassbox run.sh] worker pool is warm
[glassbox run.sh] starting agent service on port 18090…
[glassbox-agent] listening on port 18090 (planner=demo, db=demo/glassbox-demo.db)
```
(npm's local cache made `npm ci` fast on this VM; the genuinely cold part —
Pyodide wheel downloads into the fresh `node_modules` plus per-worker
micropip plotly installs — is inside the warm-up time below.)

**Checks against the cold-started instance — 10/10 PASS:**

| Check | Result |
|---|---|
| `/healthz` green, worker pool ready | PASS — green after **82.3 s** of polling from a cold copy (install + seed + 2-worker warm-up included) |
| Demo page served at `GET /` | PASS |
| `POST /ask` canonical question | PASS — HTTP 200 in **2.4 s**, 4 figures |
| Figures pass the shared validator | PASS |
| Planted +2 h lag found | PASS — `lag_hours === 2` |
| Lag pair correct | PASS — `throughput_mbps → latency_ms` |
| Hostile `os.system` via sidecar `/run` | PASS — blocked, contract `ok:false` |
| Host marker file | PASS — not created |
| Hostile `import js` via sidecar `/run` | PASS — blocked |

**Platform-sim verdict: PASS.** The cold run exposed no missing
dependencies, path assumptions, or port-handling problems; nothing needed
fixing in the real project as a result of the sim. The sim instance was
shut down after the checks.

## 7. Known limits

- Worker warm-up (~35 s/worker, micropip plotly fetch included) is the
  dominant cold-start cost; the pool hides it after boot, but a fully
  drained pool under burst load queues runs behind a recycle (~35 s).
  Vendored wheels (§5) are the fix.
- One run per worker means memory is ~0.85–1 GB per concurrent analysis
  (spike-measured) — size `POOL_SIZE` to the instance (§8.6).
- The corrected §3 residual risk stands: same-OS-user `/proc` snooping by
  a fully escaped run is not prevented by this design; the ctypes neuter
  (§3) raises the bar but the documented boundary remains the
  secret-free disposable worker process. Trusted internal audience only.
- SQLite is a file the agent process must be able to read; the SQL tool's
  interface is the seam for the production DB.
