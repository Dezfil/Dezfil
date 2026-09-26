import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance, connectQueryInstance, h3Available } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { registerTableViews } from "./views";
import { filteredSql, effectiveSql, wrappable } from "./compile";
import { hexCellAt, mercator } from "@/lib/hex-bin";
import {
  defaultViz,
  isValidFilters,
  type Aggregate,
  type LayerFilter,
  type LayerViz,
} from "@/lib/viz";

// ---- pure composition & escaping ----

describe("filteredSql", () => {
  it("returns the SQL unchanged without filters", () => {
    expect(filteredSql("SELECT * FROM t;", [])).toBe("SELECT * FROM t");
  });

  it("combines filters with AND and escapes idents and values", () => {
    const filters: LayerFilter[] = [
      { field: 'wei"rd', kind: "range", min: 2, max: null },
      { field: "name", kind: "values", values: ["o'hare", "zoo"] },
    ];
    const sql = filteredSql("SELECT * FROM t", filters);
    expect(sql).toContain('"wei""rd" >= 2');
    expect(sql).toContain(`CAST("name" AS VARCHAR) IN ('o''hare', 'zoo')`);
    expect(sql).toMatch(/\) AND \(/);
  });

  it("an all-open range excludes nothing; an empty value set excludes everything", () => {
    expect(
      filteredSql("SELECT 1", [{ field: "x", kind: "range", min: null, max: null }]),
    ).toContain("(TRUE)");
    expect(
      filteredSql("SELECT 1", [{ field: "x", kind: "values", values: [] }]),
    ).toContain("(FALSE)");
  });

  it("time ranges compare in the time domain with escaped ISO literals", () => {
    const sql = filteredSql("SELECT * FROM t", [
      { field: "seen", kind: "timerange", min: "2021-03-01", max: "2021-04-01T10:15:00" },
    ]);
    expect(sql).toContain(`CAST("seen" AS TIMESTAMP) >= '2021-03-01'::TIMESTAMP`);
    expect(sql).toContain(`CAST("seen" AS TIMESTAMP) <= '2021-04-01T10:15:00'::TIMESTAMP`);
    expect(
      filteredSql("SELECT 1", [{ field: "seen", kind: "timerange", min: null, max: null }]),
    ).toContain("(TRUE)");
  });

  it("a malformed time bound never reaches SQL", () => {
    expect(() =>
      filteredSql("SELECT 1", [
        { field: "seen", kind: "timerange", min: "1'); DROP TABLE t; --", max: null },
      ]),
    ).toThrow(/ISO-8601/);
  });
});

describe("filter validation", () => {
  it("accepts-era documents unchanged and the new time kind", () => {
    expect(
      isValidFilters([
        { field: "riders", kind: "range", min: 100, max: null },
        { field: "category", kind: "values", values: ["u", "s"] },
        { field: "seen", kind: "timerange", min: "2021-03-01", max: null },
        { field: "seen", kind: "timerange", min: "2021-03-01 08:30:00", max: null },
        { field: "seen", kind: "timerange", min: null, max: null },
      ]),
    ).toBe(true);
  });

  it("rejects non-ISO time bounds", () => {
    for (const min of ["yesterday", "03/01/2021", "2021", 1614556800, ""]) {
      expect(isValidFilters([{ field: "seen", kind: "timerange", min, max: null }])).toBe(
        false,
      );
    }
  });
});

