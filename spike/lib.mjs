// Shared helpers for the Glassbox Phase 0 spike.
import { loadPyodide } from "pyodide";
import { performance } from "node:perf_hooks";
import fs from "node:fs";

export function now() {
  return performance.now();
}

export function secs(ms) {
  return Math.round(ms) / 1000;
}

export function memMB() {
  const m = process.memoryUsage();
  return {
    rss_mb: Math.round(m.rss / 1048576),
    heap_used_mb: Math.round(m.heapUsed / 1048576),
    external_mb: Math.round(m.external / 1048576),
  };
}

export async function freshPyodide() {
  const t0 = now();
  const pyodide = await loadPyodide();
  const loadMs = now() - t0;
  return { pyodide, loadMs };
}

export async function timedLoadPackage(pyodide, names) {
  const t0 = now();
  await pyodide.loadPackage(names);
  return now() - t0;
}

export function writeResult(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  console.log(`\n=== RESULT (${file}) ===`);
  console.log(JSON.stringify(obj, null, 2));
}
