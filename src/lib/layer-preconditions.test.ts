import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "./metadata/db";
import { testAccountScope, testAccountRequest } from "./test-support/accounts";
import { createMap, readMap, updateMap } from "./map-service";
import { createLayer, duplicateLayer, updateLayer } from "./layer-service";
import { removeLayer } from "./layer-removal";
import { buildTools } from "./tools/tools";
import { PATCH, DELETE } from "@/app/api/layers/[id]/route";
import { POST as add } from "@/app/api/maps/[id]/layers/route";
import { POST as duplicate } from "@/app/api/layers/[id]/duplicate/route";
const effects = vi.hoisted(() => ({ inspect: vi.fn(async () => ({ geometryType: "POINT" })), remove: vi.fn(async () => {}) }));
vi.mock("./layer-geometry", () => ({ inspectLayerGeometry: effects.inspect }));
vi.mock("./tiles/build", () => ({ removeTileArtifacts: effects.remove }));
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); db.close(); });
const snapshot = () => ["maps", "layers", "map_history", "data_tables", "projects"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
const sql = "SELECT ST_Point(1, 2) AS geom";
const stale = { status: 409, code: "stale_revision", message: "This item has changed. Reload it before trying again." };
const missing = { status: 400, code: "invalid_request", message: "Read this item first, then send its editRevision in X-Edit-Revision." };
async function fixture() {
  const scope = testAccountScope(db), map = createMap(scope, "Map");
  const layer = await createLayer(scope, map.id, { name: "Layer", sql }, { expectedRevision: map.editRevision });
  return { scope, map: readMap(scope, map.id), layer };
}
for (const basis of [undefined, "bad", "stale"] as const) it(`refuses ${basis ?? "missing"} bases for every layer write without changing the parent or artifacts`, async () => {
  const { scope, map, layer } = await fixture();
  updateMap(scope, map.id, { name: "Other tab" }, { expectedRevision: map.editRevision });
  const expectedRevision = basis === "stale" ? map.editRevision : basis;
  const before = snapshot(), expected = basis === "stale" ? stale : missing;
  for (const write of [
    () => createLayer(scope, map.id, { name: "New", sql }, { expectedRevision }),
    () => updateLayer(scope, layer.id, { name: "Layer" }, { expectedRevision }),
    () => duplicateLayer(scope, layer.id, { expectedRevision }),
    () => removeLayer(scope, layer.id, { expectedRevision }),
  ]) {
    await expect(Promise.resolve().then(write)).rejects.toMatchObject(expected);
    expect(snapshot()).toEqual(before);
  }
  expect(effects.remove).not.toHaveBeenCalled();
});
it("refuses SQL validation races once without re-deriving on the newer map", async () => {
  const { scope, map, layer } = await fixture();
  let accepted: unknown;
  effects.inspect.mockClear().mockImplementationOnce(async () => {
    updateMap(scope, map.id, { name: "Changed during validation" }, { expectedRevision: map.editRevision });
    accepted = snapshot();
    return { geometryType: "POINT" };
  });
  await expect(updateLayer(scope, layer.id, { sql: "SELECT ST_Point(3, 4) AS geom" }, { expectedRevision: map.editRevision })).rejects.toMatchObject(stale);
  expect(snapshot()).toEqual(accepted);
  expect(effects.inspect).toHaveBeenCalledOnce();
});
it("refuses creation when its validation races another edit", async () => {
  const { scope, map } = await fixture();
  let accepted: unknown;
  effects.inspect.mockImplementationOnce(async () => {
    updateMap(scope, map.id, { basemap: "light" }, { expectedRevision: map.editRevision });
    accepted = snapshot(); return { geometryType: "POINT" };
  });
  await expect(createLayer(scope, map.id, { name: "Lost", sql }, { expectedRevision: map.editRevision })).rejects.toMatchObject(stale);
  expect(snapshot()).toEqual(accepted);
});
it("accepts only one disjoint write from the same basis and keeps a current no-op revision and actor stable", async () => {
  const { scope, map, layer } = await fixture();
  const outcomes = await Promise.allSettled([
    updateLayer(scope, layer.id, { name: "Renamed" }, { expectedRevision: map.editRevision }),
    updateLayer(scope, layer.id, { visible: false }, { expectedRevision: map.editRevision }),
  ]);
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(r => r.status === "rejected")).toMatchObject({ reason: stale });
  const shown = readMap(scope, map.id), before = snapshot();
  await updateLayer(scope, layer.id, { name: shown.layers[0].name }, { expectedRevision: shown.editRevision });
  expect(readMap(scope, map.id)).toMatchObject({ editRevision: shown.editRevision, lastChangedAt: shown.lastChangedAt, lastChangedBy: shown.lastChangedBy });
  expect(snapshot()[2]).toEqual(before[2]);
});
it("routes the parent revision through each layer operation and publishes it in the tools", async () => {
  const { map, layer } = await fixture();
  const cases = [
    { handler: add, id: map.id, path: `/api/maps/${map.id}/layers`, method: "POST", body: { name: "New", sql } },
    { handler: PATCH, id: layer.id, path: `/api/layers/${layer.id}`, method: "PATCH", body: { name: "Changed" } },
    { handler: duplicate, id: layer.id, path: `/api/layers/${layer.id}/duplicate`, method: "POST" },
    { handler: DELETE, id: layer.id, path: `/api/layers/${layer.id}`, method: "DELETE" },
  ];
  for (const c of cases) {
    const request = testAccountRequest(new Request(`http://instance.test${c.path}`, { method: c.method,
      ...(c.body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(c.body) } : {}) }), db);
    const response = await c.handler(request, { params: Promise.resolve({ id: c.id }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: missing.code, message: missing.message } });
  }
  for (const name of ["create_layer", "update_layer", "duplicate_layer", "delete_layer"]) {
    expect(buildTools().find(t => t.name === name)!.inputSchema.required, name).toContain("expected_revision");
  }
});
