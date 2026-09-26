import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { connectQueryInstance, resetQueryInstance } from "@/lib/duckdb";
import type { DataTable } from "@/lib/metadata/tables";
import { resolveMeasurementCrs } from "./measurement";
import { clusterByDistanceSql, MAX_CLUSTER_ROWS } from "./statistics-verbs";

/**
 * What the clustering verb answers, and how long it takes to answer it.
 *
 * **Everything here executes the shipped generator.** The chain, the
 * inclusive boundary, the id stability and the two-latitude pair are all read
 * out of its own output, because the failure modes worth catching — a
 * threshold that is exclusive, an id that moves between runs, a distance
 * measured in degrees — are all invisible in the SQL string and obvious in the
 * result.
 */

let conn: DuckDBConnection;

beforeAll(async () => {
  conn = await connectQueryInstance();
});

afterAll(() => {
  resetQueryInstance();
});

const rows = async (sql: string): Promise<Record<string, unknown>[]> =>
  (await (await conn.run(sql)).getRowObjects()) as Record<string, unknown>[];

/** A registered-looking table over literal longitude/latitude pairs. */
async function fixture(
  name: string,
  points: [number, number][],
): Promise<DataTable> {
  await conn.run(`DROP TABLE IF EXISTS ${name}`);
  await conn.run(
    `CREATE TABLE ${name} AS SELECT id, ST_SetCRS(ST_Point(lon, lat), 'EPSG:4326') AS geom
     FROM (VALUES ${points
       .map(([lon, lat], i) => `(${i + 1}, ${lon}, ${lat})`)
       .join(", ")}) t(id, lon, lat)`,
  );
  return { name, geometryColumn: "geom" } as DataTable;
}

/** The projection the compiler would resolve for an extent. */
const crsFor = (points: [number, number][]) =>
  resolveMeasurementCrs(
    {
      minLon: Math.min(...points.map((p) => p[0])),
      maxLon: Math.max(...points.map((p) => p[0])),
      minLat: Math.min(...points.map((p) => p[1])),
      maxLat: Math.max(...points.map((p) => p[1])),
    },
    "distance",
  );

async function cluster(
  name: string,
  points: [number, number][],
  distance: number,
): Promise<Record<string, unknown>[]> {
  const table = await fixture(name, points);
  return rows(
    `${clusterByDistanceSql(table, distance, crsFor(points))} ORDER BY id`,
  );
}

/** Metres of longitude at a latitude, near enough for placing a fixture. */
const lonDegreesFor = (metres: number, lat: number) =>
  metres / (111_320 * Math.cos((lat * Math.PI) / 180));

