import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "@/lib/query/execute";
import { getJob, listJobs } from "@/lib/metadata/jobs";
import { getTableByName } from "@/lib/metadata/tables";
import { startRun } from "./run";
import { laneSettled, resetLane } from "./lane";
import { compileOperation } from "./compile";
import { dryRun } from "./materialize";
import { GROUND_METRES_MAX } from "./catalog";
import { POST as runRoute } from "@/app/api/operations/run/route";

/**
 * Every verb this spec adds, run end to end.
 *
 * **Against real data, through the real lane**, because a generator's SQL text
 * proves the shape of a query and nothing about what the engine does with it —
 * and the row count each verb *promises* is a promise about the engine's
 * answer, not about the string.
 *
 * The fixtures are built so a wrong answer differs: two overlapping shapes, so
 * a clip that multiplied rows would show it; groups of unequal size, so a
 * dissolve's count cannot be right by coincidence; and a point outside every
 * polygon, so a location filter that kept everything would fail.
 */

let dir: string;

/** Four points, two inside the west square, one inside the east square, one
 * outside both. */
const POINTS = [
  { name: "a", lon: 0.2, lat: 0.2, kind: "west", weight: 1 },
  { name: "b", lon: 0.4, lat: 0.4, kind: "west", weight: 2 },
  { name: "c", lon: 2.2, lat: 0.2, kind: "east", weight: 4 },
  // Outside every polygon, and **inside the same UTM zone** as the rest: a
  // measured verb over data spanning two zones is refused now that the extent
  // is the dataset's ('s repair), and this fixture is about the verbs.
  { name: "d", lon: 5.0, lat: 0.9, kind: "far", weight: 8 },
];

/** Two squares, overlapping in x from 1.5 to 2.5 — so a clip against "the
 * whole of" them cannot be confused with a clip against each. */
const SQUARES = [
  { name: "west", wkt: "POLYGON((0 0, 2.5 0, 2.5 1, 0 1, 0 0))", zone: "w" },
  { name: "east", wkt: "POLYGON((1.5 0, 4 0, 4 1, 1.5 1, 1.5 0))", zone: "e" },
];

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-verbs-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();

  // **A CSV, deliberately, against GeoJSON polygons below.** This suite used
  // GeoJSON points while stood, because the engine refused every spatial
  // predicate between geometry the CSV path built and geometry GDAL read. The
  // repair is what lets the natural fixture come back, and the verbs are
  // exercised across the seam rather than around it.
  const points = path.join(dir, "points.csv");
  await writeFile(
    points,
    `name,lon,lat,kind,weight\n${POINTS.map(
      (p) => `${p.name},${p.lon},${p.lat},${p.kind},${p.weight}`,
    ).join("\n")}\n`,
  );
  await ingestFile(points, "points.csv");

  const squares = path.join(dir, "squares.geojson");
  await writeFile(
    squares,
    JSON.stringify({
      type: "FeatureCollection",
      features: SQUARES.map((s) => ({
        type: "Feature",
        properties: { name: s.name, zone: s.zone },
        geometry: wktToGeoJson(s.wkt),
      })),
    }),
  );
  await ingestFile(squares, "squares.geojson");

  // A second polygon table on the same side of the CRS seam as `squares` (a
  // derived table and an imported one cannot be joined), for the two-input
  // overlay verbs. **Two strips, and the west square crosses both.** With one
  // clip feature a whole-mask clip and a forbidden feature-by-feature one give
  // the same row count, so the fixture could not tell them apart — found at
  // the cross-model review, and this is what makes the rule's assertion
  // able to fail.
  const strip = path.join(dir, "strip.geojson");
  await writeFile(
    strip,
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "strip_a" },
          geometry: wktToGeoJson("POLYGON((0.1 0, 0.6 0, 0.6 1, 0.1 1, 0.1 0))"),
        },
        {
          type: "Feature",
          properties: { name: "strip_b" },
          geometry: wktToGeoJson("POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"),
        },
      ],
    }),
  );
  await ingestFile(strip, "strip.geojson");

  const keys = path.join(dir, "keys.csv");
  await writeFile(keys, "kind,label\nwest,Western\neast,Eastern\n");
  await ingestFile(keys, "keys.csv");
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function wktToGeoJson(wkt: string): { type: string; coordinates: number[][][] } {
  const ring = wkt
    .replace(/^POLYGON\(\(/, "")
    .replace(/\)\)$/, "")
    .split(", ")
    .map((pair) => pair.split(" ").map(Number));
  return { type: "Polygon", coordinates: [ring] };
}

