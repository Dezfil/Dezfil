import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import type { AccountScope } from "./scope";
import type { DataTable } from "@/lib/metadata/tables";
import type { Layer, MapRecord } from "@/lib/metadata/maps";

/**
 * A shared map's evaluations, through the routes. Ada files `roads` in her
 * project P, where Bob is a viewer, and keeps `parks` to herself; Bob owns a
 * `roads` of his own with two rows; Cyd belongs to nothing. Ada's map in P
 * draws `roads` and `parks`. Every row names its owner.
 *
 * Whoever reaches the map evaluates it in Ada's home within their own reach:
 * Bob sees Ada's roads and never his own, is told `parks` is not available to
 * him, and Cyd sees nothing at all.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let map: MapRecord;
let roads: Layer;
let parks: Layer;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "map-reach-evaluation-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name, rows] of [["ada", "roads", 1], ["ada", "parks", 1], ["bob", "roads", 2]] as const) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${Array.from({ length: rows }, (_, i) => `${owner} ${name},${i + 1},2`).join("\n")}\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "viewer"]], [tables["ada.roads"].id]);
  map = createMap(scopes.ada, "Survey", "P");
  roads = await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" });
  parks = await createLayer(scopes.ada, map.id, { name: "Parks", sql: "SELECT * FROM parks" });
  updateMap(scopes.ada, map.id, { widgets: [{ id: "count", type: "formula", layerId: roads.id, title: "Count", field: null,
    agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }] });
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, url: string, params: Record<string, string>,
  method = "GET", body?: unknown) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), undefined, account);
  const response = await ((await load())[method] as Handler)(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, text, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) as unknown : null };
}
const route = {
  render: () => import("@/app/api/layers/[id]/render/route"),
  fields: () => import("@/app/api/layers/[id]/fields/route"),
  extent: () => import("@/app/api/layers/[id]/extent/route"),
  exported: () => import("@/app/api/layers/[id]/export/[format]/route"),
  widgets: () => import("@/app/api/maps/[id]/widget-values/route"),
  search: () => import("@/app/api/maps/[id]/search/route"),
  dependencies: () => import("@/app/api/maps/[id]/dependencies/route"),
};
const sentinels = (body: unknown) =>
  ((body as { geojson: { features: { properties: { sentinel: string } }[] } }).geojson.features).map((f) => f.properties.sentinel);

describe("a shared map's evaluations, through the routes", () => {
  it("draws, describes, counts, searches and exports the map in its owner's home within the reader's reach", async () => {
    for (const account of ["ada", "bob"]) {
      const render = await call(account, route.render, `/api/layers/${roads.id}/render`, { id: roads.id });
      expect(render.status, account).toBe(200);
      expect(sentinels(render.body), account).toEqual(["ada roads"]);
      const fields = await call(account, route.fields, `/api/layers/${roads.id}/fields`, { id: roads.id });
      expect(fields.status, account).toBe(200);
      expect(JSON.stringify(fields.body), account).toContain("sentinel");
      expect((await call(account, route.extent, `/api/layers/${roads.id}/extent`, { id: roads.id }, "POST", {})).status, account).toBe(200);
      const widgets = await call(account, route.widgets, `/api/maps/${map.id}/widget-values`, { id: map.id }, "POST", {});
      expect(widgets.body, account).toMatchObject({ widgets: [{ id: "count", value: 1 }] });
      const search = await call(account, route.search, `/api/maps/${map.id}/search?q=ada%20roads`, { id: map.id });
      expect(search.status, account).toBe(200);
      expect(JSON.stringify(search.body), account).toContain("ada roads");
      const exported = await call(account, route.exported, `/api/layers/${roads.id}/export/csv`, { id: roads.id, format: "csv" });
      expect(exported.status, account).toBe(200);
      expect(exported.text, account).toContain("ada roads");
      expect(exported.text, account).not.toContain("bob roads");
    }
  });

  it("names a dataset the reader cannot reach, never drawing a same-named one of their own", async () => {
    const render = await call("bob", route.render, `/api/layers/${parks.id}/render`, { id: parks.id });
    expect(render.body).toMatchObject({ ok: false, error: { code: "sql_error", message: 'The dataset "parks" is not available to you.' } });
    expect((await call("ada", route.render, `/api/layers/${parks.id}/render`, { id: parks.id })).body).toMatchObject({ ok: true });
  });

  it("refuses someone who does not reach the map exactly as a layer or map that never existed", async () => {
    const pairs: [() => Promise<Record<string, unknown>>, string, string, string, Record<string, string>, unknown?][] = [
      [route.render, "/api/layers/{}/render", "GET", roads.id, {}],
      [route.fields, "/api/layers/{}/fields", "GET", roads.id, {}],
      [route.extent, "/api/layers/{}/extent", "POST", roads.id, {}, {}],
      [route.exported, "/api/layers/{}/export/csv", "GET", roads.id, { format: "csv" }],
      [route.widgets, "/api/maps/{}/widget-values", "POST", map.id, {}, {}],
      [route.search, "/api/maps/{}/search?q=ada", "GET", map.id, {}],
      [route.dependencies, "/api/maps/{}/dependencies", "GET", map.id, {}],
    ];
    for (const [load, url, method, id, extra, body] of pairs) {
      const hidden = await call("cyd", load, url.replace("{}", id), { id, ...extra }, method, body);
      const missing = await call("cyd", load, url.replace("{}", "never-existed"), { id: "never-existed", ...extra }, method, body);
      expect(hidden.status, url).toBe(404);
      expect(hidden.body, url).toEqual(missing.body);
    }
  });

  it("lists a map's datasets by identity in its home, leaving out whatever the reader cannot list", async () => {
    const names = async (account: string) => {
      const read = await call(account, route.dependencies, `/api/maps/${map.id}/dependencies`, { id: map.id });
      expect(read.status, account).toBe(200);
      return (read.body as { datasets: { id: string }[] }).datasets.map((dataset) => dataset.id);
    };
    expect(await names("ada")).toEqual([tables["ada.parks"].id, tables["ada.roads"].id]);
    // Bob's own `roads` is never taken for the map's: the reference binds in
    // Ada's home. Her datasets are not his to list.
    expect(await names("bob")).toEqual([]);
  });
});
