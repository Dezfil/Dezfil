import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { DuckDBConnection, DuckDBVarCharVector, type DuckDBResult } from "@duckdb/node-api";
import { setupGeometryTest, cleanupGeometryTest, stored } from "@/lib/test-support/geometry";
import { testAccountScope } from "@/lib/test-support/accounts";
import { withConnection } from "@/lib/duckdb";
import { lit } from "@/lib/ingest/sql";
import { tableFeatures, type TableFeaturesResult } from "@/lib/table-service";
import type { DataTable } from "@/lib/metadata/tables";

/**
 * Dataset map features under Bytes drawn per layer: the complete answer,
 * envelope included, is admitted exactly at the limit; above it, the full
 * dataset or the requested sample answers the existing not-ok shape with a
 * byte reason and no feature data, and is refused before it is built.
 */

let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.DEZFIL_RENDER_CAP_BYTES;
  delete process.env.DEZFIL_RENDER_CAP_FEATURES;
  await cleanupGeometryTest(dir);
});

const MIXED = `SELECT * FROM (VALUES
  (1, ST_GeomFromText('POINT (13.4 52.5)')),
  (2, NULL),
  (3, ST_GeomFromText('POLYGON ((0 0, 3.25 0, 3.25 3.5, 0 3.5, 0 0))')),
  (4, ST_GeomFromText('LINESTRING (1e-7 12345678901234567, 1e21 0.30000000000000004)')),
  (5, ST_GeomFromText('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))')),
  (6, ST_GeomFromText('POINT (-0.0 1)'))
) AS v(id, geometry)`;

const fixture = (select: string) => stored(select, { geometryColumn: "geometry", geometryType: "MIXED" });
const read = (table: DataTable, sample = false) => tableFeatures(testAccountScope(), table.name, { sample });
const bytesOf = (answer: TableFeaturesResult) => Buffer.byteLength(JSON.stringify(answer), "utf8");

/** The answer as the dialog map's features were built before the byte
 * limit: the engine's GeoJSON text for each geometry, parsed whole. */
async function previous(table: DataTable, sample: number | null): Promise<unknown[]> {
  const file = path.join(process.env.DEZFIL_DATA_DIR!, table.file);
  return withConnection(async (conn) => {
    const rows = await conn.runAndReadAll(`SELECT ST_AsGeoJSON(geometry) AS g FROM read_parquet(${lit(file)})
      WHERE geometry IS NOT NULL ${sample === null ? "" : `LIMIT ${sample}`}`);
    return rows.getRowObjects().map((r, i) => ({ type: "Feature", id: i, geometry: JSON.parse(String(r.g)), properties: { __table: table.name, __fid: i } }));
  });
}

const BYTE_REASON = /^This table's features are larger than [\d,]+ bytes, the limit for one layer drawn in the map, too large to draw here\.$/;

describe("a dataset's map features under the byte limit", () => {
  it("draws what it drew before exactly at the limit, and answers the not-ok shape one byte under", async () => {
    const table = await fixture(MIXED);
    const whole = await read(table);
    expect(whole).toMatchObject({ ok: true, name: table.name, geometryType: "MIXED", featureCount: 5 });
    expect(JSON.stringify((whole.geojson as { features: unknown[] }).features)).toBe(JSON.stringify(await previous(table, null)));

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole));
    expect(await read(table)).toEqual(whole);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole) - 1);
    const refused = await read(table);
    expect(Object.keys(refused).sort()).toEqual(["geometryType", "name", "ok", "reason"]);
    expect(refused).toMatchObject({ ok: false, name: table.name, geometryType: "MIXED" });
    expect(refused.reason).toMatch(BYTE_REASON);
    expect(refused.reason).toContain((bytesOf(whole) - 1).toLocaleString("en-US"));
  });

  it("refuses a requested sample that is itself over the limit, naming the sample", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "3";
    const table = await fixture(MIXED);
    // Over the feature cap without a sample: the existing refusal.
    expect((await read(table)).reason).toBe("6 features is over the render cap of 3, too many to draw here.");
    const sampled = await read(table, true);
    expect(sampled).toMatchObject({ ok: true, featureCount: 3, sampled: true, totalCount: 6 });
    expect(JSON.stringify((sampled.geojson as { features: unknown[] }).features)).toBe(JSON.stringify(await previous(table, 3)));

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(sampled));
    expect(await read(table, true)).toEqual(sampled);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(sampled) - 1);
    const refused = await read(table, true);
    expect(Object.keys(refused).sort()).toEqual(["geometryType", "name", "ok", "reason"]);
    expect(refused.reason).toMatch(/^This table's first 3 features are larger than [\d,]+ bytes, the limit for one layer drawn in the map, too large to draw here\.$/);
  });

  it("refuses an envelope larger than the limit before reading a feature", async () => {
    const table = await fixture(MIXED);
    process.env.DEZFIL_RENDER_CAP_BYTES = "64";
    const seen = observe();
    expect((await read(table)).reason).toMatch(BYTE_REASON);
    expect(seen.rows).toBe(0);
  });
});

/** Rows streamed into a dataset answer, and the longest text converted
 * from native storage, while a read runs. */
function observe() {
  const seen = { rows: 0, longestText: 0 };
  const stream = DuckDBConnection.prototype.stream;
  vi.spyOn(DuckDBConnection.prototype, "stream").mockImplementation(async function (this: DuckDBConnection, ...args: Parameters<DuckDBConnection["stream"]>) {
    const result: DuckDBResult = await stream.apply(this, args);
    const fetch = result.fetchChunk.bind(result);
    result.fetchChunk = async () => { const chunk = await fetch(); seen.rows += chunk?.rowCount ?? 0; return chunk; };
    return result;
  });
  const item = DuckDBVarCharVector.prototype.getItem;
  vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index: number) {
    const text = item.call(this, index);
    if (text !== null) seen.longestText = Math.max(seen.longestText, Buffer.byteLength(text));
    return text;
  });
  return seen;
}

describe("an oversized dataset answer is refused before it is built", () => {
  const LIMIT = 65_536;

  it("many small features: refused within the chunk that crosses the limit", async () => {
    const table = await fixture("SELECT ST_Point(i, i) AS geometry FROM range(20000) t(i)");
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    const seen = observe();
    expect((await read(table)).reason).toMatch(BYTE_REASON);
    expect(seen.rows).toBeLessThanOrEqual(2048);
  });

  it("one oversized geometry: refused before its text is converted", async () => {
    const ring = Array.from({ length: 50000 }, (_, i) => `${i} ${i % 2}`);
    const table = await fixture(`SELECT ST_GeomFromText('LINESTRING (${ring.join(", ")})') AS geometry`);
    process.env.DEZFIL_RENDER_CAP_BYTES = String(LIMIT);
    const seen = observe();
    expect((await read(table)).reason).toMatch(BYTE_REASON);
    expect(seen.longestText).toBeLessThanOrEqual(LIMIT);
  });
});
