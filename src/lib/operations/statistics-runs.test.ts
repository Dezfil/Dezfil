import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "@/lib/query/execute";
import { getJob } from "@/lib/metadata/jobs";
import { getTableByName } from "@/lib/metadata/tables";
import { startRun } from "./run";
import { laneSettled, resetLane } from "./lane";

/**
 * The statistics verbs run end to end.
 *
 * **Through the real lane against ingested data**, because everything these
 * assertions are about — the columns that arrive, the rows that survive, the
 * geometry class the registry records, the provenance a reader will read
 * months later — is the lane's answer and not the generator's.
 */

let dir: string;

/**
 * Twelve points in three tight clusters, plus one alone.
 *
 * Tight enough that a coarse H3 cell holds a whole cluster, and far enough
 * apart that the clusters land in different cells — so a hotspot has cells of
 * unequal weight to score, and a wrong aggregation shows as an equal one.
 */
function pointsCsv(): string {
  const rows: string[] = ["name,lon,lat,weight"];
  const clusters: [number, number, number][] = [
    [13.4, 52.5, 5],
    [13.5, 52.5, 4],
    [13.45, 52.6, 2],
  ];
  clusters.forEach(([lon, lat, n], c) => {
    for (let i = 0; i < n; i += 1) {
      rows.push(`c${c}p${i},${lon + i * 0.0005},${lat + i * 0.0005},${i + 1}`);
    }
  });
  rows.push(`alone,13.9,52.9,1`);
  return rows.join("\n") + "\n";
}

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-stats-runs-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  await writeFile(path.join(dir, "sightings.csv"), pointsCsv());
  await ingestFile(path.join(dir, "sightings.csv"), "sightings.csv");
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function run(operation: string, parameters: Record<string, unknown>) {
  const job = await startRun({ operation, parameters });
  await laneSettled();
  return getJob(job.id)!;
}

/** Every column the output has, in order — so an extra one fails rather than
 * passing a `toContain`. A containment check
 * cannot see a stray helper column surviving into a published dataset. */
const columnsOf = async (table: string): Promise<string[]> =>
  (
    await executeQuery(`SELECT * FROM (DESCRIBE SELECT * FROM ${table})`)
  ).preview.map((row) => String(row.column_name));

/** The provenance every operation output carries, asserted the same way for
 * each verb rather than for whichever one happened to get a test. */
function expectProvenance(
  table: { source?: string; sourceParams?: unknown },
  operation: string,
  parameters: Record<string, unknown>,
): void {
  expect(table.source).toBe("operation");
  const source = table.sourceParams as {
    operation: string;
    parameters: Record<string, unknown>;
    inputs: { id: string; name: string }[];
    sql: string;
    ranAt: string;
  };
  expect(source.operation).toBe(operation);
  expect(source.parameters).toMatchObject(parameters);
  expect(source.inputs.map((i) => i.name)).toEqual(["sightings"]);
  expect(source.inputs.every((i) => typeof i.id === "string" && i.id.length > 0)).toBe(true);
  expect(source.sql.length).toBeGreaterThan(0);
  expect(Date.parse(source.ranAt)).not.toBeNaN();
}

/** The columns a CSV import of the fixture carries, which every pass-through
 * verb must reproduce exactly before adding its own. */
const INPUT_COLUMNS = ["name", "lon", "lat", "weight", "geometry"];

