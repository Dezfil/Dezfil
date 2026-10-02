import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createMap, readMap, updateMap } from "@/lib/map-service";
import { POST, DELETE } from "@/app/api/maps/[id]/publish/route";
import { buildTools } from "@/lib/tools/tools";
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const snapshot = () => ["maps", "layers", "map_history"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
function write(id: string, revision?: string, method = "POST", body?: unknown, account = "test-account") {
  const request = testAccountRequest(new Request(`http://instance.test/api/maps/${id}/publish`, { method,
    headers: { "content-type": "application/json", ...(revision === undefined ? {} : { "X-Edit-Revision": revision }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, account);
  return (method === "POST" ? POST : DELETE)(request, { params: Promise.resolve({ id }) });
}
it.each([false, true])("refuses missing, malformed and stale publication writes atomically (published=%s)", async published => {
  const scope = testAccountScope(db), map = createMap(scope, "Map");
  if (published) expect((await write(map.id, map.editRevision)).status).toBe(201);
  const shown = readMap(scope, map.id);
  updateMap(scope, map.id, { name: "Another tab" }, { expectedRevision: shown.editRevision });
  for (const revision of [undefined, "bad", shown.editRevision]) {
    for (const [method, body] of [["POST", undefined], ["POST", { theme: "light" }], ["POST", { viewerControls: { tilt: false } }], ["DELETE", undefined]] as const) {
      const before = snapshot();
      const result = await write(map.id, revision, method, body);
      expect(result.status).toBe(revision === shown.editRevision ? 409 : 400);
      expect(await result.json()).toEqual({ error: revision === shown.editRevision
        ? { code: "stale_revision", message: "This item has changed. Reload it before trying again." }
        : { code: "invalid_request", message: "Read this item first, then send its editRevision in X-Edit-Revision." } });
      expect(snapshot()).toEqual(before);
    }
  }
});
it("chains settings and revocation results and checks genuine no-ops without advancing facts", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "Map");
  const first = await (await write(map.id, map.editRevision)).json();
  expect(first.editRevision).not.toBe(map.editRevision);
  const same = await (await write(map.id, first.editRevision)).json();
  expect(same).toEqual(first);
  const changed = await (await write(map.id, same.editRevision, "POST", { theme: "light" })).json();
  expect(changed.editRevision).not.toBe(first.editRevision); expect(changed.token).toBe(first.token);
  const revoked = await (await write(map.id, changed.editRevision, "DELETE")).json();
  expect(revoked.editRevision).not.toBe(changed.editRevision);
  const before = snapshot();
  expect((await write(map.id, revoked.editRevision, "DELETE")).status).toBe(200);
  expect(snapshot()).toEqual(before);
});
it("keeps private reach ahead of the revision check and declares both owner tools", async () => {
  const map = createMap(testAccountScope(db), "Private");
  expect((await write(map.id, undefined, "POST", undefined, "outsider")).status).toBe(404);
  expect((await write(map.id, undefined, "DELETE", undefined, "outsider")).status).toBe(404);
  for (const name of ["publish_map", "unpublish_map"]) expect(buildTools().find(tool => tool.name === name)!.inputSchema.required).toContain("expected_revision");
});

it("refuses a publication whose body arrives after another accepted edit", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "Map");
  let send!: (value: Uint8Array) => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) { send = value => { controller.enqueue(value); controller.close(); }; } });
  const request = testAccountRequest(new Request(`http://instance.test/api/maps/${map.id}/publish`, {
    method: "POST", headers: { "X-Edit-Revision": map.editRevision }, body, duplex: "half",
  } as RequestInit), db);
  const pending = POST(request, { params: Promise.resolve({ id: map.id }) });
  updateMap(scope, map.id, { name: "Changed while receiving settings" }, { expectedRevision: map.editRevision });
  const before = snapshot();
  send(new TextEncoder().encode('{"theme":"light"}'));
  const response = await pending;
  expect(response.status).toBe(409);
  expect(snapshot()).toEqual(before);
});
