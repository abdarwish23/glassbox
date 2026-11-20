// 01 — Load test: Pyodide cold load, package availability + versions, timings, memory.
// Run: node 01-load-test.mjs
import { now, secs, memMB, timedLoadPackage, writeResult } from "./lib.mjs";
import { loadPyodide } from "pyodide";
import fs from "node:fs";

const processStart = now();
const result = { test: "01-load-test", stages: {}, packages: {}, errors: {} };

result.memory_at_start = memMB();

// --- Cold load: runtime only ---
let t0 = now();
const pyodide = await loadPyodide();
result.stages.runtime_load_s = secs(now() - t0);
result.memory_after_runtime = memMB();
result.python_version = pyodide.runPython("import sys; sys.version");

// --- Core scientific packages from the Pyodide lock ---
for (const group of [
  ["numpy"],
  ["pandas"],
  ["scipy"],
  ["statsmodels"],
  ["scikit-learn"],
]) {
  const name = group[0];
  try {
    const ms = await timedLoadPackage(pyodide, group);
    result.stages[`load_${name}_s`] = secs(ms);
  } catch (e) {
    result.errors[name] = String(e).slice(0, 500);
  }
}
result.memory_after_core_packages = memMB();

// Versions of everything that imported
result.packages = JSON.parse(
  pyodide.runPython(`
import json, importlib
mods = ["numpy", "pandas", "scipy", "statsmodels", "sklearn"]
out = {}
for m in mods:
    try:
        mod = importlib.import_module(m)
        out[m] = getattr(mod, "__version__", "unknown")
    except Exception as e:
        out[m] = "IMPORT FAILED: " + repr(e)
json.dumps(out)
`)
);

// --- micropip + plotly (plotly is NOT in the lock; must come from PyPI) ---
try {
  let t = now();
  await pyodide.loadPackage("micropip");
  result.stages.load_micropip_s = secs(now() - t);

  const micropip = pyodide.pyimport("micropip");
  t = now();
  await micropip.install("plotly");
  result.stages.micropip_install_plotly_s = secs(now() - t);
  result.packages.plotly = pyodide.runPython("import plotly; plotly.__version__");
  result.plotly_source = "micropip from PyPI (network required)";
} catch (e) {
  result.errors.plotly = String(e).slice(0, 800);
}
result.memory_after_plotly = memMB();

result.total_wall_s = secs(now() - processStart);
result.pyodide_npm_version = JSON.parse(
  fs.readFileSync("node_modules/pyodide/package.json", "utf8")
).version;

writeResult("logs/01-load-test.json", result);
