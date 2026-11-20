// 04e — Module-graph crawl probe: after fullplus hardening + warm-up exercise,
// can agent code still reach a live `ctypes` or `js` object by crawling
// attributes of already-imported modules in sys.modules?
// Run: node 04e-crawl-probe.mjs
import { writeResult } from "./lib.mjs";
import { loadPyodide } from "pyodide";
import fs from "node:fs";

const MARKER = "/tmp/glassbox_crawl_marker";
if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER);
process.env.GLASSBOX_CANARY = "CANARY_TEST_VALUE_9f3k2";

const pyodide = await loadPyodide();
await pyodide.loadPackage(["numpy", "pandas", "scipy", "statsmodels", "scikit-learn", "micropip"]);
const micropip = pyodide.pyimport("micropip");
await micropip.install("plotly");

// warm-up exercise (same as 04d's winning recipe)
pyodide.runPython(`
import numpy as np, statsmodels.api as sm
from sklearn.cluster import DBSCAN
DBSCAN(eps=0.05, min_samples=2).fit(np.array([[0.0, 0.0], [0.01, 0.01], [1.0, 1.0], [1.01, 1.01]]))
sm.OLS(np.arange(5, dtype=float), sm.add_constant(np.arange(5, dtype=float))).fit()
import plotly.express as px, pandas as pd
px.scatter_map(pd.DataFrame({"lat": [0.0], "lon": [0.0]}), lat="lat", lon="lon").to_json()
from scipy import stats
stats.pearsonr([1,2,3],[1,2,3])
`);

// fullplus hardening
pyodide.runPython(`
import sys, os
blocked = ("js", "pyodide_js", "subprocess", "ctypes", "_ctypes")
for m in ("js", "pyodide_js", "ctypes", "_ctypes"):
    sys.modules.pop(m, None)
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
import posix
posix.system = _raise
`);

const probe = JSON.parse(
  pyodide.runPython(`
import sys, json
out = {}

# Which already-loaded modules expose a 'ctypes' or 'js' attribute?
ctypes_holders, js_holders = [], []
for name, mod in list(sys.modules.items()):
    if mod is None:
        continue
    try:
        if hasattr(mod, "ctypes"):
            ctypes_holders.append(name)
    except Exception:
        pass
    try:
        if hasattr(mod, "js"):
            js_holders.append(name)
    except Exception:
        pass
out["modules_exposing_ctypes_attr"] = ctypes_holders[:15]
out["modules_exposing_js_attr"] = js_holders[:15]

# Escape attempt 1: crawl to a ctypes module object and call libc system()
try:
    done = False
    for name in ctypes_holders:
        ct = getattr(sys.modules[name], "ctypes")
        rc = ct.CDLL(None).system(b"touch ${MARKER}")
        out["crawl_ctypes_system"] = {"outcome": "SUCCEEDED", "via_module": name, "rc": rc}
        done = True
        break
    if not done:
        out["crawl_ctypes_system"] = {"outcome": "blocked", "detail": "no ctypes holders found"}
except Exception as e:
    out["crawl_ctypes_system"] = {"outcome": "blocked", "detail": type(e).__name__ + ": " + str(e)[:180]}

# Escape attempt 2: crawl to a js module object and read process.env
try:
    done = False
    for name in js_holders:
        j = getattr(sys.modules[name], "js")
        v = j.process.env.GLASSBOX_CANARY
        out["crawl_js_canary"] = {"outcome": "SUCCEEDED" if v else "partial", "via_module": name, "value_obtained": bool(v)}
        done = True
        break
    if not done:
        out["crawl_js_canary"] = {"outcome": "blocked", "detail": "no js holders found"}
except Exception as e:
    out["crawl_js_canary"] = {"outcome": "blocked", "detail": type(e).__name__ + ": " + str(e)[:180]}

json.dumps(out)
`)
);

writeResult("logs/04e-crawl-probe.json", {
  test: "04e-crawl-probe",
  ...probe,
  host_checks: { crawl_marker_created_on_host: fs.existsSync(MARKER) },
});
