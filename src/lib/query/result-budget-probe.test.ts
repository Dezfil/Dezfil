import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupGeometryTest, cleanupGeometryTest } from "@/lib/test-support/geometry";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { boundary, probeClient } from "../../../scripts/result-budget-client.mjs";
import { geometrySQL, countriesSQL } from "../../../scripts/result-budget-readers.mjs";
import { withConnection } from "@/lib/duckdb";
let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await cleanupGeometryTest(dir); });
it("constructs independently measured native fitting geometry controls", async () => {
  await withConnection(async conn => {
    for (const size of [10151576, 6138709, 267502]) {
      const result = (await conn.runAndReadAll(`SELECT ST_AsGeoJSON(${geometrySQL(size)}) AS value`)).getRowObjects()[0].value;
      expect(Buffer.byteLength(JSON.stringify(JSON.parse(String(result))))).toBe(size);
    }
    const rows = (await conn.runAndReadAll(`SELECT ST_AsGeoJSON(geometry) AS value FROM (${countriesSQL()}) q`)).getRowObjects();
    const sizes = rows.map(row => Buffer.byteLength(JSON.stringify(JSON.parse(String(row.value)))));
    expect(sizes).toHaveLength(258); expect(sizes.reduce((a, b) => a + b, 0)).toBe(12395238); expect(Math.max(...sizes)).toBe(1573724);
  });
});
it("fails when its fitting oracle cannot land on a boundary", async () => {
  const client = { fitting: () => {}, refused: () => {} };
  vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(boundary(async () => ({ status: 200, bytes: 100 }), client, 1, "impossible")).rejects.toThrow("could not land");
});
it("uploads a native WKB fixture and previews it through the actual geometry route", async () => {
  vi.stubEnv("DEZFIL_PROBE_TOKEN", "fixture");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    request.headers.delete("authorization");
    return dispatchAssistantTestRoute(request);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const client = await probeClient("http://localhost:3307", "route-shape-control");
  try {
    const table = await client.upload(`SELECT ST_AsWKB(${geometrySQL(6138709)}) AS geometry`);
    const path = `/api/tables/${table.name}`;
    const inspection = client.fitting(await client.read(path));
    expect(inspection.crsAssumed).toBe(true);
    const state = client.fitting(await client.read(`${path}/geometry`));
    const preview = client.fitting(await client.read(`${path}/geometry/preview`, { expectedRevision: state.revision, choice: { format: "wkb", columns: ["geometry"], epsg: 4326 } }));
    expect(Buffer.byteLength(JSON.stringify(preview.sample.features.features[0].geometry))).toBe(6138709);
  } finally { await client.cleanup(); }
});