describe("effectiveSql", () => {
  const hexbin = defaultViz("hexbin");
  it("filters compose before aggregation", () => {
    const sql = effectiveSql(
      {
        sql: "SELECT * FROM t",
        filters: [{ field: "riders", kind: "range", min: 100, max: null }],
        viz: hexbin,
      },
      "geometry",
    );
    // the binning subquery must select from the *filtered* result
    expect(sql).toContain('"riders" >= 100');
    expect(sql.indexOf('"__fq"')).toBeLessThan(sql.indexOf('"riders" >= 100'));
    expect(sql).toContain('GROUP BY "__cx", "__cy"');
  });

  it("points and heatmap pass the filtered SQL through", () => {
    const filters: LayerFilter[] = [{ field: "n", kind: "range", min: 1, max: 2 }];
    const points = effectiveSql({ sql: "SELECT * FROM t", filters, viz: { type: "points" } }, "geometry");
    const heat = effectiveSql({ sql: "SELECT * FROM t", filters, viz: defaultViz("heatmap") }, "geometry");
    expect(points).toBe(heat);
    expect(points).not.toContain("GROUP BY");
  });

  it("aggregation without a geometry column refuses", () => {
    expect(() =>
      effectiveSql({ sql: "SELECT 1", filters: [], viz: hexbin }, null),
    ).toThrow(/geometry column/);
  });

  it("arc/line compose an O→D line first in the SELECT", () => {
    const viz: LayerViz = {
      type: "arc",
      origin: { kind: "geometry", field: "o_geom" },
      dest: { kind: "lonlat", lon: "d_lon", lat: "d_lat" },
      height: 0.6,
    };
    const sql = effectiveSql({ sql: "SELECT * FROM t", filters: [], viz }, "o_geom");
    expect(sql).toMatch(/^SELECT ST_MakeLine\("o_geom", ST_Point\("d_lon"::DOUBLE, "d_lat"::DOUBLE\)\) AS "__od"/);
    // The mapped geometry endpoint leaves the result; both ends must exist.
    expect(sql).toContain('EXCLUDE ("o_geom")');
    expect(sql).toContain('"o_geom" IS NOT NULL');
    expect(sql).toContain('"d_lon" IS NOT NULL AND "d_lat" IS NOT NULL');
  });

  it("arc without mapped endpoints refuses with guidance", () => {
    const viz: LayerViz = { type: "line", origin: null, dest: null, height: 0.6 };
    expect(() =>
      effectiveSql({ sql: "SELECT * FROM t", filters: [], viz }, "geometry"),
    ).toThrow(/origin and destination/);
  });
});

// ---- against the hardened engine ----

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    [
      "name,category,lon,lat,riders",
      "alexanderplatz,u,13.410,52.520,900",
      "hackescher,s,13.402,52.523,700",
      "zoo,u,13.330,52.510,500",
      "sudkreuz,s,13.360,52.480,120",
    ].join("\n"),
  );
  await ingestFile(src, "stations.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function run(sql: string): Promise<Record<string, unknown>[]> {
  const conn = await connectQueryInstance();
  try {
    await registerTableViews(conn);
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    conn.disconnectSync();
  }
}

const base = "SELECT name, category, riders, geometry FROM stations";

/** Deliberately safe hex fixtures: points laid out around the
 * centers of known 1 km-edge cells — cell (0,0) holds two, (1,0) and (0,1)
 * one each — every point hundreds of meters from any cell boundary. */
const HEX_POINTS = [
  { name: "a1", lon: 0, lat: 0, riders: 900 }, // cell (0,0), its center
  { name: "a2", lon: 0.0017967, lat: 0.0008983, riders: 700 }, // (0,0) too
  { name: "b", lon: 0.015559, lat: 0, riders: 500 }, // cell (1,0) center
  { name: "c", lon: 0.0077795, lat: 0.0134747, riders: 120 }, // (0,1) center
];

async function ingestHexPoints(dir: string) {
  const src = path.join(dir, "hexpoints.csv");
  await writeFile(
    src,
    [
      "name,lon,lat,riders",
      ...HEX_POINTS.map((p) => `${p.name},${p.lon},${p.lat},${p.riders}`),
    ].join("\n"),
  );
  await ingestFile(src, "hexpoints.csv");
}

const hexBase = "SELECT name, riders, geometry FROM hexpoints";
const hexViz = (aggregate: Aggregate): LayerViz => ({
  type: "hexbin",
  cellKm: 1,
  aggregate,
});

