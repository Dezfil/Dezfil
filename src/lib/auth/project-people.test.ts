import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, createApiToken, issueSession } from "./credentials";
import { PERMISSION_REFUSAL } from "./reach";

/**
 * A project's people.
 *
 * Pat owns project P. Ada is its editor, Vi its viewer and Dee a member whose
 * account is deactivated; Out is an admin who belongs to nothing, Ivy an
 * invitation never redeemed and Bo an active account outside the project. Ada
 * files her map M into P.
 *
 * The project's owner reads its people, the owner first; a member reads the
 * owner and themselves, their own role included, and nobody else. Only the
 * project's owner adds a person, changes a role or removes one; a member is
 * refused by the permission shape, anyone else by the absent shape, alike on a
 * session and a token, and a refusal changes nothing. A change governs the
 * member's very next request on the credential they already hold.
 */
let db: Database;
const now = "2026-01-01T00:00:00.000Z";
const origin = "http://instance.test";
const sessions = new Map<string, string>();
const tokens = new Map<string, string>();

beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  sessions.clear(); tokens.clear();
  for (const id of ["pat", "ada", "vi", "dee", "out", "ivy", "bo"]) testAccountScope(db, id);
  db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run("Pat Owner", "pat");
  db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run("ada Lovelace", "ada");
  db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run("Vi Viewer", "vi");
  db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run("Dee Gone", "dee");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'out'").run();
  db.exec(`INSERT INTO projects (id, name, note, created_at, updated_at, owner_id) VALUES ('P', 'Survey', NULL, '${now}', '${now}', 'pat');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${now}'), ('P', 'vi', 'viewer', '${now}'), ('P', 'dee', 'editor', '${now}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id) VALUES ('M', 'Filed map', '${now}', '${now}', 'ada', 'P');`);
  for (const id of ["pat", "ada", "vi", "dee", "out", "bo"]) credentials(id);
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'dee'").run();
  db.prepare("UPDATE accounts SET status = 'invited' WHERE id = 'ivy'").run();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

/** One session and one token per account, held for the whole test, so a
 * second request rides the very credential the first one did. */
