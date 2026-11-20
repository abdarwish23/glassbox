// 04d — Diagnostic: in "fullplus" mode (ctypes blocked), WHICH benign battery
// step breaks, and does exercising the lazy code paths during warm-up
// (before purge+block) fix it?
// Run: node 04d-fullplus-diagnostic.mjs
import { writeResult } from "./lib.mjs";
import { loadPyodide } from "pyodide";

async function buildWorker({ warmupExercise }) {
  const pyodide = await loadPyodide();
  await pyodide.loadPackage(["numpy", "pandas", "scipy", "statsmodels", "scikit-learn", "micropip"]);
  const micropip = pyodide.pyimport("micropip");
  await micropip.install("plotly");
  if (warmupExercise) {
    // Exercise lazy import paths (threadpoolctl/sklearn, statsmodels, plotly)
    // BEFORE hardening purges ctypes from sys.modules.
    pyodide.runPython(`
import numpy as np, statsmodels.api as sm
from sklearn.cluster import DBSCAN
DBSCAN(eps=0.05, min_samples=2).fit(np.array([[0.0, 0.0], [0.01, 0.01], [1.0, 1.0], [1.01, 1.01]]))
sm.OLS(np.arange(5, dtype=float), sm.add_constant(np.arange(5, dtype=float))).fit()
import plotly.express as px, pandas as pd
px.scatter_map(pd.DataFrame({"lat": [0.0], "lon": [0.0]}), lat="lat", lon="lon").to_json()
`);
  }
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
  return pyodide;
}

const STEPS = {
  pandas_corr: `float(pd.DataFrame({"a": [1.0,2.0,3.0,4.0], "b": [2.0,4.0,6.0,8.0]}).corr().iloc[0,1])`,
  scipy_pearsonr: `float(stats.pearsonr([1,2,3,4,5],[2,4,5,4,5]).statistic)`,
  scipy_spearmanr: `float(stats.spearmanr([1,2,3,4,5],[5,4,3,2,1]).statistic)`,
  statsmodels_ols: `float(sm.OLS(np.arange(20, dtype=float)*2+1, sm.add_constant(np.arange(20, dtype=float))).fit().rsquared)`,
  sklearn_dbscan: `DBSCAN(eps=0.05, min_samples=2).fit(np.array([[35.67,139.65],[35.68,139.66],[34.69,135.50],[34.70,135.51]])).labels_.tolist()`,
  plotly_scattermap: `len(px.scatter_map(pd.DataFrame({"lat":[35.67],"lon":[139.65],"v":[1.0]}), lat="lat", lon="lon", map_style="open-street-map").to_json())`,
  ctypes_escape: `__import__("ctypes").CDLL(None).system(b"echo should-not-run")`,
};

const IMPORTS = {
  pandas: "import pandas as pd",
  numpy: "import numpy as np",
  scipy_stats: "from scipy import stats",
  statsmodels: "import statsmodels.api as sm",
  sklearn_dbscan: "from sklearn.cluster import DBSCAN",
  plotly: "import plotly.express as px",
};

async function runBattery(pyodide) {
  const res = { imports: {} };
  for (const [name, stmt] of Object.entries(IMPORTS)) {
    try {
      pyodide.runPython(stmt);
      res.imports[name] = { ok: true };
    } catch (e) {
      const msg = String(e);
      const tail = msg.split("\n").filter((l) => l.trim()).slice(-2).join(" | ");
      res.imports[name] = { ok: false, error: tail.slice(0, 260) };
    }
  }
  for (const [name, expr] of Object.entries(STEPS)) {
    try {
      const v = pyodide.runPython(expr);
      res[name] = { ok: true, value: typeof v === "object" ? JSON.stringify(v) : v };
    } catch (e) {
      const msg = String(e);
      const tail = msg.split("\n").filter((l) => l.trim()).slice(-2).join(" | ");
      res[name] = { ok: false, error: tail.slice(0, 260) };
    }
  }
  return res;
}

const plain = await buildWorker({ warmupExercise: false });
const plainRes = await runBattery(plain);

const exercised = await buildWorker({ warmupExercise: true });
const exercisedRes = await runBattery(exercised);

writeResult("logs/04d-fullplus-diagnostic.json", {
  test: "04d-fullplus-diagnostic",
  fullplus_no_warmup_exercise: plainRes,
  fullplus_with_warmup_exercise: exercisedRes,
});
