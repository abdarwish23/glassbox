# Glassbox — Phase 0 Spike Results

**Date:** 2026-11-19 · **Environment:** Node v24.22.1, npm 10.9.4, this VM (shared vCPU, ~8 GB RAM)
**Stack under test:** npm `pyodide` **314.0.8** (pinned, `--save-exact`) → CPython **3.14.2**, Emscripten 5.0.3, ABI `2026_0`
**Scripts:** `01-load-test.mjs` … `05-state-isolation.mjs` (+ `04b/04c/04d/04e` follow-ups, `hardened-worker.mjs`) · **Raw outputs:** `logs/*.json`

## Verdict summary

| # | Item | Verdict |
|---|---|---|
| 1 | Load test (packages, cold load, memory) | **PASS** — every required package available; one (plotly) needs micropip/PyPI |
| 2 | Geo check (geopandas/shapely/h3, scattermap, fallbacks) | **PASS** — all geo packages are in the Pyodide lock and work |
| 3 | Correlation benchmark (500k values, planted 2 h lag) | **PASS** — all analyses in well under a second; planted lag found exactly |
| 4 | Hostile-code tests | **FAIL for a naive embedding; PARTIAL with hardening** — real escapes exist and one cannot be closed from inside Python (see §4) |
| 5 | State isolation | **PASS** — fresh instance sees nothing; clean-worker cost ≈ 6 s (core stack) |

**Overall: GO for the Pyodide design — with a corrected security model.** The workload assumptions (packages, performance, geo, state isolation) all passed with wide margins. One security sub-assumption in DESIGN.md §3 — *"executed code cannot spawn processes or a shell"* — was **falsified** for this Pyodide build (see §4). The fix is architectural and the design mostly embodies it already: **the worker process, not the WASM boundary alone, is the containment boundary** — it must hold no secrets, run as an unprivileged user, and be disposable. Option B (§11) is **not** triggered.

---

## 1. Load test — PASS

All packages imported and reported versions:

| Package | Version | Source |
|---|---|---|
| numpy | 2.4.6 | Pyodide lock |
| pandas | 3.0.2 | Pyodide lock |
| scipy | 1.18.0 | Pyodide lock |
| statsmodels | 0.14.6 | Pyodide lock |
| scikit-learn | 1.8.0 | Pyodide lock |
| plotly | 7.1.0 | **micropip from PyPI** (not in the lock) |

**Cold load times** (two runs measured):

| Stage | First-ever run (incl. CDN wheel downloads) | Wheels cached |
|---|---|---|
| Pyodide runtime | 3.09 s | 3.07 s |
| numpy | 12.17 s | 0.63 s |
| pandas | 8.35 s | 0.72 s |
| scipy | 8.27 s | 2.77 s |
| statsmodels | 6.29 s | 1.00 s |
| scikit-learn | 5.29 s | 1.45 s |
| micropip | 0.41 s | 0.02 s |
| **Core stack ready (cumulative)** | **≈ 44 s** | **≈ 9.7 s** |
| plotly via micropip (PyPI fetch) | 7.97 s | 6.31 s |
| Total wall (script) | 63.5 s | 26.4 s |

**Memory (Node process RSS):** 63 MB at start → ~165 MB after runtime → **~500 MB after the core stack** → **~810–840 MB after plotly + micropip machinery**. A fully-warmed worker therefore has a **~0.85 GB memory floor**, inside the design §9 planning band of 1–1.5 GB per worker.

**Implications:**
- Lock wheels are downloaded from the jsDelivr CDN on first use, then cached in `node_modules`. `run.sh` should pre-download/vendor the wheel set at deploy time so first request never pays the ~44 s download path.
- plotly is the only PyPI-dependent piece, and micropip re-fetches it for **every fresh interpreter (~6.3 s)**. Vendor the plotly wheel at deploy and install from the local copy during warm-up.
- Deploy-time internet is required unless wheels are vendored — relevant to open question Q1.

## 2. Geo check — PASS

- **shapely 2.1.2, geopandas 1.1.3, h3 4.4.2, pyproj 3.7.2 — all present in the Pyodide lock** and functional, not just importable: a GeoDataFrame buffer/distance exercise ran (with the expected geographic-CRS warning), and h3 `latlng_to_cell` → `cell_to_latlng` round-tripped with `grid_disk(k=1)` returning 7 cells. Load times (cached wheels): shapely 1.2 s, h3 0.8 s, geopandas 12.8 s (large dep tree — load it lazily, only for geo tasks, not in the default warm set).
- **Plotly scattermap:** figure generated inside Pyodide from lat/lon points; JSON validated on the JS side — parses, trace type is `scattermap`, `layout.map` present, 7,793 bytes for 4 points.
- **Pure-Python fallbacks verified:**
  - Haversine: 392.4 km for the spike's Tokyo/Osaka coordinates — matches two independent host implementations to 0.1 km. (The script's initial "expected 402 km" reference was imprecise for those exact coordinates; the canonical Tokyo Station → Osaka Station pair computes to 403.1 km ≈ the ~400 km reference. The implementation is correct.)
  - Geohash: precision-9 encode of central Tokyo → `xn76cydhz` (correct `xn76` prefix), decode round-trip contains the original point.

