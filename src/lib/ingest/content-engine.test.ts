import { expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { withConnection } from "@/lib/duckdb";
import { declarationSql, decoderSql, degreeSql } from "./content-decoders";
import { recognizeCsvContent } from "./content-recognition";

it("engine: EWKT and EWKB decode without CRS; declarations must be read separately", async () => {
  await withConnection(async conn => {
    for (const [format, text] of [
      ["wkt", "SRID=3857;POINT (1113194.9079327357 0)"],
      ["wkb", "0101000020110F00009F476EE86AFC30410000000000000000"],
      ["wkb", "002000000100000F114130FC6AE86E479F0000000000000000"],
    ] as const) {
      const row = (await conn.runAndReadAll(`SELECT typeof(${decoderSql(format, ["value"])}) t, ST_AsText(${decoderSql(format, ["value"])}) g, ${declarationSql(format, "value")} srid FROM (SELECT '${text}' AS "value")`)).getRowObjects()[0];
      expect(row).toEqual({ t: "GEOMETRY", g: "POINT (1113194.9079327357 0)", srid: 3857n });
    }
  });
});

it("engine: tolerant decoders distinguish bad inputs and GeoJSON geometry objects", async () => {
  await withConnection(async conn => {
    for (const format of ["wkt", "wkb", "geojson"] as const) {
      expect((await conn.runAndReadAll(`SELECT ${decoderSql(format, ["value"])} g FROM (SELECT 'bad' AS "value")`)).getRowObjects()).toEqual([{ g: null }]);
    }
    for (const text of ['{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]}}', '{"type":"FeatureCollection","features":[]}']) {
      expect((await conn.runAndReadAll(`SELECT ${decoderSql("geojson", ["value"])} g FROM (SELECT '${text}' AS "value")`)).getRowObjects()).toEqual([{ g: null }]);
    }
    expect((await conn.runAndReadAll(`SELECT ${degreeSql("ST_GeomFromText('POINT EMPTY')")} ok`)).getRowObjects()).toEqual([{ ok: true }]);
  });
});

it("engine: H3 requires validation before boundary decoding and produces a closed polygon", async () => {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await conn.run("LOAD spatial");
    await expect(conn.runAndReadAll("SELECT h3_is_valid_cell('8928308280fffff')")).rejects.toThrow();
    await conn.run("LOAD h3");
    const row = (await conn.runAndReadAll(`SELECT ST_AsText(${decoderSql("h3", ["value"])}) g FROM (VALUES ('bad'), ('8928308280fffff')) t(value)`)).getRowObjects();
    expect(row[0].g).toBeNull();
    expect(row[1].g).toBe("POLYGON ((-122.4172 37.775198, -122.416128 37.77688, -122.417388 37.778385, -122.419719 37.778207, -122.42079 37.776524, -122.419531 37.77502, -122.4172 37.775198))");
  } finally { conn.disconnectSync(); db.closeSync(); }
});

it("deterministic unavailable H3 stays an unvalidated weak hint on the real reader", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(process.cwd(), ".tmp-h3-"));
  try {
    const file = path.join(dir, "h3.csv");
    await writeFile(file, "payload,label\n8928308280fffff,a\n");
    await withConnection(async conn => {
      const plan = await recognizeCsvContent(conn, `read_csv('${file}')`, [{ name: "payload", type: "VARCHAR" }, { name: "label", type: "VARCHAR" }], async () => false);
      expect(plan).toMatchObject({ crsAssumed: false, geometryRecord: null, geometryCandidates: [{ format: "h3", strength: "weak", sample: { rows: 1, nonNull: 1, readable: null }, reasons: ["h3-unavailable"] }] });
      expect((await conn.runAndReadAll(plan.select)).getRowObjects()).toEqual([{ payload: "8928308280fffff", label: "a" }]);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
