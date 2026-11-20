// Planners for the agent service (DESIGN.md §5.1, §8).
//
// A planner turns a question into tool calls (sql_query / run_python) and
// a final { answer_summary, figures, stats }. Two implementations:
//
//  - DemoPlanner (default, no keys): deterministic. Inspects the demo DB
//    schema, fetches the hourly KPI table via the SQL tool, and generates
//    sandbox code for the §8 correlation suite — raw + detrended Pearson
//    heatmaps, ranked pairs with p-values, a lagged cross-correlation
//    scan over all pairs (the lead/lag pair is selected by margin over
//    its own lag-0 correlation), and a scattermap when the table has
//    lat/lon.
//
//  - LlmPlanner: a tool-calling loop over the official Anthropic or OpenAI
//    SDK (selected by which API key is present). Same tools, same
//    validator; the §8 discipline rules are in the system prompt. Every
//    figure the model produces is validated before it is returned; invalid
//    figures are sent back to the model as tool errors so it can fix them.

import { rowsToColumnar } from "../worker/datasets.mjs";
import { validateFigures } from "../shared/validator.mjs";

const SYSTEM_PROMPT = `You are Glassbox, an analytics agent. You answer questions about data in a SQL database by (1) fetching data with the sql_query tool (read-only SELECT only; results are registered as datasets and you receive the schema plus a small preview, never the full rows), then (2) writing Python with the run_python tool to analyse the dataset and build Plotly figures.

In run_python, the dataset is already loaded as a pandas DataFrame named \`df\`. numpy (np), pandas (pd), scipy, statsmodels, scikit-learn and plotly are available. End your code by assigning a dict to \`result\` with optional "figures" (a list of json.loads(fig.to_json()) objects) and "summary" (JSON-safe stats).

Statistics discipline (mandatory):
- For hourly time series, raw Pearson correlation is misleading: shared daily seasonality inflates it. Always also compute detrended correlation (first differences or residuals after removing the hour-of-day profile) and say which you used.
- For the most interesting pair, compute lagged cross-correlation over lags -24..+24 hours and report the best lag ("A leads B by N h").
- Report n and p-values with every correlation coefficient. Warn when many pairs are tested (some will look significant by chance). Correlation is a hypothesis generator, not proof of cause.
- Keep figures modest: aggregate or downsample rather than plotting hundreds of thousands of points; oversized figures are rejected with an explanation.

Be concise in your final summary: state the data analysed, the method, the headline findings with numbers, and the caveats.`;

const TOOL_DEFS = {
  sql_query: {
    description:
      "Run a single read-only SELECT against the database. The full result is registered as a dataset for run_python; you receive the columns, row count, and a 5-row preview.",
    properties: {
      sql: { type: "string", description: "A single SELECT statement (parameterless)." },
    },
    required: ["sql"],
  },
  run_python: {
    description:
      "Run Python in the sandbox against the most recent dataset (loaded as `df`). End by assigning a dict to `result` with optional 'figures' and 'summary'.",
    properties: {
      code: { type: "string", description: "Python source code." },
      dataset_handle: { type: "string", description: "Optional dataset handle from a previous sql_query; defaults to the latest dataset." },
    },
    required: ["code"],
  },
};

// ---------------------------------------------------------------- demo ---

