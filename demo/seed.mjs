// Seed the Glassbox demo database.
//
// Creates an hourly KPI time series for 30 sites over 60 days (43,200 rows)
// in a SQLite table `kpi_hourly`:
//   timestamp, site_id, lat, lon,
//   users, throughput_mbps, latency_ms, packet_loss_pct, cpu_pct
//
// The data carries a shared daily cycle (so raw correlations are inflated,
// per DESIGN.md §8) and one planted relationship: each site's latency_ms
// is driven by that site's own throughput_mbps value exactly 2 hours
// earlier (including its noise, so the relationship is specific to the
// throughput→latency pair and not just to the shared cycle) — the lagged
// cross-correlation in the demo flow must find it, mirroring the Phase 0
// spike benchmark.
//
// Deterministic (seeded PRNG) so every seed produces identical data.
// Usage: node demo/seed.mjs [db-path]   (default: demo/glassbox-demo.db,
// or $GLASSBOX_DB_PATH)

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbPath =
  process.argv[2] || process.env.GLASSBOX_DB_PATH || path.join(ROOT, "demo", "glassbox-demo.db");

const N_SITES = 30;
const N_DAYS = 60;
const HOURS = N_DAYS * 24; // 1440
const START = Date.UTC(2026, 8, 1, 0, 0, 0); // 2026-09-01T00:00:00Z

// mulberry32 — small deterministic PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261120);
const gauss = () => (rand() + rand() + rand() + rand() - 2) / 2; // approx N(0, ~0.29)

// Shared underlying driver: daily cycle + weekly cycle + smoothed noise.
const white = Array.from({ length: HOURS + 48 }, () => gauss());
const smooth = white.map((_, i) => {
  let s = 0;
  for (let k = -4; k <= 4; k++) s += white[Math.max(0, Math.min(white.length - 1, i + k))];
  return s / 9;
});
// A second, independent smoothed-noise series: `users` gets its own wander
// on top of the shared driver, so users/throughput are strongly related
// (as in real networks) but not the same series twice.
const white2 = Array.from({ length: HOURS + 48 }, () => gauss());
const smooth2 = white2.map((_, i) => {
  let s = 0;
  for (let k = -4; k <= 4; k++) s += white2[Math.max(0, Math.min(white2.length - 1, i + k))];
  return s / 9;
});
function sig(t) {
  const hour = t % 24;
  const daily = Math.sin((2 * Math.PI * (hour - 9)) / 24);
  const weekly = 0.3 * Math.sin((2 * Math.PI * t) / (24 * 7));
  return daily + weekly + 0.55 * smooth[t + 24];
}

// Sites scattered around the Tokyo area, each with its own amplitude.
const sites = Array.from({ length: N_SITES }, (_, i) => ({
  id: `site_${String(i + 1).padStart(2, "0")}`,
  lat: 35.55 + rand() * 0.35,
  lon: 139.5 + rand() * 0.5,
  amp: 0.7 + rand() * 0.6,
}));

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE kpi_hourly (
    timestamp TEXT NOT NULL,
    site_id TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    users REAL NOT NULL,
    throughput_mbps REAL NOT NULL,
    latency_ms REAL NOT NULL,
    packet_loss_pct REAL NOT NULL,
    cpu_pct REAL NOT NULL
  );
  CREATE INDEX idx_kpi_ts ON kpi_hourly(timestamp);
`);
const insert = db.prepare(`
  INSERT INTO kpi_hourly
    (timestamp, site_id, lat, lon, users, throughput_mbps, latency_ms, packet_loss_pct, cpu_pct)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Precompute each site's throughput series: latency is driven by it (+2h),
// so it must exist before the row loop.
for (const site of sites) {
  site.thr = new Float64Array(HOURS);
  for (let t = 0; t < HOURS; t++) {
    site.thr[t] = clamp(420 + 210 * site.amp * sig(t) + gauss() * 36, 10, 1500);
  }
}

db.exec("BEGIN");
let n = 0;
for (let t = 0; t < HOURS; t++) {
  const ts = new Date(START + t * 3600_000).toISOString().replace(".000Z", "Z");
  const s0 = sig(t);
  const sLag1 = sig(t - 1);
  for (const site of sites) {
    const a = site.amp;
    const thr = site.thr[t];
    const thrLag2 = site.thr[Math.max(0, t - 2)]; // the planted +2h driver
    insert.run(
      ts,
      site.id,
      site.lat,
      site.lon,
      Math.round(clamp(950 + 430 * a * s0 + 380 * smooth2[t + 24] + gauss() * 90, 5, 4000)),
      thr,
      clamp(24 + 0.042 * (thrLag2 - 420) + gauss() * 2.2, 3, 120),
      clamp(0.4 + 0.25 * Math.max(0, sLag1) + Math.abs(gauss()) * 0.24, 0, 8),
      clamp(46 + 17 * a * s0 + gauss() * 8, 2, 98)
    );
    n++;
  }
}
db.exec("COMMIT");
db.close();
console.log(`seeded ${n} rows (${N_SITES} sites x ${HOURS} hours) into ${dbPath}`);
