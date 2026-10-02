import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "./metadata/db";
import { testAccountScope, testAccountRequest } from "./test-support/accounts";
import { createMap, readMap, updateMap, removeMap } from "./map-service";
import { PATCH, DELETE } from "@/app/api/maps/[id]/route";
import { buildTools } from "./tools/tools";

const effects = vi.hoisted(() => ({ inspect: vi.fn(), remove: vi.fn(async () => {}) }));
vi.mock("./basemap-custom", () => ({ resolveCustomBasemapWrite: effects.inspect }));
vi.mock("./map-thumbnails", () => ({ prepareThumbnailRemoval: () => effects.remove }));
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); db.close(); });
const snapshot = () => ["maps", "layers", "map_history", "data_tables", "projects"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
const stale = { status: 409, code: "stale_revision", message: "This item has changed. Reload it before trying again." };
const missing = { status: 400, code: "invalid_request", message: "Read this item first, then send its editRevision in X-Edit-Revision." };
function request(id: string, body: unknown, revision?: string, method = "PATCH", actor = "test-account") {
  return testAccountRequest(new Request(`http://instance.test/api/maps/${id}`, { method,
    headers: { "content-type": "application/json", ...(revision === undefined ? {} : { "X-Edit-Revision": revision }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, actor);
}
it("refuses missing, malformed and stale content bases, including no-ops and mixed cameras, without side effects", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "First");
  updateMap(scope, map.id, { name: "Accepted" }, { expectedRevision: map.editRevision });
  const before = snapshot();
  for (const basis of [undefined, "bad", map.editRevision]) {
    for (const fields of [{ name: "Accepted" }, { widgets: [] }, { layerOrder: [] }, { name: "Lost", viewport: { lng: 4, lat: 5, zoom: 6 } }]) {
      const response = await PATCH(request(map.id, fields, basis), { params: Promise.resolve({ id: map.id }) });
      const error = basis === map.editRevision ? stale : missing;
      expect(response.status).toBe(error.status);
      expect(await response.json()).toEqual({ error: { code: error.code, message: error.message } });
      expect(snapshot()).toEqual(before);
    }
    await expect(removeMap(scope, map.id, { expectedRevision: basis })).rejects.toMatchObject(basis === map.editRevision ? stale : missing);
    expect(snapshot()).toEqual(before);
  }
  expect(effects.remove).not.toHaveBeenCalled();
});
it("allows the independent camera and current no-op without advancing history or attribution", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "First");
  const history = db.prepare("SELECT * FROM map_history").all();
  const response = await PATCH(request(map.id, { viewport: { lng: 4, lat: 5, zoom: 6 } }), { params: Promise.resolve({ id: map.id }) });
  expect(response.status).toBe(200);
  const current = readMap(scope, map.id);
  expect(current).toMatchObject({ editRevision: map.editRevision, lastChangedAt: map.lastChangedAt, lastChangedBy: map.lastChangedBy });
  expect(updateMap(scope, map.id, { name: "First" }, { expectedRevision: current.editRevision }).editRevision).toBe(current.editRevision);
  expect(db.prepare("SELECT * FROM map_history").all()).toEqual(history);
});
it("refuses a map change that races asynchronous basemap validation", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "First");
  let accepted: unknown;
  effects.inspect.mockImplementation(async () => {
    updateMap(scope, map.id, { name: "Other tab" }, { expectedRevision: map.editRevision });
    accepted = snapshot();
    return null;
  });
  const response = await PATCH(request(map.id, { customBasemap: null, viewport: { lng: 4, lat: 5, zoom: 6 } }, map.editRevision), { params: Promise.resolve({ id: map.id }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code: stale.code, message: stale.message } });
  expect(snapshot()).toEqual(accepted);
});
it("keeps authorization before revision facts and deletes only against the seen revision", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "First");
  testAccountScope(db, "outsider");
  const response = await DELETE(request(map.id, undefined, undefined, "DELETE", "outsider"), { params: Promise.resolve({ id: map.id }) });
  expect(response.status).toBe(404);
  const deleted = await DELETE(request(map.id, undefined, map.editRevision, "DELETE"), { params: Promise.resolve({ id: map.id }) });
  expect(deleted.status).toBe(204);
  expect(effects.remove).toHaveBeenCalledOnce();
});
it("declares the conditional map basis and required deletion basis on the generated tools", () => {
  const tools = buildTools();
  const update = tools.find(t => t.name === "update_map")!, remove = tools.find(t => t.name === "delete_map")!;
  expect(update.inputSchema.properties).toHaveProperty("expected_revision");
  expect(update.inputSchema.required ?? []).not.toContain("expected_revision");
  expect(remove.inputSchema.required).toContain("expected_revision");

});
