// SQL tool (DESIGN.md §5.2) — read-only by construction, three layers:
//   1. Statement check: a single statement, must start with SELECT or WITH,
//      and must not contain any DDL/DML keyword anywhere (this also kills
//      the SQLite "WITH … UPDATE/DELETE" trick). Multiple statements are
//      rejected outright.
//   2. The database is opened read-only (node:sqlite { readOnly: true })
//      inside a throwaway child process per query.
//   3. Caps: row cap (default 100k, truncation is reported, never silent)
//      and a query timeout enforced by SIGKILLing the runner process
//      (a synchronous native SQLite step cannot be interrupted in-process,
//      so the timeout must live outside the executing process).
//
// Backend note: SQLite via Node's built-in node:sqlite is the MVP backend
// (zero external services). The public interface — query(sql, {params,
// maxRows, timeoutMs}) → {columns, rows, rowCount, truncated} — is the
// seam behind which a Postgres/MySQL adapter can be added later; Bahaa's
// production DB type is still an open question (DESIGN.md Q4), so nothing
// outside this file assumes SQLite.

import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "sql-runner.mjs");

const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|vacuum|reindex|grant|revoke|truncate|begin|commit|rollback|savepoint|release)\b/i;

export class SqlToolError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// Pure statement validation — exported for unit tests.
export function assertReadOnlySelect(sql) {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new SqlToolError("SQL statement is empty", "EMPTY_SQL");
  }
  let s = sql.trim();
  if (s.endsWith(";")) s = s.slice(0, -1).trimEnd();
  if (s.includes(";")) {
    throw new SqlToolError("multiple statements are not allowed; submit a single SELECT", "MULTI_STATEMENT");
  }
  if (!/^(select|with)\b/i.test(s)) {
    throw new SqlToolError("only SELECT statements are allowed", "NOT_A_SELECT");
  }
  const kw = s.match(FORBIDDEN_KEYWORDS);
  if (kw) {
    throw new SqlToolError(`statement contains forbidden keyword "${kw[0]}"; the SQL tool is read-only`, "FORBIDDEN_KEYWORD");
  }
  return s;
}

export class SqlTool {
  constructor(dbPath, { defaultMaxRows = 100_000, defaultTimeoutMs = 30_000 } = {}) {
    if (!dbPath) throw new Error("SqlTool requires a database path");
    this.dbPath = dbPath;
    this.defaultMaxRows = defaultMaxRows;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async query(sql, { params = [], maxRows, timeoutMs } = {}) {
    const clean = assertReadOnlySelect(sql);
    const limit = maxRows ?? this.defaultMaxRows;
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const child = fork(RUNNER_PATH, [], { silent: true });
      let settled = false;
      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch {}
        fn(val);
      };
      const timer = setTimeout(() => {
        settle(
          reject,
          new SqlToolError(`query exceeded the ${Math.round(timeout / 1000)}s timeout and the runner was killed`, "QUERY_TIMEOUT")
        );
      }, timeout);
      timer.unref();
      child.once("message", (msg) => {
        if (msg.ok) {
          settle(resolve, { columns: msg.columns, rows: msg.rows, rowCount: msg.rowCount, truncated: msg.truncated });
        } else {
          settle(reject, new SqlToolError(msg.error, "QUERY_FAILED"));
        }
      });
      child.once("error", (e) => {
        settle(reject, new SqlToolError(String(e && e.message ? e.message : e), "QUERY_FAILED"));
      });
      child.once("exit", (code) => {
        if (!settled) {
          settle(reject, new SqlToolError(`query runner exited (code ${code}) without a result`, "QUERY_FAILED"));
        }
      });
      child.send({ dbPath: this.dbPath, sql: clean, params, maxRows: limit });
    });
  }

  // Schema of one table: [{name, type}] via the pragma_table_info
  // table-valued function (usable inside a SELECT, so it passes the
  // statement check like any other read).
  async tableSchema(table) {
    const { rows } = await this.query("SELECT name, type FROM pragma_table_info(?)", { params: [table] });
    return rows.map(([name, type]) => ({ name, type }));
  }

  async listTables() {
    const { rows } = await this.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    return rows.map(([name]) => name);
  }
}
