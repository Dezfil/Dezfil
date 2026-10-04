import { afterEach, expect, it } from "vitest";
import { executeQuery } from "./execute";
import { testAccountScope } from "../test-support/accounts";
import { setupGeometryTest, cleanupGeometryTest } from "../test-support/geometry";
import { withConnection } from "../duckdb";

let directory: string;
afterEach(async () => { if (directory) await cleanupGeometryTest(directory); });
// Self-contained so the same case can run against another implementation.
it("measures a large decimal geometry and matches the engine GeoJSON exactly", async () => {
  directory = await setupGeometryTest();
  const sql = "SELECT ST_GeomFromText('LINESTRING (' || repeat('0.5 0.5,', 1000000) || '1.5 1.5)') AS g";
  const expected = await withConnection(async conn => JSON.parse(String((await conn.runAndReadAll(`SELECT ST_AsGeoJSON(g) AS g FROM (${sql}) q`)).getRowObjects()[0].g)));
  await executeQuery(testAccountScope(), "SELECT 1");
  const started = performance.now();
  const result = await executeQuery(testAccountScope(), sql, { geometry: "geojson" });
  const elapsedMs = performance.now() - started;
  expect(result.preview).toEqual([{ g: expected }]);
  const geometryBytes = Buffer.byteLength(JSON.stringify(result.preview[0].g));
  expect(geometryBytes).toBeGreaterThan(10_000_000);
  process.stdout.write(JSON.stringify({ observation: "decimal-geometry", elapsedMs, geometryBytes, rows: result.rowCount }) + "\n");
}, 60_000);
