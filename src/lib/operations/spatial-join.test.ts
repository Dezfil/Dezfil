import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "@/lib/query/execute";
import { ApiError } from "@/lib/api/errors";
import { getTableByName, type DataTable } from "@/lib/metadata/tables";
import {
  AGGREGATES,
  PREDICATES,
  spatialJoinSql,
  validateSpatialJoin,
  type SpatialJoinParams,
} from "./spatial-join";

/**
 * The spatial join, against a real engine and a **known-answer fixture**.
 *
 * The expected numbers below are worked out by hand from the fixture's
 * geometry and written into the test. Comparing the operation against
 * "equivalent hand-written SQL" would risk two expressions of one defect —
 * especially if the reference were built from the generated SQL.
 *
 * The fixture: four square zones in a row along the x axis, each 10 wide.
 * Points are placed so the answers are countable by eye.
 */

let dir: string;

/** Zones: A=[0,10), B=[10,20), C=[20,30), D=[30,40), all y in [0,10). */
const ZONES = `name,wkt,pop
A,"POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))",100
B,"POLYGON((10 0, 20 0, 20 10, 10 10, 10 0))",200
C,"POLYGON((20 0, 30 0, 30 10, 20 10, 20 0))",300
D,"POLYGON((30 0, 40 0, 40 10, 30 10, 30 0))",400
`;

/**
 * Points, by design:
 *   zone A ← 3 points (values 1, 2, 6)
 *   zone B ← 1 point  (value 10)
 *   zone C ← 0 points   ← the unmatched case
 *   zone D ← 2 points (values 4, 4)  ← identical values, to catch merging
 */
