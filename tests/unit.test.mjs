// Unit/integration tests: SQL tool guardrails, figure validator, dataset
// registry. No sandbox needed. Run: node tests/unit.test.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqlTool, SqlToolError, assertReadOnlySelect } from "../agent/sqltool.mjs";
import { validateFigures } from "../shared/validator.mjs";
import { DatasetRegistry } from "../worker/datasets.mjs";

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  PASS ${name}`);
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixture DB -----------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-unit-"));
const dbPath = path.join(dir, "t.db");
{
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE kpi (ts TEXT, a REAL, b REAL)");
  const ins = db.prepare("INSERT INTO kpi VALUES (?, ?, ?)");
  for (let i = 0; i < 50; i++) ins.run(`2026-09-01T${String(i % 24).padStart(2, "0")}:00:00Z`, i, i * 2);
  db.close();
}
const sql = new SqlTool(dbPath, { defaultMaxRows: 10 });

console.log("SQL tool:");
await ok("rejects INSERT", async () => {
  await assert.rejects(() => sql.query("INSERT INTO kpi VALUES ('x', 1, 2)"), /read-only|only SELECT|forbidden/i);
});
await ok("rejects DELETE", async () => {
  await assert.rejects(() => sql.query("DELETE FROM kpi"), /only SELECT|forbidden/i);
});
await ok("rejects multi-statement", async () => {
  await assert.rejects(() => sql.query("SELECT 1; SELECT 2"), /multiple statements/i);
});
await ok("rejects WITH … DELETE (SQLite DML-after-CTE trick)", async () => {
  await assert.rejects(
    () => sql.query("WITH x AS (SELECT 1) DELETE FROM kpi"),
    /forbidden/i
  );
});
await ok("rejects DROP disguised after SELECT keyword scan", async () => {
  assert.throws(() => assertReadOnlySelect("SELECT * FROM kpi; DROP TABLE kpi"), SqlToolError);
});
await ok("plain SELECT works with parameters", async () => {
  const r = await sql.query("SELECT a, b FROM kpi WHERE a > ? ORDER BY a", { params: [40] });
  assert.equal(r.rowCount, 9);
  assert.deepEqual(r.columns, ["a", "b"]);
  assert.equal(r.rows[0][0], 41);
});
await ok("row cap truncates and reports it", async () => {
  const r = await sql.query("SELECT a FROM kpi");
  assert.equal(r.rowCount, 10);
  assert.equal(r.truncated, true);
});
await ok("runaway query is terminated by the timeout", async () => {
  const t0 = Date.now();
  await assert.rejects(
    () =>
      sql.query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT sum(x) FROM c", {
        timeoutMs: 800,
      }),
    (e) => e.code === "QUERY_TIMEOUT"
  );
  assert.ok(Date.now() - t0 < 10_000, "timeout fired promptly");
});
await ok("tableSchema reads pragma_table_info via SELECT", async () => {
  const schema = await sql.tableSchema("kpi");
  assert.deepEqual(schema.map((c) => c.name), ["ts", "a", "b"]);
});

console.log("Figure validator:");
await ok("accepts a valid heatmap figure", async () => {
  const v = validateFigures([
    { data: [{ type: "heatmap", z: [[1, 0.5], [0.5, 1]] }], layout: { title: "t" } },
  ]);
  assert.equal(v.ok, true, v.errors.join("; "));
});
await ok("accepts scattermap (geo family)", async () => {
  const v = validateFigures([
    { data: [{ type: "scattermap", lat: [35.6], lon: [139.6] }], layout: { map: { style: "open-street-map" } } },
  ]);
  assert.equal(v.ok, true, v.errors.join("; "));
});
await ok("rejects a disallowed trace type", async () => {
  const v = validateFigures([{ data: [{ type: "evil_script", x: [1] }] }]);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /not allowed/);
});
await ok("rejects an oversized figure with a downsample instruction", async () => {
  const big = { data: [{ type: "scatter", x: Array.from({ length: 500 }, (_, i) => i), y: Array.from({ length: 500 }, (_, i) => i) }] };
  const v = validateFigures([big], { maxPointsPerFigure: 100 });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /downsample|Aggregate/i);
});
await ok("rejects unexpected top-level keys", async () => {
  const v = validateFigures([{ data: [{ type: "scatter", x: [1] }], onload: "alert(1)" }]);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /unexpected top-level key/);
});
await ok("rejects a non-array figures payload", async () => {
  const v = validateFigures("not-an-array");
  assert.equal(v.ok, false);
});

console.log("Dataset registry:");
await ok("put/get round-trip and metadata", async () => {
  const reg = new DatasetRegistry({ ttlMs: 60_000 });
  const info = reg.put("t", { a: [1, 2, 3], b: ["x", "y", "z"] });
  assert.match(info.handle, /^ds_/);
  assert.equal(reg.get(info.handle).rowCount, 3);
  assert.equal(reg.describe(info.handle).columns.join(), "a,b");
  reg.close();
});
await ok("expired handle reads as missing", async () => {
  const reg = new DatasetRegistry({ ttlMs: 50 });
  const info = reg.put("t", { a: [1] });
  await sleep(130);
  assert.equal(reg.get(info.handle), null);
  assert.equal(reg.describe(info.handle), null);
  reg.close();
});
await ok("unknown handle reads as missing (clean error path)", async () => {
  const reg = new DatasetRegistry({});
  assert.equal(reg.get("ds_doesnotexist"), null);
  reg.close();
});
await ok("ragged columns are rejected at put time", async () => {
  const reg = new DatasetRegistry({});
  assert.throws(() => reg.put("t", { a: [1, 2], b: [1] }), /not an array of length/);
  reg.close();
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nunit.test.mjs: ${passed} checks passed`);
