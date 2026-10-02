import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { requireMap } from "@/lib/map-access";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { scopedDatasets } from "@/lib/query/access";
import { publishMap, unpublishMap, getPublishedView, resetPublishCache } from "./publish-service";
import { resolvePublication, requirePublicationScope, type PublicationScope } from "./publication-scope";

let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); resetPublishCache(); });
afterEach(() => { resetPublishCache(); vi.restoreAllMocks(); db.close(); });
function table(owner: string | null, id: string) {
  db.prepare(`INSERT INTO data_tables (owner_id, id, name, source_filename, format, file, geometry_column, geometry_type,
    crs_assumed, header_suspect, row_count, created_at, source) VALUES (?, ?, 'roads', 'roads.csv', 'csv', ?, NULL, NULL, 0, 0, 1, 'time', 'upload')`).run(owner, id, `${id}.parquet`);
}
it("selects each publisher's durable datasets regardless of visitor or owner activity", () => {
  for (const owner of ["alice", "bob", "admin"]) {
    const scope = testAccountScope(db, owner), map = createMap(scope, `Map ${owner}`); table(owner, owner);
    const publication = resolvePublication(publishMap(scope, map.id, {}, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }).token)!;
    expect(scopedDatasets(publication.scope).map(t => t.id)).toEqual([owner]);
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(owner);
    expect(() => requireAccountScope(scope)).toThrow(); expect(requirePublicationScope(publication.scope)).toBe(owner);
    expect(scopedDatasets(publication.scope).map(t => t.id)).toEqual([owner]);
    expect(() => requireMap(publication.scope as unknown as AccountScope, map.id)).toThrow(expect.objectContaining({ code: "authentication_required" }));
  }
});
it("keeps pending-adoption publication-only access and retires it atomically at setup", async () => {
  db.prepare("INSERT INTO maps (id, name, publish_token, published_at, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy-token', 'time', 'time', 'time')").run();
  table(null, "legacy-roads");
  const before = resolvePublication("legacy-token")!;
  expect(before.scope.ownerId).toBeNull(); expect(scopedDatasets(before.scope).map(t => t.id)).toEqual(["legacy-roads"]);
  const oldView = await getPublishedView("legacy-token", Date.now()); expect(oldView?.name).toBe("Legacy");
  const scope = testAccountScope(db, "original");
  expect(() => requirePublicationScope(before.scope)).toThrow(expect.objectContaining({ code: "not_found" }));
  const after = resolvePublication("legacy-token")!;
  expect(after.scope.ownerId).toBe("original"); expect(after.revision).not.toBe(before.revision);
  expect(scopedDatasets(after.scope).map(t => t.id)).toEqual(["legacy-roads"]);
  expect(requireMap(scope, "legacy").id).toBe("legacy");
  expect(await getPublishedView("legacy-token", Date.now())).toEqual(oldView);
  expect(JSON.stringify(oldView)).not.toMatch(/ownerId|accountId|legacy-roads|\.parquet|legacy-token/);
});
it("rejects missing, forged, copied and revoked scope identities without widening private authority", () => {
  const account = testAccountScope(db, "alice"), map = createMap(account, "Map");
  const { token } = publishMap(account, map.id, {}, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }), scope = resolvePublication(token)!.scope;
  expect(Object.isFrozen(scope)).toBe(true);
  for (const bad of [undefined, { token, mapId: map.id, ownerId: "alice" }, { ...scope, ownerId: "bob" }, { ...scope, mapId: "other" }]) {
    expect(() => requirePublicationScope(bad as PublicationScope)).toThrow(expect.objectContaining({ code: "not_found" }));
  }
  unpublishMap(account, map.id, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }); expect(() => scopedDatasets(scope)).toThrow(expect.objectContaining({ code: "not_found" }));
  expect(resolvePublication(token)).toBeNull(); expect(resolvePublication("missing")).toBeNull();
});