**Implication:** §8.5's worry is retired — geo does **not** need the Option B fallback, and geopandas/h3 are available if wanted; the pure-Python fallbacks also work.

## 3. Correlation benchmark — PASS

Dataset (generated inside Pyodide in 0.09 s): **8,760 hourly timestamps × 57 KPI series = 499,320 values**, DataFrame 3.9 MB. Background series share a daily cycle; the planted pair has `kpi_b(t) = 0.85 · s(t−2) + noise` (B lags A by exactly 2 h).

| Analysis | Wall time |
|---|---|
| Pearson matrix (57×57) | 0.154 s |
| Spearman matrix (57×57) | 0.198 s |
| Detrended (first-difference) Pearson | 0.094 s |
| Lagged cross-correlation, lags −24…+24 (49 lags) | 0.016 s |

- **Planted lag found exactly:** best lag **+2 h, r = 0.975** (vs r = 0.679 at lag 0). ✔
- **Seasonality trap, quantified (validates §8 rule 2):** mean |r| across unrelated background pairs was **0.134 raw vs 0.020 after detrending** — the shared daily cycle inflates raw correlations ~6.7×. Detrended/lagged analysis isn't optional garnish; it's the difference between signal and artefact.
- Process RSS grew 420 → 614 MB during the benchmark (WASM heap is not returned promptly; another reason workers are recycled, §5.3).

**Implication:** performance is a non-issue at the design's stated scale — the full correlation suite costs ~0.5 s of compute against a ~10 s worker warm-up. The 30 s per-run cap in §5.3 has ~50× headroom for this workload.

## 4. Hostile-code tests — FAIL (naive) / PARTIAL (hardened)

A canary secret was planted in the Node process environment. Attempts ran as agent-style Python inside Pyodide.

### 4.1 The pure-Python surface is well isolated ✔

| Attempt | Result |
|---|---|
| `os.getenv` / `os.environ` | **Blocked** — Python sees only a small synthetic env; the canary is absent |
| Read `/etc/passwd`, host `DESIGN.md`, `/proc/self/environ` | **Blocked** — `FileNotFoundError` (empty MEMFS; no host filesystem) |
| Write `/tmp/...` | Lands in MEMFS only — host check confirmed **no file created on the host** |
| `subprocess.run` | **Blocked** — `OSError: emscripten does not support processes` |
| `urllib` HTTPS request | **Blocked** — `RuntimeError: TLS not supported in this environment` |
| `socket.create_connection` / DNS | **Misleading** — connect and DNS *appear* to succeed at API level, but a real data exchange with a listening host-loopback server **timed out with zero bytes**. Do not rely on Python sockets for anything, in either direction. |

### 4.2 Three real escapes in a default embedding ✘

| Escape | Evidence |
|---|---|
| **`js` module → whole host** | `import js` works; `js.process.env.GLASSBOX_CANARY` returned the canary; `Function('return process.env…')()` worked; **`js.fetch` from Python successfully fetched a host-loopback HTTP server** and returned its payload. In a naive embedding, Python code has the Node host. |
| **`os.system` → real host shell** | `os.system('touch …')` created the marker **on the host**; `os.system('id > …')` wrote `uid=0(root)` to a host file (this VM runs as root; on the FaaS it would be the app user). Emscripten's `system()` is backed by Node's `child_process`. |
| **`ctypes` → libc `system`** | `ctypes.CDLL(None).system(...)` also executed on the host (marker created). |

### 4.3 Hardening ladder (measured, four configurations + diagnostic)

| Measure | Closes | Does not close |
|---|---|---|
| Delete `globalThis.process/fetch/Buffer` **after** load | `js.process` and `js.fetch` lookups (`AttributeError`) | `import js` itself; `os.system`; `ctypes` |
| + Import block (`js`, `pyodide_js`, `subprocess`) via `sys.meta_path`, purge `sys.modules` | **`import js` completely** — and a module-graph crawl found **no warmed module exposing a `js` object**, so the bridge stays closed | `ctypes` |
| + Patch `os.system`/`os.popen` **and** `posix.system` | `os.system`, incl. after `importlib.reload(os)` (host-marker verified) | `ctypes` |
| + Block `ctypes` import | The direct `import ctypes` route — **but only if a warm-up "exercise" pass runs first** (see below) | The `ctypes` **object**, reachable by crawling attributes of legitimately-loaded modules |

