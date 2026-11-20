// Hardened worker (child process) for test 04c.
// Modes (SPIKE_MODE env):
//   naive          — no hardening (control; canary IS in this process's env)
//   scrub          — delete host globals (process/fetch/Buffer) around load
//   full           — scrub + Python-side import block (js/pyodide_js/subprocess),
//                    sys.modules purge, os.system/os.popen patched to raise
//   full-nocanary  — full hardening, and the driver did NOT put the canary in env
// Prints exactly one JSON line to stdout with the attempt results.
import { loadPyodide } from "pyodide";
import fs from "node:fs";

const proc = process; // private reference; bootstrap keeps working after scrub
const mode = proc.env.SPIKE_MODE || "naive";
const port = proc.env.SPIKE_HTTP_PORT || "18713";
const marker = proc.env.SPIKE_MARKER;
const marker2 = proc.env.SPIKE_MARKER2;
const ctypesMarker = proc.env.SPIKE_CTYPES_MARKER;
const leakFile = proc.env.SPIKE_LEAK_FILE;
const FULLPLUS = mode === "fullplus";
const FULL = mode === "full" || mode === "full-nocanary" || FULLPLUS;

const out = { mode, canary_in_worker_env: "GLASSBOX_CANARY" in proc.env, steps: {}, attempts: {} };

function scrubGlobals() {
  const killed = [];
  for (const k of ["process", "fetch", "Buffer"]) {
    try {
      delete globalThis[k];
    } catch {}
    if (typeof globalThis[k] === "undefined") killed.push(k);
    else {
      try {
        Object.defineProperty(globalThis, k, { value: undefined, configurable: true });
        if (typeof globalThis[k] === "undefined") killed.push(k + "(shadowed)");
      } catch {}
    }
  }
  return killed;
}

// --- load FIRST, scrub AFTER ---
// (Spike finding: scrub-before-load crashes Pyodide init — its JS layer reads
//  globalThis.process while initialising the package index. So the only viable
//  order is: warm up with globals intact, then scrub before serving agent code.)
let pyodide = await loadPyodide();
await pyodide.loadPackage(["numpy", "pandas", "scipy", "statsmodels", "scikit-learn", "micropip"]);
const micropip = pyodide.pyimport("micropip");
await micropip.install("plotly");
if (mode === "naive") {
  out.steps.load_order = "no scrub";
} else {
  out.steps.load_order = "load-then-scrub";
  out.steps.scrubbed_after_load = scrubGlobals();
}

// --- Python-side hardening (full modes) ---
if (FULL) {
  out.steps.python_hardening = pyodide.runPython(`
import sys, os, json
blocked = ("js", "pyodide_js", "subprocess") + (("ctypes", "_ctypes") if ${FULLPLUS ? "True" : "False"} else ())
ctypes_was_cached = "ctypes" in sys.modules
purge_list = ("js", "pyodide_js") + (("ctypes", "_ctypes") if ${FULLPLUS ? "True" : "False"} else ())
purged = [m for m in purge_list if sys.modules.pop(m, None) is not None]
class _Blocker:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in blocked:
            raise ImportError("blocked import: " + name)
        return None
sys.meta_path.insert(0, _Blocker())
def _raise(*a, **k):
    raise OSError("blocked by sandbox policy")
os.system = _raise
os.popen = _raise
posix_patched = False
try:
    import posix
    posix.system = _raise
    posix_patched = True
except Exception:
    pass
json.dumps({"purged_from_sys_modules": purged, "ctypes_was_cached_after_warmup": ctypes_was_cached,
            "os_system_patched": True, "posix_system_patched": posix_patched,
            "blocked_imports": list(blocked)})
`);
}

// --- attempt battery ---
function attempt(code) {
  const wrapped = `
import json
try:
    _r = (lambda: (${code}))()
    _out = json.dumps(_r)
except Exception as e:
    _out = json.dumps({"outcome": "blocked", "detail": type(e).__name__ + ": " + str(e)[:200]})
_out
`;
  const s = String(pyodide.runPython(wrapped)).trim().split("\n").pop();
  try {
    return JSON.parse(s);
  } catch {
    return { outcome: "error", detail: s.slice(0, 200) };
  }
}

out.attempts.import_js = attempt(`(lambda: (
    __import__("js"),
    {"outcome": "SUCCEEDED", "detail": "import js worked"}
)[1])()`);

out.attempts.js_process_canary = attempt(`(lambda: (
    (lambda v: {"outcome": "SUCCEEDED" if v == "CANARY_TEST_VALUE_9f3k2" else "blocked",
                 "detail": "via js bridge, process.env.GLASSBOX_CANARY -> " + repr(v)})(
        __import__("js").process.env.GLASSBOX_CANARY)
))()`);

