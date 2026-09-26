// What does the overlay family actually
// cost, and is a spatial index available under the hardened lockdown?
//
// Doctrine expected a million-row spatial join to outrun the 60 s user-query
// bound, and labelled that expectation *comparative judgment*. It also labelled
// "a view cannot carry a spatial index" *confirmed* and "indexing works on base
// tables under the lockdown" *plausible*, on no executed probe. This settles all
// three by running them.
//
// Re-run:
//
//   node scripts/perf/overlay-budget.mjs            # default 1,000,000 rows
//   node scripts/perf/overlay-budget.mjs --rows 2000000 --reps 5
//
// It writes only under a temporary directory of its own and touches no
// product state. The report compares the configured lane-budget
// default against the figure this prints, which is why this lives in a script
// and not in a constant the implementation also supplies — a check whose two
// sides come from one place proves nothing.
//
// TWO HARNESS DEFECTS were found writing this, and the guards against them are
// deliberate rather than decorative:
//
//  * Results are verified, not merely timed. The first version serialized a
//    BigInt count and threw inside its own reporter, so every query "completed"
//    without a single result ever being checked.
//  * Work is forced to materialize. `count(*)` over a subquery lets the
//    optimizer discard the projection entirely, so a buffer of 200 polygons
//    "took 0 ms" because it never ran. Every geometry-producing arm is summed
//    through ST_NPoints so the geometry has to exist.

import { DuckDBInstance } from "@duckdb/node-api";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const ROWS = opt("rows", 1_000_000);
const REPS = opt("reps", 3);
const N_POLY = opt("polys", 200);
const SEGS = 500; // segments per quarter circle → ~2,000 vertices per polygon

const DIR = path.join(os.tmpdir(), `dezfil-overlay-budget-${process.pid}`);
const PTS = path.join(DIR, "points.parquet");
const SIMPLE = path.join(DIR, "simple.parquet");
const COMPLEX = path.join(DIR, "complex.parquet");

const J = (v) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));

async function spatial(conn) {
  try {
    await conn.run("LOAD spatial");
  } catch {
    await conn.run("INSTALL spatial");
    await conn.run("LOAD spatial");
  }
}

async function build() {
  await mkdir(DIR, { recursive: true });
  const trusted = await DuckDBInstance.create(":memory:", {});
  const c = await trusted.connect();
  await spatial(c);
  await c.run(`COPY (SELECT i AS id, ST_Point(random()*10, random()*10) AS geom,
                            (i % 7) AS cat
                     FROM range(0, ${ROWS}) t(i))
               TO '${PTS}' (FORMAT PARQUET)`);
  // Simple: a grid of squares — the shape a synthetic benchmark reaches for.
  await c.run(`COPY (SELECT gx*20+gy AS id,
                       ST_GeomFromText('POLYGON((' ||
                         (gx*0.5)||' '||(gy*0.5)||','|| ((gx+1)*0.5)||' '||(gy*0.5)||','||
                         ((gx+1)*0.5)||' '||((gy+1)*0.5)||','|| (gx*0.5)||' '||((gy+1)*0.5)||','||
                         (gx*0.5)||' '||(gy*0.5)||'))') AS geom,
                       'cell_'||(gx*20+gy) AS name
                     FROM range(0,20) a(gx), range(0,20) b(gy))
               TO '${SIMPLE}' (FORMAT PARQUET)`);
  // Complex: high-vertex rings, the shape real administrative boundaries have.
  await c.run(`COPY (SELECT i AS id,
                       ST_Buffer(ST_Point(1.5+(i%14)*0.62, 1.5+((i/14)::INT%14)*0.62),
                                 1.2, ${SEGS}) AS geom,
                       'zone_'||i AS name
                     FROM range(0,${N_POLY}) s(i))
               TO '${COMPLEX}' (FORMAT PARQUET)`);
  c.disconnectSync();
}

