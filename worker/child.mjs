// Glassbox sandbox worker child process — one Pyodide instance, one run.
//
// Bootstrap recipe is empirical, from the Phase 0 spike (spike/RESULTS.md):
//   load → load packages → install plotly (micropip) → EXERCISE lazy import
//   paths → scrub host globals → purge + import-block the JS bridge →
//   patch os/posix system calls → neuter ctypes → serve exactly one run →
//   exit (the pool replaces us with a fresh worker; fresh state per run is
//   therefore structural, not a reset we have to trust).
//
// Security model (DESIGN.md §3, corrected): this process is the boundary.
// It is started with a scrubbed, allowlisted environment and holds no
// secrets. Python-layer hardening below is defence-in-depth: it closes the
// JS bridge completely and patches the easy shell routes. The ctypes
// *module object* is additionally neutered in place (its CDLL/PyDLL/
// CFUNCTYPE constructors replaced with stubs and `pythonapi` removed),
// because the spike showed the ctypes object stays reachable by crawling
// attributes of legitimately loaded modules — every crawl path leads to
// this same module object, so mutating it covers them all.

// Capture IPC primitives BEFORE scrubbing globals: after
// `delete globalThis.process`, these bound references keep the channel alive.
const ipcSend = process.send ? process.send.bind(process) : null;
const ipcOn = process.on.bind(process);
const procExit = process.exit.bind(process);
const proc = process;

import { loadPyodide } from "pyodide";

const STDOUT_CAP = 8000;

function scrubGlobals() {
  // Spike finding: scrub BEFORE loadPyodide() crashes Pyodide init (its JS
  // layer reads globalThis.process). Only ever call this after warm-up.
  for (const k of ["process", "fetch", "Buffer"]) {
    try {
      delete globalThis[k];
    } catch {}
    if (typeof globalThis[k] !== "undefined") {
      try {
        Object.defineProperty(globalThis, k, { value: undefined, configurable: true });
      } catch {}
    }
  }
}

const stdoutParts = [];
let pyodide;
let ready = false;

async function bootstrap() {
  pyodide = await loadPyodide();
  pyodide.setStdout({
    batched: (s) => {
      if (stdoutParts.join("\n").length < STDOUT_CAP * 2) stdoutParts.push(s);
    },
  });
  pyodide.setStderr({
    batched: (s) => {
      if (stdoutParts.join("\n").length < STDOUT_CAP * 2) stdoutParts.push(s);
    },
  });
  await pyodide.loadPackage([
    "numpy",
    "pandas",
    "scipy",
    "statsmodels",
    "scikit-learn",
    "micropip",
  ]);
  const micropip = pyodide.pyimport("micropip");
  await micropip.install("plotly");

  // Exercise pass: force every lazy import path the real workload needs
  // BEFORE hardening. Without this, blocking ctypes breaks pandas /
  // statsmodels / scipy lazy imports (spike RESULTS.md §4.3).
  pyodide.runPython(`
import numpy as np, pandas as pd
_df = pd.DataFrame({"a": [1.0, 2.0, 3.0, 4.0], "b": [2.0, 4.0, 5.0, 8.0],
                    "lat": [35.6, 35.7, 34.6, 34.7], "lon": [139.6, 139.7, 135.5, 135.6]})
_df.corr()
from scipy import stats
stats.pearsonr([1, 2, 3, 4], [2, 4, 5, 8]); stats.spearmanr([1, 2, 3, 4], [4, 3, 2, 1])
import statsmodels.api as sm
sm.OLS(np.arange(8, dtype=float), sm.add_constant(np.arange(8, dtype=float))).fit()
from sklearn.cluster import DBSCAN
DBSCAN(eps=0.05, min_samples=2).fit(np.array([[35.67, 139.65], [35.68, 139.66], [34.69, 135.50], [34.70, 135.51]]))
import threadpoolctl  # force its lazy library loads pre-hardening
import plotly.graph_objects as go, plotly.express as px, json as _json
_json.loads(go.Figure(data=go.Heatmap(z=[[1.0, 0.5], [0.5, 1.0]])).to_json())
_json.loads(px.scatter_map(_df, lat="lat", lon="lon", map_style="open-street-map").to_json())
del _df
`);

  // Scrub host globals now that Pyodide no longer needs them.
  scrubGlobals();

  // Python-layer hardening (defence-in-depth; see header).
  pyodide.runPython(`
import sys, os

# --- neuter ctypes in place BEFORE purging it from sys.modules ---
# The ctypes module object is shared: numpy/pandas/scipy hold references to
# this exact object, so replacing its dangerous constructors here covers the
# attribute-crawl route the spike found (numpy._core._internal.ctypes ...).
try:
    import ctypes as _ct
    def _blocked_ctor(*a, **k):
        raise OSError("blocked by sandbox policy: ctypes foreign-function access is disabled")
    for _n in ("CDLL", "PyDLL", "WinDLL", "OleDLL", "CFUNCTYPE", "PYFUNCTYPE"):
        if hasattr(_ct, _n):
            setattr(_ct, _n, _blocked_ctor)
    if hasattr(_ct, "pythonapi"):
        try:
            delattr(_ct, "pythonapi")
        except Exception:
            _ct.pythonapi = None
    del _ct, _blocked_ctor, _n
except Exception:
    pass

# --- purge bridge/FFI modules and block re-import ---
_blocked = ("js", "pyodide_js", "subprocess", "ctypes", "_ctypes")
# Purge the blocked modules from the cache too: the exercise pass leaves
# e.g. subprocess in sys.modules (via sklearn/joblib), and a cached module
# is returned without ever consulting the meta_path blocker below.
for _m in ("js", "pyodide_js", "subprocess", "ctypes", "_ctypes"):
    sys.modules.pop(_m, None)
class _Blocker:
    def __init__(self, blocked):
        self._blocked = blocked
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in self._blocked:
            raise ImportError("blocked import: " + name)
        return None
sys.meta_path.insert(0, _Blocker(_blocked))

# --- patch shell entry points (posix too, so importlib.reload(os) stays patched) ---
def _raise(*a, **k):
    raise OSError("blocked by sandbox policy")
os.system = _raise
os.popen = _raise
try:
    import posix
    posix.system = _raise
except Exception:
    pass
del _blocked, _Blocker, _raise
`);

  ready = true;
  if (ipcSend) ipcSend({ type: "ready" });
}

