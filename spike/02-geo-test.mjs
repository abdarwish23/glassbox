// 02 — Geo check: geopandas/shapely/h3 availability, Plotly scattermap JSON,
//      pure-Python haversine + geohash fallbacks.
// Run: node 02-geo-test.mjs
import { secs, memMB, timedLoadPackage, writeResult } from "./lib.mjs";
import { loadPyodide } from "pyodide";
import { performance } from "node:perf_hooks";

const result = {
  test: "02-geo-test",
  packages: {},
  load_times_s: {},
  scattermap: {},
  fallbacks: {},
  errors: {},
};

const pyodide = await loadPyodide();
await pyodide.loadPackage(["numpy", "pandas"]);

// plotly via micropip (established in test 01)
await pyodide.loadPackage("micropip");
const micropip = pyodide.pyimport("micropip");
await micropip.install("plotly");

// --- Availability: shapely, geopandas, h3 (all present in the Pyodide lock) ---
for (const pkg of ["shapely", "geopandas", "h3"]) {
  try {
    const ms = await timedLoadPackage(pyodide, [pkg]);
    result.load_times_s[pkg] = secs(ms);
  } catch (e) {
    result.errors[`load_${pkg}`] = String(e).slice(0, 400);
  }
}

result.packages = JSON.parse(
  pyodide.runPython(`
import json, importlib
out = {}
for m in ["shapely", "geopandas", "h3", "pyproj"]:
    try:
        mod = importlib.import_module(m)
        out[m] = {"status": "ok", "version": getattr(mod, "__version__", "unknown")}
    except Exception as e:
        out[m] = {"status": "FAILED", "error": repr(e)[:300]}
json.dumps(out)
`)
);

// --- Exercise geopandas/shapely for real (points, buffer, distance) ---
try {
  result.geopandas_exercise = JSON.parse(
    pyodide.runPython(`
import json
import geopandas as gpd
from shapely.geometry import Point
sites = gpd.GeoDataFrame(
    {"site": ["tokyo-1", "tokyo-2", "osaka-1"],
     "kpi": [0.92, 0.71, 0.85]},
    geometry=[Point(139.6503, 35.6762), Point(139.7670, 35.6812), Point(135.5023, 34.6937)],
    crs="EPSG:4326",
)
buf = sites.geometry.buffer(0.01)  # ~1km-ish in degrees; exercises GEOS
d = sites.geometry.iloc[0].distance(sites.geometry.iloc[2])
json.dumps({"rows": len(sites), "buffer_area_0": float(buf.iloc[0].area),
            "deg_distance_tokyo_osaka": float(d)})
`)
  );
} catch (e) {
  result.errors.geopandas_exercise = String(e).slice(0, 600);
}

// --- Exercise h3 for real ---
try {
  result.h3_exercise = JSON.parse(
    pyodide.runPython(`
import json, h3
cell = h3.latlng_to_cell(35.6762, 139.6503, 9)
lat, lng = h3.cell_to_latlng(cell)
neighbors = list(h3.grid_disk(cell, 1))
json.dumps({"cell": cell, "roundtrip_lat": lat, "roundtrip_lng": lng,
            "disk_k1_size": len(neighbors)})
`)
  );
} catch (e) {
  result.errors.h3_exercise = String(e).slice(0, 600);
}

// --- Plotly scattermap figure JSON generated inside Pyodide ---
try {
  const figJsonStr = pyodide.runPython(`
import json
import plotly.express as px
import pandas as pd
df = pd.DataFrame({
    "site": ["site-a", "site-b", "site-c", "site-d"],
    "lat": [35.6762, 35.6812, 35.6895, 35.6586],
    "lon": [139.6503, 139.7670, 139.6917, 139.7454],
    "throughput_mbps": [812.0, 640.0, 905.0, 388.0],
})
fig = px.scatter_map(df, lat="lat", lon="lon", size="throughput_mbps",
                     color="throughput_mbps", hover_name="site", zoom=10,
                     map_style="open-street-map")
fig.to_json()
`);
  const fig = JSON.parse(figJsonStr); // validate on the JS side, as the agent service would
  result.scattermap = {
    parses_as_json: true,
    trace_types: fig.data.map((t) => t.type),
    trace_point_count: fig.data[0].lat.length,
    layout_has_map: "map" in (fig.layout ?? {}),
    json_size_bytes: figJsonStr.length,
  };
} catch (e) {
  result.errors.scattermap = String(e).slice(0, 600);
}

// --- Pure-Python fallbacks: haversine + geohash ---
try {
  result.fallbacks = JSON.parse(
    pyodide.runPython(`
import json, math

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

# Tokyo (35.6762, 139.6503) -> Osaka (34.6937, 135.5023); known great-circle ~402 km
d = haversine_km(35.6762, 139.6503, 34.6937, 135.5023)

_B32 = "0123456789bcdefghjkmnpqrstuvwxyz"
def geohash_encode(lat, lon, precision=9):
    lat_r, lon_r = [-90.0, 90.0], [-180.0, 180.0]
    bits, ch, out = 0, 0, []
    even = True
    while len(out) < precision:
        if even:
            mid = sum(lon_r) / 2
            if lon > mid: bits = (bits << 1) | 1; lon_r[0] = mid
            else: bits <<= 1; lon_r[1] = mid
        else:
            mid = sum(lat_r) / 2
            if lat > mid: bits = (bits << 1) | 1; lat_r[0] = mid
            else: bits <<= 1; lat_r[1] = mid
        even = not even
        ch += 1
        if ch == 5:
            out.append(_B32[bits]); bits, ch = 0, 0
    return "".join(out)

def geohash_decode(h):
    lat_r, lon_r = [-90.0, 90.0], [-180.0, 180.0]
    even = True
    for c in h:
        v = _B32.index(c)
        for mask in (16, 8, 4, 2, 1):
            if even:
                if v & mask: lon_r[0] = sum(lon_r) / 2
                else: lon_r[1] = sum(lon_r) / 2
            else:
                if v & mask: lat_r[0] = sum(lat_r) / 2
                else: lat_r[1] = sum(lat_r) / 2
            even = not even
    return (sum(lat_r) / 2, sum(lon_r) / 2,
            (lat_r[1] - lat_r[0]) / 2, (lon_r[1] - lon_r[0]) / 2)

gh = geohash_encode(35.6762, 139.6503, 9)
clat, clon, elat, elon = geohash_decode(gh)
inside = abs(clat - 35.6762) <= elat and abs(clon - 139.6503) <= elon

json.dumps({
  "haversine_tokyo_osaka_km": round(d, 1),
  "haversine_expected_km": 402,
  "haversine_within_2pct": abs(d - 402) / 402 < 0.02,
  "geohash_precision9": gh,
  "geohash_known_prefix_ok": gh.startswith("xn76"),  # Tokyo cells start xn76...
  "geohash_roundtrip_point_inside_cell": inside,
})
`)
  );
} catch (e) {
  result.errors.fallbacks = String(e).slice(0, 600);
}

result.memory = memMB();
writeResult("logs/02-geo-test.json", result);
