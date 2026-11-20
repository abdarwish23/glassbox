// One-shot query runner process for the SQL tool. Receives one query over
// IPC, executes it against the SQLite database opened READ-ONLY, sends the
// result back, and exits. The parent (sqltool.mjs) enforces the query
// timeout with SIGKILL — node:sqlite is synchronous and a single aggregate
// step over an unbounded recursive CTE never returns to the JS VM, so
// in-process interruption (worker.terminate) cannot be relied on; a
// separate process can always be killed.
import { DatabaseSync } from "node:sqlite";

process.on("message", ({ dbPath, sql, params, maxRows }) => {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare(sql);
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    const rows = [];
    let truncated = false;
    for (const row of stmt.iterate(...params)) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    db.close();
    process.send({ ok: true, columns, rows, rowCount: rows.length, truncated }, () => process.exit(0));
  } catch (e) {
    process.send({ ok: false, error: String(e && e.message ? e.message : e) }, () => process.exit(1));
  }
});
