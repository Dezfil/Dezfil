import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "@/lib/query/execute";
import { getJob } from "@/lib/metadata/jobs";
import { getTableByName } from "@/lib/metadata/tables";
import { startRun } from "@/lib/operations/run";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { crsOfGeometryType, isCanonicalEquivalent } from "@/lib/crs";

/**
 * Geometry from different ingest paths compares ('s repair).
 *
 * **This is the defect's own reproduction, kept.** Before the repair, geometry
 * built by the CSV path was tagged `OGC:CRS84` and geometry read from a file
 * by GDAL was tagged `EPSG:4326`, and DuckDB refused every spatial predicate
 * across the two at bind time — so *upload a CSV of stations, upload a GeoJSON
 * of districts, join them* failed on the shipped product, with no derived
 * table involved.
 *
 * Two properties make these able to fail. They run **through the real
 * operation lane**, not against a hand-written query, because the refusal was
 * at bind time and only a real predicate reaches it. And each asserts the
 * **coordinates are unchanged** as well as the join succeeding: a repair that
 * relabelled by transforming would move every feature and still pass a
 * row-count assertion.
 */

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-crs-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();

  // The CSV path builds geometry from lon/lat columns.
  const csv = path.join(dir, "stations.csv");
  await writeFile(csv, "name,lon,lat\nalpha,0.5,0.5\nbeta,1.5,0.5\n");
  await ingestFile(testAccountScope(), csv, "stations.csv");

  // The file path reads it through GDAL, which labels it differently.
  const geojson = path.join(dir, "districts.geojson");
  await writeFile(
    geojson,
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "west" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    }),
  );
  await ingestFile(testAccountScope(), geojson, "districts.geojson");
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function run(operation: string, parameters: Record<string, unknown>) {
  const job = await startRun(testAccountScope(), { operation, parameters });
  await laneSettled();
  return getJob(job.id)!;
}

/** Each path names its geometry column its own way — the CSV builder and GDAL
 * do not agree on that either — so the tests read the names rather than
 * assuming them. */
const geometryOf = (table: string) => getTableByName(table)!.geometryColumn!;

describe("geometry from different ingest paths", () => {
  it("compares in user SQL", async () => {
    // The bind-time refusal, at its narrowest: one predicate, two tables, two
    // labels for the same coordinates.
    const result = await executeQuery(
      `SELECT count(*) AS n FROM stations s, districts d
       WHERE ST_Within(s.${geometryOf("stations")}, d.${geometryOf("districts")})`,
    );
    expect(Number(result.preview[0].n)).toBe(1);
  }, 60_000);

  it.each([
    'POINT (0.5 0.5)',
    'SRID=4326;POINT (0.5 0.5)',
    '{"type":"Point","coordinates":[0.5,0.5]}',
    '0101000000000000000000E03F000000000000E03F',
  ])("content CSV %s compares with existing GeoJSON without moving coordinates", async (value) => {
    const file = path.join(dir, "content.csv");
    await writeFile(file, 'payload,label\n"' + value.replaceAll('"', '""') + '",a\n');
    const table = await ingestFile(testAccountScope(), file, "content.csv");
    const result = await executeQuery(
      `SELECT ST_X(c.geometry) x, ST_Y(c.geometry) y
       FROM ${table.name} c, districts d WHERE ST_Within(c.geometry, d.${geometryOf("districts")})`,
    );
    expect(result.preview).toEqual([{ x: 0.5, y: 0.5 }]);
  }, 60_000);

  it("joins through the real operation lane", async () => {
    const job = await run("spatial_join", {
      left: "districts",
      right: "stations",
      predicate: "intersects",
      carry: [{ aggregate: "count" }],
      name: "enriched",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const rows = (await executeQuery(`SELECT * FROM enriched`)).preview;
    expect(rows).toHaveLength(1);
    // The west district contains exactly one of the two stations.
    expect(Number(rows[0].match_count ?? rows[0].count)).toBe(1);
  }, 60_000);

  it("joins a derived table against an imported one — the design story's chain", async () => {
    // Buffer the CSV points, then enrich the imported polygons from the rings:
    // the chain browser round could not run, which is what recorded the defect
    // in the first place.
    const buffered = await run("buffer", {
      input: "stations",
      distance: 200,
      name: "rings",
    });
    expect(buffered.state, buffered.errorMessage ?? "").toBe("succeeded");

    const joined = await run("spatial_join", {
      left: "districts",
      right: "rings",
      predicate: "intersects",
      carry: [{ aggregate: "count" }],
      name: "district_rings",
    });
    expect(joined.state, joined.errorMessage ?? "").toBe("succeeded");
    expect(getTableByName("district_rings")!.rowCount).toBe(1);
  }, 60_000);

  it("relabels without moving anything", async () => {
    // **Coordinates unchanged.** A repair that normalised by transforming
    // would pass every assertion above and put every feature somewhere else.
    const geom = geometryOf("stations");
    const result = await executeQuery(
      `SELECT ST_X(${geom}) AS x, ST_Y(${geom}) AS y FROM stations ORDER BY x`,
    );
    expect(Number(result.preview[0].x)).toBeCloseTo(0.5, 9);
    expect(Number(result.preview[0].y)).toBeCloseTo(0.5, 9);
    expect(Number(result.preview[1].x)).toBeCloseTo(1.5, 9);
  }, 60_000);

  it("presents one label to whatever reads the view", async () => {
    const types = await executeQuery(
      `SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM stations)`,
    );
    const geometry = types.preview.find(
      (row) => row.column_name === geometryOf("stations"),
    );
    expect(String(geometry?.column_type)).toContain("EPSG:4326");
  }, 60_000);
});

describe("which labels may be relabelled", () => {
  it("reads the CRS out of a geometry type", () => {
    expect(crsOfGeometryType("GEOMETRY('OGC:CRS84')")).toBe("OGC:CRS84");
    expect(crsOfGeometryType("GEOMETRY")).toBeNull();
  });

  it("relabels what means WGS84 by another name, and nothing else", () => {
    for (const type of [
      "GEOMETRY('OGC:CRS84')",
      "GEOMETRY('EPSG:4326')",
      "GEOMETRY('CRS:84')",
      "GEOMETRY",
    ]) {
      expect(isCanonicalEquivalent(type), type).toBe(true);
    }
    // **Relabelling is not projecting.** Setting the canonical label on a
    // genuinely projected column would move every feature to the wrong place
    // and report success, which is why the list is closed.
    for (const type of [
      "GEOMETRY('EPSG:3857')",
      "GEOMETRY('EPSG:25832')",
      "VARCHAR",
      "DOUBLE",
    ]) {
      expect(isCanonicalEquivalent(type), type).toBe(false);
    }
  });
});
