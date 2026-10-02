import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "./metadata/db";
import { testAccountScope } from "./test-support/accounts";
import { createMap, updateMap } from "./map-service";
import { mapHistory, undoChange, redoChange } from "./map-history";
import { readDocumentRevision } from "./metadata/revisions";
import { undoSteps, redoSteps } from "./metadata/history";
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function fixture() {
  const owner = testAccountScope(db), editor = testAccountScope(db, "editor"), viewer = testAccountScope(db, "viewer");
  const map = createMap(owner, "Map");
  db.prepare("INSERT INTO projects (id,name,owner_id,created_at,updated_at) VALUES ('p','P',?,'t','t')").run(owner.accountId);
  db.exec("INSERT INTO project_people VALUES ('p','editor','editor','t'), ('p','viewer','viewer','t')");
  db.prepare("UPDATE maps SET project_id = 'p' WHERE id = ?").run(map.id);
  return { owner, editor, viewer, map };
}
it("never coalesces or groups two actors, even with an identical group value", async () => {
  const { owner, editor, map } = fixture();
  updateMap(owner, map.id, { name: "One" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision, groupId: "same" });
  updateMap(editor, map.id, { name: "Two" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision, groupId: "same" });
  updateMap(owner, map.id, { name: "Three" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision, groupId: "same" });
  expect(db.prepare("SELECT author_id FROM map_history ORDER BY seq").all()).toEqual([
    { author_id: owner.accountId }, { author_id: editor.accountId }, { author_id: owner.accountId },
  ]);
  expect(undoSteps(map.id)).toHaveLength(1);
  await undoChange(editor, map.id, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  expect(undoSteps(map.id)).toHaveLength(1);
  expect(redoSteps(map.id)).toHaveLength(1);
  const revision = readDocumentRevision({ kind: "map", id: map.id })!;
  expect(revision.lastChangedBy).toBe(editor.accountId);
  expect(redoSteps(map.id)[0]).toMatchObject({ authorId: owner.accountId });
  await redoChange(editor, map.id, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  expect(readDocumentRevision({ kind: "map", id: map.id })!.editRevision!).not.toBe(revision.editRevision);
});
it("exposes original actors and whole-group replay eligibility to reached readers", async () => {
  const { owner, editor, viewer, map } = fixture();
  updateMap(owner, map.id, { name: "Renamed" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision, groupId: "one" });
  updateMap(owner, map.id, { widgetsPublished: false }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision, groupId: "one" });
  const history = await mapHistory(editor, map.id);
  expect(history).toMatchObject({ canUndo: true, undoTarget: { eligible: false, reason: expect.any(String), steps: [
    { author: { name: owner.accountId, sqlName: expect.any(String) } },
    { author: { name: owner.accountId, sqlName: expect.any(String) } },
  ] }, redoTarget: null });
  expect((await mapHistory(owner, map.id))).toMatchObject({ undoTarget: { eligible: true, reason: null } });
  expect((await mapHistory(viewer, map.id))).toMatchObject({ undoTarget: { eligible: false } });
  const before = db.prepare("SELECT * FROM maps").all();
  await expect(undoChange(editor, map.id, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision })).rejects.toThrow();
  expect(db.prepare("SELECT * FROM maps").all()).toEqual(before);
});
it("keeps unknown historical authors and reports SQL admission failure before replay", async () => {
  const { owner, editor, map } = fixture();
  const { createLayer } = await import("./layer-creation");
  const { recordStep } = await import("./metadata/history");
  const layer = await createLayer(owner, map.id, { name: "Layer", sql: "SELECT ST_Point(1, 2) AS geom" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  recordStep({ mapId: map.id, targetId: layer.id, scope: "layer", op: "update",
    before: { sql: "SELECT * FROM unreachable_dataset" }, after: { sql: layer.sql } }, db);
  expect(await mapHistory(editor, map.id)).toMatchObject({ undoTarget: {
    eligible: false, reason: expect.stringContaining("unreachable_dataset"), steps: [{ author: null }],
  } });
  expect(await mapHistory(owner, map.id)).toMatchObject({ undoTarget: { eligible: true } });
});
