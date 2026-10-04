import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { getAccount } from "@/lib/metadata/accounts";
import { authenticateSession, createApiToken, issueSession } from "./credentials";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { removeProjectPerson, setProjectPerson } from "@/lib/metadata/project-people";
import { requireReachable } from "./reach";

let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of ["owner", "viewer", "editor", "outside"]) testAccountScope(db, id);
  db.exec(`INSERT INTO projects (id, name, owner_id, created_at, updated_at) VALUES
    ('P', 'Shared', 'owner', 'before', 'before'), ('Q', 'Independent', 'owner', 'before', 'before');
    INSERT INTO project_people VALUES ('P', 'viewer', 'viewer', 'before'), ('P', 'editor', 'editor', 'before'),
      ('Q', 'viewer', 'viewer', 'before'), ('Q', 'editor', 'editor', 'before');
    INSERT INTO maps (id, name, owner_id, project_id, created_at, updated_at) VALUES
      ('M', 'Exclusive', 'owner', 'P', 'before', 'before'), ('I', 'Independent', 'owner', 'Q', 'before', 'before'),
      ('O', 'Own work', 'editor', 'P', 'before', 'before');`);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const contents = () => ["projects", "maps", "recipes", "map_history"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
const grants = () => db.prepare("SELECT * FROM project_people ORDER BY 1, 2").all();
async function leave(account: string, project = "P", kind = "session") {
  const { POST } = await import("@/app/api/projects/[id]/leave/route");
  const session = issueSession(getAccount(account, db)!, db, Date.now());
  const token = createApiToken(authenticateSession(session.secret, db)!, "Departure", db);
  const request = socketRequest(new Request(`http://instance.test/api/projects/${project}/leave`, {
    method: "POST", headers: { origin: "http://instance.test", ...(kind === "session"
      ? { cookie: `dezfil_session=${session.secret}` } : { authorization: `Bearer ${token.secret}` }) },
  }));
  const response = await POST(request, { params: Promise.resolve({ id: project }) });
  return { status: response.status, body: await response.json() };
}

it.each(["session", "token"])("refuses owners and hides non-members through %s, without changing anything", async kind => {
  const before = [contents(), grants()];
  expect(await leave("owner", "P", kind)).toEqual({ status: 409, body: { error: {
    code: "project_owner_cannot_leave", message: "The project's owner cannot leave. Transfer or delete the project instead.",
  } } });
  expect(await leave("outside", "P", kind)).toEqual(await leave("outside", "absent", kind));
  expect((await leave("outside", "P", kind)).status).toBe(404);
  expect([contents(), grants()]).toEqual(before);
});

for (const role of ["viewer", "editor"] as const) for (const frozen of [false, true]) {
  it.each(["session", "token"])(`${role} leaves a ${frozen ? "frozen" : "live"} project through %s with no roster or revision change`, async kind => {
    const scope = testAccountScope(db, role);
    requireReachable(scope, "map", "M", db);
    if (frozen) db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'owner'").run();
    const before = contents();
    const otherGrants = grants().filter(row => (row as { project_id: string; account_id: string }).project_id !== "P" || (row as { account_id: string }).account_id !== role);
    expect(await leave(role, "P", kind)).toEqual({ status: 200, body: { left: true } });
    expect(grants()).toEqual(otherGrants);
    expect(contents()).toEqual(before);
    expect(() => requireReachable(scope, "map", "M", db)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(requireReachable(scope, "map", "I", db).relation).toBe(role);
    if (role === "editor") expect(requireReachable(scope, "map", "O", db).relation).toBe("owner");
    expect((await leave(role, "P", kind)).status).toBe(404);
  });
}

it("matches owner removal exactly and permits ordinary re-addition", async () => {
  const owner = testAccountScope(db, "owner");
  const before = contents();
  removeProjectPerson(owner, "P", "editor", db);
  const removed = grants();
  setProjectPerson(owner, "P", "editor", "editor", db);
  expect((await leave("editor")).status).toBe(200);
  expect(grants()).toEqual(removed);
  expect(contents()).toEqual(before);
  setProjectPerson(owner, "P", "editor", "viewer", db);
  expect(requireReachable(testAccountScope(db, "editor"), "project", "P", db).relation).toBe("viewer");
});

it("rejects an inactive credential before departure", async () => {
  const { POST } = await import("@/app/api/projects/[id]/leave/route");
  const request = testAccountRequest(new Request("http://instance.test/api/projects/P/leave", { method: "POST" }), db, "viewer");
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'viewer'").run();
  const before = grants();
  expect((await POST(request, { params: Promise.resolve({ id: "P" }) })).status).toBe(401);
  expect(grants()).toEqual(before);
});
