// 03 — Correlation benchmark: synthetic hourly KPI dataset (~500k values),
//      Pearson / Spearman / detrended / lagged cross-correlation inside Pyodide.
// Run: node 03-corr-benchmark.mjs
import { memMB, writeResult } from "./lib.mjs";
import { loadPyodide } from "pyodide";

const pyodide = await loadPyodide();
await pyodide.loadPackage(["numpy", "pandas", "scipy"]);

const memBefore = memMB();

const py = JSON.parse(
  pyodide.runPython(`
import json, time
import numpy as np
import pandas as pd
from scipy.signal import lfilter

rng = np.random.default_rng(42)
N_HOURS = 8760          # one year of hourly samples
N_SERIES = 57           # KPI columns -> 8760 x 57 = 499,320 values
t = np.arange(N_HOURS)
hour_of_day = t % 24
day_of_week = (t // 24) % 7

def ar1(n, rho, scale, rng):
    e = rng.normal(0, scale, n)
    return lfilter([1.0], [1.0, -rho], e)

# ---- generate ----
t0 = time.perf_counter()
cols = {}
# 55 background KPIs: shared daily cycle (the seasonality trap) + own AR noise
for i in range(55):
    phase = rng.uniform(0, 2 * np.pi)
    amp = rng.uniform(0.6, 1.4)
    daily = amp * np.sin(2 * np.pi * hour_of_day / 24 + phase)
    weekly = 0.3 * np.sin(2 * np.pi * day_of_week / 7 + phase)
    cols[f"kpi_{i:02d}"] = 50 + daily + weekly + ar1(N_HOURS, 0.7, 1.0, rng)

# planted pair: kpi_b(t) = 0.85 * s(t-2) + noise  => B lags A by exactly 2 hours
s = 1.2 * np.sin(2 * np.pi * hour_of_day / 24) + ar1(N_HOURS, 0.8, 1.0, rng)
a = s + rng.normal(0, 0.25, N_HOURS)
b = np.empty(N_HOURS)
b[:2] = rng.normal(0, 0.3, 2)
b[2:] = 0.85 * s[:-2] + rng.normal(0, 0.3, N_HOURS - 2)
cols["kpi_a"] = a
cols["kpi_b"] = b

idx = pd.date_range("2025-01-01", periods=N_HOURS, freq="h")
df = pd.DataFrame(cols, index=idx)
gen_s = time.perf_counter() - t0

out = {
  "shape": list(df.shape),
  "n_values": int(df.size),
  "df_memory_mb": round(float(df.memory_usage(deep=True).sum()) / 1048576, 1),
  "gen_s": round(gen_s, 3),
}

# ---- Pearson matrix ----
t0 = time.perf_counter()
pear = df.corr(method="pearson")
out["pearson_matrix_s"] = round(time.perf_counter() - t0, 3)

# ---- Spearman matrix ----
t0 = time.perf_counter()
spear = df.corr(method="spearman")
out["spearman_matrix_s"] = round(time.perf_counter() - t0, 3)

# ---- Detrended (first differences) Pearson ----
t0 = time.perf_counter()
detr = df.diff().corr(method="pearson")
out["detrended_diff_pearson_s"] = round(time.perf_counter() - t0, 3)

# seasonality-trap evidence: mean |r| over off-diagonal pairs, raw vs detrended
def mean_abs_offdiag(m):
    v = m.values
    return float(np.abs(v[np.triu_indices_from(v, k=1)]).mean())
out["mean_abs_r_raw"] = round(mean_abs_offdiag(pear), 3)
out["mean_abs_r_detrended"] = round(mean_abs_offdiag(detr), 3)

# ---- Lagged cross-correlation, planted pair ----
# r(L) = corr(A(t), B(t+L)); B was built as B(t) = 0.85*s(t-2) and A ~ s,
# so the peak is expected at L = +2.
t0 = time.perf_counter()
av = df["kpi_a"].to_numpy()
bv = df["kpi_b"].to_numpy()
lags, rs = [], []
for L in range(-24, 25):
    if L >= 0:
        x, y = av[: N_HOURS - L] if L else av, bv[L:]
    else:
        x, y = av[-L:], bv[: N_HOURS + L]
    lags.append(L)
    rs.append(float(np.corrcoef(x, y)[0, 1]))
lag_s = time.perf_counter() - t0
best = int(np.argmax(rs))
out["lagged_xcorr_s"] = round(lag_s, 3)
out["lagged_best_lag_h"] = lags[best]
out["lagged_best_r"] = round(rs[best], 4)
out["planted_lag_h"] = 2
out["lag_found_correctly"] = bool(lags[best] == 2)
out["planted_pair_r_at_lag0"] = round(float(pear.loc["kpi_a", "kpi_b"]), 4)
out["planted_pair_r_at_lag2"] = round(rs[lags.index(2)], 4)
json.dumps(out)
`)
);

writeResult("logs/03-corr-benchmark.json", {
  test: "03-corr-benchmark",
  ...py,
  node_memory_before: memBefore,
  node_memory_after: memMB(),
});