out.attempts.os_getenv_canary = attempt(`(lambda: (
    (lambda v: {"outcome": "SUCCEEDED" if v == "CANARY_TEST_VALUE_9f3k2" else "blocked",
                 "detail": "os.getenv -> " + repr(v)})(__import__("os").getenv("GLASSBOX_CANARY"))
))()`);

out.attempts.os_system_marker = attempt(`(lambda: (
    (lambda rc: {"outcome": "SUCCEEDED", "detail": "os.system rc=" + repr(rc)})(
        __import__("os").system("touch ${marker}"))
))()`);

out.attempts.ctypes_system_marker = attempt(`(lambda: (
    (lambda rc: {"outcome": "SUCCEEDED", "detail": "libc.system rc=" + repr(rc)})(
        __import__("ctypes").CDLL(None).system(b"touch ${ctypesMarker}"))
))()`);

if (leakFile) {
  out.attempts.os_system_printenv_leak = attempt(`(lambda: (
      (lambda rc: {"outcome": "ran", "detail": "printenv leak attempt rc=" + repr(rc)})(
          __import__("os").system("printenv GLASSBOX_CANARY > ${leakFile}"))
  ))()`);
}

// js.fetch (async)
try {
  pyodide.runPython(`
import js
from pyodide.ffi import to_js
async def _ft():
    ctrl = js.AbortController.new()
    js.setTimeout(lambda: ctrl.abort(), 5000)
    r = await js.fetch("http://127.0.0.1:${port}/", to_js({"signal": ctrl.signal}))
    return await r.text()
`);
  const text = await pyodide.runPythonAsync("_ft()");
  out.attempts.js_fetch = {
    outcome: String(text).includes("HTTP_CANARY_7d2e") ? "SUCCEEDED" : "partial",
    detail: "fetch returned: " + String(text).slice(0, 60),
  };
} catch (e) {
  out.attempts.js_fetch = { outcome: "blocked", detail: String(e).slice(0, 200) };
}

out.attempts.reload_os_system = attempt(`(lambda: (
    __import__("importlib").reload(__import__("os")),
    (lambda rc: {"outcome": "SUCCEEDED" if rc == 0 else "blocked",
                 "detail": "after importlib.reload(os), os.system rc=" + repr(rc)})(
        __import__("os").system("touch ${marker2}"))
))()`);

// benign battery: the sandbox must still do its actual job, incl. the
// scipy/statsmodels/sklearn/plotly paths the real workload needs
try {
  const batt = JSON.parse(
    pyodide.runPython(`
import json
res = {}
import pandas as pd, numpy as np
df = pd.DataFrame({"a": [1.0, 2.0, 3.0, 4.0], "b": [2.0, 4.0, 6.0, 8.0]})
res["pandas_corr"] = float(df.corr().iloc[0, 1])
from scipy import stats
res["scipy_pearsonr"] = float(stats.pearsonr([1,2,3,4,5],[2,4,5,4,5]).statistic)
res["scipy_spearmanr"] = float(stats.spearmanr([1,2,3,4,5],[5,4,3,2,1]).statistic)
import statsmodels.api as sm
X = sm.add_constant(np.arange(20, dtype=float))
res["statsmodels_ols_rsq"] = float(sm.OLS(np.arange(20, dtype=float) * 2 + 1, X).fit().rsquared)
from sklearn.cluster import DBSCAN
pts = np.array([[35.67, 139.65], [35.68, 139.66], [34.69, 135.50], [34.70, 135.51]])
res["sklearn_dbscan_labels"] = DBSCAN(eps=0.05, min_samples=2).fit(pts).labels_.tolist()
import plotly.express as px
fig = px.scatter_map(pd.DataFrame({"lat": [35.67], "lon": [139.65], "v": [1.0]}),
                     lat="lat", lon="lon", map_style="open-street-map")
res["plotly_scattermap_json_len"] = len(fig.to_json())
json.dumps(res)
`)
  );
  const ok =
    Math.abs(batt.pandas_corr - 1.0) < 1e-9 &&
    batt.scipy_spearmanr === -1.0 &&
    Math.abs(batt.statsmodels_ols_rsq - 1.0) < 1e-9 &&
    batt.sklearn_dbscan_labels.join() === "0,0,1,1" &&
    batt.plotly_scattermap_json_len > 100;
  out.attempts.benign_battery = { outcome: ok ? "works" : "partial", detail: JSON.stringify(batt).slice(0, 300) };
} catch (e) {
  out.attempts.benign_battery = { outcome: "BROKEN", detail: String(e).slice(0, 300) };
}

proc.stdout.write(JSON.stringify(out) + "\n");
proc.exit(0);
