// Container-replacement durability check (spec: all state survives replacing
// the container when the data directory is mounted). Seeds state through the
// API, then the caller replaces the container and runs this with --verify to
// confirm the state is intact.
//
//   node scripts/durability.mjs seed   <base-url>   (before replacement)
//   node scripts/durability.mjs verify <base-url>   (after replacement)
//
// The seed step writes the expected identifiers to durability-state.json in
// the cwd; verify reads them back.

import { writeFile, readFile } from "node:fs/promises";

const mode = process.argv[2];
const base = process.argv[3] ?? "http://localhost:3000";
const STATE_FILE = "durability-state.json";

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

function die(msg) {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
}

async function seed() {
  const form = new FormData();
  form.append(
    "file",
    new Blob(["name,lon,lat\ndurable,10,20\n"]),
    "durability.csv",
  );
  const up = await api("POST", "/api/tables", { form });
  if (up.status !== 201) die(`seed upload failed: ${JSON.stringify(up.json)}`);

  const map = await api("POST", "/api/maps", { body: { name: "Durable map" } });
  const layer = await api("POST", `/api/maps/${map.json.id}/layers`, {
    body: { name: "L", sql: `SELECT * FROM ${up.json.name}` },
  });
  const pub = await api("POST", `/api/maps/${map.json.id}/publish`);

  await writeFile(
    STATE_FILE,
    JSON.stringify({
      table: up.json.name,
      mapId: map.json.id,
      layerId: layer.json.id,
      token: pub.json.token,
    }),
  );
  console.log(`  \x1b[32m✓\x1b[0m seeded table/map/layer/published-link`);
}

async function verify() {
  const state = JSON.parse(await readFile(STATE_FILE, "utf8"));

  const table = await api("GET", `/api/tables/${state.table}`);
  if (table.status !== 200) die("table did not survive replacement");

  const map = await api("GET", `/api/maps/${state.mapId}`);
  if (map.status !== 200 || map.json.layers.length !== 1)
    die("map/layers did not survive replacement");

  const query = await api("POST", "/api/query", {
    body: { sql: `SELECT count(*) AS n FROM ${state.table}` },
  });
  if (query.status !== 200 || Number(query.json.preview[0].n) !== 1)
    die("table is no longer queryable after replacement");

  const pub = await api("GET", `/api/published/${state.token}`);
  if (pub.status !== 200) die("published link did not survive replacement");

  console.log(
    `  \x1b[32m✓\x1b[0m table, map, layer, and published link all survived container replacement`,
  );
}

if (mode === "seed") await seed();
else if (mode === "verify") await verify();
else die("usage: durability.mjs seed|verify <base-url>");
