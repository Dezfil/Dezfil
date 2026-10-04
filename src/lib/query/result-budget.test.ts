import { geometryOfBytes, countryGeometryRows } from "@/lib/test-support/budget-geometry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection, DuckDBDoubleVector, DuckDBResult, DuckDBVarCharVector } from "@duckdb/node-api";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance, withConnection } from "@/lib/duckdb";
import { POST } from "@/app/api/query/route";
import { executeQuery } from "./execute";

const message = "The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb(); resetQueryInstance();
});
afterEach(async () => {
  vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR; delete process.env.DEZFIL_QUERY_MEMORY_MB; delete process.env.DEZFIL_PREVIEW_ROWS;
  await rm(dir, { recursive: true, force: true });
});
const query = (sql: string) => executeQuery(testAccountScope(), sql);
const refusal = { code: "query_result_too_large", status: 422, message, extra: {} };
const refused = async (answer: Promise<unknown>) => expect(await answer.then(() => null, error => error)).toMatchObject(refusal);

// This observes public client decoding and fetching, never accounting-module totals.
function observeClient() {
  const decoded: number[] = [];
  const original = DuckDBVarCharVector.prototype.getItem;
  vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index) {
    const value = original.call(this, index);
    if (value !== null && value.length >= 100_000) decoded.push(Buffer.byteLength(JSON.stringify(value)));
    return value;
  });
  const fetches = vi.spyOn(DuckDBResult.prototype, "fetchChunk");
  const releases = vi.spyOn(DuckDBConnection.prototype, "disconnectSync");
  return { decoded, fetches, releases };
}

