// Figure validator (DESIGN.md §7).
//
// Every Plotly figure produced by sandbox code passes through here before it
// is allowed to reach a frontend. The frontend treats figure JSON as data,
// never code — this module is what makes that safe and bounded:
//   - figure must be a plain object with only {data, layout, frames} keys
//   - every trace type must be on the allowlist (standard Plotly types,
//     including the map family from §8.5)
//   - total data points per figure / per response are capped, so a runaway
//     analysis is rejected with a reason the agent can act on ("aggregate or
//     downsample"), never silently truncated
//   - serialized size per figure is capped

export const ALLOWED_TRACE_TYPES = new Set([
  "scatter", "bar", "heatmap", "histogram", "box", "violin", "pie",
  "contour", "table", "sunburst", "treemap", "funnel", "funnelarea",
  "indicator", "waterfall", "candlestick", "ohlc", "sankey", "parcats",
  "scatter3d", "surface", "mesh3d", "cone", "streamtube", "volume", "isosurface",
  // map family (§8.5)
  "scattermap", "scattermapbox", "densitymap", "densitymapbox",
  "choropleth", "choroplethmap", "choroplethmapbox",
]);

const ALLOWED_FIGURE_KEYS = new Set(["data", "layout", "frames"]);
const POINT_KEYS = ["x", "y", "z", "lat", "lon", "values", "locations", "r", "theta"];

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Count the data points a trace would plot. For 2-D arrays (heatmap z),
// count rows x row length.
function countTracePoints(trace) {
  let n = 0;
  for (const key of POINT_KEYS) {
    const v = trace[key];
    if (Array.isArray(v)) {
      if (v.length > 0 && Array.isArray(v[0])) {
        for (const row of v) n += Array.isArray(row) ? row.length : 1;
      } else {
        n = Math.max(n, v.length);
      }
    }
  }
  return n;
}

export function validateFigures(figures, opts = {}) {
  const maxFigures = opts.maxFigures ?? 10;
  const maxPointsPerFigure = opts.maxPointsPerFigure ?? 200_000;
  const maxTotalPoints = opts.maxTotalPoints ?? 500_000;
  const maxFigureBytes = opts.maxFigureBytes ?? 5_000_000;
  const errors = [];

  if (!Array.isArray(figures)) {
    return { ok: false, errors: ["figures must be an array of Plotly figure objects"], figures: [] };
  }
  if (figures.length > maxFigures) {
    errors.push(
      `too many figures: ${figures.length} (max ${maxFigures}). Return fewer, combined figures.`
    );
  }

  let totalPoints = 0;
  figures.forEach((fig, i) => {
    const where = `figure ${i}`;
    if (!isPlainObject(fig)) {
      errors.push(`${where}: not a plain object — build figures with plotly and json.loads(fig.to_json())`);
      return;
    }
    for (const key of Object.keys(fig)) {
      if (!ALLOWED_FIGURE_KEYS.has(key)) {
        errors.push(`${where}: unexpected top-level key "${key}" (allowed: data, layout, frames)`);
      }
    }
    if (!Array.isArray(fig.data) || fig.data.length === 0) {
      errors.push(`${where}: "data" must be a non-empty array of traces`);
      return;
    }
    if (fig.layout !== undefined && !isPlainObject(fig.layout)) {
      errors.push(`${where}: "layout" must be an object`);
    }
    let figPoints = 0;
    fig.data.forEach((trace, j) => {
      if (!isPlainObject(trace)) {
        errors.push(`${where} trace ${j}: not a plain object`);
        return;
      }
      const type = trace.type ?? "scatter";
      if (!ALLOWED_TRACE_TYPES.has(type)) {
        errors.push(
          `${where} trace ${j}: trace type "${type}" is not allowed. Use a standard Plotly type (scatter, bar, heatmap, scattermap, …).`
        );
      }
      figPoints += countTracePoints(trace);
    });
    if (figPoints > maxPointsPerFigure) {
      errors.push(
        `${where}: ${figPoints} data points exceeds the per-figure cap of ${maxPointsPerFigure}. Aggregate or downsample before plotting.`
      );
    }
    totalPoints += figPoints;
    let bytes = 0;
    try {
      bytes = JSON.stringify(fig).length;
    } catch {
      errors.push(`${where}: figure is not JSON-serializable`);
    }
    if (bytes > maxFigureBytes) {
      errors.push(
        `${where}: serialized size ${bytes} bytes exceeds the cap of ${maxFigureBytes}. Aggregate or downsample before plotting.`
      );
    }
  });
  if (totalPoints > maxTotalPoints) {
    errors.push(
      `total data points ${totalPoints} exceeds the response cap of ${maxTotalPoints}. Aggregate or downsample before plotting.`
    );
  }

  return { ok: errors.length === 0, errors, figures: errors.length === 0 ? figures : [] };
}