export function buildCorrelationCode({ kpiColumns, hasGeo }) {
  const kpis = JSON.stringify(kpiColumns);
  return `
import numpy as np, pandas as pd, json
from scipy import stats
import plotly.graph_objects as go
import plotly.express as px

KPIS = ${kpis}
df["timestamp"] = pd.to_datetime(df["timestamp"])
ts = df.groupby("timestamp")[KPIS].mean().sort_index()
n_ts = int(len(ts))

raw = ts.corr(method="pearson")
det = ts.diff().dropna().corr(method="pearson")

def heat(mat, title):
    fig = go.Figure(data=go.Heatmap(
        z=mat.values, x=list(mat.columns), y=list(mat.index),
        zmin=-1, zmax=1, colorscale="RdBu",
        text=np.round(mat.values, 2), texttemplate="%{text}"))
    fig.update_layout(title=title)
    return fig

# ranked detrended pairs with p-values
diff = ts.diff().dropna()
pairs = []
cols = list(ts.columns)
for i in range(len(cols)):
    for j in range(i + 1, len(cols)):
        a, b = cols[i], cols[j]
        r = float(det.loc[a, b])
        p = float(stats.pearsonr(diff[a], diff[b]).pvalue)
        pairs.append({"a": a, "b": b, "r": round(r, 3), "p": p, "n": int(len(diff))})
pairs.sort(key=lambda d: -abs(d["r"]))
top = pairs[0]

# Lagged cross-correlation scan over ALL pairs, on the raw aggregated
# series. A pair qualifies as a lead/lag finding only if its best non-zero
# lag beats its own lag-0 correlation by a clear margin (>= 0.03) — that
# disqualifies simultaneous look-alikes riding the same cycle, whose
# profiles peak at lag 0. Among qualifying pairs, the strongest peak |r|
# wins: a true driver/response pair (the response literally follows the
# driver's own values, noise included) peaks higher than pairs that merely
# share the underlying cycle. If nothing qualifies, fall back to the
# largest-margin pair and let the summary say so. (Selecting the top
# detrended pair instead would be wrong — first differences destroy the
# lag structure of smooth signals.)
lags = list(range(-24, 25))
def lag_profile(a_s, b_s):
    rs = []
    for lag in lags:
        # r at "lag" pairs a(t) with b(t+lag): a peak at lag > 0 means
        # a LEADS b by lag hours.
        shifted = b_s.shift(-lag)
        m = a_s.notna() & shifted.notna()
        rs.append(float(np.corrcoef(a_s[m], shifted[m])[0, 1]) if m.sum() > 10 else float("nan"))
    return rs

best = None       # best qualifying pair (margin >= 0.03), by peak |r|
best_fb = None    # fallback: largest margin
for i in range(len(cols)):
    for j in range(i + 1, len(cols)):
        a, b = cols[i], cols[j]
        prof = lag_profile(ts[a] - ts[a].mean(), ts[b] - ts[b].mean())
        r0 = prof[lags.index(0)]
        nz = [(abs(r), k) for k, r in enumerate(prof) if lags[k] != 0 and not np.isnan(r)]
        peak_abs, peak_k = max(nz)
        margin = peak_abs - abs(r0)
        cand = {"a": a, "b": b, "profile": prof, "peak_k": peak_k,
                "lag_hours": int(lags[peak_k]), "r_peak": float(prof[peak_k]),
                "r0": float(r0), "margin": float(margin)}
        if best_fb is None or cand["margin"] > best_fb["margin"]:
            best_fb = cand
        if margin >= 0.03 and (best is None or abs(cand["r_peak"]) > abs(best["r_peak"])):
            best = cand
if best is None:
    best = best_fb
rs = best["profile"]
best_lag = best["lag_hours"]
lag_fig = go.Figure(data=go.Scatter(x=lags, y=rs, mode="lines+markers",
                                    name="cross-correlation"))
lag_fig.add_vline(x=best_lag, line_dash="dash")
lag_fig.update_layout(
    title=f"Lagged cross-correlation: {best['a']} vs {best['b']} (peak at lag {best_lag:+d} h)",
    xaxis_title="lag (hours; positive = first series leads)",
    yaxis_title="Pearson r")

figures = [
    json.loads(heat(raw, "Raw Pearson correlation (hourly means across sites)").to_json()),
    json.loads(heat(det, "Detrended correlation (first differences) — the honest view").to_json()),
    json.loads(lag_fig.to_json()),
]

summary = {
    "method": "Pearson on hourly means across sites; detrended = correlation of first differences; lagged cross-correlation over -24..+24 h on the raw aggregated series",
    "n_timestamps": n_ts,
    "n_rows": int(len(df)),
    "n_sites": int(df["site_id"].nunique()) if "site_id" in df.columns else None,
    "kpis": KPIS,
    "top_pairs_detrended": pairs[:5],
    "best_lag": {
        "a": best["a"], "b": best["b"],
        "lag_hours": best_lag,
        "r_at_best_lag": round(best["r_peak"], 3),
        "r_at_lag_0": round(best["r0"], 3),
        "margin_over_lag_0": round(best["margin"], 3),
        "selection": "all KPI pairs scanned; a pair qualifies if its best non-zero-lag |r| beats its lag-0 |r| by >= 0.03; among qualifiers the strongest peak |r| wins (fallback: largest margin)",
        "interpretation": (f"{best['a']} leads {best['b']} by {best_lag} h" if best_lag > 0
                           else f"{best['b']} leads {best['a']} by {-best_lag} h" if best_lag < 0
                           else "peak at lag 0 — the two move together"),
    },
}
${hasGeo ? `
# geographic view: per-site mean of the lag pair's response KPI
site_means = df.groupby(["site_id", "lat", "lon"])[best["b"]].mean().reset_index()
map_fig = px.scatter_map(site_means, lat="lat", lon="lon", color=best["b"], size=best["b"],
                         hover_name="site_id", zoom=9, map_style="open-street-map",
                         title=f"Mean {best['b']} by site")
figures.append(json.loads(map_fig.to_json()))
summary["map"] = "scattermap of per-site mean " + best["b"]
` : ""}
result = {"figures": figures, "summary": summary}
`;
}