describe("effective queries on the hardened engine", () => {
  it("hex bins group nearby points and expose value, count, geometry", async () => {
    await ingestHexPoints(dir);
    const rows = await run(
      effectiveSql({ sql: hexBase, filters: [], viz: hexViz({ fn: "count" }) }, "geometry"),
    );
    expect(rows.length).toBe(3);
    const counts = rows.map((r) => Number(r.count)).sort();
    expect(counts).toEqual([1, 1, 2]);
    for (const r of rows) {
      expect(Number(r.value)).toBe(Number(r.count)); // default aggregate: count
      expect(r.geometry).toBeDefined();
    }
  });

  it("hex cells contain their points as DuckDB sees them", async () => {
    await ingestHexPoints(dir);
    const cells = effectiveSql(
      { sql: hexBase, filters: [], viz: hexViz({ fn: "count" }) },
      "geometry",
    );
    const matches = await run(
      `SELECT count(*) AS n FROM (${cells}) AS c
       JOIN hexpoints AS p ON ST_Intersects(c.geometry, p.geometry)`,
    );
    // every point lands inside exactly the cell it was grouped into
    expect(Number(matches[0].n)).toBe(4);
  });

  it("hex binning agrees with the shared TS tessellation at any size", async () => {
    const stations: [number, number][] = [
      [13.41, 52.52],
      [13.402, 52.523],
      [13.33, 52.51],
      [13.36, 52.48],
    ];
    for (const cellKm of [0.5, 2, 50]) {
      const expected = new Set(
        stations.map((p) => {
          const [x, y] = mercator(p);
          const cell = hexCellAt(x, y, cellKm * 1000);
          return `${cell.q}:${cell.r}`;
        }),
      );
      const rows = await run(
        effectiveSql(
          { sql: base, filters: [], viz: { type: "hexbin", cellKm, aggregate: { fn: "count" } } },
          "geometry",
        ),
      );
      expect(rows.length).toBe(expected.size);
      expect(rows.reduce((s, r) => s + Number(r.count), 0)).toBe(4);
    }
  });

  it.each(["sum", "avg", "min", "max"] as const)(
    "aggregates %s over an attribute",
    async (fn) => {
      await ingestHexPoints(dir);
      const viz: LayerViz = {
        type: "hexbin",
        cellKm: 1,
        aggregate: { fn, attribute: "riders" },
      };
      const rows = await run(effectiveSql({ sql: hexBase, filters: [], viz }, "geometry"));
      const pair = rows.find((r) => Number(r.count) === 2)!;
      const expected = { sum: 1600, avg: 800, min: 700, max: 900 }[fn];
      expect(Number(pair.value)).toBe(expected);
    },
  );

  it("grid cells honor the cell size and cover their points", async () => {
    const rows = await run(
      effectiveSql(
        { sql: base, filters: [], viz: { type: "grid", cellKm: 5, aggregate: { fn: "count" } } },
        "geometry",
      ),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.reduce((s, r) => s + Number(r.count), 0)).toBe(4);
    const coarse = await run(
      effectiveSql(
        { sql: base, filters: [], viz: { type: "grid", cellKm: 1000, aggregate: { fn: "count" } } },
        "geometry",
      ),
    );
    expect(coarse.length).toBe(1);
    expect(Number(coarse[0].count)).toBe(4);
  });

  it("filters apply before aggregation and injection attempts stay data", async () => {
    const filters: LayerFilter[] = [
      { field: "riders", kind: "range", min: 400, max: null },
      { field: "category", kind: "values", values: ["u", "x'); DROP TABLE stations; --"] },
    ];
    const rows = await run(
      effectiveSql({ sql: base, filters, viz: defaultViz("hexbin") }, "geometry"),
    );
    // riders >= 400 AND category in (u, <junk>) → alexanderplatz + zoo
    expect(rows.reduce((s, r) => s + Number(r.count), 0)).toBe(2);
    // the table is intact — the hostile value was treated as a literal
    const still = await run("SELECT count(*) AS n FROM stations");
    expect(Number(still[0].n)).toBe(4);
  });

  it("O→D queries run: flow rows become two-point lines", async () => {
    const src = path.join(dir, "flows.csv");
    await writeFile(
      src,
      [
        "route,origin_lon,origin_lat,dest_lon,dest_lat,trips",
        "a,13.40,52.52,13.30,52.51,900",
        "b,13.36,52.48,13.30,52.51,120",
        "c,13.41,52.53,,52.51,50",
      ].join("\n"),
    );
    await ingestFile(src, "flows.csv");
    const viz: LayerViz = {
      type: "arc",
      origin: { kind: "lonlat", lon: "origin_lon", lat: "origin_lat" },
      dest: { kind: "lonlat", lon: "dest_lon", lat: "dest_lat" },
      height: 0.6,
    };
    const rows = await run(
      `SELECT route, trips, ST_AsText("__od") AS wkt,
              ST_NPoints("__od") AS pts
       FROM (${effectiveSql(
         { sql: "SELECT route, origin_lon, origin_lat, dest_lon, dest_lat, trips FROM flows", filters: [], viz },
         null,
       )}) AS od`,
    );
    // The row with a NULL endpoint drops; each line has exactly two points.
    expect(rows.map((r) => r.route).sort()).toEqual(["a", "b"]);
    for (const r of rows) {
      expect(Number(r.pts)).toBe(2);
      expect(String(r.wkt)).toMatch(/^LINESTRING/);
    }
    // Width-by attribute and tooltips keep their column.
    expect(rows.map((r) => Number(r.trips)).sort((x, y) => x - y)).toEqual([
      120, 900,
    ]);
  });

  it("h3 loaded on the hardened instance", async () => {
    await run("SELECT 1");
    expect(h3Available()).toBe(true);
  });
});