const POINTS = `label,lon,lat,value
p1,1,1,1
p2,2,2,2
p3,3,3,6
p4,11,1,10
p5,31,1,4
p6,32,2,4
`;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();

  const zones = path.join(dir, "zones.csv");
  await writeFile(zones, ZONES);
  await ingestFile(zones, "zones.csv");

  const points = path.join(dir, "points.csv");
  await writeFile(points, POINTS);
  await ingestFile(points, "points.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const zonesTable = () => getTableByName("zones") as DataTable;
const pointsTable = () => getTableByName("points") as DataTable;

const join = (over: Partial<SpatialJoinParams> = {}): SpatialJoinParams => ({
  left: "zones",
  right: "points",
  predicate: "contains",
  carry: [{ aggregate: "count" }],
  ...over,
});

async function run(params: SpatialJoinParams) {
  const sql = spatialJoinSql(params, zonesTable(), pointsTable());
  return executeQuery(sql);
}

describe("the shape of the result", () => {
  it("is one row per LEFT feature, however many matched", async () => {
    const result = await run(join());
    // Four zones in, four rows out — six points and one zone with three of
    // them, so a row-multiplying join would give more.
    expect(result.rowCount).toBe(4);
  }, 60_000);

  it("counts matches per zone, with the known answers", async () => {
    const result = await run(join());
    const byName = Object.fromEntries(
      result.preview.map((r) => [r.name as string, Number(r.match_count)]),
    );
    expect(byName).toEqual({ A: 3, B: 1, C: 0, D: 2 });
  }, 60_000);

  it("keeps an unmatched left feature with count 0, not empty", async () => {
    const result = await run(join());
    const c = result.preview.find((r) => r.name === "C")!;
    // Zero and absent mean different things: an empty count reads as unknown.
    expect(c.match_count).not.toBeNull();
    expect(Number(c.match_count)).toBe(0);
  }, 60_000);

  it("does not merge left features that would group together", async () => {
    // D's two points carry the same value; a grouped implementation keyed on
    // the aggregated columns could collapse rows here.
    const result = await run(
      join({ carry: [{ aggregate: "sum", field: "value" }] }),
    );
    expect(result.rowCount).toBe(4);
    const d = result.preview.find((r) => r.name === "D")!;
    expect(Number(d.value_sum)).toBe(8);
  }, 60_000);
});

describe("the aggregates, against hand-worked answers", () => {
  it("sums, averages, mins and maxes what matched", async () => {
    const result = await run(
      join({
        carry: [
          { aggregate: "sum", field: "value" },
          { aggregate: "mean", field: "value" },
          { aggregate: "min", field: "value" },
          { aggregate: "max", field: "value" },
        ],
      }),
    );
    const a = result.preview.find((r) => r.name === "A")!;
    // Zone A holds values 1, 2 and 6.
    expect(Number(a.value_sum)).toBe(9);
    expect(Number(a.value_mean)).toBe(3);
    expect(Number(a.value_min)).toBe(1);
    expect(Number(a.value_max)).toBe(6);
  }, 60_000);

  it("leaves non-count aggregates empty where nothing matched", async () => {
    const result = await run(join({ carry: [{ aggregate: "sum", field: "value" }] }));
    const c = result.preview.find((r) => r.name === "C")!;
    expect(c.value_sum).toBeNull();
  }, 60_000);

  it("renames a carried value when asked", async () => {
    const result = await run(
      join({ carry: [{ aggregate: "count", as: "how_many" }] }),
    );
    expect(result.columns.map((c) => c.name)).toContain("how_many");
  }, 60_000);
});

describe("the output's geometry is the left input's", () => {
  /**
   * The inputs' geometry columns differ in **name and class**, which is what
   * the criterion asks for and what an earlier version of this test did not
   * supply: with both columns called `geometry`, "first geometry column found"
   * gives the same answer as "the left's" and the check cannot fail.
   */
  it("carries the left's geometry column by name and by class", async () => {
    // A left input whose geometry column is named `outline`, and a right one
    // whose is named `spot`. Now the two rules disagree if the wrong one wins.
    const left = { ...zonesTable(), name: "zones_named", geometryColumn: "outline" };
    const right = { ...pointsTable(), name: "points_named", geometryColumn: "spot" };
    await executeQuery("SELECT 1");
    const sql = spatialJoinSql(
      { left: left.name, right: right.name, predicate: "contains", carry: [{ aggregate: "count" }] },
      left,
      right,
    );
    // The generated SQL reads the left's column name, and never the right's,
    // for the geometry it keeps.
    expect(sql).toContain('l."outline"');
    expect(sql).not.toMatch(/SELECT[^]*l\."spot"/);

    // And against the engine, with the columns actually renamed.
    const renamed = sql
      .replace(/FROM "zones_named" AS l/, 'FROM (SELECT * EXCLUDE (geometry), geometry AS outline FROM zones) AS l')
      .replace(/FROM "points_named" AS r/g, 'FROM (SELECT * EXCLUDE (geometry), geometry AS spot FROM points) AS r');
    const result = await executeQuery(renamed);
    const geometry = result.columns.filter((c) => c.type.startsWith("GEOMETRY"));
    expect(geometry.map((c) => c.name)).toEqual(["outline"]);
    const a = result.preview.find((r) => r.name === "A")!;
    // Class as well as name: polygons out, not the right input's points.
    expect(String(a.outline)).toMatch(/^POLYGON/);
  }, 60_000);
});

describe("the predicates", () => {
  it("orients left-relative-to-right", async () => {
    // Every point is inside a zone, so zones-within-points matches nothing
    // while zones-contains-points matches everything. If the orientation were
    // reversed these two would swap.
    const contains = await run(join({ predicate: "contains" }));
    const within = await run(join({ predicate: "within" }));

    const total = (r: Awaited<ReturnType<typeof run>>) =>
      r.preview.reduce((n, row) => n + Number(row.match_count), 0);

    expect(total(contains)).toBe(6);
    expect(total(within)).toBe(0);
  }, 60_000);

  it("offers exactly the set the spec fixes", () => {
    expect([...PREDICATES]).toEqual([
      "intersects",
      "contains",
      "within",
      "touches",
      "crosses",
      "overlaps",
    ]);
    expect([...AGGREGATES]).toEqual(["count", "sum", "mean", "min", "max", "any"]);
  });

  it("every predicate the spec fixes actually runs", async () => {
    for (const predicate of PREDICATES) {
      const result = await run(join({ predicate }));
      expect(result.rowCount).toBe(4);
    }
  }, 120_000);
});

describe("refusals, before any SQL is generated", () => {
  const columnsOf = (t: DataTable) => [
    { name: "name", type: "VARCHAR" },
    { name: "pop", type: "BIGINT" },
    { name: "geometry", type: "GEOMETRY" },
    ...(t.name === "points"
      ? [
          { name: "label", type: "VARCHAR" },
          { name: "value", type: "BIGINT" },
        ]
      : []),
  ];

  const check = (params: SpatialJoinParams, left = zonesTable(), right = pointsTable()) =>
    validateSpatialJoin(
      params,
      { table: left, columns: columnsOf(left) },
      { table: right, columns: columnsOf(right) },
    );

  it("names which side has no geometry", () => {
    const noGeometry = { ...pointsTable(), name: "flat", geometryColumn: null };
    try {
      check(join({ right: "flat" }), zonesTable(), noGeometry);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ApiError).code).toBe("invalid_request");
      expect((e as ApiError).message).toMatch(/right input "flat" has no geometry/i);
    }
  });

  it("refuses a numeric aggregate on a non-numeric column, naming the type", () => {
    try {
      check(join({ carry: [{ aggregate: "sum", field: "label" }] }));
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ApiError).message).toMatch(/VARCHAR/);
      expect((e as ApiError).message).toMatch(/sum/);
    }
  });

  it("refuses a carried name that collides with a left column", () => {
    try {
      check(join({ carry: [{ aggregate: "count", as: "pop" }] }));
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ApiError).message).toMatch(/already has/i);
    }
  });

  it("refuses two carried values that would share a name", () => {
    try {
      check(
        join({
          carry: [
            { aggregate: "count", as: "n" },
            { aggregate: "sum", field: "value", as: "n" },
          ],
        }),
      );
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ApiError).message).toMatch(/both be called/i);
    }
  });

  it("refuses a column the right input does not have", () => {
    expect(() =>
      check(join({ carry: [{ aggregate: "sum", field: "nope" }] })),
    ).toThrow(ApiError);
  });

  it("refuses a join that carries nothing", () => {
    expect(() => check(join({ carry: [] }))).toThrow(ApiError);
  });

  it("accepts a valid join", () => {
    expect(() => check(join())).not.toThrow();
  });
});