describe("SQL result byte budget", () => {
  it("refuses the forty-row result at the client boundary and releases the connection", async () => {
    process.env.DEZFIL_QUERY_MEMORY_MB = "32";
    await query("SELECT 1");
    const seen = observeClient();
    await refused(query("SELECT repeat('x', 1000000) AS payload FROM range(40)"));
    expect(seen.decoded.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(33_554_432);
    expect(seen.decoded).toHaveLength(33);
    expect(seen.releases).toHaveBeenCalledTimes(1);
    expect((await query("SELECT 42 AS answer")).preview).toEqual([{ answer: 42 }]);
  });

  it("does not decode an oversized cell or consume its following value", async () => {
    const seen = observeClient();
    await refused(query("SELECT repeat('x', 2097151) AS first, repeat('z', 100000) AS later"));
    expect(seen.decoded).toEqual([]);
    expect(seen.releases).toHaveBeenCalled();
  });

  it.each([-1, 0, 1])("counts quotes at the non-geometry cell boundary (%s)", async (delta) => {
    const result = query(`SELECT repeat('x', ${2097150 + delta}) AS value`);
    if (delta > 0) await refused(result);
    else expect(Buffer.byteLength(JSON.stringify((await result).preview[0].value))).toBe(2097152 + delta);
  });

  it.each(["repeat('é', 1048576)", "repeat(chr(10), 1048576)", "[repeat('x', 1100000), repeat('y', 1100000)]", "{'value': repeat('x', 2097141)}", "CAST(repeat('x', 2097151) AS BLOB)"])("refuses represented UTF-8, escaping and nested bytes: %s", async (expression) => {
    await refused(query(`SELECT ${expression} AS value`));
  });

  it("counts repeated escaped column names and schema in the complete envelope", async () => {
    const name = '"'.repeat(17_000).replaceAll('"', '""');
    await refused(query(`SELECT 1 AS "${name}" FROM range(1000)`));
  });

  it.each(["wkt", "geojson"] as const)("admits minus-one and exact complete %s envelopes and refuses plus-one using an independent fitting control", async geometry => {
    const scope = testAccountScope();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const sql = (tail: number) => `SELECT repeat('x', CASE range WHEN 32 THEN ${tail} ELSE 1000000 END) AS v, ST_Point(0.5,0.5) AS geometry FROM range(33)`;
    const fitting = await executeQuery(scope, sql(1), { geometry });
    const overhead = Buffer.byteLength(JSON.stringify(fitting)) - 32_000_001;
    for (const delta of [-1, 0, 1]) {
      const answer = executeQuery(scope, sql(33_554_432 - overhead - 32_000_000 + delta), { geometry });
      if (delta > 0) expect(await answer.then(() => null, e => e)).toMatchObject(refusal);
      else expect(Buffer.byteLength(JSON.stringify(await answer))).toBe(33_554_432 + delta);
    }
  });

  it("stops fetching native chunks when a later chunk crosses", async () => {
    process.env.DEZFIL_PREVIEW_ROWS = "10000";
    const seen = observeClient();
    const error = await query("SELECT repeat('x', 10000) AS value FROM range(10000)").then(() => null, e => e);
    expect(error).toMatchObject(refusal);
    // At most two 2048-row data chunks: fetching a third would cross the bound.
    // Ignore the statement analysis and count reads, whose schemas differ.
    const dataFetches = seen.fetches.mock.contexts.filter(result => (result as DuckDBResult).columnNames().includes("value"));
    expect(dataFetches).toHaveLength(2);
    delete process.env.DEZFIL_PREVIEW_ROWS;
  });

  it("cancels at a fetched chunk before decoding and releases the read", async () => {
    await query("SELECT 1");
    const controller = new AbortController();
    const original = DuckDBResult.prototype.fetchChunk;
    const seen = observeClient();
    seen.fetches.mockImplementation(async function (this: DuckDBResult) {
      const chunk = await original.call(this);
      if (this.columnNames().includes("cancel_payload")) controller.abort();
      return chunk;
    });
    const error = await executeQuery(testAccountScope(), "SELECT repeat('x', 1000000) AS cancel_payload FROM range(40)", { signal: controller.signal }).then(() => null, e => e);
    expect(error.constructor.name).toBe("EvaluationCancelled");
    expect(seen.decoded).toEqual([]);
    expect(seen.releases).toHaveBeenCalledTimes(1);
  });

  it("retains parsed GeoJSON geometry collections, empty shapes and numeric presentation", async () => {
    for (const wkt of ["POINT EMPTY", "POINT (0.0000001 12345678901234567)", "LINESTRING (0.5 0.5, 1.25 1.5, 0.0000001 -0.0000001)", "MULTIPOLYGON (((0.5 0.5,1.5 0.5,1.5 1.5,0.5 0.5)))", "GEOMETRYCOLLECTION (POINT (1.5 2.5), GEOMETRYCOLLECTION (LINESTRING (0.5 0.5,1.5 1.5)))"]) {
      const expected = await withConnection(async conn => JSON.parse(String((await conn.runAndReadAll(`SELECT ST_AsGeoJSON(ST_GeomFromText('${wkt}')) AS g`)).getRowObjects()[0].g)));
      const result = await executeQuery(testAccountScope(), `SELECT ST_GeomFromText('${wkt}') AS g`, { geometry: "geojson" });
      expect(result.preview[0].g).toEqual(expected);
    }
  });

  it("returns just the catalogue error from the real route", async () => {
    const response = await POST(testAccountRequest(new Request("http://test/api/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT repeat('x', 1000000) AS payload FROM range(40)" }),
    })));
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBeLessThan(1024);
    expect(JSON.parse(body)).toEqual({ error: { code: "query_result_too_large", message } });
  });

  it("preserves native conversions, duplicate columns, nulls and nested values", async () => {
    const sql = `SELECT 1 AS a, 2 AS a, NULL AS missing, 9007199254740993::BIGINT AS big,
      12.340::DECIMAL(10,3) AS decimal, TIMESTAMP '2020-01-01 12:30:00.123456' AS stamp,
      TIMESTAMPTZ '2020-01-01 12:30:00+03' AS zoned, INTERVAL '2 months 3 days 4 seconds' AS duration,
      '\\x00\\xFF'::BLOB AS blob, [1::BIGINT, NULL, 3] AS list, [1, 2]::INTEGER[2] AS arr,
      {'a': 'é"', 'b': [1::BIGINT, NULL]} AS object, MAP(['a'], [4::BIGINT]) AS mapping,
      union_value(v := 'hello') AS tagged, 'NaN'::DOUBLE AS nan, '-Infinity'::DOUBLE AS inf`;
    const expected = await withConnection(async conn => (await conn.runAndReadAll(`SELECT * FROM (${sql}) q`)).getRowObjectsJson());
    expect((await query(sql)).preview).toEqual(expected);
  });

  it("preserves bare backslash bytes in blobs and nested geometry", async () => {
    const sql = String.raw`SELECT '\x5C'::BLOB AS b, {'g': ST_Point(113, 0)} AS s,
      ['\x5Cx5C\x00'::BLOB] AS nested, '\x5C'::BLOB::VARIANT AS variant`;
    const expected = await withConnection(async conn => (await conn.runAndReadAll(sql)).getRowObjectsJson());
    expect(expected[0].b).toBe("\\");
    expect((await query(sql)).preview).toEqual(expected);
  });

  it("preserves the client's last unnamed struct entry, including zipped lists", async () => {
    expect((await query("SELECT row(1, 'a') AS r, list_zip([1], [2]) AS z")).preview)
      .toEqual([{ r: { "": "a" }, z: [{ "": 2 }] }]);
    expect((await query("SELECT row(repeat('x', 2097153), 'a') AS r")).preview)
      .toEqual([{ r: { "": "a" } }]);
    await refused(query("SELECT row(1, repeat('x', 2097151)) AS r"));
  });

  it.each([-1, 0, 1])("counts the shipped blob text at its cell boundary (%s)", async delta => {
    const sql = `SELECT encode(repeat(chr(92), 1048574) || repeat('a', ${delta + 2})) AS b`;
    if (delta > 0) await refused(query(sql));
    else expect(Buffer.byteLength(JSON.stringify((await query(sql)).preview[0].b))).toBe(2097152 + delta);
  });

  it("preserves heterogeneous variant containers and refuses their oversized leaves before decoding", async () => {
    const sql = `SELECT {'x': [1::BIGINT, 2], 'a': 'é', 'b': 4294967295::UINTEGER, 'blob': '\\x00'::BLOB}::VARIANT AS value`;
    const expected = await withConnection(async conn => (await conn.runAndReadAll(sql)).getRowObjectsJson());
    expect((await query(sql)).preview).toEqual(expected);
    const seen = observeClient();
    const error = await query("SELECT {'x': repeat('x', 2097151)}::VARIANT AS value").then(() => null, e => e);
    expect(error).toMatchObject(refusal);
    expect(seen.decoded).toEqual([]);
  });

  it("admits coastline-sized native geometries with independently measured GeoJSON and WKT envelopes", async () => {
    process.env.DEZFIL_QUERY_MEMORY_MB = "512";
    for (const bytes of [10_151_576, 6_138_709]) {
      for (const geometry of ["geojson", "wkt"] as const) {
        let decoded = false;
        const original = DuckDBDoubleVector.prototype.getItem;
        const spy = vi.spyOn(DuckDBDoubleVector.prototype, "getItem").mockImplementationOnce(function (this: DuckDBDoubleVector, index) {
          decoded = true; spy.mockRestore(); return original.call(this, index);
        });
        const answer = await executeQuery(testAccountScope(), `SELECT ${geometryOfBytes(bytes)} AS coast`, { geometry });
        const cellBytes = Buffer.byteLength(JSON.stringify(answer.preview[0].coast));
        if (geometry === "geojson") { expect(cellBytes).toBe(bytes); expect(decoded).toBe(true); }
        else { spy.mockRestore(); expect(cellBytes).toBeGreaterThan(2_097_152); }
        expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThan(33_554_432);
      }
    }
    const countries = await executeQuery(testAccountScope(), countryGeometryRows(), { geometry: "geojson" });
    const sizes = countries.preview.map(row => Buffer.byteLength(JSON.stringify(row.coast)));
    expect(countries.rowCount).toBe(258); expect(countries.preview).toHaveLength(258);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(12_395_238);
    expect(Math.max(...sizes)).toBe(1_573_724);
  });

  it.each(["wkt", "geojson"] as const)("refuses complete native-geometry overflow in %s", async (geometry) => {
    process.env.DEZFIL_QUERY_MEMORY_MB = "512";
    const error = await executeQuery(testAccountScope(), `SELECT ${geometryOfBytes(10_151_576)} AS coast FROM range(4)`, { geometry }).then(() => null, e => e);
    expect(error).toMatchObject(refusal);
  });

  it.each(["wkt", "geojson"] as const)("exempts native geometry only in %s previews", async (geometry) => {
    const native = "ST_GeomFromText('LINESTRING (' || repeat('0 0,', 550000) || '1 1)')";
    const result = await executeQuery(testAccountScope(), `SELECT ${native} AS coast`, { geometry });
    expect(Buffer.byteLength(JSON.stringify(result.preview[0].coast))).toBeGreaterThan(2097152);
    expect(result.rowCount).toBe(1); expect(result.previewTruncated).toBe(false);
    await refused(query(`SELECT ST_AsText(${native}) AS geometry`));
  });
});
