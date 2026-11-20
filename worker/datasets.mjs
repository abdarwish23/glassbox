// Dataset registry for the worker sidecar (DESIGN.md §5.2/§5.3).
//
// Datasets are stored columnar ({ columnName: [values...] }) under a random
// handle. The agent service registers query results here; sandbox runs refer
// to them by handle, so large data never travels through the LLM context.
// Handles expire after a TTL and are swept periodically.

import { randomBytes } from "node:crypto";

export class DatasetRegistry {
  constructor({ ttlMs = 600_000, sweepMs = 60_000 } = {}) {
    this.ttlMs = ttlMs;
    this.store = new Map();
    this.sweeper = setInterval(() => this.sweep(), sweepMs);
    this.sweeper.unref();
  }

  put(name, columnar) {
    const columns = Object.keys(columnar ?? {});
    if (columns.length === 0) throw new Error("dataset has no columns");
    const rowCount = Array.isArray(columnar[columns[0]]) ? columnar[columns[0]].length : 0;
    for (const c of columns) {
      if (!Array.isArray(columnar[c]) || columnar[c].length !== rowCount) {
        throw new Error(`dataset column "${c}" is not an array of length ${rowCount}`);
      }
    }
    const handle = "ds_" + randomBytes(9).toString("hex");
    this.store.set(handle, {
      name: name || handle,
      columnar,
      columns,
      rowCount,
      expiresAt: Date.now() + this.ttlMs,
    });
    return { handle, name: name || handle, columns, rowCount };
  }

  get(handle) {
    const entry = this.store.get(handle);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(handle);
      return null;
    }
    return entry;
  }

  describe(handle) {
    const entry = this.get(handle);
    if (!entry) return null;
    return {
      handle,
      name: entry.name,
      columns: entry.columns,
      rowCount: entry.rowCount,
      expiresAt: entry.expiresAt,
    };
  }

  remove(handle) {
    return this.store.delete(handle);
  }

  sweep() {
    const now = Date.now();
    for (const [handle, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(handle);
    }
  }

  close() {
    clearInterval(this.sweeper);
  }
}

// Convert [{col: v, ...}, ...] row objects to columnar form.
export function rowsToColumnar(columns, rows) {
  const columnar = {};
  for (const c of columns) columnar[c] = new Array(rows.length);
  rows.forEach((row, i) => {
    columns.forEach((c, j) => {
      columnar[c][i] = Array.isArray(row) ? row[j] : row[c];
    });
  });
  return columnar;
}
