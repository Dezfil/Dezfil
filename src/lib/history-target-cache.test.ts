import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "./metadata/db";
import * as admission from "./save-admission";
import { testAccountScope } from "./test-support/accounts";
import { createMap } from "./map-service";
import { mapHistory } from "./map-history";
import { recordStep, undoSteps, setHistoryCursor } from "./metadata/history";
import { recordDocumentChanges } from "./metadata/revisions";
import { insertTable, type DataTable } from "./metadata/tables";
import { ApiError } from "./api/errors";

let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function fixture() {
  const owner = testAccountScope(db), editor = testAccountScope(db, "editor"), other = testAccountScope(db, "other");
  const map = createMap(owner, "History");
  db.prepare("INSERT INTO projects (id,name,owner_id,created_at,updated_at) VALUES ('p','P',?,'t','t')").run(owner.accountId);
  db.exec("INSERT INTO project_people VALUES ('p','editor','editor','t'), ('p','other','editor','t')");
  db.prepare("UPDATE maps SET project_id = 'p' WHERE id = ?").run(map.id);
  for (let i = 1; i <= 2; i++) recordStep({ mapId: map.id, scope: "layer", targetId: "layer", op: "update", before: { sql: `SELECT ${i}` }, after: { sql: `SELECT ${i + 1}` }, groupId: `gesture-${i}` }, db);
  setHistoryCursor(map.id, undoSteps(map.id, db)[0].seq - 1, db);
  return { owner, editor, other, map };
}
it("reuses SQL eligibility for repeated undo and redo reads, invalidating by target and revision", async () => {
  const { owner, editor, map } = fixture();
  const sql = vi.spyOn(admission, "admitMapSql");
  expect(await mapHistory(editor, map.id)).toMatchObject({ undoTarget: { eligible: true }, redoTarget: { eligible: true } });
  expect(sql).toHaveBeenCalledTimes(2);
  await mapHistory(editor, map.id);
  expect(sql).toHaveBeenCalledTimes(2);
  db.transaction(() => recordDocumentChanges(owner, [{ kind: "map", id: map.id }], db))();
  await mapHistory(editor, map.id);
  expect(sql).toHaveBeenCalledTimes(4);
  setHistoryCursor(map.id, 2, db);
  await mapHistory(editor, map.id);
  expect(sql).toHaveBeenCalledTimes(5);
});
it("rechecks permission, caller and dataset namespace even when the document revision is unchanged", async () => {
  const { editor, other, map } = fixture();
  const sql = vi.spyOn(admission, "admitMapSql").mockResolvedValue({ bound: [] });
  const first = await mapHistory(editor, map.id);
  await mapHistory(other, map.id); expect(sql).toHaveBeenCalledTimes(4);
  await mapHistory(editor, map.id); expect(sql).toHaveBeenCalledTimes(4);
  insertTable(editor, { id: "data", name: "data", sourceFilename: null, format: "geoparquet", file: "data.parquet", geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 1, createdAt: "t", source: "upload", sourceParams: null, importedAt: null } as DataTable, db);
  expect((await mapHistory(editor, map.id)).editRevision).toBe(first.editRevision);
  expect(sql).toHaveBeenCalledTimes(6);
  db.exec("UPDATE data_tables SET name = 'renamed' WHERE id = 'data'");
  await mapHistory(editor, map.id); expect(sql).toHaveBeenCalledTimes(8);
  db.exec("DELETE FROM data_tables WHERE id = 'data'");
  db.exec("UPDATE project_people SET role = 'viewer' WHERE account_id = 'editor'");
  expect(await mapHistory(editor, map.id)).toMatchObject({ undoTarget: { eligible: false }, redoTarget: { eligible: false } });
  expect(sql).toHaveBeenCalledTimes(8);
});
it("does not cache a failed SQL admission", async () => {
  const { editor, map } = fixture();
  const sql = vi.spyOn(admission, "admitMapSql").mockRejectedValue(new ApiError("invalid_request", "Temporarily unavailable", 400));
  expect(await mapHistory(editor, map.id)).toMatchObject({ undoTarget: { eligible: false } });
  sql.mockResolvedValue({ bound: [] });
  expect(await mapHistory(editor, map.id)).toMatchObject({ undoTarget: { eligible: true } });
  expect(sql).toHaveBeenCalledTimes(4);
});
