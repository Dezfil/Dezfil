import { provisionJourney } from "./journey-auth.mjs";
// In-container export probe: runs INSIDE the
// image (mounted at /probes) against its own loopback API, so it works
// with --network=none. Seeds a minimal table + map + layer, POSTs a
// server image export, and proves DATA PIXELS — a blank or basemap-only
// render fails. With --expect-unavailable it asserts the negative
// instead: the export answers the coded render_unavailable while health
// stays green (the browser-removed derived image).
//
// With --tiled, the layer crosses the configured render cap and proves the
// application-owned parser worker inside the egress-less image.
//
// Usage: node /probes/offline-export-probe.mjs [--tiled|--expect-unavailable]
import { decodePng, countColored } from "./png-probe.mjs";

const base = process.env.DEZFIL_BASE_URL ?? "http://127.0.0.1:3000";
const authenticatedFetch = (await provisionJourney(base)).fetch;
const expectUnavailable = process.argv.includes("--expect-unavailable");
const expectTiled = process.argv.includes("--tiled");

function fail(msg, detail) {
  console.error(`✗ ${msg}${detail ? ` — ${detail}` : ""}`);
  process.exit(1);
}

const health = await fetch(`${base}/api/health`);
if (!health.ok) fail("health not green before the probe");

// Seed: a four-point CSV, a map, a styled layer.
const csv = [
  "name,lon,lat,riders",
  "alexanderplatz,13.410,52.520,900",
  "hackescher,13.402,52.523,700",
  "zoo,13.330,52.510,500",
  "sudkreuz,13.360,52.480,120",
].join("\n");
const form = new FormData();
form.append(
  "file",
  new Blob([csv], { type: "text/csv" }),
  `probe_${Date.now().toString(36)}.csv`,
);
const upload = await authenticatedFetch(`${base}/api/tables`, { method: "POST", body: form });
if (!upload.ok) fail("seed upload failed", String(upload.status));
const table = (await upload.json()).name;

const mapRes = await authenticatedFetch(`${base}/api/maps`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Offline export probe" }),
});
if (!mapRes.ok) fail("map create failed", String(mapRes.status));
const mapId = (await mapRes.json()).id;

const layerRes = await authenticatedFetch(`${base}/api/maps/${mapId}/layers`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "probe",
    sql: expectTiled
      ? `SELECT
           ST_Point(
             ST_X(p.geometry) + (r.i % 60) * 0.0005,
             ST_Y(p.geometry) + floor(r.i / 60) * 0.0005
           ) AS geometry
         FROM (SELECT geometry FROM "${table}" LIMIT 1) AS p
         CROSS JOIN range(0, 2401) AS r(i)`
      : `SELECT * FROM "${table}"`,
  }),
});
if (!layerRes.ok) fail("layer create failed", String(layerRes.status));
const layerId = (await layerRes.json()).id;

if (expectTiled) {
  let render;
  const deadline = Date.now() + 120_000;
  do {
    const response = await authenticatedFetch(`${base}/api/layers/${layerId}/render`);
    if (!response.ok) fail("tiled render probe failed", String(response.status));
    render = await response.json();
    if (render?.tiles?.state === "building") {
      if (Date.now() >= deadline) fail("tiled archive did not settle in 120s");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } while (render?.tiles?.state === "building");
  if (render?.mode !== "tiled" || render?.tiles?.state !== "ready") {
    fail("probe layer did not reach ready tiled mode", JSON.stringify(render));
  }
}

const definition = {
  viewport: expectTiled
    ? { lng: 13.425, lat: 52.53, zoom: 12.5, pitch: 0, bearing: 0 }
    : { lng: 13.37, lat: 52.5, zoom: 10, pitch: 0, bearing: 0 },
  size: { width: 640, height: 360 },
  legend: { visible: false, corner: "bottom-left", size: "m" },
  widgets: [],
  title: null,
  appearance: "light",
  overlayScale: 2,
};
const exp = await authenticatedFetch(`${base}/api/maps/${mapId}/export/image`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ definition }),
});

if (expectUnavailable) {
  if (exp.status !== 503) {
    fail("expected render_unavailable, got", String(exp.status));
  }
  const body = await exp.json().catch(() => null);
  if (body?.error?.code !== "render_unavailable") {
    fail("expected the coded render_unavailable", JSON.stringify(body));
  }
  const after = await fetch(`${base}/api/health`);
  if (!after.ok) fail("health went red over a missing browser");
  console.log("✓ browser-removed negative: export coded, health green");
  process.exit(0);
}

if (!exp.ok) {
  fail("export did not answer 200", `${exp.status} ${await exp.text()}`);
}
const png = Buffer.from(await exp.arrayBuffer());
const img = decodePng(png);
if (img.width !== 640 || img.height !== 360) {
  fail("export dimensions wrong", `${img.width}×${img.height}`);
}
const colored = countColored(img);
if (colored < 200) {
  fail("no data pixels in the offline export", `colored=${colored}`);
}
console.log(
  `✓ offline ${expectTiled ? "tiled " : ""}export renders data pixels (colored=${colored})`,
);
