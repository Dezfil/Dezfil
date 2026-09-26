// Differentiator proof (spec success criteria): a dataset
// beyond browser-memory scale uploads, queries, aggregates — and, since
// renders whole as vector tiles and publishes — within the default
// limits, because the engine and the tiler are server-side.
//
//   node scripts/big-data.mjs <base-url> [approx-rows]
//
// Generates a GeoParquet of random points via the running instance's own
// query engine is not possible (read-only), so we generate a large CSV
// locally, upload it, then drive it server-side.

import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";

const base = process.argv[2] ?? "http://localhost:3000";
const rows = Number(process.argv[3] ?? 10_000_000); // ~1.3 GB CSV at this width
const FILE = "big-data.csv";

function die(msg, detail) {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
  if (detail) console.error(`     ${detail}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

// Deterministic pseudo-random so runs are comparable (no Math.random needed).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

async function generate() {
  const rand = lcg(42);
  const out = createWriteStream(FILE);
  out.write("id,lon,lat,category,value\n");
  const cats = ["a", "b", "c", "d", "e"];
  for (let i = 0; i < rows; i++) {
    const lon = (rand() * 360 - 180).toFixed(5);
    const lat = (rand() * 170 - 85).toFixed(5);
    const cat = cats[i % cats.length];
    const value = Math.floor(rand() * 100000);
    if (!out.write(`${i},${lon},${lat},${cat},${value}\n`)) {
      await new Promise((r) => out.once("drain", r));
    }
  }
  await new Promise((r) => out.end(r));
  const { size } = await stat(FILE);
  ok(`generated ${rows.toLocaleString()} rows (${(size / 1e9).toFixed(2)} GB)`);
  return size;
}

async function api(method, pathname, opts = {}) {
  const init = { method, headers: {} };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function main() {
  console.log(`\nBig-data differentiator proof → ${base}\n`);
  await generate();

  // Upload via a streamed body so we never buffer the whole file in memory.
  const { openAsBlob } = await import("node:fs");
  const blob = await openAsBlob(FILE);
  const form = new FormData();
  form.append("file", blob, "big_points.csv");

  let t = Date.now();
  const up = await api("POST", "/api/tables", { form });
  if (up.status !== 201) die("upload failed", JSON.stringify(up.json));
  ok(`uploaded → table "${up.json.name}" in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const table = up.json.name;

  // A full-scan aggregate: this is the server-side engine doing work no
  // browser could hold in memory.
  t = Date.now();
  const agg = await api("POST", "/api/query", {
    body: {
      sql: `SELECT category, count(*) AS n, avg(value) AS avg_value FROM ${table} GROUP BY category ORDER BY category`,
    },
  });
  if (agg.status !== 200 || agg.json.rowCount !== 5)
    die("aggregate query failed", JSON.stringify(agg.json));
  ok(`aggregated ${rows.toLocaleString()} rows server-side in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  // Aggregate to a layer that fits under the render cap (H3-less: grid-snap).
  const map = await api("POST", "/api/maps", { body: { name: "Big data" } });
  t = Date.now();
  const layer = await api("POST", `/api/maps/${map.json.id}/layers`, {
    body: {
      name: "Density",
      sql: `SELECT round(lon) AS lon, round(lat) AS lat, count(*) AS n,
                   ST_Point(round(lon), round(lat)) AS geometry
            FROM ${table} GROUP BY 1, 2`,
    },
  });
  if (layer.status !== 201) die("layer creation failed", JSON.stringify(layer.json));
  const render = await api("GET", `/api/layers/${layer.json.id}/render`);
  if (render.status !== 200 || render.json.ok !== true)
    die("layer did not render", JSON.stringify(render.json));
  ok(`aggregated into a ${render.json.featureCount}-feature layer in ${((Date.now() - t) / 1000).toFixed(1)}s (under the render cap)`);

  // The proof: the raw points — every single one — as a tiled layer.
  t = Date.now();
  const raw = await api("POST", `/api/maps/${map.json.id}/layers`, {
    body: {
      name: "Every point",
      sql: `SELECT id, category, value, ST_Point(lon, lat) AS geometry FROM ${table}`,
    },
  });
  if (raw.status !== 201) die("raw layer creation failed", JSON.stringify(raw.json));
  let tiled = await api("GET", `/api/layers/${raw.json.id}/render`);
  if (tiled.json?.mode !== "tiled")
    die("raw layer did not switch to tiles", JSON.stringify(tiled.json));
  while (tiled.json?.tiles?.state === "building") {
    await new Promise((r) => setTimeout(r, 5000));
    tiled = await api("GET", `/api/layers/${raw.json.id}/render`);
  }
  if (tiled.json?.tiles?.state !== "ready")
    die("tile build did not finish", JSON.stringify(tiled.json));
  ok(
    `tiled ${rows.toLocaleString()} raw points server-side in ${((Date.now() - t) / 1000).toFixed(1)}s (zoom ${tiled.json.tiles.minZoom}–${tiled.json.tiles.maxZoom})`,
  );

  // Style it by the numeric attribute — classification runs in the database.
  t = Date.now();
  const fill = await api("POST", `/api/layers/${raw.json.id}/fill`, {
    body: { attribute: "value", method: "quantile", classes: 5 },
  });
  if (fill.status !== 200) die("classification failed", JSON.stringify(fill.json));
  const current = await api("GET", `/api/layers/${raw.json.id}`);
  const patched = await api("PATCH", `/api/layers/${raw.json.id}`, {
    body: { style: { ...current.json.style, fill: fill.json } },
  });
  if (patched.status !== 200) die("styling failed", JSON.stringify(patched.json));
  ok(`quantile-classified ${rows.toLocaleString()} rows in ${((Date.now() - t) / 1000).toFixed(1)}s — no rebuild needed`);

  // Every data-driven channel over the full table — natural breaks
  // cluster a bounded sample, the outline classifies the categories, the
  // size scale resolves the value range — and none of it re-prepares tiles.
  const builtAt = tiled.json.tiles.builtAt;
  t = Date.now();
  const natural = await api("POST", `/api/layers/${raw.json.id}/fill`, {
    body: { attribute: "value", method: "natural", classes: 5 },
  });
  if (natural.status !== 200) die("natural breaks failed", JSON.stringify(natural.json));
  const naturalS = ((Date.now() - t) / 1000).toFixed(1);
  t = Date.now();
  const outline = await api("POST", `/api/layers/${raw.json.id}/fill`, {
    body: { attribute: "category", method: "categorical" },
  });
  if (outline.status !== 200) die("categorical outline failed", JSON.stringify(outline.json));
  const outlineS = ((Date.now() - t) / 1000).toFixed(1);
  t = Date.now();
  const scale = await api("POST", `/api/layers/${raw.json.id}/scale`, {
    body: { attribute: "value", range: [2, 14] },
  });
  if (scale.status !== 200) die("size scale failed", JSON.stringify(scale.json));
  const scaleS = ((Date.now() - t) / 1000).toFixed(1);
  const channels = await api("PATCH", `/api/layers/${raw.json.id}`, {
    body: {
      style: {
        ...patched.json.style,
        fill: natural.json,
        strokeBy: outline.json,
        pointRadiusBy: scale.json,
      },
    },
  });
  if (channels.status !== 200) die("channel styling failed", JSON.stringify(channels.json));
  const after = await api("GET", `/api/layers/${raw.json.id}/render`);
  if (after.json?.tiles?.state !== "ready" || after.json?.tiles?.builtAt !== builtAt)
    die("restyle touched the tile archive", JSON.stringify(after.json?.tiles));
  ok(
    `styled every channel: natural breaks ${naturalS}s, outline ${outlineS}s, size scale ${scaleS}s — tile archive untouched`,
  );

  // Publish and pull one tile through the read-only path.
  const pub = await api("POST", `/api/maps/${map.json.id}/publish`);
  if (pub.status !== 201) die("publish failed", JSON.stringify(pub.json));
  const view = await api("GET", `/api/published/${pub.json.token}`);
  const pubTiles = view.json?.layers?.find((l) => l.id === raw.json.id)?.render?.tiles;
  if (pubTiles?.state !== "ready") die("published view lacks ready tiles", JSON.stringify(pubTiles));
  const z = Math.min(pubTiles.maxZoom ?? 5, 6);
  const tileUrl = pubTiles.url
    .replace("{z}", z)
    .replace("{x}", Math.floor(((0 + 180) / 360) * 2 ** z))
    .replace("{y}", Math.floor(2 ** z / 2));
  const tile = await fetch(`${base}${tileUrl}`);
  const bytes = (await tile.arrayBuffer()).byteLength;
  if (tile.status !== 200 || bytes === 0)
    die("published tile did not serve", `status ${tile.status}`);
  ok(`published: anonymous viewers stream tiles (${bytes.toLocaleString()} bytes at z${z})`);

  await rm(FILE, { force: true });
  console.log(
    `\n\x1b[32mDifferentiator proven — ${rows.toLocaleString()} features uploaded, queried, tiled, styled, and published server-side.\x1b[0m\n`,
  );
}

main().catch((e) => die("unexpected error", e?.stack ?? String(e)));
