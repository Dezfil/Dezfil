import { readDocumentRevision } from "@/lib/metadata/revisions";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import type { Database } from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";
import { createMap } from "@/lib/map-service";
import { getPublicationState, getPublishedView, publishMap, resetPublishCache } from "@/lib/publish/publish-service";
import { DELETE } from "@/app/api/publications/[token]/route";
import type { AccountScope } from "./scope";

let db: Database, scopes: Record<string, AccountScope>, maps: Record<string, string>, tokens: Record<string, string>;
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  scopes = {}; maps = {}; tokens = {}; resetPublishCache();
  for (const id of ["alice", "bob", "admin"]) { scopes[id] = testAccountScope(db, id); maps[id] = createMap(scopes[id], `Secret ${id}`).id; tokens[id] = publishMap(scopes[id], maps[id]).token; }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
});
afterEach(() => { resetPublishCache(); vi.restoreAllMocks(); db.close(); });
function request(account: string, token: string, kind = "session") {
  const req = testAccountRequest(new Request(`http://instance.test/api/publications/${token}`, { method: "DELETE" }), db, account);
  if (kind === "token") { const credential = createApiToken(requireRequestAuth(req), "Revoke", db); req.headers.delete("cookie"); req.headers.set("authorization", `Bearer ${credential.secret}`); }
  return req;
}
function revoke(account: string, token: string, kind = "session") { return DELETE(request(account, token, kind), { params: Promise.resolve({ token }) }); }
function state() { return db.prepare("SELECT * FROM maps ORDER BY id").all(); }
it.each(["session", "token"])("allows an admin %s to revoke only a known deactivated owner's publication without returning content", async kind => {
  const before = state(); const warmed = await getPublishedView(tokens.alice, Date.now()); expect(warmed?.name).toBe("Secret alice");
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  expect((await getPublishedView(tokens.alice, Date.now()))?.name).toBe("Secret alice");
  const previous = readDocumentRevision({ kind: "map", id: maps.alice }, db)!;
  const response = await revoke("admin", tokens.alice, kind); expect(response.status).toBe(204); expect(await response.text()).toBe("");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await getPublishedView(tokens.alice, Date.now())).toBeNull();
  const changed = readDocumentRevision({ kind: "map", id: maps.alice }, db)!;
  expect(changed.editRevision).not.toBe(previous.editRevision);
  expect(changed.lastChangedBy).toBe("admin");
  const after = state() as Record<string, unknown>[];
  for (let i = 0; i < after.length; i++) {
    if (after[i].id !== maps.alice) expect(after[i]).toEqual(before[i]);
    else expect(after[i]).toMatchObject({ ...(before[i] as object), publish_token: null, published_at: null, published_theme: null, viewer_controls: null, updated_at: after[i].updated_at, edit_revision: changed.editRevision, last_changed_by: "admin", last_changed_at: changed.lastChangedAt });
  }
  expect(() => getPublicationState(scopes.admin, maps.alice)).toThrow(expect.objectContaining({ code: "not_found" }));
  db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  expect(getPublicationState(scopes.alice, maps.alice)).toBeNull(); expect(publishMap(scopes.alice, maps.alice).token).not.toBe(tokens.alice);
});
it("keeps active owners, the admin's own active map and unknown tokens indistinguishable with no write", async () => {
  const before = state(); const missing = await revoke("admin", "missing"), control = await missing.json(); expect(missing.status).toBe(404);
  for (const token of Object.values(tokens)) { const response = await revoke("admin", token); expect(response.status).toBe(404); expect(await response.json()).toEqual(control); }
  expect(state()).toEqual(before);
});
it("refuses ordinary and anonymous callers before target lookup", async () => {
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); const before = state();
  const hidden = await revoke("bob", tokens.alice), missing = await revoke("bob", "missing");
  expect(hidden.status).toBe(403); expect(await hidden.json()).toEqual(await missing.json());
  expect((await DELETE(socketRequest(new Request("http://instance.test/api/publications/x", { method: "DELETE" })), { params: Promise.resolve({ token: tokens.alice }) })).status).toBe(401);
  expect(state()).toEqual(before);
});
it.each(["reactivation", "admin removal"])("rechecks %s after request admission before any revocation write", async change => {
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  let resume!: (value: { token: string }) => void;
  const params = new Promise<{ token: string }>(resolve => { resume = resolve; });
  const pending = DELETE(request("admin", tokens.alice), { params });
  if (change === "reactivation") db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'alice'").run();
  else db.prepare("UPDATE accounts SET is_admin = 0 WHERE id = 'admin'").run();
  const before = state(); resume({ token: tokens.alice });
  expect((await pending).status).toBe(change === "reactivation" ? 404 : 403); expect(state()).toEqual(before);
});