describe("H3 cell assignment, end to end", () => {
  it("keeps every row, adds the cell, and leaves the geometry alone", async () => {
    const job = await run("h3_cell", {
      input: "sightings",
      resolution: 7,
      name: "celled",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");

    const table = getTableByName("celled")!;
    expect(table.rowCount).toBe(12);
    // Exactly the input's columns plus the one this verb adds — no helper
    // column survived, and nothing was dropped.
    expect(await columnsOf("celled")).toEqual([...INPUT_COLUMNS, "h3_cell"]);
    expectProvenance(table, "h3_cell", { input: "sightings", resolution: 7 });
    // Pass-through by default (G4): the class the registry records is the
    // input's own, so the result still draws as points.
    expect(table.geometryType?.toLowerCase()).toContain("point");

    const cells = await executeQuery(
      `SELECT count(DISTINCT h3_cell) AS n FROM celled WHERE h3_cell IS NOT NULL`,
    );
    // Three clusters and a loner, at a resolution coarse enough to hold each
    // cluster whole: four cells, not twelve.
    expect(Number(cells.preview[0].n)).toBe(4);
  }, 120_000);

  it("redraws as cells when asked, and says so in the registry", async () => {
    const job = await run("h3_cell", {
      input: "sightings",
      resolution: 7,
      boundary: true,
      name: "hexed",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const table = getTableByName("hexed")!;
    expect(table.rowCount).toBe(12);
    expect(table.geometryType?.toLowerCase()).toContain("polygon");
    expect(await columnsOf("hexed")).toEqual([...INPUT_COLUMNS, "h3_cell"]);
    expectProvenance(table, "h3_cell", {
      input: "sightings",
      resolution: 7,
      boundary: true,
    });
  }, 120_000);
});

describe("hotspot, end to end", () => {
  it("answers one row per cell with the documented columns", async () => {
    const job = await run("hotspot", {
      input: "sightings",
      resolution: 7,
      neighbours: 1,
      name: "hot",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");

    const table = getTableByName("hot")!;
    expect(table.rowCount).toBe(4);
    expect(table.geometryType?.toLowerCase()).toContain("polygon");
    // A hotspot answers **only** its own columns: none of the input's survive,
    // which is also why it needs no collision check.
    expect(await columnsOf("hot")).toEqual([
      "h3_cell",
      "value",
      "gi_star",
      "neighbour_count",
      "geom",
    ]);
    expectProvenance(table, "hotspot", {
      input: "sightings",
      resolution: 7,
      neighbours: 1,
    });

    // The counts are the cluster sizes, and every cell is its own
    // neighbourhood here because the clusters are further apart than one step.
    const values = await executeQuery(
      `SELECT value, neighbour_count FROM hot ORDER BY value DESC`,
    );
    expect(values.preview.map((r) => Number(r.value))).toEqual([5, 4, 2, 1]);
    expect(values.preview.every((r) => Number(r.neighbour_count) === 1)).toBe(
      true,
    );
  }, 120_000);

  it("records the operation, its parameters and its inputs in provenance", async () => {
    await run("hotspot", {
      input: "sightings",
      resolution: 7,
      value: "sum",
      field: "weight",
      name: "hot_sum",
    });
    expectProvenance(getTableByName("hot_sum")!, "hotspot", {
      input: "sightings",
      resolution: 7,
      value: "sum",
      field: "weight",
    });
  }, 120_000);
});

describe("clustering, end to end", () => {
  it("keeps every row, clusters the tight groups, and records where it measured", async () => {
    const job = await run("cluster_by_distance", {
      input: "sightings",
      distance: 200,
      name: "clustered",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");

    const table = getTableByName("clustered")!;
    expect(table.rowCount).toBe(12);
    expect(table.geometryType?.toLowerCase()).toContain("point");
    // The input's columns, then the two this verb adds — and **none of the
    // six scratch columns** the CTEs carry on the way.
    expect(await columnsOf("clustered")).toEqual([
      ...INPUT_COLUMNS,
      "cluster_id",
      "cluster_size",
    ]);
    expectProvenance(table, "cluster_by_distance", {
      input: "sightings",
      distance: 200,
    });

    const clusters = await executeQuery(
      `SELECT count(DISTINCT cluster_id) AS n FROM clustered`,
    );
    expect(Number(clusters.preview[0].n)).toBe(4);

    // **The measurement is recorded** (G6): a clustering whose provenance does
    // not name where it measured is not reproducible, because the same
    // parameters under a later strategy can group different points.
    const source = table.sourceParams as {
      measurement?: { crs: Record<string, string>; fallback: boolean; assumedCrs: string[] };
    };
    // Berlin is UTM zone 33N, and a local zone means no fallback was needed.
    expect(source.measurement?.crs.distance).toBe("EPSG:32633");
    expect(source.measurement?.fallback).toBe(false);
    // The CSV path assumed WGS84 rather than reading a declaration, and the
    // record says which input that was — not merely that something was assumed.
    expect(source.measurement?.assumedCrs).toEqual(["sightings"]);
  }, 120_000);

  /**
   * Criterion 10, G6's fence — in two halves, because a lane race is not a
   * test.
   *
   * The fence is a comparison between what the run was **compiled** for and
   * what it **finds** when it executes. Both halves have to hold, and each can
   * break without the other showing it: a compiler that recorded no bindings
   * would fence nothing while the materializer's check stayed perfectly
   * correct. So the bindings are asserted where they are produced, and the
   * refusal where it fires — rather than queuing a job and hoping the lane has
   * not started it yet, which passes or fails on timing.
   */
  it("compiles with the input's generation recorded", async () => {
    const { compileOperation } = await import("./compile");
    const compiled = await compileOperation("cluster_by_distance", {
      input: "sightings",
      distance: 200,
      name: "fenced",
    });
    expect(compiled.bindings).toEqual({
      sightings: getTableByName("sightings")!.file,
    });
    // And the measurement it was prepared for is on the same object, which is
    // what makes a stale binding a measurement problem rather than a
    // bookkeeping one.
    expect(compiled.measurement?.crs.distance).toContain("EPSG:326");
  }, 120_000);

  it("refuses to publish against a generation it was not compiled for", async () => {
    const { compileOperation } = await import("./compile");
    const { materialize } = await import("./materialize");
    const compiled = await compileOperation("cluster_by_distance", {
      input: "sightings",
      distance: 200,
      name: "fenced",
    });
    const before = getTableByName("sightings")!.file;

    await expect(
      materialize({
        sql: compiled.sql,
        name: "fenced",
        operation: "cluster_by_distance",
        // Passed exactly as the lane passes it, because J10 it decides
        // *which* refusal this is: a run that measured is told its projection
        // no longer describes the data, and a run that measured nothing is
        // told plainly that its input changed.
        measurement: compiled.measurement as unknown as Record<string, unknown>,
        // What the run was compiled for, and not what it will find.
        requireBindings: { sightings: "tables/a-generation-that-is-gone.parquet" },
      }),
    ).rejects.toMatchObject({ code: "measurement_crs_unavailable" });

    // Nothing written, and the input untouched.
    expect(getTableByName("fenced")).toBeNull();
    expect(getTableByName("sightings")!.file).toBe(before);
  }, 120_000);
});
