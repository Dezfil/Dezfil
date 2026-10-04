import { afterEach, expect, it, vi } from "vitest";
import { executeQuery } from "./execute";
import { testAccountScope } from "../test-support/accounts";
import { setupGeometryTest, cleanupGeometryTest, stored } from "../test-support/geometry";
import { resetQueryInstance, withConnection } from "../duckdb";

let directory: string;
afterEach(async () => {
  if (directory) await cleanupGeometryTest(directory);
  vi.unstubAllEnvs();
});

// Keep the fixture and imports usable unchanged on the baseline implementation.
it("admits the coastline control and optionally reports its engine budget floor", async () => {
  directory = await setupGeometryTest();
  const source = "SELECT ST_GeomFromText('LINESTRING (' || repeat('0.5 0.5,', 1015152) || '0.5555555555 0.5)') AS g";
  const expected = await withConnection(async conn => JSON.stringify(JSON.parse(String((await conn.runAndReadAll(`SELECT ST_AsGeoJSON(g) AS g FROM (${source}) q`)).getRowObjects()[0].g))));
  expect(Buffer.byteLength(expected)).toBe(10_151_576);
  const table = await stored(source, { geometryColumn: "g", geometryType: "LineString" });
  const report = process.env.DEZFIL_TEST_GEOMETRY_BUDGET_REPORT === "1";
  async function admits(engineMemoryMb: number): Promise<boolean> {
    vi.stubEnv("DEZFIL_QUERY_MEMORY_MB", String(engineMemoryMb));
    resetQueryInstance();
    try {
      const result = await executeQuery(testAccountScope(), `SELECT g FROM "${table.name}"`, { geometry: "geojson" });
      expect(result.rowCount).toBe(1);
      expect(JSON.stringify(result.preview[0].g)).toBe(expected);
      if (report) process.stdout.write(JSON.stringify({ observation: "geometry-engine-budget-attempt", engineMemoryMb, admitted: true, geometryBytes: 10_151_576 }) + "\n");
      return true;
    } catch (error) {
      // A different refusal or a conversion mismatch must fail the report.
      expect(error).toMatchObject({ code: "query_memory_exceeded" });
      if (report) process.stdout.write(JSON.stringify({ observation: "geometry-engine-budget-attempt", engineMemoryMb, admitted: false, code: "query_memory_exceeded" }) + "\n");
      return false;
    } finally { resetQueryInstance(); }
  }
  expect(await admits(512)).toBe(true);
  if (!report) return;
  let rejected = 0;
  let admitted = 512;
  while (admitted - rejected > 1) {
    const candidate = Math.floor((admitted + rejected) / 2);
    if (await admits(candidate)) admitted = candidate;
    else rejected = candidate;
  }
  // Recheck both adjacent budgets on fresh instances, including the winner.
  if (rejected > 0) expect(await admits(rejected)).toBe(false);
  expect(await admits(admitted)).toBe(true);
  process.stdout.write(JSON.stringify({ observation: "geometry-engine-budget-floor", geometryBytes: 10_151_576, minimumEngineMemoryMb: admitted, rejectedEngineMemoryMb: rejected || null, resolutionMb: 1, method: "binary-search-with-neighbor-recheck" }) + "\n");
}, 120_000);