const PREAMBLE = `
import json, math
import numpy as np
import pandas as pd

def to_jsonable(o):
    if isinstance(o, dict):
        return {str(k): to_jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [to_jsonable(v) for v in o]
    if isinstance(o, (set, frozenset)):
        return [to_jsonable(v) for v in o]
    if isinstance(o, np.ndarray):
        return to_jsonable(o.tolist())
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, pd.Timestamp):
        return o.isoformat()
    return o

_gb_raw = globals().get("__gb_data")
if _gb_raw is None or type(_gb_raw).__name__ == "JsNull":
    df = pd.DataFrame()
else:
    df = pd.DataFrame(_gb_raw)
del _gb_raw
`;

const EXTRACT = `
if "result" not in globals() or not isinstance(result, dict):
    raise RuntimeError("agent code must assign a dict to \`result\` (with optional 'figures' and 'summary')")
__gb_payload = json.dumps(to_jsonable(result))
`;

async function handleRun(msg) {
  const { id, code, dataset } = msg;
  stdoutParts.length = 0;
  let contract;
  try {
    // Note: a JS null set into globals becomes Pyodide's JsNull, not None —
    // the PREAMBLE handles both, and we simply omit the global when empty.
    if (dataset) pyodide.globals.set("__gb_data", pyodide.toPy(dataset));
    await pyodide.runPythonAsync(PREAMBLE + "\n" + code + "\n" + EXTRACT);
    const payload = JSON.parse(String(pyodide.globals.get("__gb_payload")));
    contract = {
      ok: true,
      figures: Array.isArray(payload.figures) ? payload.figures : [],
      summary: payload.summary && typeof payload.summary === "object" ? payload.summary : {},
      stdout: "",
      error: null,
    };
  } catch (e) {
    const raw = String(e && e.message ? e.message : e);
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    contract = {
      ok: false,
      figures: [],
      summary: {},
      stdout: "",
      error: {
        type: lines.length ? lines[lines.length - 1].split(":")[0].slice(0, 80) : "Error",
        message: lines.length ? lines[lines.length - 1].slice(0, 500) : raw.slice(0, 500),
        traceback_tail: lines.slice(-8).join("\n").slice(0, 2000),
      },
    };
  }
  let stdout = stdoutParts.join("\n");
  if (stdout.length > STDOUT_CAP) stdout = stdout.slice(0, STDOUT_CAP) + "\n…[stdout truncated]";
  contract.stdout = stdout;
  if (ipcSend) {
    ipcSend({ type: "result", id, contract }, () => procExit(0));
  } else {
    procExit(0);
  }
  // If the send callback never fires, still do not linger.
  setTimeout(() => procExit(0), 2000).unref();
}

ipcOn("message", (msg) => {
  if (msg && msg.type === "run" && ready) {
    handleRun(msg).catch(() => procExit(1));
  }
});

bootstrap().catch((e) => {
  if (ipcSend) {
    try {
      ipcSend({ type: "bootstrap_error", message: String(e && e.message ? e.message : e).slice(0, 500) });
    } catch {}
  }
  procExit(1);
});
