import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBConnection, DuckDBResult, DuckDBVarCharVector } from "@duckdb/node-api";
import { testAccountScope } from "@/lib/test-support/accounts";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";
import { withConnection } from "@/lib/duckdb";
import { geometryOfBytes } from "@/lib/test-support/budget-geometry";
import { geometryRevision } from "./read";
import { previewGeometry } from "./service";

let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => { vi.restoreAllMocks(); await cleanupGeometryTest(dir); });
const refused = async (value: Promise<unknown>) => expect(await value.then(() => null, e => e)).toMatchObject({ code: "query_result_too_large", status: 422 });
async function preview(sql: string) {
  const t = await stored(sql);
  return previewGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkt", columns: ["payload"] });
}
it("refuses a nested source cell before decoding its excess or any later value", async () => {
  const t = await stored("SELECT 'POINT (0.5 0.5)' payload, [repeat('x', 2097151)] AS contents, [repeat('z', 100000)] later");
  const decoded: number[] = [];
  const original = DuckDBVarCharVector.prototype.getItem;
  vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index) {
    const value = original.call(this, index);
    if (value && value.length >= 100000) decoded.push(value.length);
    return value;
  });
  const released = vi.spyOn(DuckDBConnection.prototype, "disconnectSync");
  await refused(previewGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkt", columns: ["payload"] }));
  expect(decoded).toEqual([]);
  expect(released).toHaveBeenCalledTimes(1);
});
it("counts grid and map sample together and stops at the crossing value", async () => {
  const t = await stored("SELECT 'POINT (0.5 0.5)' payload, [repeat('x', 1000000)] AS contents FROM range(40)");
  const decoded: number[] = [];
  const original = DuckDBVarCharVector.prototype.getItem;
  vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index) {
    const value = original.call(this, index);
    if (value && value.length >= 100000) decoded.push(value.length);
    return value;
  });
  const fetches = vi.spyOn(DuckDBResult.prototype, "fetchChunk");
  await refused(previewGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkt", columns: ["payload"] }));
  expect(decoded).toHaveLength(33);
  expect(fetches.mock.contexts.filter(r => (r as DuckDBResult).columnNames().includes("contents"))).toHaveLength(1);
});
it("retains text excerpts while nested coordinate text remains non-geometry", async () => {
  const p = await preview("SELECT 'POINT (0.5 0.5)' payload, repeat('é', 2097152) AS txt");
  expect(p.sample.rows[0].values.txt).toBe("é".repeat(512) + "…");
  await refused(preview("SELECT 'POINT (0.5 0.5)' payload, [repeat('[0,0],', 350000)] geometry"));
});
it("admits an unsimplified native multipoint above the cell ceiling with excerpted WKT", async () => {
  const t = await stored("SELECT ST_GeomFromText('MULTIPOINT (' || repeat('(0.5 0.5),', 350000) || '(1.5 1.5))') coast", { geometryColumn: "coast", geometryType: "MULTIPOINT", crsAssumed: true });
  const p = await previewGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkb", columns: ["coast"], epsg: 4326 });
  expect(String(p.sample.rows[0].values.coast)).toHaveLength(513);
  expect(Buffer.byteLength(JSON.stringify(p.sample.features.features[0].geometry))).toBeGreaterThan(2097152);
  expect(p.sample.rows[0].status).toBe("readable");
});
it("fits the complete rows/features envelope independently at minus-one, equality and plus-one", async () => {
  const sql = (tail: number) => `SELECT 'POINT (0.5 0.5)' payload, [repeat('x', CASE range WHEN 32 THEN ${tail} ELSE 1000000 END)] AS contents FROM range(33)`;
  const fitting = await preview(sql(1));
  const overhead = Buffer.byteLength(JSON.stringify(fitting)) - 32000001;
  for (const delta of [-1, 0, 1]) {
    const result = preview(sql(33554432 - overhead - 32000000 + delta));
    if (delta > 0) await refused(result);
    else expect(Buffer.byteLength(JSON.stringify(await result))).toBe(33554432 + delta);
  }
});
it("refuses map geometry when its complete answer crosses the result ceiling", async () => {
  const t = await stored("SELECT ST_GeomFromText('MULTIPOINT (' || repeat('(0.5 0.5),', 350000) || '(1.5 1.5))') coast FROM range(16)", { geometryColumn: "coast", geometryType: "MULTIPOINT", crsAssumed: true });
  await refused(previewGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkb", columns: ["coast"], epsg: 4326 }));
});

it.each([10_151_576, 6_138_709, 267_502])("matches the engine for a %s-byte decimal map geometry", async bytes => {
  const geometry = geometryOfBytes(bytes, "MultiPoint");
  const expected = await withConnection(async conn => JSON.parse(String((await conn.runAndReadAll(`SELECT ST_AsGeoJSON(${geometry}) AS g`)).getRowObjects()[0].g)));
  const t = await stored(`SELECT ${geometry} AS coast`, { geometryColumn: "coast", geometryType: "MULTIPOINT", crsAssumed: true });
  const result = await previewGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkb", columns: ["coast"], epsg: 4326 });
  expect(result.sample.features.features[0].geometry).toEqual(expected);
  expect(Buffer.byteLength(JSON.stringify(expected))).toBe(bytes);
});