describe("clustering follows chains", () => {
  it("puts A, B and C together where only the links are close", async () => {
    // Criterion 6. A–B and B–C are 300 m apart; A–C is 600 m and outside the
    // threshold. Single-link clustering joins all three anyway — that is the
    // whole difference between this verb and "everything within 500 m of A".
    const step = lonDegreesFor(300, 0);
    const result = await cluster(
      "chain_fixture",
      [
        [0, 0],
        [step, 0],
        [step * 2, 0],
        [step * 20, 0],
      ],
      500,
    );
    const clusters = result.map((r) => String(r.cluster_id));
    expect(new Set(clusters.slice(0, 3)).size).toBe(1);
    expect(result.slice(0, 3).every((r) => Number(r.cluster_size) === 3)).toBe(
      true,
    );
    // The far point is its own cluster of one — there is no noise class.
    expect(clusters[3]).not.toBe(clusters[0]);
    expect(Number(result[3].cluster_size)).toBe(1);
  }, 60_000);

  it("counts exactly the threshold as within", async () => {
    // The spec says inclusive, and "inclusive" is only testable against the
    // distance the verb itself measures — a fixture placed at "500 m" by
    // degrees-per-metre arithmetic is 500 m plus a rounding error, which is a
    // different assertion. So: measure the pair's ground distance, then use
    // that exact number as the threshold.
    const points: [number, number][] = [
      [0, 0],
      [lonDegreesFor(500, 0), 0],
    ];
    const crs = crsFor(points);
    await fixture("inclusive_fixture", points);
    const exact = Number(
      (
        await rows(
          `SELECT ST_Distance(
             ST_Transform(a.geom, 'EPSG:4326', '${crs.crs}', always_xy := true),
             ST_Transform(b.geom, 'EPSG:4326', '${crs.crs}', always_xy := true)) AS d
           FROM inclusive_fixture a, inclusive_fixture b WHERE a.id = 1 AND b.id = 2`,
        )
      )[0].d,
    );
    const together = await cluster("inclusive_fixture", points, exact);
    expect(new Set(together.map((r) => String(r.cluster_id))).size).toBe(1);

    // One millimetre short of it, and they are two clusters.
    const apart = await cluster("inclusive_fixture", points, exact - 0.001);
    expect(new Set(apart.map((r) => String(r.cluster_id))).size).toBe(2);
  }, 60_000);

  it("joins a pair whose buckets are two apart, not one", async () => {
    /**
     * **The bucket is sized for the collapse; the search has to be sized for
     * the threshold.** A separation of `distance` is √2 bucket sides, so a
     * pair well inside the threshold can land two bucket indexes apart when
     * the first point sits near the top of its bucket — and a ±1 search
     * silently returns them as two clusters.
     *
     * These coordinates are the measured case: 72.43 m apart under a 100 m
     * threshold, straddling two buckets. Against the ±1 search this test reads
     * two clusters where the contract says one. Found at the cross-model
     * review; the inclusive-threshold test above missed it because its pair
     * happened to land in adjacent buckets.
     */
    const result = await cluster(
      "reach_fixture",
      [
        [0.00006, 0],
        [0.00071, 0],
      ],
      100,
    );
    expect(new Set(result.map((r) => String(r.cluster_id))).size).toBe(1);
    expect(result.every((r) => Number(r.cluster_size) === 2)).toBe(true);
  }, 60_000);

  it("takes a multipoint by its representative point", async () => {
    // `geometryClassOf` admits MULTIPOINT as point, so the verb accepts it —
    // and `ST_X` takes only a single POINT, so reading coordinates straight
    // off the geometry turned an advertised input into a failed job. Found at
    // the cross-model review.
    await conn.run(`DROP TABLE IF EXISTS multi_fixture`);
    await conn.run(
      `CREATE TABLE multi_fixture AS SELECT * FROM (VALUES
         (1, ST_SetCRS(ST_GeomFromText('MULTIPOINT ((0 0), (0.0001 0))'), 'EPSG:4326')),
         (2, ST_SetCRS(ST_GeomFromText('MULTIPOINT ((0.0002 0))'), 'EPSG:4326')))
       t(id, geom)`,
    );
    const result = await rows(
      `${clusterByDistanceSql(
        { name: "multi_fixture", geometryColumn: "geom" } as DataTable,
        500,
        crsFor([[0, 0]]),
      )} ORDER BY id`,
    );
    expect(result).toHaveLength(2);
    expect(new Set(result.map((r) => String(r.cluster_id))).size).toBe(1);
  }, 60_000);

  it("gives the same ids twice for the same data", async () => {
    // A re-run that recolors every cluster on the map is a re-run the user
    // reads as a different answer.
    const step = lonDegreesFor(100, 0);
    const points: [number, number][] = [
      [0, 0],
      [step, 0],
      [step * 40, 0],
      [step * 41, 0],
    ];
    const first = await cluster("stable_fixture", points, 300);
    const second = await cluster("stable_fixture", points, 300);
    expect(first.map((r) => String(r.cluster_id))).toEqual(
      second.map((r) => String(r.cluster_id)),
    );
  }, 60_000);

  it("keeps a row with no geometry, without a cluster", async () => {
    const table = await fixture("null_geom_fixture", [[0, 0], [0.0001, 0]]);
    await conn.run(`INSERT INTO null_geom_fixture VALUES (3, NULL)`);
    const result = await rows(
      `${clusterByDistanceSql(table, 500, crsFor([[0, 0]]))} ORDER BY id`,
    );
    expect(result).toHaveLength(3);
    expect(result[2].cluster_id).toBeNull();
    expect(result[2].cluster_size).toBeNull();
  }, 60_000);
});

