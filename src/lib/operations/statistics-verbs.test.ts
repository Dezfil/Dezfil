import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { connectQueryInstance, resetQueryInstance } from "@/lib/duckdb";
import type { DataTable } from "@/lib/metadata/tables";
import { h3CellSql, hotspotSql } from "./statistics-verbs";

/**
 * Known answers for the statistics verbs.
 *
 * **These run against the engine, not against the generators' strings.** A
 * test that asserts the SQL contains `h3_latlng_to_cell_string` proves the
 * author's intent; only executing it proves the cell.
 *
 * Everything here is anchored **outside this repository**: a published cell id
 * from H3's own documentation, a boundary checked against the coordinate that
 * produced it, and a Gi\* computed by hand from the formula in the spec. A
 * fixture whose expected values came from running the generator would pass
 * whatever the generator does, which is the tautological check the review
 * rules name.
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
const one = async (sql: string): Promise<Record<string, unknown>> =>
  (await rows(sql))[0];

describe("the engine this spec was written against", () => {
  it("has every H3 function these verbs call", async () => {
    // Criterion 1. The *capabilities*, asserted by name — a build that loses
    // one fails here rather than in a user's run. The clustering-absence sweep
    // is deliberately not here: it belongs in the record as a dated probe,
    // because a future DuckDB gaining a DBSCAN function should prompt a
    // decision, not a red pipeline. **Every H3 function these verbs call, and
    // the list drifts if nobody maintains it.** The last three arrived with
    // seam split and were not added here, so this list quietly stopped
    // asserting what it claims to — a build losing one of them would have
    // failed in a user's run instead. Found at the cross-model review of that
    // repair.
    const needed = [
      "h3_latlng_to_cell_string",
      "h3_cell_to_boundary_wkt",
      "h3_grid_disk",
      "h3_string_to_h3",
      "h3_cell_to_vertexes",
      "h3_vertex_to_lng",
      "h3_vertex_to_lat",
    ];
    const present = (
      await rows(
        `SELECT DISTINCT function_name FROM duckdb_functions()
         WHERE function_name IN (${needed.map((n) => `'${n}'`).join(", ")})`,
      )
    ).map((r) => String(r.function_name));
    expect(present.sort()).toEqual([...needed].sort());
  });
});

describe("H3 cell assignment", () => {
  /**
   * H3's own documented example. Uber's H3 documentation uses
   * (37.775938728915946, -122.41795063018799) at resolution 9 as its worked
   * example, and publishes `8928308280fffff` as the answer — the value asserted
   * here, so this test is anchored outside the implementation.
   */
  const PUBLISHED = {
    lat: 37.775938728915946,
    lon: -122.41795063018799,
    resolution: 9,
    cell: "8928308280fffff",
  };

  /** A one-row table at the published coordinates, for the generator to read. */
  async function publishedFixture(): Promise<DataTable> {
    await conn.run(`DROP TABLE IF EXISTS h3_fixture`);
    await conn.run(
      `CREATE TABLE h3_fixture AS
       SELECT 1 AS id, ST_Point(${PUBLISHED.lon}, ${PUBLISHED.lat}) AS geom`,
    );
    return { name: "h3_fixture", geometryColumn: "geom" } as DataTable;
  }

  it("assigns the published cell — through the generator", async () => {
    // **`h3CellSql`, not the extension.** Calling the extension with the
    // arguments already in the right order proves the extension; the axis
    // hazard lives in what the *generator* passes it, so a generator that
    // transposed them would leave this green. Found at the cross-model review.
    const answer = await one(h3CellSql(await publishedFixture(), PUBLISHED.resolution, false));
    expect(answer.h3_cell).toBe(PUBLISHED.cell);
  });

  it("is latitude-first, proven by transposing the fixture", async () => {
    // Criterion 3. The same generator over a table whose coordinates are
    // swapped answers a different cell — so the ordering being asserted is the
    // one the generator actually applies, at the coordinates it applies it to.
    await conn.run(`DROP TABLE IF EXISTS h3_fixture_swapped`);
    await conn.run(
      `CREATE TABLE h3_fixture_swapped AS
       SELECT 1 AS id, ST_Point(${PUBLISHED.lat}, ${PUBLISHED.lon}) AS geom`,
    );
    const answer = await one(
      h3CellSql(
        { name: "h3_fixture_swapped", geometryColumn: "geom" } as DataTable,
        PUBLISHED.resolution,
        false,
      ),
    );
    expect(answer.h3_cell).not.toBe(PUBLISHED.cell);
    expect(String(answer.h3_cell).length).toBeGreaterThan(0);
  });

  it("splits a cell that crosses the antimeridian into the two polygons it is", async () => {
    /**
     * **repair.** Read as a planar polygon, a boundary with vertices on both
     * sides of ±180 is not a hexagon near the seam — it is a shape stretching
     * most of the way round the earth, whose fill would cover every other
     * layer. Measured before the repair, the cell at 0°N 179.999°E parsed to an
     * extent from −179.998762 to 179.999305.
     *
     * withheld the shape, which was honest and gave a user in Fiji no hexagons
     * at all. Now it is split, and the assertions are the ones that fail if any
     * step of the rebuild is wrong: two parts rather than one, each side of the
     * meridian reached exactly, and — the one that catches an arithmetic slip
     * anywhere — the cell still **contains its own centre**.
     */
    await conn.run(`DROP TABLE IF EXISTS seam_fixture`);
    await conn.run(
      `CREATE TABLE seam_fixture AS SELECT * FROM (VALUES
         (1, ST_Point(179.999, 0.0)),
         (2, ST_Point(-179.999, 0.0)),
         (3, ST_Point(13.4, 52.5)),
         (4, ST_Point(-122.418, 37.776))) t(id, geom)`,
    );
    const drawn = await rows(
      `SELECT id, h3_cell,
              ST_GeometryType(geom) AS kind,
              ST_Contains(geom, ST_Point(h3_cell_to_lng(h3_cell), h3_cell_to_lat(h3_cell))) AS holds_centre,
              round(ST_XMin(geom), 3) AS xmin, round(ST_XMax(geom), 3) AS xmax
       FROM (${h3CellSql({ name: "seam_fixture", geometryColumn: "geom" } as DataTable, 8, true)})
       ORDER BY id`,
    );

    // Both seam cells, east and west of the line, become two parts that meet
    // the meridian exactly.
    for (const row of [drawn[0], drawn[1]]) {
      expect(row.kind).toBe("MULTIPOLYGON");
      expect(Number(row.xmin)).toBe(-180);
      expect(Number(row.xmax)).toBe(180);
      expect(row.holds_centre).toBe(true);
    }
    // Everywhere else is untouched — one polygon, its own narrow extent, in
    // both hemispheres, so the unwrap cannot have moved an ordinary cell.
    expect(drawn[2].kind).toBe("POLYGON");
    expect(Number(drawn[2].xmax) - Number(drawn[2].xmin)).toBeLessThan(1);
    expect(drawn[2].holds_centre).toBe(true);
    expect(drawn[3].kind).toBe("POLYGON");
    expect(Number(drawn[3].xmin)).toBeLessThan(-122);
    expect(drawn[3].holds_centre).toBe(true);
  });

  it("leaves a coarse polar cell alone, which also spans more than 180°", async () => {
    /**
     * **A wide longitude span does not mean a seam crossing.** A resolution-0
     * cell near a pole spans 180.3° legitimately, and unwrapping it produces a
     * ring that is a hexagon nowhere — it throws, or answers a shape that does
     * not contain its own centre. One such row aborts the whole query, so a
     * user with data near a pole would lose the run entirely. Found at the
     * cross-model review of the seam repair.
     *
     * The pair of spans separates them: unwrapping collapses a seam cell from
     * 360° to 0.01°, and leaves a polar cell at 324.9°. These run at the coarse
     * resolutions where the case exists at all.
     */
    await conn.run(`DROP TABLE IF EXISTS polar_fixture`);
    await conn.run(
      `CREATE TABLE polar_fixture AS SELECT * FROM (VALUES
         (1, ST_Point(0.0, 85.0)),
         (2, ST_Point(0.0, 89.99)),
         (3, ST_Point(0.0, -89.9)),
         (4, ST_Point(179.999, 0.0))) t(id, geom)`,
    );
    for (const resolution of [0, 1]) {
      const drawn = await rows(
        `SELECT id, ST_IsEmpty(geom) AS empty, ST_GeometryType(geom) AS kind
         FROM (${h3CellSql(
           { name: "polar_fixture", geometryColumn: "geom" } as DataTable,
           resolution,
           true,
         )}) ORDER BY id`,
      );
      // The query completes at all, which is the first thing the bug took
      // away, and every row has a shape.
      expect(drawn, `resolution ${resolution}`).toHaveLength(4);
      for (const row of drawn) {
        expect(row.empty, `resolution ${resolution}, row ${row.id}`).toBe(false);
      }
    }
  });

  it("draws the cell's boundary around the point that produced it", async () => {
    // A correct id does not prove the polygon lands in the right place: the
    // boundary comes back as WKT in longitude/latitude while the cell call
    // takes latitude first, and reversed axes there put every hexagon in the
    // sea off west Africa. So: the boundary must *contain* its own coordinate.
    const answer = await one(
      `SELECT ST_Contains(
                ST_GeomFromText(h3_cell_to_boundary_wkt('${PUBLISHED.cell}')),
                ST_Point(${PUBLISHED.lon}, ${PUBLISHED.lat})) AS contains,
              ST_X(ST_Centroid(ST_GeomFromText(h3_cell_to_boundary_wkt('${PUBLISHED.cell}')))) AS x`,
    );
    expect(answer.contains).toBe(true);
    // And its centroid is at the point's longitude, not at its latitude —
    // which is what a transposed boundary would give.
    expect(Number(answer.x)).toBeCloseTo(PUBLISHED.lon, 2);
  });
});

