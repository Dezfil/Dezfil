import { afterEach, expect, it } from "vitest";
import { executeQuery } from "./execute";
import { testAccountScope } from "../test-support/accounts";
import { setupGeometryTest, cleanupGeometryTest, stored } from "../test-support/geometry";
import { withConnection } from "../duckdb";
import { limits } from "../limits";

let directory: string;
afterEach(async () => { if (directory) await cleanupGeometryTest(directory); });
// Self-contained so the same case can run against another implementation.
it("measures a stored decimal geometry and matches the engine GeoJSON exactly", async () => {
  directory = await setupGeometryTest();
  const source = "SELECT ST_GeomFromText('LINESTRING (' || repeat('0.5 0.5,1.5 2.5,2.5 3.5,3.5 1.5,', 250000) || '1.5 1.5)') AS g";
  const expected = await withConnection(async conn => JSON.parse(String((await conn.runAndReadAll(`SELECT ST_AsGeoJSON(g) AS g FROM (${source}) q`)).getRowObjects()[0].g)));
  const table = await stored(source, { geometryColumn: "g", geometryType: "LineString" });
  const sql = `SELECT g FROM "${table.name}"`;
  const scope = testAccountScope();
  // Warm the full decoder and table read before timing the same query.
  await executeQuery(scope, sql, { geometry: "geojson" });
  const started = performance.now();
  const result = await executeQuery(scope, sql, { geometry: "geojson" });
  const elapsedMs = performance.now() - started;
  expect(result.preview).toEqual([{ g: expected }]);
  const geometryBytes = Buffer.byteLength(JSON.stringify(result.preview[0].g));
  expect(geometryBytes).toBeGreaterThan(10_000_000);
  process.stdout.write(JSON.stringify({ observation: "stored-decimal-geometry", elapsedMs, geometryBytes, engineMemoryMb: limits.queryMemoryMb, warmups: 1, rows: result.rowCount }) + "\n");
}, 60_000);