describe("the distance is ground metres", () => {
  /**
   * Criterion 7. The same **angular** separation at two latitudes 60° apart,
   * against one threshold that sits between the two ground distances.
   *
   * 0.005° of longitude is 556 m at the equator and 278 m at 60° north. With a
   * 400 m threshold, correct behavior clusters the northern pair and not the
   * equatorial one. Degree-space arithmetic cannot tell them apart at all —
   * it sees 0.005 twice — so a verb that skipped the projection fails here
   * whichever way it rounds.
   */
  const SEPARATION = 0.005;

  it("separates at the equator and joins at 60° north", async () => {
    const equator = await cluster(
      "metric_equator",
      [
        [0, 0],
        [SEPARATION, 0],
      ],
      400,
    );
    expect(new Set(equator.map((r) => String(r.cluster_id))).size).toBe(2);

    const north = await cluster(
      "metric_north",
      [
        [0, 60],
        [SEPARATION, 60],
      ],
      400,
    );
    expect(new Set(north.map((r) => String(r.cluster_id))).size).toBe(1);
  }, 60_000);
});

describe("the bound holds on the shapes that stress it", () => {
  /**
   * A row bound with no execution behind it is a number, not a
   * guarantee — and the first draft of this spec set one by extrapolating from
   * a single shape, which a review returned it for.
   *
   * Two shapes at **exactly** the accepted maximum. The chain is the depth
   * case, and it is what a GPS trace looks like. The concentrated case is the
   * one the chain probe could not see: without the same-bucket collapse it is
   * a quadratic self-join, and it would pass every correctness test above
   * while taking the instance down on real data.
   */
  const LANE_BUDGET_MS = 600_000;

  it("clusters a chain of the maximum length, correctly and in time", async () => {
    const step = lonDegreesFor(10, 0);
    const points: [number, number][] = Array.from(
      { length: MAX_CLUSTER_ROWS },
      (_, i) => [i * step, 0],
    );
    const started = Date.now();
    const result = await cluster("scale_chain", points, 50);
    const elapsed = Date.now() - started;
    expect(result).toHaveLength(MAX_CLUSTER_ROWS);
    // Every point is 10 m from its neighbour and the threshold is 50 m, so the
    // whole trace is one cluster — the answer that costs the most to reach.
    expect(new Set(result.map((r) => String(r.cluster_id))).size).toBe(1);
    expect(Number(result[0].cluster_size)).toBe(MAX_CLUSTER_ROWS);
    expect(elapsed).toBeLessThan(LANE_BUDGET_MS);
  }, 900_000);

  it("clusters the maximum concentrated into a handful of buckets", async () => {
    const step = lonDegreesFor(0.45, 0);
    const points: [number, number][] = Array.from(
      { length: MAX_CLUSTER_ROWS },
      (_, i) => [(i % 311) * step, ((i * 7) % 311) * lonDegreesFor(0.45, 0)],
    );
    const started = Date.now();
    const result = await cluster("scale_dense", points, 50);
    const elapsed = Date.now() - started;
    expect(result).toHaveLength(MAX_CLUSTER_ROWS);
    expect(new Set(result.map((r) => String(r.cluster_id))).size).toBe(1);
    expect(elapsed).toBeLessThan(LANE_BUDGET_MS);
  }, 900_000);
});
