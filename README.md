# Glassbox — the visible sandbox

An AI analytics agent that fetches data from a database with a read-only SQL
tool, runs real Python statistical analysis inside a pure-code WebAssembly
(Pyodide) sandbox, and returns Plotly figures as JSON that a frontend renders
with Plotly.js. It deploys on a Docker-less FaaS platform from a single
`run.sh`: one repo, one instance, one URL — agent service, SQL tool, and the
sandbox worker pool all live in the same instance.

See [DESIGN.md](DESIGN.md) for the full design (including the threat model
and the Phase 0 spike findings that corrected it) and
[BUILD-REPORT.md](BUILD-REPORT.md) for what is built, tested, and deferred.

## Quickstart

```bash
bash run.sh
# → installs deps, seeds the demo DB if absent, warms the sandbox pool,
#   then serves on $PORT (default 8080)
open http://localhost:8080/        # demo page
curl localhost:8080/healthz
curl -X POST localhost:8080/ask -H 'content-type: application/json' \
  -d '{"question": "Which KPIs are correlated, and does any KPI lead another?"}'
```

No API keys are needed for the demo: without `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` the agent uses a deterministic demo planner that runs the
correlation suite (raw + detrended heatmaps, ranked pairs, lagged
cross-correlation scan, site map) against the bundled demo database
(30 sites × 60 days of hourly KPIs, with a planted throughput→latency +2h
lag that the analysis finds).

## Architecture

```
Frontend (Plotly.js) ──question──▶ Agent service  (binds $PORT, holds ALL secrets)
                                     │  planner: demo | LLM (Anthropic/OpenAI SDK)
                                     │  tools: sql_query · run_python
                                     ├──▶ SQL tool ──▶ Database (read-only)
                                     │     single SELECT only, row cap,
                                     │     timeout via killable runner process
                                     └──▶ Worker sidecar (localhost only, NO secrets)
                                            Pyodide worker pool — one fresh
                                            worker per run, recycled after
                                            each run; datasets by handle
```

The load-bearing rule: **database credentials and LLM keys exist only in
the agent service process.** The sandbox receives rows, never credentials,
never a connection string. The sandbox is a calculator, not a keyholder.

## API

Agent service:

| Endpoint | Description |
|---|---|
| `GET /healthz` | `{ ok, planner, db, worker: { ok, ready, pool } }` |
| `POST /ask` | `{ question, user_id? }` → `{ answer_summary, figures, stats, planner, elapsed_ms }` — figures are validator-approved Plotly JSON |
| `GET /` | Demo page (question box, renders figures with Plotly.js) |

Worker sidecar (localhost only — not part of the public surface):

| Endpoint | Description |
|---|---|
| `GET /healthz` | Pool readiness |
| `POST /datasets` | Register a columnar dataset → `{ handle, columns, rowCount }` (handles expire) |
| `POST /run` | `{ code, dataset_handle?, timeout_s? }` → the execution contract `{ ok, figures, summary, stdout, error }` |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Agent service port (platform-provided on the FaaS) |
| `WORKER_PORT` | `8079` | Sidecar port (localhost) |
| `POOL_SIZE` | `2` | Warm Pyodide workers (~0.85–1 GB RAM each) |
| `GLASSBOX_DB_PATH` | `demo/glassbox-demo.db` | SQLite database for the SQL tool |
| `RUN_TIMEOUT_MS` | `30000` | Per-run sandbox wall-clock cap |
| `DATASET_TTL_MS` | `600000` | Dataset handle lifetime |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | If set, the LLM planner replaces the demo planner |
| `GLASSBOX_LLM_MODEL` | `claude-sonnet-4-5` / `gpt-4o` | Model for the LLM planner |

## Security model (summary)

The worker **process** is the security boundary — not the WASM layer alone
(the Phase 0 spike falsified the stronger claim; see DESIGN.md §3 and
`spike/RESULTS.md`). Workers hold no secrets, run with a scrubbed
allowlisted environment, serve exactly one run, and are recycled. Inside
the sandbox, defence-in-depth hardening closes the JS bridge
(`import js` blocked and purged), patches `os.system`/`os.popen`, blocks
`subprocess`/`ctypes` imports, and neuters the `ctypes` module object in
place (the attribute-crawl route the spike found). A security regression
suite (`tests/security.test.mjs`) exercises all of these against the real
endpoint. Residual risk, stated plainly in the design: agent and worker run
under the same OS user, so this suits a trusted internal audience — it is
not a hostile multi-tenant platform.

## Project layout

```
agent/    agent service: server, planner (demo + LLM), SQL tool, worker client
worker/   sandbox sidecar: HTTP server, worker pool, Pyodide child, datasets
shared/   figure validator (trace allowlist, point/size caps)
demo/     seed script (demo SQLite DB) + demo page
tests/    unit, security, and end-to-end suites
spike/    Phase 0 verification spike and its RESULTS.md
run.sh    the whole deployment in one script
```

## Tests

```bash
node tests/unit.test.mjs       # SQL guardrails, validator, dataset registry
node tests/security.test.mjs   # hostile-code regression against /run
node tests/e2e.test.mjs        # full stack via run.sh, incl. concurrency
```

## Current limits / TODO

- **Wheel vendoring**: Pyodide lock wheels and the plotly wheel are fetched
  on first worker warm-up (cached in `node_modules` afterwards). Production
  deployment should vendor them into the repo so `run.sh` needs no internet
  (DESIGN.md §9). The demo page likewise loads Plotly.js from a CDN;
  production frontends should bundle it.
- **Database**: SQLite (via `node:sqlite`) is the MVP backend behind the
  SQL tool's interface; a Postgres/MySQL adapter is the follow-up once the
  production DB is chosen (DESIGN.md Q4).
- **LLM planner** is wired for Anthropic/OpenAI but the demo planner is the
  default and the tested path; per-user DB credentials (§8.6), dataset
  caching, the Phase 2 simulated shell, and dhakira memory integration
  (§5.5) are designed but not yet built.