describe("wrappable: trailing comments never break the wrapper", () => {
  it("strips a same-line trailing comment", () => {
    expect(wrappable("SELECT 1 -- note")).toBe("SELECT 1");
  });

  it("drops toggled-off comment tail lines", () => {
    expect(wrappable("SELECT 1\n-- LIMIT 5\n-- ORDER BY x")).toBe("SELECT 1");
  });

  it("handles a comment after the trailing semicolon", () => {
    expect(wrappable("SELECT 1; -- note")).toBe("SELECT 1");
  });

  it("still strips a plain trailing semicolon", () => {
    expect(wrappable("SELECT 1;  ")).toBe("SELECT 1");
  });

  it("leaves dashes inside a literal alone", () => {
    expect(wrappable("SELECT 'a -- b' AS t")).toBe("SELECT 'a -- b' AS t");
  });

  it("leaves a multi-line literal ending in a comment-shaped line alone", () => {
    const sql = "SELECT 'x\n-- not a comment' AS t";
    expect(wrappable(sql)).toBe(sql);
  });

  it("respects quoted identifiers containing a single quote", () => {
    const sql = 'SELECT "a\'b" FROM t -- note';
    expect(wrappable(sql)).toBe('SELECT "a\'b" FROM t');
  });

  it("reads through block comments containing quotes", () => {
    expect(wrappable("SELECT 1 /* ' */ -- note")).toBe("SELECT 1");
    expect(wrappable("/* don't */ SELECT 1 -- x")).toBe("/* don't */ SELECT 1");
  });

  it("handles nested block comments", () => {
    expect(wrappable("/* a /* b */ c */ SELECT 1 -- x")).toBe(
      "/* a /* b */ c */ SELECT 1",
    );
  });

  it("trailing block comments are trivia and cannot hide a semicolon", () => {
    expect(wrappable("SELECT 1; /* note */ -- tail")).toBe("SELECT 1");
    expect(wrappable("SELECT 1 /* note */")).toBe("SELECT 1");
  });

  it("leaves dollar-quoted literals alone, strips comments after them", () => {
    expect(wrappable("SELECT $$a -- b$$ AS t")).toBe("SELECT $$a -- b$$ AS t");
    expect(wrappable("SELECT $$x$$ AS t -- n")).toBe("SELECT $$x$$ AS t");
    expect(wrappable("SELECT $tag$y -- z$tag$ AS t")).toBe(
      "SELECT $tag$y -- z$tag$ AS t",
    );
  });

  it("respects escape-string literals", () => {
    expect(wrappable("SELECT e'\\'' AS t -- n")).toBe("SELECT e'\\'' AS t");
  });

  it("bails to the semicolon rule on unterminated constructs", () => {
    expect(wrappable("SELECT 'a")).toBe("SELECT 'a");
    expect(wrappable("SELECT 1 /* open")).toBe("SELECT 1 /* open");
    expect(wrappable("SELECT $$open")).toBe("SELECT $$open");
  });
});