async function run(operation: string, parameters: Record<string, unknown>) {
  const job = await startRun({ operation, parameters });
  await laneSettled();
  return getJob(job.id)!;
}

const rowsOf = async (table: string) =>
  (await executeQuery(`SELECT * FROM ${table}`)).preview;

/** The table's column names, sorted — for exact-schema assertions. */
const columnsOfTable = async (table: string) =>
  (await executeQuery(`SELECT * FROM ${table} LIMIT 0`)).columns
    .map((c) => c.name)
    .sort();

describe("every verb runs, and produces what it promises", () => {
  it("centroid: one point per feature", async () => {
    const job = await run("centroid", { input: "squares", name: "centres" });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const table = getTableByName("centres")!;
    expect(table.rowCount).toBe(SQUARES.length);
    expect(table.geometryType).toMatch(/POINT/i);
  }, 60_000);

  it("convex hull: one hull per group, with the count it wrapped", async () => {
    const job = await run("convex_hull", {
      input: "points",
      group_by: ["kind"],
      name: "hulls",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    // Three kinds among four points — so a per-group hull is three rows, and a
    // single hull over everything would be one.
    const hulls = getTableByName("hulls")!;
    expect(hulls.rowCount).toBe(3);
    // **The class the catalog promises, and it promises `probed` here**: a
    // hull of one point is a point, so this fixture registers a mixed class
    // and the catalog says so rather than claiming polygon.
    expect(hulls.geometryType).not.toBeNull();
    const rows = await rowsOf("hulls");
    const west = rows.find((r) => r.kind === "west")!;
    expect(Number(west.feature_count)).toBe(2);
  }, 60_000);

  it("simplify: the same features, fewer vertices", async () => {
    const job = await run("simplify", {
      input: "squares",
      tolerance: 1000,
      name: "coarse",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const coarse = getTableByName("coarse")!;
    expect(coarse.rowCount).toBe(SQUARES.length);
    expect(coarse.geometryType).toMatch(/POLYGON/i);
  }, 60_000);

  it("simplify: a geometry simplified to nothing drops its feature", async () => {
    // A house-sized square among the degree-sized ones: at a 1 km tolerance
    // it simplifies to nothing and is dropped; the big ones keep their
    // simplified shape and unchanged attributes.
    const mixed = path.join(dir, "mixed.geojson");
    await writeFile(
      mixed,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          ...SQUARES.map((s) => ({
            type: "Feature",
            properties: { name: s.name, zone: s.zone },
            geometry: wktToGeoJson(s.wkt),
          })),
          {
            type: "Feature",
            properties: { name: "tiny", zone: "t" },
            geometry: wktToGeoJson(
              "POLYGON((0 0, 0.001 0, 0.001 0.001, 0 0.001, 0 0))",
            ),
          },
        ],
      }),
    );
    await ingestFile(mixed, "mixed.geojson");
    const job = await run("simplify", {
      input: "mixed",
      tolerance: 1000,
      name: "survivors",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const survivors = await rowsOf("survivors");
    expect(survivors.map((r) => r.name).sort()).toEqual(["east", "west"]);
    expect(await columnsOfTable("survivors")).toEqual(
      (await columnsOfTable("mixed")).sort(),
    );
  }, 60_000);

  it("simplify: an absurd tolerance says zero at the dry run, then writes zero", async () => {
    // The silent case the browser round found: a blank layer
    // asserting the full count. Now the dry run reports what will survive
    // **before** anything is written, and the output holds what it says.
    const compiled = await compileOperation(
      "simplify",
      { input: "squares", tolerance: 1_000_000 },
      { requireName: false },
    );
    expect((await dryRun(compiled.sql)).rowCount).toBe(0);

    const job = await run("simplify", {
      input: "squares",
      tolerance: 1_000_000,
      name: "gone",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    expect(getTableByName("gone")!.rowCount).toBe(0);
  }, 60_000);

  it("dissolve: one shape per group, carrying how many it merged", async () => {
    const job = await run("dissolve", {
      input: "points",
      group_by: ["kind"],
      name: "merged",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const merged = getTableByName("merged")!;
    expect(merged.rowCount).toBe(3);
    expect(merged.geometryType).not.toBeNull();
    const rows = await rowsOf("merged");
    expect(Number(rows.find((r) => r.kind === "west")!.feature_count)).toBe(2);
    expect(Number(rows.find((r) => r.kind === "far")!.feature_count)).toBe(1);
  }, 60_000);

  it("group & summarize: one row per group, and no geometry", async () => {
    const job = await run("group_summarize", {
      input: "points",
      group_by: ["kind"],
      aggregates: [{ aggregate: "count" }, { aggregate: "sum", field: "weight" }],
      name: "summary",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const table = getTableByName("summary")!;
    expect(table.rowCount).toBe(3);
    // A result with no geometry is a dataset, not a failure.
    expect(table.geometryColumn).toBeNull();
    const rows = await rowsOf("summary");
    expect(Number(rows.find((r) => r.kind === "west")!.sum_weight)).toBe(3);
  }, 60_000);

  it("filter rows: the rows that match, and only those", async () => {
    const job = await run("filter_rows", {
      input: "points",
      field: "kind",
      comparison: "equals",
      value: "west",
      name: "westerly",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const westerly = getTableByName("westerly")!;
    expect(westerly.rowCount).toBe(2);
    expect(westerly.geometryType).toMatch(/POINT/i);
  }, 60_000);

  it("join by key: one row per left row, with the match count", async () => {
    const job = await run("join_by_key", {
      left: "points",
      right: "keys",
      left_key: "kind",
      right_key: "kind",
      carry: ["label"],
      name: "labelled",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    // Four points in, four rows out — including the one whose kind matches
    // nothing, which keeps its own values.
    const labelled = getTableByName("labelled")!;
    expect(labelled.rowCount).toBe(POINTS.length);
    expect(labelled.geometryType).toMatch(/POINT/i);
    const rows = await rowsOf("labelled");
    expect(rows.find((r) => r.name === "a")!.label).toBe("Western");
    expect(rows.find((r) => r.name === "d")!.label).toBeNull();
  }, 60_000);

  it("clip: one row per surviving feature, not one per overlap", async () => {
    const job = await run("clip", {
      input: "squares",
      clip: "strip",
      name: "clipped",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    // The west square crosses **both** clip features, and comes back once. A
    // feature-by-feature intersection would have given it two rows — which is
    // what makes this count able to fail.
    expect(getTableByName("clipped")!.rowCount).toBe(2);
    const clipped = await rowsOf("clipped");
    expect(clipped.filter((r) => r.name === "west")).toHaveLength(1);
    // **The input's schema, exactly**: the input's attributes plus its
    // geometry column, and no operation-owned working column — the shape
    // that leaked `__dezfil_clipped` into the workspace, exports and carry
    // pickers. Values ride through unchanged.
    expect(await columnsOfTable("clipped")).toEqual(
      (await columnsOfTable("squares")).sort(),
    );
    expect(clipped.find((r) => r.name === "west")!.zone).toBe("w");
  }, 60_000);

  it("difference: what is left outside, and nothing that is empty", async () => {
    const job = await run("difference", {
      input: "squares",
      erase: "strip",
      name: "remaining",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const remaining = getTableByName("remaining")!;
    expect(remaining.rowCount).toBe(2);
    expect(remaining.geometryType).toMatch(/POLYGON/i);
    // The same exact-schema promise as the clip.
    expect(await columnsOfTable("remaining")).toEqual(
      (await columnsOfTable("squares")).sort(),
    );
    expect((await rowsOf("remaining")).find((r) => r.name === "east")!.zone).toBe("e");
  }, 60_000);

  it("clip and difference: a user's own internal-prefix column is theirs", async () => {
    // No column name is reserved (spec): the computed geometry replaces
    // the input's under its own name, so an input that happens to carry
    // `__dezfil_clipped` keeps it, value intact — the withdrawn
    // alternative refused such inputs at admission for no reason.
    const theirs = path.join(dir, "theirs.geojson");
    await writeFile(
      theirs,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "mine", __dezfil_clipped: 7 },
            geometry: wktToGeoJson("POLYGON((0 0, 2.5 0, 2.5 1, 0 1, 0 0))"),
          },
        ],
      }),
    );
    await ingestFile(theirs, "theirs.geojson");
    expect(await columnsOfTable("theirs")).toContain("__dezfil_clipped");

    for (const [operation, key, name] of [
      ["clip", "clip", "theirs_clipped"],
      ["difference", "erase", "theirs_remaining"],
    ] as const) {
      const job = await run(operation, { input: "theirs", [key]: "strip", name });
      expect(job.state, job.errorMessage ?? "").toBe("succeeded");
      expect(await columnsOfTable(name)).toEqual(
        (await columnsOfTable("theirs")).sort(),
      );
      const rows = await rowsOf(name);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].__dezfil_clipped)).toBe(7);
    }
  }, 60_000);

  it("union: three pieces, each saying where it came from", async () => {
    const job = await run("union", {
      left: "squares",
      right: "strip",
      name: "overlaid",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const rows = await rowsOf("overlaid");
    // Shared, left-only and right-only — and every piece names its source
    // (ruling G2). The strip lies inside the squares' union, so its
    // right-only piece is empty and dropped: two pieces, both named.
    const sources = rows.map((r) => String(r.source)).sort();
    expect(sources).toEqual(["both", "left"]);
  }, 60_000);

  it("nearest join: one row per left feature, including the far one", async () => {
    const job = await run("nearest_join", {
      left: "points",
      right: "squares",
      // `zone`, not `name`: both tables have a `name` column, and carrying it
      // is refused rather than silently renamed — asserted below.
      carry: ["zone"],
      name: "nearest",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const nearest = getTableByName("nearest")!;
    expect(nearest.rowCount).toBe(POINTS.length);
    expect(nearest.geometryType).toMatch(/POINT/i);
    const rows = await rowsOf("nearest");
    // The distance is reported, so a reader can see how near the nearest was.
    expect(Number(rows.find((r) => r.name === "a")!.nearest_distance_m)).toBe(0);
    expect(
      Number(rows.find((r) => r.name === "d")!.nearest_distance_m),
    ).toBeGreaterThan(0);
  }, 60_000);

  it("filter by location: kept once, however many it is near", async () => {
    const job = await run("filter_by_location", {
      input: "points",
      mask: "squares",
      relation: "within",
      name: "inside",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    // Three of the four points are inside a square; the far one is not. The
    // point at 2.2 is inside **both** squares and is kept once.
    const inside = getTableByName("inside")!;
    expect(inside.rowCount).toBe(3);
    expect(inside.geometryType).toMatch(/POINT/i);
  }, 60_000);

  it("filter by location: any relationship can be negated", async () => {
    // **Negation is a flag on the relationship, not a relationship of its
    // own.** `disjoint` only negates intersection; not-within is a different
    // question, and a point on a boundary is neither within a polygon nor
    // disjoint from it. Found at the cross-model review.
    const job = await run("filter_by_location", {
      input: "points",
      mask: "squares",
      relation: "within",
      negate: true,
      name: "outside",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    expect(getTableByName("outside")!.rowCount).toBe(1);
  }, 60_000);
});

describe("a failure speaks the product's language", () => {
  // A numeric comparison over a text column passes admission — the field
  // exists, the comparison is offered, the value is a number — and fails in
  // the engine: the leak class *"Conversion Error: Could not convert
  // string 'Mitte' to DOUBLE"*. The pinned build
  // refuses this seed at bind time, so the kept diagnosis is the binder's;
  // the SQL-step case below exercises a true conversion error and keeps it.
  const seeded = {
    input: "points",
    field: "name",
    comparison: "greater_than",
    value: 5,
  };

  // A string value against the numeric weight column reaches the engine and
  // fails converting the *value* — the diagnosis names 'abc', so retention
  // of the concrete user value is assertable.
  const seededValue = {
    input: "points",
    field: "weight",
    comparison: "equals",
    value: "abc",
  };

  it("a generated verb's run names the operation and drops the engine prefix", async () => {
    const job = await run("filter_rows", { ...seeded, name: "broken" });
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("sql_error");
    expect(job.errorMessage).toMatch(/^Filter rows could not run on this data: /);
    // The actionable part survives: what the engine could not do, verbatim.
    expect(job.errorMessage).toMatch(/compare values|cast/i);
    // No engine class prefix anywhere, and no statement text.
    expect(job.errorMessage).not.toMatch(/[A-Za-z ]+ Error:/);
    expect(job.errorMessage).not.toMatch(/SELECT/);
  }, 60_000);

  it("the concrete user value in the engine's diagnosis survives the curation", async () => {
    const job = await run("filter_rows", { ...seededValue, name: "broken2" });
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("sql_error");
    expect(job.errorMessage).toMatch(/^Filter rows could not run on this data: /);
    // The engine says which value it choked on, and the sentence keeps it.
    expect(job.errorMessage).toContain("'abc'");
    expect(job.errorMessage).not.toMatch(/[A-Za-z ]+ Error:/);
  }, 60_000);

  it("the dry run takes the same voice through the public route, and mints no job", async () => {
    // Through the route, not the boundary directly: the
    // route is what forwards the operation identity, and a test that hands
    // it over itself would stay green with the wiring broken.
    const response = await runRoute(
      new Request("http://localhost/api/operations/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "filter_rows",
          parameters: seededValue,
          dryRun: true,
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("sql_error");
    expect(body.error.message).toMatch(/^Filter rows could not run on this data: /);
    expect(body.error.message).toContain("'abc'");
    expect(body.error.message).not.toMatch(/[A-Za-z ]+ Error:/);
    expect(listJobs()).toHaveLength(0);
  }, 60_000);

  it("the SQL step keeps the engine's diagnostic — that SQL is the user's", async () => {
    const job = await run("sql_step", {
      sql: "SELECT CAST(name AS DOUBLE) AS n FROM points",
      name: "cast_broken",
    });
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("sql_error");
    // The workspace's form: the class prefix is the cure here, not jargon.
    expect(job.errorMessage).toMatch(/Conversion Error/i);
    expect(job.errorMessage).not.toContain("could not run on this data");
  }, 60_000);

  it("the SQL step's dry run keeps the diagnostic too, through the route", async () => {
    // A bind-time failure, deliberately: the runtime cast seed survives a
    // dry run because counting rows prunes the failing column away.
    const response = await runRoute(
      new Request("http://localhost/api/operations/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "sql_step",
          parameters: { sql: "SELECT name > 5 AS broken FROM points" },
          dryRun: true,
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("sql_error");
    // The workspace's form, class prefix and all — never the voice.
    expect(body.error.message).toMatch(/Binder Error/i);
    expect(body.error.message).not.toContain("could not run on this data");
    expect(listJobs()).toHaveLength(0);
  }, 60_000);

  it("an out-of-memory run keeps the boundary's code, never the voice", async () => {
    // The bypass sits above the voice split, so an engine OOM must reach the
    // memory boundary's own coded answer whatever the operation was. Seeded
    // exactly as the query-bounds suite seeds it: the operation lane had
    // no memory coverage of its own.
    process.env.DEZFIL_QUERY_MEMORY_MB = "64";
    resetQueryInstance();
    try {
      const job = await run("sql_step", {
        sql: "SELECT hash(a.range) AS h FROM (SELECT * FROM range(50000000) ORDER BY hash(range)) a",
        name: "hungry",
      });
      expect(job.state).toBe("failed");
      expect(job.errorCode).toBe("query_memory_exceeded");
      expect(job.errorMessage).toContain("memory budget");
    } finally {
      delete process.env.DEZFIL_QUERY_MEMORY_MB;
      resetQueryInstance();
    }
  }, 60_000);
});

describe("what a verb refuses, it refuses at admission", () => {
  const refusal = async (operation: string, parameters: Record<string, unknown>) => {
    try {
      await startRun({ operation, parameters });
      return null;
    } catch (error) {
      return error as { code?: string; message?: string };
    }
  };

  it("refuses an input that is not a table, naming it", async () => {
    const error = await refusal("centroid", { input: "nowhere", name: "x" });
    expect(error?.code).toBe("not_found");
    expect(error?.message).toContain("nowhere");
 // The sentence reads as one (a sitting): the generic key is
    // literally "input", and the template once doubled it.
    expect(error?.message).toMatch(/^The input "nowhere"/);
    expect(error?.message).not.toContain("input input");
  });

  it("refuses a missing column in a sentence that survives a noun role", async () => {
    // "nothing to grouping column" shipped; the template
    // now says what the column would have been used as.
    const error = await refusal("group_summarize", {
      input: "points",
      group_by: ["colour"],
      aggregates: [{ aggregate: "count" }],
      name: "x",
    });
    expect(error?.code).toBe("invalid_request");
    expect(error?.message).toContain('to use as the grouping column');
    expect(error?.message).not.toMatch(/nothing to grouping/);
  });

  it("every ground-metre value refuses past the ceiling, and takes it exactly", async () => {
    // D3: half the WGS84 meridional circumference, served, and refused at admission — 1e12 was
    // accepted without comment (browser round). Five parameters, one contract; the ceiling itself
    // passes admission (asserted at the compile gate, so nothing giant actually runs), one metre
    // above it is refused with the curated sentence.
    const past = GROUND_METRES_MAX + 1;
    const cases: [string, Record<string, unknown>, string][] = [
      ["buffer", { input: "squares", name: "x" }, "distance"],
      ["simplify", { input: "squares", name: "x" }, "tolerance"],
      [
        "nearest_join",
        { left: "points", right: "squares", name: "x" },
        "max_distance",
      ],
      [
        "filter_by_location",
        { input: "points", mask: "squares", relation: "within_distance", name: "x" },
        "distance",
      ],
      ["cluster_by_distance", { input: "points", name: "x" }, "distance"],
    ];
    for (const [operation, base, key] of cases) {
      const error = await refusal(operation, { ...base, [key]: past });
      expect(error?.code, operation).toBe("invalid_request");
      expect(error?.message, operation).toContain("20,003,932");
      await expect(
        compileOperation(
          operation,
          { ...base, [key]: GROUND_METRES_MAX },
          { requireName: false },
        ),
        operation,
      ).resolves.toBeDefined();
    }
  }, 60_000);

  it("refuses a column the table does not have, and lists the ones it does", async () => {
    const error = await refusal("filter_rows", {
      input: "points",
      field: "colour",
      comparison: "equals",
      value: "red",
      name: "x",
    });
    expect(error?.code).toBe("invalid_request");
    expect(error?.message).toContain("colour");
    expect(error?.message).toContain("kind");
  });

  it("refuses a distance that is not a positive number", async () => {
    for (const tolerance of [0, -5, "500", null]) {
      const error = await refusal("simplify", {
        input: "squares",
        tolerance,
        name: "x",
      });
      expect(error?.code, String(tolerance)).toBe("invalid_request");
    }
  });

  it("refuses a geometryless input to a verb that needs geometry", async () => {
    const error = await refusal("centroid", { input: "keys", name: "x" });
    expect(error?.code).toBe("invalid_request");
    expect(error?.message).toMatch(/no geometry/i);
  });

  it("refuses a measured verb over data spanning more than one zone", async () => {
    // **End to end, through admission** — not at the strategy. Before repair
    // the extent came from the first row, so this refusal could not fire at
    // all; the fixture's first point is deliberately in-band and a later one
    // is not, which is exactly the case that used to pass.
    const wide = path.join(dir, "wide.geojson");
    await writeFile(
      wide,
      JSON.stringify({
        type: "FeatureCollection",
        features: [0.5, 40].map((lon) => ({
          type: "Feature",
          properties: { name: `p${lon}` },
          geometry: { type: "Point", coordinates: [lon, 10] },
        })),
      }),
    );
    await ingestFile(wide, "wide.geojson");

    const error = await refusal("nearest_join", {
      left: "wide",
      right: "points",
      name: "x",
    });
    expect(error?.code).toBe("measurement_crs_unavailable");
    expect(error?.message).toMatch(/more than one UTM zone/i);
  }, 60_000);

  it("refuses a table whose geometry class the input does not accept", async () => {
    // The picker filters what it offers; an API caller is not the picker.
    const error = await refusal("simplify", {
      input: "points",
      tolerance: 100,
      name: "x",
    });
    expect(error?.code).toBe("invalid_request");
    expect(error?.message).toMatch(/point/i);
  });

  it("refuses an aggregate a column cannot take, before a job exists", async () => {
    const error = await refusal("group_summarize", {
      input: "points",
      aggregates: [{ aggregate: "sum", field: "kind" }],
      name: "x",
    });
    expect(error?.code).toBe("invalid_request");
    expect(error?.message).toMatch(/not a numeric column/i);
  });

  it("refuses grouping by geometry in a verb that answers no geometry", async () => {
    const error = await refusal("group_summarize", {
      input: "points",
      // The CSV path names its geometry column `geometry`.
      group_by: ["geometry"],
      aggregates: [{ aggregate: "count" }],
      name: "x",
    });
    expect(error?.code).toBe("invalid_request");
    expect(error?.message).toMatch(/group by an attribute/i);
  });

  it("refuses a carried column that collides with one the left already has", async () => {
    const error = await refusal("nearest_join", {
      left: "points",
      right: "squares",
      carry: ["name"],
      name: "x",
    });
    expect(error?.code).toBe("invalid_request");
    expect(error?.message).toContain("name");
    expect(error?.message).toMatch(/two columns of that name/i);
  });

  it("refuses an aggregate it does not offer, and one with no column", async () => {
    expect(
      (
        await refusal("group_summarize", {
          input: "points",
          aggregates: [{ aggregate: "median", field: "weight" }],
          name: "x",
        })
      )?.message,
    ).toContain("median");
    expect(
      (
        await refusal("group_summarize", {
          input: "points",
          aggregates: [{ aggregate: "sum" }],
          name: "x",
        })
      )?.message,
    ).toMatch(/needs the column/i);
  });
});
