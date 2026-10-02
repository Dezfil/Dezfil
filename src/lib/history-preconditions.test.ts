import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "./metadata/db";
import { testAccountRequest, testAccountScope } from "./test-support/accounts";
import { createMap, readMap, updateMap } from "./map-service";
import { removeLayer } from "./layer-removal";
import { createLayer, updateLayer } from "./layer-service";
import { undoChange, redoChange, mapHistory } from "./map-history";
import { redoSteps, undoSteps } from "./metadata/history";
import * as admission from "./save-admission";
import { buildTools } from "./tools/tools";
import { POST as undoRoute } from "@/app/api/maps/[id]/undo/route";
import { POST as redoRoute } from "@/app/api/maps/[id]/redo/route";

const effects = vi.hoisted(() => ({ remove: vi.fn(async () => {}) }));
vi.mock("./tiles/build", () => ({ removeTileArtifacts: effects.remove }));
vi.mock("./layer-geometry", () => ({ inspectLayerGeometry: async () => ({ geometryType: "POINT" }) }));
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); db.close(); });
const stale = { code: "stale_revision", status: 409, message: "This item has changed. Reload it before trying again." };
const missing = { code: "invalid_request", status: 400, message: "Read this item first, then send its editRevision in X-Edit-Revision." };
const snapshot = () => ["maps", "layers", "map_history", "data_tables"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
function fixture() {
  const owner = testAccountScope(db), editor = testAccountScope(db, "editor"), map = createMap(owner, "Original");
  db.prepare("INSERT INTO projects (id,name,owner_id,created_at,updated_at) VALUES ('p','Project',?,'t','t')").run(owner.accountId);
  db.exec("INSERT INTO project_people VALUES ('p','editor','editor','t')");
  db.prepare("UPDATE maps SET project_id = 'p' WHERE id = ?").run(map.id);
  return { owner, editor, map };
}
for (const direction of ["undo", "redo"] as const) for (const kind of ["missing", "malformed", "stale"] as const) {
  it(`refuses ${kind} ${direction} without moving any part of the group or cursor`, async () => {
    const { owner, map } = fixture();
    const named = updateMap(owner, map.id, { name: "New name" }, { groupId: "group", expectedRevision: map.editRevision });
    const styled = updateMap(owner, map.id, { basemap: "light" }, { groupId: "group", expectedRevision: named.editRevision });
    if (direction === "redo") await undoChange(owner, map.id, { expectedRevision: styled.editRevision });
    const expectedRevision = kind === "missing" ? undefined : kind === "malformed" ? "bad" : map.editRevision;
    const before = snapshot();
    await expect((direction === "undo" ? undoChange : redoChange)(owner, map.id, { expectedRevision })).rejects.toMatchObject(kind === "stale" ? stale : missing);
    expect(snapshot()).toEqual(before); expect(effects.remove).not.toHaveBeenCalled();
  });
}
it("never revives a token when undo and redo restore the same values or a deleted layer identity", async () => {
  const { owner, map } = fixture(), tokens = new Set([map.editRevision]);
  const changed = updateMap(owner, map.id, { name: "Changed" }, { expectedRevision: map.editRevision });
  tokens.add(changed.editRevision);
  const undone = await undoChange(owner, map.id, { expectedRevision: changed.editRevision });
  expect(undone.name).toBe(map.name); tokens.add(undone.editRevision);
  const redone = await redoChange(owner, map.id, { expectedRevision: undone.editRevision });
  tokens.add(redone.editRevision); expect(tokens.size).toBe(4);
  const layer = await createLayer(owner, map.id, { name: "Layer", sql: "SELECT ST_Point(1, 2) AS geom" }, { expectedRevision: redone.editRevision });
  const deleted = await removeLayer(owner, layer.id, { expectedRevision: layer.editRevision });
  const restored = await undoChange(owner, map.id, { expectedRevision: deleted.editRevision });
  expect(restored.layers.map(row => row.id)).toEqual([layer.id]);
  expect(restored.editRevision).not.toBe(layer.editRevision);
  const before = snapshot();
  await expect(updateLayer(owner, layer.id, { name: "Layer" }, { expectedRevision: layer.editRevision })).rejects.toMatchObject(stale);
  expect(snapshot()).toEqual(before);
});
it("keeps actor boundaries even for identical groups and attributes replay to the replayer", async () => {
  const { owner, editor, map } = fixture();
  const a = updateMap(owner, map.id, { name: "Owner first" }, { groupId: "shared", expectedRevision: map.editRevision });
  const b = updateMap(editor, map.id, { name: "Editor" }, { groupId: "shared", expectedRevision: a.editRevision });
  const c = updateMap(owner, map.id, { name: "Owner last" }, { groupId: "shared", expectedRevision: b.editRevision });
  expect(undoSteps(map.id)).toHaveLength(1);
  const replayed = await undoChange(editor, map.id, { expectedRevision: c.editRevision });
  expect(replayed.name).toBe("Editor");
  expect(replayed.lastChangedBy?.name).toBe("editor");
  expect(redoSteps(map.id)).toMatchObject([{ authorId: owner.accountId }]);
  expect(undoSteps(map.id)).toMatchObject([{ authorId: editor.accountId }]);
  const before = snapshot();
  expect(() => updateMap(owner, map.id, { name: "Bypass" }, { groupId: "shared", expectedRevision: c.editRevision })).toThrowError(stale.message);
  expect(snapshot()).toEqual(before);
  const next = updateMap(editor, map.id, { name: "New branch" }, { expectedRevision: replayed.editRevision });
  expect(next.editRevision).not.toBe(replayed.editRevision); expect(redoSteps(map.id)).toEqual([]);
});
it("refuses a publication-ineligible group whole before disclosing revision facts in either direction", async () => {
  const { owner, editor, map } = fixture();
  const named = updateMap(owner, map.id, { name: "Renamed" }, { groupId: "mixed", expectedRevision: map.editRevision });
  const changed = updateMap(owner, map.id, { widgetsPublished: false }, { groupId: "mixed", expectedRevision: named.editRevision });
  expect(undoSteps(map.id)).toHaveLength(2);
  for (const move of [undoChange, redoChange]) {
    for (const basis of [undefined, map.editRevision, readMap(owner, map.id).editRevision]) {
      const before = snapshot();
      await expect(move(editor, map.id, { expectedRevision: basis })).rejects.toMatchObject({ code: "forbidden", status: 403 });
      expect(snapshot()).toEqual(before);
    }
    if (move === undoChange) await undoChange(owner, map.id, { expectedRevision: changed.editRevision });
  }
});
for (const direction of ["undo", "redo"] as const) it(`refuses SQL-ineligible ${direction} without partially replaying its name change`, async () => {
  const { owner, editor, map } = fixture();
  const good = "SELECT ST_Point(1, 2) AS geom", bad = "SELECT * FROM unavailable_dataset";
  const layer = await createLayer(owner, map.id, { name: "Layer", sql: direction === "undo" ? bad : good }, { expectedRevision: map.editRevision });
  const updated = await updateLayer(owner, layer.id, { sql: direction === "undo" ? good : bad }, { groupId: "mixed", expectedRevision: layer.editRevision });
  const named = updateMap(owner, map.id, { name: "Renamed" }, { groupId: "mixed", expectedRevision: updated.editRevision });
  if (direction === "redo") await undoChange(owner, map.id, { expectedRevision: named.editRevision });
  const basis = readMap(owner, map.id).editRevision, before = snapshot();
  await expect((direction === "undo" ? undoChange : redoChange)(editor, map.id, { expectedRevision: basis })).rejects.toMatchObject({ code: "sql_error", status: 400 });
  expect(snapshot()).toEqual(before); expect(effects.remove).not.toHaveBeenCalled();
  expect((await mapHistory(editor, map.id))[direction === "undo" ? "undoTarget" : "redoTarget"]).toMatchObject({ eligible: false, steps: [{}, {}] });
});
it("refuses a replay whose SQL admission races another content change, without re-deriving", async () => {
  const { owner, editor, map } = fixture();
  const layer = await createLayer(owner, map.id, { name: "Layer", sql: "SELECT ST_Point(1, 2) AS geom" }, { expectedRevision: map.editRevision });
  const changed = await updateLayer(owner, layer.id, { sql: "SELECT ST_Point(3, 4) AS geom" }, { expectedRevision: layer.editRevision });
  const admit = admission.admitMapSql;
  let accepted: unknown;
  const spy = vi.spyOn(admission, "admitMapSql").mockImplementationOnce(async (...args) => {
    const result = await admit(...args);
    updateMap(owner, map.id, { name: "Concurrent" }, { expectedRevision: changed.editRevision });
    accepted = snapshot(); return result;
  });
  await expect(undoChange(editor, map.id, { expectedRevision: changed.editRevision })).rejects.toMatchObject(stale);
  expect(snapshot()).toEqual(accepted); expect(spy).toHaveBeenCalledOnce();
});
it("requires the documented basis at both history routes and in generated tools", async () => {
  const { owner, map } = fixture();
  updateMap(owner, map.id, { name: "Renamed" }, { expectedRevision: map.editRevision });
  for (const handler of [undoRoute, redoRoute]) {
    const request = testAccountRequest(new Request("http://instance.test/history", { method: "POST" }), db), before = snapshot();
    const response = await handler(request, { params: Promise.resolve({ id: map.id }) });
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: { code: missing.code, message: missing.message } });
    expect(snapshot()).toEqual(before);
  }
  for (const name of ["undo_change", "redo_change"]) expect(buildTools().find(tool => tool.name === name)!.inputSchema.required).toContain("expected_revision");
});