/** The hardened instance, configured exactly as src/lib/duckdb.ts configures it. */
async function hardened() {
  const instance = await DuckDBInstance.create(":memory:", {});
  const c = await instance.connect();
  await spatial(c);
  await c.run(`SET GLOBAL allowed_directories = ['${DIR}']`);
  await c.run("SET GLOBAL memory_limit = '2048MB'");
  await c.run("SET GLOBAL temp_directory = ''");
  await c.run("SET GLOBAL enable_external_access = false");
  await c.run("SET GLOBAL autoinstall_known_extensions = false");
  await c.run("SET GLOBAL autoload_known_extensions = false");
  await c.run("SET GLOBAL lock_configuration = true");
  c.disconnectSync();
  return instance;
}

async function measure(conn, label, sql, check) {
  const runs = [];
  let note = "";
  let value;
  for (let i = 0; i < REPS; i++) {
    const t = Date.now();
    try {
      const r = await conn.runAndReadAll(sql);
      const row = r.getRowObjects()[0];
      value = Number(Object.values(row)[0]);
      note = J(row);
    } catch (e) {
      console.log(`  ${label}: THREW ${String(e).slice(0, 140)} — not a measurement`);
      return null;
    }
    runs.push(Date.now() - t);
  }
  // Every workload is checked against an expectation its caller supplies.
  // An earlier version took a `verify` argument and then never passed one, so
  // the guard was decorative: a zero-row join would have been reported as a
  // verified measurement and could have set the lane budget. Refusing to
  // report a timing without an expectation is what stops that recurring.
  if (typeof check !== "function") {
    console.log(`  ${label}: NO EXPECTATION SUPPLIED — refusing to report a timing`);
    return null;
  }
  const verdict = check(value);
  if (verdict !== true) {
    console.log(`  ${label}: WRONG RESULT ${note} (${verdict}) — not a measurement`);
    return null;
  }
  runs.sort((a, b) => a - b);
  const median = runs[Math.floor(runs.length / 2)];
  console.log(
    `  ${String(median).padStart(7)}ms median  (min ${runs[0]}, max ${runs.at(-1)})  ${label}  ${note} [verified]`,
  );
  return { label, median, max: runs.at(-1), value };
}

async function scalar(conn, sql) {
  const r = await conn.runAndReadAll(sql);
  return Number(Object.values(r.getRowObjects()[0])[0]);
}

async function family(conn, kind, file) {
  await conn.run(`CREATE OR REPLACE VIEW zones AS SELECT * FROM read_parquet('${file}')`);
  console.log(`\n--- ${kind} polygons ---`);
  const out = [];
  const zoneCount = await scalar(conn, `SELECT count(*) AS n FROM zones`);

  // Simple squares tile the space exactly once, so every point lands in one
  // cell and the join's size is known in advance. The complex rings overlap
  // deliberately, so its expectation is a property rather than a number.
  const joined = await measure(
    conn,
    "spatial join (ST_Within), counted",
    `SELECT count(*) AS n FROM pts p JOIN zones z ON ST_Within(p.geom, z.geom)`,
    kind === "simple"
      ? (v) => (v === ROWS ? true : `expected exactly ${ROWS}`)
      : (v) => (v > 0 && v <= ROWS * zoneCount ? true : "expected a non-empty join"),
  );
  out.push(joined);

  const outFile = path.join(DIR, `out-${kind}.parquet`);
  const copied = await measure(
    conn,
    "enrich + materialize to parquet",
    `COPY (SELECT p.id, z.name, p.geom FROM pts p JOIN zones z ON ST_Within(p.geom, z.geom))
     TO '${outFile}' (FORMAT PARQUET)`,
    (v) => (joined && v === joined.value ? true : `expected ${joined?.value} rows written`),
  );
  if (copied) {
    // Read the artifact back: a COPY reporting a count it did not write must
    // not pass as a timing.
    const onDisk = await scalar(conn, `SELECT count(*) AS n FROM read_parquet('${outFile}')`);
    if (onDisk !== joined.value) {
      console.log(`  enrich artifact holds ${onDisk} rows, not ${joined.value} — rejected`);
    } else {
      console.log(`  enrich artifact verified on disk: ${onDisk} rows`);
      out.push(copied);
    }
  }

  // Summed through ST_NPoints so the geometry must actually be produced —
  // count(*) over a subquery lets the optimizer discard the projection, which
  // once reported 0 ms for work that never ran.
  out.push(
    await measure(
      conn,
      "buffer every zone (materialized)",
      `SELECT sum(ST_NPoints(ST_Buffer(geom, 0.05)))::BIGINT AS v FROM zones`,
      (v) => (v > zoneCount ? true : "expected more vertices than zones"),
    ),
  );
  out.push(
    await measure(
      conn,
      "dissolve: union all zones (materialized)",
      `SELECT ST_NPoints(ST_Union_Agg(geom))::BIGINT AS v FROM zones`,
      (v) => (v > 0 ? true : "expected a non-empty union"),
    ),
  );
  return out.filter(Boolean);
}