Two measured subtleties:

- **Blocking `ctypes` naively breaks the stack.** Without warm-up exercise, post-block imports of pandas and statsmodels fail (`blocked import: ctypes` in their lazy import chains) and scipy reports itself broken. **With** a warm-up exercise pass (a tiny DBSCAN fit, an OLS fit, a scipy.stats call, a plotly figure — all before hardening), every benign check passes with correct values *and* the direct ctypes import stays blocked. The recipe is: **load → exercise → purge → block → serve.**
- **The ctypes object cannot be fully revoked.** After full hardening + exercise, 11 already-loaded modules expose a `ctypes` attribute (`numpy._core._internal`, `pandas.errors`, `scipy._lib._ccallback`, `threadpoolctl`, …), and crawling `numpy._core._internal.ctypes` → `CDLL(None).system()` **executed on the host** (marker verified). numpy/pandas/scipy legitimately embed ctypes references; no Python-layer blocklist removes them all.

**Bootstrap order matters:** scrubbing globals *before* `loadPyodide()` crashes initialisation (`TypeError: Cannot read properties of undefined (reading '_importhook')` — Pyodide's JS layer needs `process` at load). The only viable order is **load → warm up → scrub → harden → serve**.

### 4.4 Corrected security model (required DESIGN.md §3 amendment)

The §3 sentence *"executed code cannot spawn processes or a shell"* is **false for this build** and should be replaced. What the spike supports claiming:

- Agent code cannot reach the host filesystem, the host environment, or Python-level networking.
- The JS bridge can be closed completely (import block + purge + global scrub).
- **Agent code must be assumed able to execute shell commands inside the worker process** (via ctypes references inside the scientific stack). Therefore:
  - the worker is a **separate OS process holding no secrets at all** — the §4 rule "credentials live only in the agent service" is load-bearing, not optional;
  - it runs as a **dedicated unprivileged user** and is **disposable** (fresh or recycled per run — cost measured in §5);
  - the Python-layer hardening above is defence-in-depth (it closes the easy doors and the entire JS bridge), not the boundary itself;
  - the FaaS instance is the outer wall, which is consistent with §3's "internal tool, trusted users" positioning.

## 5. State isolation — PASS

Instance A was deliberately dirtied (a `secret_marker` global, an extra imported module, a DataFrame, a MEMFS file). A fresh instance B saw **none of it**: marker absent, DataFrame absent, module absent from `sys.modules`, MEMFS file → `FileNotFoundError`.

**Cost of a clean worker (cached wheels):** runtime 2.47 s + numpy/pandas/scipy 3.55 s = **≈ 6.0 s**; with the full stack + vendored plotly, ≈ 10–13 s (from §1 stage times). 

**Implication:** fresh-instance-per-run is correct but too slow to pay inside a request. Keep §5.3's warm pool; recycle workers *between* runs in the background so the ~6–13 s respawn never lands in the request path.

## 6. Environment note (this VM, not Pyodide)

Fetching from PyPI/CDN inside a Node worker on this VM requires the host's proxy configuration to be passed through — including `NODE_USE_ENV_PROXY=1`, without which Node's fetch silently ignores the proxy variables and micropip fails with "Can't fetch metadata". Diagnosed during the spike (it cost three debugging rounds); on the target FaaS, vendored wheels (§1) make worker-time fetching unnecessary anyway.

## 7. Go / No-Go

**GO.** Proceed to Phase 1 on the Pyodide design, with these amendments folded in:

1. **§3 security text corrected** per §4.4 — worker process is the boundary; no secrets in the worker, ever; unprivileged user; disposable workers.
2. **Worker bootstrap recipe** (measured): load → load packages → exercise lazy paths → scrub globals → purge + import-block (`js`, `pyodide_js`, `subprocess`, `ctypes`) → patch `os`/`posix` system calls → serve.
3. **run.sh vendors all wheels** (lock set + plotly wheel) — removes ~44 s of first-run downloads and the per-interpreter ~6 s plotly fetch, and removes worker-time internet dependence.
4. **Warm pool with background recycling** (§5), sized at ~1 GB per worker.
5. **geopandas/h3 loaded lazily** for geo tasks only (12.8 s load); the default warm set stays numpy/pandas/scipy/statsmodels/sklearn/plotly.

Option B (native CPython subprocess) is **not** needed: no Phase 0 blocker fired — packages, performance, geo, and state isolation all passed, and the one falsified assumption has an architectural answer the design already mostly embodies.
