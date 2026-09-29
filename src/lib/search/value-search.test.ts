import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { searchValues, type ValueSearchLayer } from "./value-search";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
});

afterAll(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

/** Table-free layers: literal VALUES rows, so the tests exercise the
 * scan without any uploaded artifact. */
const stations = (id = "l1", name = "Stations"): ValueSearchLayer => ({
  layerId: id,
  layerName: name,
  sql: `SELECT * FROM (VALUES
    ('Alexanderplatz', 'U2', ST_Point(13.41, 52.52)),
    ('Zoologischer Garten', 'U2', ST_Point(13.33, 52.51)),
    ('Südkreuz', NULL, ST_Point(13.36, 52.48))
  ) AS t(name, line, geom)`,
});

describe("value search", () => {
  it("matches case-insensitive substrings in text fields, one row per feature", async () => {
    const rows = await searchValues(testAccountScope(), [stations()], "alex");
    expect(rows).toEqual([
      {
        layerId: "l1",
        layerName: "Stations",
        field: "name",
        value: "Alexanderplatz",
        point: [13.41, 52.52],
      },
    ]);
    // "U2" matches two features in one field each — two rows, not four.
    expect(await searchValues(testAccountScope(), [stations()], "u2")).toHaveLength(2);
  });

  it("folds Unicode case in the engine", async () => {
    const rows = await searchValues(testAccountScope(), [stations()], "SÜDKREUZ");
    expect(rows.map((r) => r.value)).toEqual(["Südkreuz"]);
  });

  it("folds ß against SS on both sides of the match", async () => {
    const layer: ValueSearchLayer = {
      layerId: "l1",
      layerName: "L",
      sql: `SELECT 'Hauptstraße 12' AS address, ST_Point(0, 0) AS geom`,
    };
    expect((await searchValues(testAccountScope(), [layer], "STRASSE")).map((r) => r.value)).toEqual(
      ["Hauptstraße 12"],
    );
    // And the mirror: data holds "ss", the query holds "ß".
    const mirror: ValueSearchLayer = {
      layerId: "l2",
      layerName: "L",
      sql: `SELECT 'Hauptstrasse 12' AS address, ST_Point(0, 0) AS geom`,
    };
    expect((await searchValues(testAccountScope(), [mirror], "straße")).map((r) => r.value)).toEqual(
      ["Hauptstrasse 12"],
    );
  });

  it("treats pattern characters as literal text", async () => {
    const layer: ValueSearchLayer = {
      layerId: "l1",
      layerName: "L",
      sql: `SELECT * FROM (VALUES
        ('100% organic', ST_Point(0, 0)),
        ('abc', ST_Point(1, 1))
      ) AS t(label, geom)`,
    };
    expect(await searchValues(testAccountScope(), [layer], "100%")).toHaveLength(1);
    expect(await searchValues(testAccountScope(), [layer], "a%c")).toEqual([]);
    expect(await searchValues(testAccountScope(), [layer], "a_c")).toEqual([]);
  });

  it("keeps injection-shaped text as data", async () => {
    for (const hostile of [
      "'; DROP TABLE x; --",
      `") OR 1=1 --`,
      "$$ union select",
    ]) {
      expect(await searchValues(testAccountScope(), [stations()], hostile)).toEqual([]);
    }
  });

  it("reaches only genuine text columns", async () => {
    const layer: ValueSearchLayer = {
      layerId: "l1",
      layerName: "L",
      // "true" and "42" exist as boolean/number renderings, not text.
      sql: `SELECT * FROM (VALUES
        ('name-true-42', true, 42, ST_Point(0, 0))
      ) AS t(name, flag, count, geom)`,
    };
    expect(await searchValues(testAccountScope(), [layer], "true")).toHaveLength(1);
    expect((await searchValues(testAccountScope(), [layer], "true"))[0].field).toBe("name");
    expect(await searchValues(testAccountScope(), [layer], "42")).toHaveLength(1);
    expect((await searchValues(testAccountScope(), [layer], "42"))[0].field).toBe("name");
  });

  it("answers non-point features with anchor and bounds, no point", async () => {
    const layer: ValueSearchLayer = {
      layerId: "l1",
      layerName: "L",
      sql: `SELECT 'Mitte' AS name,
                   ST_GeomFromText('POLYGON((13 52, 14 52, 14 53, 13 53, 13 52))') AS geom`,
    };
    const [row] = await searchValues(testAccountScope(), [layer], "mitte");
    expect(row.point).toBeUndefined();
    expect(row.bounds).toEqual([13, 52, 14, 53]);
    expect(row.anchor?.[0]).toBeGreaterThan(13);
    expect(row.anchor?.[0]).toBeLessThan(14);
    expect(row.anchor?.[1]).toBeGreaterThan(52);
    expect(row.anchor?.[1]).toBeLessThan(53);
  });

  it("applies the cross-layer bound serially", async () => {
    const many: ValueSearchLayer = {
      layerId: "big",
      layerName: "Big",
      sql: `SELECT 'row-' || CAST(range AS VARCHAR) AS name,
                   ST_Point(0, 0) AS geom
            FROM range(30)`,
    };
    const rows = await searchValues(testAccountScope(), [many, stations()], "o", { bound: 20 });
    expect(rows).toHaveLength(20);
    // The budget filled on the first layer; the second contributed none.
    expect(rows.every((r) => r.layerId === "big")).toBe(true);
  });

  it("skips a failing layer and answers from the rest", async () => {
    const broken: ValueSearchLayer = {
      layerId: "bad",
      layerName: "Bad",
      sql: "SELECT nonsense FROM nowhere",
    };
    const rejected: ValueSearchLayer = {
      layerId: "write",
      layerName: "Write",
      sql: "INSERT INTO x VALUES (1)",
    };
    const rows = await searchValues(testAccountScope(), [broken, rejected, stations()], "alex");
    expect(rows.map((r) => r.layerId)).toEqual(["l1"]);
  });

  it("skips features with null geometry and layers without text or geometry", async () => {
    const nullGeom: ValueSearchLayer = {
      layerId: "l1",
      layerName: "L",
      sql: `SELECT * FROM (VALUES
        ('visible', ST_Point(1, 1)),
        ('missing', CAST(NULL AS GEOMETRY))
      ) AS t(name, geom)`,
    };
    expect((await searchValues(testAccountScope(), [nullGeom], "i")).map((r) => r.value)).toEqual([
      "visible",
    ]);
    const noText: ValueSearchLayer = {
      layerId: "l2",
      layerName: "N",
      sql: "SELECT 1 AS n, ST_Point(0, 0) AS geom",
    };
    expect(await searchValues(testAccountScope(), [noText], "1")).toEqual([]);
  });

  it("answers nothing for an empty or whitespace query", async () => {
    expect(await searchValues(testAccountScope(), [stations()], "")).toEqual([]);
    expect(await searchValues(testAccountScope(), [stations()], "   ")).toEqual([]);
  });
});
