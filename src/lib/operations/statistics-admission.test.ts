import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { compileOperation } from "./compile";
import { MAX_CLUSTER_ROWS } from "./statistics-verbs";
import { isScalarNumeric } from "./compile-statistics";

/**
 * What the statistics verbs refuse before a job exists.
 *
 * **An applicability matrix, not one conjunctive sentence.** The review rules
 * name conjunctive criteria evidenced by one conjunct as an overclaimed
 * closure, and the contract lists eleven separate refusals — so each gets its
 * own row and its own coded failure. Every case here is one an API caller can
 * send: the picker filters most of them, but the picker is not the contract.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-stats-adm-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();

  const csv = path.join(dir, "sightings.csv");
  await writeFile(
    csv,
    "name,lon,lat,weight,note\n" +
      Array.from(
        { length: 6 },
        (_, i) => `p${i},${0.01 * i},${0.01 * i},${i + 1},n${i}`,
      ).join("\n") +
      "\n",
  );
  await ingestFile(testAccountScope(), csv, "sightings.csv");

  const areas = path.join(dir, "areas.geojson");
  await writeFile(
    areas,
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
  await ingestFile(testAccountScope(), areas, "areas.geojson");
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

/** The coded message a refused compilation carries, or "" if it succeeded. */
async function refusal(
  operation: string,
  parameters: Record<string, unknown>,
): Promise<string> {
  try {
    await compileOperation(testAccountScope(), operation, parameters);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

const base = { input: "sightings", resolution: 8, name: "out" };

describe("the admission matrix", () => {
  it("refuses an input that is not a table", async () => {
    expect(await refusal("h3_cell", { ...base, input: "nowhere" })).toMatch(
      /not a table/i,
    );
  });

  it("refuses a geometry class the verb does not take", async () => {
    // Polygons into a verb that scores points. The picker filters this; an API
    // caller is not the picker.
    expect(await refusal("hotspot", { ...base, input: "areas" })).toMatch(
      /polygon geometry/i,
    );
    expect(
      await refusal("cluster_by_distance", {
        input: "areas",
        distance: 100,
        name: "out",
      }),
    ).toMatch(/polygon geometry/i);
  });

  it("refuses a resolution outside H3's own range, and a fractional one", async () => {
    // The engine answers *null* outside 0–15 rather than failing, so without
    // this the run would succeed with a column of nulls.
    expect(await refusal("h3_cell", { ...base, resolution: 16 })).toMatch(
      /between 0 and 15/,
    );
    expect(await refusal("h3_cell", { ...base, resolution: -1 })).toMatch(
      /between 0 and 15/,
    );
    expect(await refusal("h3_cell", { ...base, resolution: 8.5 })).toMatch(
      /whole number/,
    );
  });

  it("refuses a neighbourhood below one, above ten, or fractional", async () => {
    expect(await refusal("hotspot", { ...base, neighbours: 0 })).toMatch(
      /between 1 and 10/,
    );
    expect(await refusal("hotspot", { ...base, neighbours: 11 })).toMatch(
      /between 1 and 10/,
    );
    expect(await refusal("hotspot", { ...base, neighbours: 1.5 })).toMatch(
      /whole number/,
    );
  });

  it("refuses an unknown field, and a field that is not numeric", async () => {
    expect(
      await refusal("hotspot", { ...base, value: "sum", field: "absent" }),
    ).toMatch(/absent/);
    expect(
      await refusal("hotspot", { ...base, value: "sum", field: "note" }),
    ).toMatch(/not a numeric column/);
  });

  it("does not mistake a type that only looks numeric for one that is", () => {
    // An unanchored /INT/ matches INTERVAL and INTEGER[], neither of which
    // `sum()` takes — so the verb admitted them and the engine answered a
    // binder error, which reaches the caller as a 500 where the contract
    // promises a coded refusal. Found at the cross-model review. The spellings
    // below are DuckDB's own, as `DESCRIBE` reports them.
    for (const type of [
      "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
      "UINTEGER", "UBIGINT", "FLOAT", "DOUBLE", "DECIMAL(10,2)", "NUMERIC(4,1)",
      // Bare DECIMAL is DuckDB's DECIMAL(18,3) and sums perfectly well.
      "DECIMAL",
    ]) {
      expect(isScalarNumeric(type), type).toBe(true);
    }
    for (const type of [
      "INTERVAL", "INTEGER[]", "BIGINT[]", "VARCHAR", "BOOLEAN", "DATE",
      "TIMESTAMP", "GEOMETRY", "STRUCT(a INTEGER)", "MAP(VARCHAR, INTEGER)",
      "UNION(a INTEGER)",
    ]) {
      expect(isScalarNumeric(type), type).toBe(false);
    }
  });

  it("refuses a sum with no field named", async () => {
    expect(await refusal("hotspot", { ...base, value: "sum" })).toMatch(
      /"field"/,
    );
  });

  it("refuses a distance that is not positive", async () => {
    for (const distance of [0, -5]) {
      expect(
        await refusal("cluster_by_distance", {
          input: "sightings",
          distance,
          name: "out",
        }),
      ).toMatch(/positive number of metres/);
    }
  });

  it("refuses an input above the row bound, and admits it at the boundary", async () => {
    const { metadataDb } = await import("@/lib/metadata/db");
    const params = { input: "sightings", distance: 100, name: "out" };
    const setRows = (rows: number) =>
      metadataDb()
        .prepare(`UPDATE data_tables SET row_count = ? WHERE name = 'sightings'`)
        .run(rows);

    // Exactly the maximum is admitted — the bound is inclusive, and a test
    // that only checked "far too many" could not tell that from off-by-one.
    setRows(MAX_CLUSTER_ROWS);
    expect(await refusal("cluster_by_distance", params)).toBe("");

    // One row past it is not.
    setRows(MAX_CLUSTER_ROWS + 1);
    expect(await refusal("cluster_by_distance", params)).toMatch(
      /at most 10,000/,
    );
  });

  it("refuses a generated column that collides with one the input has", async () => {
    // Case-insensitively: precedent, because the engine's own de-duplication
    // would answer `h3_cell` and `h3_cell_1` and leave which is which to it.
    const csv = path.join(dir, "already.csv");
    await writeFile(csv, "lon,lat,H3_Cell\n0,0,x\n0.01,0.01,y\n");
    await ingestFile(testAccountScope(), csv, "already.csv");
    expect(
      await refusal("h3_cell", { input: "already", resolution: 8, name: "o" }),
    ).toMatch(/already has a column called/i);
  });

  it("refuses a universe with no spread at all — both shapes of flat", async () => {
    // Two different flat universes, and the second is the commoner one.
    // At resolution 15 every point gets its own cell and every count is 1:
    // identical values.
    expect(await refusal("hotspot", { ...base, resolution: 15 })).toMatch(
      /same value/,
    );
    // At resolution 0 the whole dataset falls in one cell, which has nothing
    // to stand out from. That run used to be admitted and published a single
    // null score, which looks like an answer. Found at the cross-model review.
    expect(await refusal("hotspot", { ...base, resolution: 0 })).toMatch(
      /falls in one cell/,
    );
  });

  it("refuses a clustering input carrying one of the verb's own scratch columns", async () => {
    // The helper columns never reach the output, but they travel beside the
    // input's on the way: `SELECT *` keeps the user's column of that name and
    // the engine renames ours, so the next CTE reads their column as a point.
    // Found at the cross-model review.
    const csv = path.join(dir, "helpers.csv");
    await writeFile(csv, "lon,lat,__dezfil_pt\n0,0,7\n0.01,0.01,8\n");
    await ingestFile(testAccountScope(), csv, "helpers.csv");
    expect(
      await refusal("cluster_by_distance", {
        input: "helpers",
        distance: 100,
        name: "o",
      }),
    ).toMatch(/already has a column called/i);
  });

  it("refuses when nothing lands on the grid", async () => {
    const empty = path.join(dir, "empty.csv");
    await writeFile(empty, "name,lon,lat\n");
    await ingestFile(testAccountScope(), empty, "empty.csv");
    const message = await refusal("hotspot", { ...base, input: "empty" });
    expect(message).toMatch(/no geometry|no cells to score|not a table/i);
  });
});

describe("a missing H3 extension", () => {
  it("refuses the two verbs that need it, and not the one that does not", async () => {
    // posture: an optional extension that could not load degrades the
    // capabilities that need it. Clustering calls no H3 function, so an
    // instance without H3 still clusters — and this is the assertion that
    // stops a blanket refusal from looking correct.
    const duckdb = await import("@/lib/duckdb");
    vi.spyOn(duckdb, "h3Ready").mockResolvedValue(false);

    expect(await refusal("h3_cell", base)).toMatch(/H3 extension/);
    expect(await refusal("hotspot", base)).toMatch(/H3 extension/);
    expect(
      await refusal("cluster_by_distance", {
        input: "sightings",
        distance: 100,
        name: "out",
      }),
    ).toBe("");
  });
});
