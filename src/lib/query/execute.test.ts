import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "./execute";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\nsudkreuz,13.36,52.48\n",
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_PREVIEW_ROWS;
  delete process.env.DEZFIL_QUERY_TIMEOUT_S;
  await rm(dir, { recursive: true, force: true });
});

describe("executeQuery", () => {
  it("accepts a trailing semicolon", async () => {
    const result = await executeQuery(testAccountScope(), "SELECT * FROM stations LIMIT 100;");
    expect(result.rowCount).toBe(3);
  });

  it("runs spatial SQL against a table by name", async () => {
    const result = await executeQuery(testAccountScope(),
      "SELECT name, ST_Y(geometry) AS lat FROM stations ORDER BY lat DESC",
    );
    expect(result.rowCount).toBe(3);
    expect(result.columns.map((c) => c.name)).toEqual(["name", "lat"]);
    expect(result.preview[0].name).toBe("alexanderplatz");
  });

  it("caps the preview at the documented limit and reports the exact total", async () => {
    process.env.DEZFIL_PREVIEW_ROWS = "2";
    const result = await executeQuery(testAccountScope(), "SELECT * FROM stations");
    expect(result.rowCount).toBe(3);
    expect(result.preview).toHaveLength(2);
    expect(result.previewTruncated).toBe(true);
  });

  it("returns geometry preview values as WKT", async () => {
    const result = await executeQuery(testAccountScope(), "SELECT geometry FROM stations LIMIT 1");
    expect(String(result.preview[0].geometry)).toMatch(/^POINT \(/);
  });

  it("previews the geometry-type enum as its text, not as geometry", async () => {
    const result = await executeQuery(testAccountScope(),
      "SELECT ST_GeometryType(geometry) AS kind FROM stations LIMIT 1",
    );
    expect(result.columns).toEqual([{ name: "kind", type: "GEOMETRY_TYPE" }]);
    expect(result.preview[0].kind).toBe("POINT");
  });

  it("previews the geometry-type enum beside a real geometry column", async () => {
    const result = await executeQuery(testAccountScope(),
      "SELECT geometry, ST_GeometryType(geometry) AS kind FROM stations LIMIT 1",
    );
    expect(result.preview[0].kind).toBe("POINT");
    expect(String(result.preview[0].geometry)).toMatch(/^POINT \(/);
  });

  it("returns GeoJSON geometry objects when asked", async () => {
    const result = await executeQuery(testAccountScope(),
      "SELECT name, geometry FROM stations ORDER BY name LIMIT 1",
      { geometry: "geojson" },
    );
    expect(result.columns.map((c) => c.type)[1]).toMatch(/^GEOMETRY/);
    expect(result.preview[0].geometry).toEqual({
      type: "Point",
      coordinates: [13.41, 52.52],
    });
    // The default is untouched: the same query without the option is WKT.
    const wkt = await executeQuery(testAccountScope(), "SELECT geometry FROM stations LIMIT 1");
    expect(typeof wkt.preview[0].geometry).toBe("string");
  });

  it("carries a null geometry cell as null under geojson", async () => {
    const result = await executeQuery(testAccountScope(),
      "SELECT NULL::GEOMETRY AS geometry FROM stations LIMIT 1",
      { geometry: "geojson" },
    );
    expect(result.preview[0].geometry).toBeNull();
  });

  it("surfaces missing tables as the engine's own error", async () => {
    await expect(executeQuery(testAccountScope(), "SELECT * FROM nope")).rejects.toMatchObject({
      code: "sql_error",
      message: expect.stringMatching(/nope/),
    });
  });

  it("reports where a sql_error sits, in the user's coordinates", async () => {
    await expect(executeQuery(testAccountScope(), "SELECT *\nFROM nope")).rejects.toMatchObject({
      code: "sql_error",
      extra: { position: { line: 2, column: 6 } },
    });
    await expect(executeQuery(testAccountScope(), "SELECT name FROMM stations")).rejects.toMatchObject({
      code: "sql_error",
      message: expect.stringMatching(/syntax error at or near "stations"/),
      extra: { position: { line: 1, column: 19 } },
    });
    // The trimmed message still carries no quoted statement.
    await expect(executeQuery(testAccountScope(), "SELECT nope_col FROM stations")).rejects.toMatchObject({
      message: expect.not.stringMatching(/LINE 1/),
      extra: { position: { line: 1, column: 8 } },
    });
  });

  it("interrupts a query that exceeds the documented timeout", async () => {
    process.env.DEZFIL_QUERY_TIMEOUT_S = "1";
    await expect(
      executeQuery(testAccountScope(),
        "SELECT count(*) FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3",
      ),
    ).rejects.toMatchObject({ code: "query_timeout" });
  }, 30_000);
});