function credentials(account: string) {
  const secret = issueSession(getAccount(account, db)!, db, Date.now()).secret;
  sessions.set(account, secret);
  tokens.set(account, createApiToken(authenticateSession(secret, db)!, "People", db).secret);
}
function input(account: string, path: string, method: string, body?: unknown, kind: "session" | "token" = "session") {
  const headers = new Headers({ "content-type": "application/json", origin });
  if (kind === "token") headers.set("authorization", `Bearer ${tokens.get(account)}`);
  else headers.set("cookie", `dezfil_session=${sessions.get(account)}`);
  return socketRequest(new Request(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes = {
  people: () => import("@/app/api/projects/[id]/people/route"),
  person: () => import("@/app/api/projects/[id]/people/[sqlName]/route"),
  project: () => import("@/app/api/projects/[id]/route"),
  map: () => import("@/app/api/maps/[id]/route"),
};
async function call(route: keyof typeof routes, method: string, account: string, params: Record<string, string>,
  body?: unknown, kind: "session" | "token" = "session") {
  const path = route === "people" ? `/api/projects/${params.id}/people`
    : route === "person" ? `/api/projects/${params.id}/people/${params.sqlName}`
    : route === "project" ? `/api/projects/${params.id}` : `/api/maps/${params.id}`;
  const handler = ((await routes[route]()) as Record<string, unknown>)[method] as Handler;
  const response = await handler(input(account, path, method, body, kind), { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() as unknown };
}
const people = () => db.prepare("SELECT project_id, account_id, role, added_at FROM project_people ORDER BY 1, 2").all();
function snapshot() {
  return ["projects", "project_people", "maps", "accounts"].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
const forbidden = { status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } };
const sqlName = (id: string) => getAccount(id, db)!.sqlName;
const PEOPLE = () => [
  { name: "Pat Owner", sqlName: sqlName("pat"), role: "owner", deactivated: false },
  { name: "ada Lovelace", sqlName: sqlName("ada"), role: "editor", deactivated: false },
  { name: "Dee Gone", sqlName: sqlName("dee"), role: "editor", deactivated: true },
  { name: "Vi Viewer", sqlName: sqlName("vi"), role: "viewer", deactivated: false },
];

describe("reading a project's people", () => {
  it("answers the project's owner the whole list, the owner first, members by name, the deactivated marked", async () => {
    for (const kind of ["session", "token"] as const) {
      expect(await call("people", "GET", "pat", { id: "P" }, undefined, kind), kind)
        .toEqual({ status: 200, body: { people: PEOPLE() } });
    }
    // Never an email, an admin flag or an account identity.
    expect(JSON.stringify((await call("people", "GET", "pat", { id: "P" })).body)).not.toMatch(/example\.test|isAdmin|"id"/);
  });

  it("answers a member the owner and themselves alone: never the rest of the roster or its deactivation marks", async () => {
    const [owner, ada, , vi] = PEOPLE();
    for (const [account, own] of [["ada", ada], ["vi", vi]] as const) {
      for (const kind of ["session", "token"] as const) {
        expect(await call("people", "GET", account, { id: "P" }, undefined, kind), `${account} ${kind}`)
          .toEqual({ status: 200, body: { people: [owner, own] } });
      }
    }
    const read = JSON.stringify((await call("people", "GET", "vi", { id: "P" })).body);
    expect(read).not.toMatch(/Dee Gone|ada Lovelace|"deactivated":true/);
    expect(read).not.toMatch(/example\.test|isAdmin|"id"/);
  });

  it("refuses an outsider and an admin exactly as a project that does not exist", async () => {
    for (const account of ["out", "bo"]) {
      const missing = await call("people", "GET", account, { id: "missing" });
      expect(missing.status).toBe(404);
      for (const kind of ["session", "token"] as const) {
        expect(await call("people", "GET", account, { id: "P" }, undefined, kind), `${account} ${kind}`).toEqual(missing);
      }
    }
  });
});

describe("changing a project's people", () => {
  const changes = [
    { label: "add a person", method: "PUT", sqlName: "bo", body: { role: "viewer" } },
    { label: "change a role", method: "PUT", sqlName: "vi", body: { role: "editor" } },
    { label: "remove a person", method: "DELETE", sqlName: "vi", body: undefined },
  ];
  describe.each(changes)("$label", change => {
    for (const account of ["ada", "vi"]) {
      it(`refuses the member ${account} by the permission shape, alike on a session and a token, with nothing changed`, async () => {
        const before = snapshot();
        const params = { id: "P", sqlName: sqlName(change.sqlName) };
        expect(await call("person", change.method, account, params, change.body)).toEqual(forbidden);
        expect(await call("person", change.method, account, params, change.body, "token")).toEqual(forbidden);
        expect(snapshot()).toEqual(before);
      });
    }
    it("refuses an admin and an outsider by the absent shape, alike on a session and a token, with nothing changed", async () => {
      const before = snapshot();
      for (const account of ["out", "bo"]) {
        const missing = await call("person", change.method, account, { id: "missing", sqlName: sqlName(change.sqlName) }, change.body);
        expect(missing.status).toBe(404);
        const params = { id: "P", sqlName: sqlName(change.sqlName) };
        expect(await call("person", change.method, account, params, change.body), account).toEqual(missing);
        expect(await call("person", change.method, account, params, change.body, "token"), account).toEqual(missing);
      }
      expect(snapshot()).toEqual(before);
    });
  });

  it("lets the owner add a person, change a role and remove a person, answering the people as they now stand", async () => {
    const added = await call("person", "PUT", "pat", { id: "P", sqlName: sqlName("bo") }, { role: "viewer" }, "token");
    expect(added.status).toBe(200);
    expect((added.body as { people: { sqlName: string; role: string }[] }).people.map(p => [p.sqlName, p.role]))
      .toEqual([[sqlName("pat"), "owner"], [sqlName("ada"), "editor"], [sqlName("bo"), "viewer"], [sqlName("dee"), "editor"], [sqlName("vi"), "viewer"]]);
    const changed = await call("person", "PUT", "pat", { id: "P", sqlName: sqlName("vi") }, { role: "editor" });
    expect(changed.status).toBe(200);
    expect(people()).toContainEqual({ project_id: "P", account_id: "vi", role: "editor", added_at: now });
    const removed = await call("person", "DELETE", "pat", { id: "P", sqlName: sqlName("bo") });
    expect(removed.status).toBe(200);
    expect(people().map(row => (row as { account_id: string }).account_id)).toEqual(["ada", "dee", "vi"]);
    expect(await call("people", "GET", "pat", { id: "P" })).toEqual(removed);
  });

  it("lets the owner remove a deactivated member, and treats removing someone who is not a member as no change", async () => {
    const removed = await call("person", "DELETE", "pat", { id: "P", sqlName: sqlName("dee") });
    expect(removed.status).toBe(200);
    expect(people().map(row => (row as { account_id: string }).account_id)).toEqual(["ada", "vi"]);
    const before = snapshot();
    for (const target of [sqlName("bo"), sqlName("pat"), "nobody_here"]) {
      const response = await call("person", "DELETE", "pat", { id: "P", sqlName: target });
      expect(response.status, target).toBe(200);
    }
    expect(snapshot()).toEqual(before);
  });

  it("refuses the owner as their own member, an inactive, invited or unknown person and an unknown role, with nothing changed", async () => {
    const before = snapshot();
    const owner = await call("person", "PUT", "pat", { id: "P", sqlName: sqlName("pat") }, { role: "editor" });
    expect(owner).toEqual({ status: 400, body: { error: { code: "invalid_request", message: "The project's owner is never its member." } } });
    // A deactivated account, an invitation and a name nobody holds are one
    // refusal: nothing tells the owner which it was.
    const nobody = await call("person", "PUT", "pat", { id: "P", sqlName: "nobody_here" }, { role: "viewer" });
    expect(nobody).toEqual({ status: 400, body: { error: { code: "invalid_request", message: "No active person has that SQL name." } } });
    for (const account of ["dee", "ivy"]) {
      expect(await call("person", "PUT", "pat", { id: "P", sqlName: sqlName(account) }, { role: "viewer" }), account).toEqual(nobody);
    }
    for (const body of [{ role: "owner" }, { role: "admin" }, {}, { role: 1 }, null]) {
      const response = await call("person", "PUT", "pat", { id: "P", sqlName: sqlName("bo") }, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(snapshot()).toEqual(before);
  });

  it("keeps membership the owner's alone while that owner is deactivated, admins included, and the project shared as it was", async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'pat'").run();
    const listed = await call("people", "GET", "ada", { id: "P" });
    expect(listed.status).toBe(200);
    expect((listed.body as { people: { role: string; deactivated: boolean }[] }).people[0]).toMatchObject({ role: "owner", deactivated: true });
    const before = snapshot();
    expect(await call("person", "PUT", "ada", { id: "P", sqlName: sqlName("bo") }, { role: "viewer" })).toEqual(forbidden);
    expect((await call("person", "PUT", "out", { id: "P", sqlName: sqlName("bo") }, { role: "viewer" })).status).toBe(404);
    expect((await call("person", "DELETE", "out", { id: "P", sqlName: sqlName("vi") })).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });
});

describe("a change governs the member's next request", () => {
  it("takes a removed member's reach away on their very next request, with no sign-out", async () => {
    expect((await call("project", "GET", "vi", { id: "P" })).status).toBe(200);
    expect((await call("map", "GET", "vi", { id: "M" })).status).toBe(200);
    expect((await call("person", "DELETE", "pat", { id: "P", sqlName: sqlName("vi") })).status).toBe(200);
    const missingMap = await call("map", "GET", "vi", { id: "never" });
    expect(await call("map", "GET", "vi", { id: "M" })).toEqual(missingMap);
    expect(await call("project", "GET", "vi", { id: "P" })).toEqual(await call("project", "GET", "vi", { id: "never" }));
    expect(await call("people", "GET", "vi", { id: "P" }, undefined, "token")).toEqual(await call("people", "GET", "vi", { id: "never" }, undefined, "token"));
  });

  it("lets a viewer made editor change content on their next request, and a demoted editor lose it", async () => {
    const rename = { name: "Renamed by Vi" };
    expect(await call("map", "PATCH", "vi", { id: "M" }, rename)).toEqual(forbidden);
    expect((await call("person", "PUT", "pat", { id: "P", sqlName: sqlName("vi") }, { role: "editor" })).status).toBe(200);
    expect((await call("map", "PATCH", "vi", { id: "M" }, rename)).status).toBe(200);
    expect((db.prepare("SELECT name FROM maps WHERE id = 'M'").get() as { name: string }).name).toBe("Renamed by Vi");
    expect((await call("person", "PUT", "pat", { id: "P", sqlName: sqlName("vi") }, { role: "viewer" })).status).toBe(200);
    expect(await call("map", "PATCH", "vi", { id: "M" }, { name: "Again" }, "token")).toEqual(forbidden);
  });

  it("gives an added person reach on their next request and nothing before", async () => {
    const missing = await call("project", "GET", "bo", { id: "never" });
    expect(await call("project", "GET", "bo", { id: "P" })).toEqual(missing);
    expect((await call("person", "PUT", "pat", { id: "P", sqlName: sqlName("bo") }, { role: "viewer" })).status).toBe(200);
    const reached = await call("project", "GET", "bo", { id: "P" });
    expect(reached.status).toBe(200);
    expect(reached.body).toMatchObject({ id: "P", role: "viewer", owner: { name: "Pat Owner", sqlName: sqlName("pat") } });
  });
});