export class DemoPlanner {
  constructor({ sql, worker }) {
    this.sql = sql;
    this.worker = worker;
    this.name = "demo";
  }

  async ask(question) {
    const tables = await this.sql.listTables();
    if (tables.length === 0) throw new Error("database has no tables");
    const table = tables.includes("kpi_hourly") ? "kpi_hourly" : tables[0];
    const schema = await this.sql.tableSchema(table);
    const colNames = schema.map((c) => c.name);
    const numeric = schema
      .filter((c) => /int|real|float|double|num/i.test(c.type || ""))
      .map((c) => c.name);
    const kpiColumns = numeric.filter((c) => !["lat", "lon"].includes(c));
    const hasGeo = colNames.includes("lat") && colNames.includes("lon");
    if (!colNames.includes("timestamp") || kpiColumns.length < 2) {
      throw new Error(`table ${table} does not look like an hourly KPI table (needs timestamp + >=2 numeric KPIs)`);
    }

    const orderCol = colNames.includes("timestamp") ? "timestamp" : colNames[0];
    const { columns, rows, rowCount, truncated } = await this.sql.query(
      `SELECT ${colNames.map((c) => `"${c}"`).join(", ")} FROM "${table}" ORDER BY "${orderCol}"`
    );
    const columnar = rowsToColumnar(columns, rows);
    const ds = await this.worker.putDataset(table, columnar);

    const code = buildCorrelationCode({ kpiColumns, hasGeo });
    const contract = await this.worker.run(code, { datasetHandle: ds.handle, timeoutS: 60 });
    if (!contract.ok) {
      throw new Error(`sandbox analysis failed: ${contract.error?.type}: ${contract.error?.message}`);
    }
    const validation = validateFigures(contract.figures);
    if (!validation.ok) {
      throw new Error(`figure validation failed: ${validation.errors.join("; ")}`);
    }
    const s = contract.summary;
    const top = s.top_pairs_detrended?.[0];
    const lag = s.best_lag;
    const answer_summary =
      `Analysed ${s.n_rows.toLocaleString()} hourly rows from ${s.n_sites} sites ` +
      `(${s.n_timestamps} timestamps, KPIs: ${s.kpis.join(", ")}). ` +
      `Method: ${s.method}. ` +
      (top
        ? `Strongest detrended correlation: ${top.a} vs ${top.b}, r = ${top.r} (p = ${top.p.toExponential(1)}, n = ${top.n}). `
        : "") +
      (lag
        ? `Lagged cross-correlation peaks at ${lag.lag_hours >= 0 ? "+" : ""}${lag.lag_hours} h (r = ${lag.r_at_best_lag}, vs ${lag.r_at_lag_0} at lag 0): ${lag.interpretation}. `
        : "") +
      `Raw hourly correlations are inflated by the shared daily cycle — the detrended heatmap is the honest view. ` +
      `Correlation is a hypothesis generator, not proof of cause.` +
      (truncated ? ` Note: the SQL result was truncated at the row cap.` : "");
    return { answer_summary, figures: validation.figures, stats: s, planner: this.name };
  }
}

// ----------------------------------------------------------------- LLM ---

