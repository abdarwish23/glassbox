// 05 — State isolation: a fresh Pyodide instance must see nothing from a prior run.
// Also measures the cost of a clean interpreter (bare, and with the core stack),
// which is the number the warm-pool / fresh-per-run design decision needs.
// Run: node 05-state-isolation.mjs
import { now, secs, memMB, writeResult } from "./lib.mjs";
import { loadPyodide } from "pyodide";

const result = { test: "05-state-isolation" };

// --- Instance A: dirty state ---
let t0 = now();
const a = await loadPyodide();
result.instanceA_runtime_load_s = secs(now() - t0);
await a.loadPackage(["numpy", "pandas"]);
a.runPython(`
secret_marker = "RUN1_SECRET_VALUE"
import calendar          # an extra module run 1 chooses to import
import pandas as pd
df_run1 = pd.DataFrame({"x": [1, 2, 3]})
with open("/run1_marker.txt", "w") as f:
    f.write("run1 was here")
`);
result.instanceA_state = JSON.parse(
  a.runPython(`
import json, sys
json.dumps({
  "marker_visible_in_A": "secret_marker" in globals(),
  "calendar_in_sys_modules": "calendar" in sys.modules,
  "memfs_file_in_A": open("/run1_marker.txt").read(),
})
`)
);

// --- Instance B: fresh — bare check ---
t0 = now();
const b = await loadPyodide();
result.instanceB_runtime_load_s = secs(now() - t0);
result.instanceB_bare_state = JSON.parse(
  b.runPython(`
import json, sys, os
def _try_open():
    try:
        return open("/run1_marker.txt").read()
    except Exception as e:
        return type(e).__name__
json.dumps({
  "marker_visible_in_B": "secret_marker" in globals(),
  "df_run1_visible_in_B": "df_run1" in globals(),
  "calendar_in_sys_modules_B": "calendar" in sys.modules,
  "memfs_file_in_B": _try_open(),
})
`)
);

// --- Instance B + core packages: the real "clean worker" cost ---
t0 = now();
await b.loadPackage(["numpy", "pandas", "scipy"]);
result.instanceB_core_packages_load_s = secs(now() - t0);
result.instanceB_total_clean_worker_s =
  Math.round((result.instanceB_runtime_load_s + result.instanceB_core_packages_load_s) * 1000) / 1000;
result.memory = memMB();

writeResult("logs/05-state-isolation.json", result);