async function indexing(conn) {
  console.log(`\n--- is a spatial index available under the lockdown? ---`);
  const attempt = async (label, sql) => {
    try {
      await conn.run(sql);
      console.log(`  AVAILABLE  ${label}`);
      return true;
    } catch (e) {
      console.log(`  REFUSED    ${label} -> ${String(e).replace(/\s+/g, " ").slice(0, 110)}`);
      return false;
    }
  };
  await attempt("RTREE index on a view", `CREATE INDEX ix_v ON pts USING RTREE (geom)`);
  await attempt("materialize a base table from the view", `CREATE TABLE pts_base AS SELECT * FROM pts`);
  await attempt(
    "RTREE index on that base table (geometry as GeoParquet typed it)",
    `CREATE INDEX ix_b ON pts_base USING RTREE (geom)`,
  );
  await attempt(
    "base table with the geometry cast to bare GEOMETRY",
    `CREATE TABLE pts_cast AS SELECT id, cat, geom::GEOMETRY AS geom FROM pts`,
  );
  const ok = await attempt(
    "RTREE index on the cast base table",
    `CREATE INDEX ix_c ON pts_cast USING RTREE (geom)`,
  );
  console.log(
    ok
      ? `  => indexing IS available under the lockdown, but only after casting away\n     the GeoParquet CRS parameter from the geometry type.`
      : `  => indexing is NOT available under the lockdown.`,
  );
}

console.log(
  `Overlay budget measurement — ${ROWS.toLocaleString()} rows, ${N_POLY} complex polygons, ` +
    `${REPS} reps\nplatform: ${os.platform()} ${os.arch()}, ${os.cpus().length} cpus, ` +
    `node ${process.version}`,
);
await build();
const instance = await hardened();
const conn = await instance.connect();
await conn.run(`CREATE OR REPLACE VIEW pts AS SELECT * FROM read_parquet('${PTS}')`);

const simple = await family(conn, "simple", SIMPLE);
const complex = await family(conn, "complex", COMPLEX);
await indexing(conn);

const worst = Math.max(...[...simple, ...complex].map((r) => r.max));
console.log(`\n=== the reference figure ===`);
console.log(`slowest verified overlay observation : ${worst} ms`);
console.log(`user-query budget                    : 60000 ms`);
console.log(`a lane budget with a 10x margin needs : >= ${worst * 10} ms`);

// The record the configured default is checked against. It is written
// to a file and committed on purpose: a check whose two sides came from one
// constant would compare the implementation to itself and could not fail.
// `--record` is required so an exploratory run on odd parameters cannot
// quietly move the number the product is held to.
if (process.argv.includes("--record")) {
  const record = {
    note:
      "Overlay budget measurement. Regenerate with: " +
      "node scripts/perf/overlay-budget.mjs --record",
    rows: ROWS,
    complexPolygons: N_POLY,
    reps: REPS,
    platform: `${os.platform()} ${os.arch()}, ${os.cpus().length} cpus, node ${process.version}`,
    slowestVerifiedOverlayMs: worst,
    requiredMarginMultiple: 10,
    observations: [...simple, ...complex].map((r) => ({
      label: r.label,
      medianMs: r.median,
      maxMs: r.max,
    })),
  };
  const where = fileURLToPath(new URL("./overlay-budget.json", import.meta.url));
  await writeFile(where, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`recorded → ${where}`);
}

conn.disconnectSync();
await rm(DIR, { recursive: true, force: true });