class ToolBox {
  constructor({ sql, worker }) {
    this.sql = sql;
    this.worker = worker;
    this.lastHandle = null;
    this.figures = [];
  }

  async sql_query({ sql }) {
    const { columns, rows, rowCount, truncated } = await this.sql.query(sql);
    const columnar = rowsToColumnar(columns, rows);
    const ds = await this.worker.putDataset("query_result", columnar);
    this.lastHandle = ds.handle;
    return {
      dataset_handle: ds.handle,
      columns,
      rowCount,
      truncated,
      preview: rows.slice(0, 5).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
    };
  }

  async run_python({ code, dataset_handle }) {
    const handle = dataset_handle || this.lastHandle;
    if (!handle) throw new Error("no dataset yet — call sql_query first");
    const contract = await this.worker.run(code, { datasetHandle: handle, timeoutS: 60 });
    if (!contract.ok) {
      return { ok: false, error: contract.error, stdout: contract.stdout };
    }
    const validation = validateFigures(contract.figures);
    if (!validation.ok) {
      return {
        ok: false,
        error: { type: "FigureValidation", message: validation.errors.join("; ") },
        summary: contract.summary,
        stdout: contract.stdout,
      };
    }
    this.figures.push(...validation.figures);
    return {
      ok: true,
      summary: contract.summary,
      stdout: contract.stdout,
      figures_accepted: validation.figures.length,
    };
  }

  async dispatch(name, args) {
    if (name === "sql_query") return this.sql_query(args);
    if (name === "run_python") return this.run_python(args);
    throw new Error(`unknown tool ${name}`);
  }
}

export class LlmPlanner {
  constructor({ sql, worker }) {
    this.sql = sql;
    this.worker = worker;
    this.provider = process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : process.env.OPENAI_API_KEY
        ? "openai"
        : null;
    if (!this.provider) throw new Error("LlmPlanner requires ANTHROPIC_API_KEY or OPENAI_API_KEY");
    this.name = `llm-${this.provider}`;
    this.model =
      process.env.GLASSBOX_LLM_MODEL ||
      (this.provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o");
  }

  async ask(question) {
    const box = new ToolBox({ sql: this.sql, worker: this.worker });
    const answer =
      this.provider === "anthropic"
        ? await this.#anthropicLoop(question, box)
        : await this.#openaiLoop(question, box);
    return { answer_summary: answer, figures: box.figures, stats: {}, planner: this.name };
  }

  async #anthropicLoop(question, box) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const tools = Object.entries(TOOL_DEFS).map(([name, d]) => ({
      name,
      description: d.description,
      input_schema: { type: "object", properties: d.properties, required: d.required },
    }));
    const messages = [{ role: "user", content: question }];
    for (let step = 0; step < 10; step++) {
      const resp = await client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      messages.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason !== "tool_use") {
        return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      }
      const results = [];
      for (const block of resp.content.filter((b) => b.type === "tool_use")) {
        let out, isError = false;
        try {
          out = await box.dispatch(block.name, block.input);
        } catch (e) {
          out = { error: String(e && e.message ? e.message : e) };
          isError = true;
        }
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(out).slice(0, 20000),
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: results });
    }
    return "The analysis loop reached its step limit before a final summary was produced.";
  }

  async #openaiLoop(question, box) {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI();
    const tools = Object.entries(TOOL_DEFS).map(([name, d]) => ({
      type: "function",
      function: {
        name,
        description: d.description,
        parameters: { type: "object", properties: d.properties, required: d.required },
      },
    }));
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
    ];
    for (let step = 0; step < 10; step++) {
      const resp = await client.chat.completions.create({
        model: this.model,
        tools,
        messages,
      });
      const msg = resp.choices[0].message;
      messages.push(msg);
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return (msg.content || "").trim();
      }
      for (const call of msg.tool_calls) {
        let out;
        try {
          out = await box.dispatch(call.function.name, JSON.parse(call.function.arguments || "{}"));
        } catch (e) {
          out = { error: String(e && e.message ? e.message : e) };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(out).slice(0, 20000),
        });
      }
    }
    return "The analysis loop reached its step limit before a final summary was produced.";
  }
}

export function createPlanner(deps) {
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    return new LlmPlanner(deps);
  }
  return new DemoPlanner(deps);
}