describe("Getis-Ord Gi* against a hand-computed answer", () => {
  /**
   * Criterion 4, worked by hand from the spec's formula.
   *
   * Five cells in a row on the H3 grid, so adjacency is a straight line:
   *
   *     A — B — C — D — E     values 10, 10, 10, 1, 1
   *
   * The universe is n = 5. Mean X̄ = 32/5 = 6.4.
   * Σx² = 100+100+100+1+1 = 302, so the population variance is
   * 302/5 − 6.4² = 60.4 − 40.96 = 19.44 and S = 4.409081…
   *
   * **At one step**, C's neighbourhood is {B, C, D}: m = 3, S_i = 21.
   *   numerator   = 21 − 6.4×3 = 1.8
   *   denominator = S × √((5×3 − 9) / 4) = 4.409081 × √1.5 = 5.400000
   *   Gi*(C)      = 0.333333…
   * A's neighbourhood is {A, B}: m = 2, S_i = 20.
   *   numerator   = 20 − 12.8 = 7.2
   *   denominator = S × √((10 − 4) / 4) = 4.409081 × 1.224745 = 5.400000
   *   Gi*(A)      = 1.333333…
   *
   * **At two steps**, C's neighbourhood is every cell: m = n = 5, so
   * 5×5 − 25 = 0 and C's score is *null* — the vanishing denominator the spec
   * answers with a null rather than a number.
   */
  const VALUES = [10, 10, 10, 1, 1];

  /**
   * Five cells in a straight line, taken from H3's own grid path between two
   * cells four steps apart — so the adjacency the test assumes is the grid's,
   * not an assumption about it.
   */
  const line = async (): Promise<string[]> => {
    const start = "8928308280fffff";
    const far = String(
      (
        await one(
          `SELECT cell FROM (SELECT unnest(h3_grid_disk('${start}', 4)) AS cell)
           WHERE h3_grid_distance('${start}', cell) = 4 ORDER BY cell LIMIT 1`,
        )
      ).cell,
    );
    const path = await rows(
      `SELECT unnest(h3_grid_path_cells('${start}', '${far}')) AS cell`,
    );
    const cells = path.map((r) => String(r.cell));
    expect(cells).toHaveLength(5);
    return cells;
  };

  /**
   * A table of points standing at those cells' own centres, so the verb's own
   * assignment puts them back where the fixture intends. `extra` adds cells the
   * ruling says must **not** reach the universe.
   */
  async function fixture(
    cells: string[],
    extra: { cell: string; rows: number; weight: number | null }[] = [],
  ): Promise<DataTable> {
    const points = [
      ...cells.flatMap((cell, i) =>
        Array.from({ length: VALUES[i] }, () => ({ cell, weight: 1 })),
      ),
      ...extra.flatMap((e) =>
        Array.from({ length: e.rows }, () => ({ cell: e.cell, weight: e.weight })),
      ),
    ];
    await conn.run(`DROP TABLE IF EXISTS gi_fixture`);
    await conn.run(
      `CREATE TABLE gi_fixture AS SELECT
         ST_Point(h3_cell_to_lng(cell), h3_cell_to_lat(cell)) AS geom,
         weight
       FROM (VALUES ${points
         .map((p) => `('${p.cell}', ${p.weight === null ? "NULL" : p.weight})`)
         .join(", ")}) t(cell, weight)`,
    );
    return { name: "gi_fixture", geometryColumn: "geom" } as DataTable;
  }

  const scored = async (sql: string) =>
    new Map((await rows(sql)).map((r) => [String(r.h3_cell), r]));

  it("matches the hand-computed scores at one step", async () => {
    // **Through the shipped generator**, not through the formula retyped: a
    // test that recomputes Gi* beside the verb proves the arithmetic and
    // nothing about what the verb does with it.
    const cells = await line();
    const table = await fixture(cells);
    const byCell = await scored(hotspotSql(table, 9, 1, "count", null));

    const c = byCell.get(cells[2])!;
    expect(Number(c.neighbour_count)).toBe(3);
    expect(Number(c.value)).toBe(10);
    expect(Number(c.gi_star)).toBeCloseTo(0.333333, 5);

    const a = byCell.get(cells[0])!;
    expect(Number(a.neighbour_count)).toBe(2);
    expect(Number(a.gi_star)).toBeCloseTo(1.333333, 5);
  }, 60_000);

  it("returns null for a cell whose neighbourhood is the whole universe", async () => {
    const cells = await line();
    const table = await fixture(cells);
    const byCell = await scored(hotspotSql(table, 9, 2, "count", null));

    const c = byCell.get(cells[2])!;
    expect(Number(c.neighbour_count)).toBe(5);
    expect(c.gi_star).toBeNull();
    // The rest of the run is perfectly good: the ends still score.
    const a = byCell.get(cells[0])!;
    expect(Number(a.neighbour_count)).toBe(3);
    expect(Number(a.gi_star)).toBeCloseTo(2.0, 5);
  }, 60_000);

  it("keeps its precision on large, closely spaced values", async () => {
    /**
     * **Catastrophic cancellation, and why the aggregate is not hand-rolled.**
     * Computing the population variance as `avg(x²) − avg(x)²` loses every
     * significant digit when the values are large and close: four cells at
     * 1,000,000,000 through 1,000,000,003 evaluate to a standard deviation of
     * **0** in double arithmetic, so every score comes back null while the
     * data plainly has spread. `stddev_pop` answers 1.118034.
     *
     * Worked from the spec's formula on that universe — n = 4, mean
     * 1,000,000,001.5, population sd 1.118034:
     *   A's neighbourhood {A, B}: m = 2, ΣX = 2,000,000,001
     *     numerator   = 2,000,000,001 − 2 × 1,000,000,001.5 = −2
     *     denominator = 1.118034 × √((4×2 − 4)/3) = 1.290994
     *     Gi*(A)      = −1.549193
     *   B's neighbourhood {A, B, C}: m = 3, ΣX = 3,000,000,003
     *     numerator   = −1.5, denominator = 1.118034, Gi*(B) = −1.341641
     *
     * Found at the cross-model review.
     */
    const cells = await line();
    await conn.run(`DROP TABLE IF EXISTS gi_fixture`);
    await conn.run(
      `CREATE TABLE gi_fixture AS SELECT
         ST_Point(h3_cell_to_lng(cell), h3_cell_to_lat(cell)) AS geom, weight
       FROM (VALUES ${cells
         .slice(0, 4)
         .map((cell, i) => `('${cell}', ${1_000_000_000 + i})`)
         .join(", ")}) t(cell, weight)`,
    );
    const table = { name: "gi_fixture", geometryColumn: "geom" } as DataTable;
    const byCell = await scored(hotspotSql(table, 9, 1, "sum", "weight"));

    expect(byCell.size).toBe(4);
    const a = byCell.get(cells[0])!;
    expect(a.gi_star).not.toBeNull();
    expect(Number(a.gi_star)).toBeCloseTo(-1.549193, 5);
    const b = byCell.get(cells[1])!;
    expect(Number(b.gi_star)).toBeCloseTo(-1.341641, 5);
  }, 60_000);

  it("gives the same answer in sum mode, and leaves an all-null cell out of the universe", async () => {
    // G8. The sixth cell holds three points whose value is null. If it entered
    // the universe as a zero, n would be 6 and every score below would move;
    // asserting the *same* hand-computed numbers is what makes that visible.
    const cells = await line();
    const sixth = String(
      (
        await one(
          `SELECT cell FROM (SELECT unnest(h3_grid_disk('${cells[0]}', 6)) AS cell)
           WHERE h3_grid_distance('${cells[0]}', cell) = 6 ORDER BY cell LIMIT 1`,
        )
      ).cell,
    );
    const table = await fixture(cells, [{ cell: sixth, rows: 3, weight: null }]);
    const byCell = await scored(hotspotSql(table, 9, 1, "sum", "weight"));

    expect(byCell.has(sixth)).toBe(false);
    expect(byCell.size).toBe(5);
    const c = byCell.get(cells[2])!;
    expect(Number(c.value)).toBe(10);
    expect(Number(c.gi_star)).toBeCloseTo(0.333333, 5);
    const a = byCell.get(cells[0])!;
    expect(Number(a.gi_star)).toBeCloseTo(1.333333, 5);
  }, 60_000);
});
