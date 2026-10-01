import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { GET as readAccount, PATCH as updateAccount } from "@/app/api/account/route";
import { GET as readSession } from "@/app/api/auth/session/route";
import { GET as listUsers, POST as inviteUser } from "@/app/api/users/route";
import { PATCH as changeAccess } from "@/app/api/users/[id]/route";
import { POST as issueLink } from "@/app/api/users/[id]/sign-in-link/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { buildTools } from "@/lib/tools/tools";
import { createFirstAccount } from "./accounts";
import { issueSession } from "./credentials";

/**
 * Every account's SQL name is on the account reads it already has: the
 * signed-in account, the session and the admin's Users listing. It is derived
 * once, at creation or at upgrade, and nothing changes it afterwards.
 */
const origin = "http://instance.test", password = "field notebooks at dawn";
let db: Database.Database;
afterEach(() => { vi.restoreAllMocks(); if (db?.open) db.close(); });
function request(pathname: string, secret: string, method = "GET", body?: unknown) {
  return new NextRequest(socketRequest(new Request(origin + pathname, { method,
    headers: { origin, "content-type": "application/json", cookie: `dezfil_session=${secret}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })));
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
type Listed = { users: { name: string; email: string; sqlName: string }[] };
const names = (listed: Listed) => Object.fromEntries(listed.users.map(user => [user.email, user.sqlName]));

describe("SQL names on the account surfaces", () => {
  let admin: Awaited<ReturnType<typeof createFirstAccount>>;
  beforeEach(async () => {
    db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
    admin = await createFirstAccount({ name: "Ada Lovelace", email: "ada@example.test", password }, db);
  });

  it("names invited people by the derivation and carries the name on every account read", async () => {
    const invited: Record<string, string> = {};
    for (const [name, email] of [["Ada Lovelace", "lovelace@example.test"], ["42 Club", "club@example.test"],
      ["!!!", "field.notes@example.test"], ["Main", "main@example.test"]]) {
      const response = await inviteUser(request("/api/users", admin.secret, "POST", { name, email }));
      expect(response.status).toBe(201);
      invited[email] = (await response.json()).account.sqlName;
    }
    expect(invited).toEqual({ "lovelace@example.test": "ada_lovelace2", "club@example.test": "u42_club",
      "field.notes@example.test": "field_notes", "main@example.test": "main2" });
    const listed = await (await listUsers(request("/api/users", admin.secret))).json() as Listed;
    expect(names(listed)).toEqual({ "ada@example.test": "ada_lovelace", ...invited });
    expect((await (await readAccount(request("/api/account", admin.secret))).json()).account.sqlName).toBe("ada_lovelace");
    expect((await (await readSession(request("/api/auth/session", admin.secret))).json()).account.sqlName).toBe("ada_lovelace");
  });

  it("keeps the name through a rename, an email change, a role change, a new sign-in link and deactivation", async () => {
    const created = await (await inviteUser(request("/api/users", admin.secret, "POST", { name: "Bo Smith", email: "bo@example.test" }))).json();
    const id = created.account.id;
    expect(created.account.sqlName).toBe("bo_smith");
    const renamed = await updateAccount(request("/api/account", admin.secret, "PATCH", { name: "Grace Hopper", email: "grace@example.test", currentPassword: password }));
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).account).toMatchObject({ name: "Grace Hopper", email: "grace@example.test", sqlName: "ada_lovelace" });
    expect((await (await changeAccess(request(`/api/users/${id}`, admin.secret, "PATCH", { isAdmin: true }), params(id))).json()).account.sqlName).toBe("bo_smith");
    expect((await (await issueLink(request(`/api/users/${id}/sign-in-link`, admin.secret, "POST"), params(id))).json()).account.sqlName).toBe("bo_smith");
    expect((await (await changeAccess(request(`/api/users/${id}`, admin.secret, "PATCH", { status: "deactivated" }), params(id))).json()).account.sqlName).toBe("bo_smith");
    const again = await (await inviteUser(request("/api/users", admin.secret, "POST", { name: "Bo Smith", email: "bo2@example.test" }))).json();
    expect(again.account.sqlName).toBe("bo_smith2");
    expect(names(await (await listUsers(request("/api/users", admin.secret))).json() as Listed))
      .toEqual({ "grace@example.test": "ada_lovelace", "bo@example.test": "bo_smith", "bo2@example.test": "bo_smith2" });
  });
});

describe("SQL names given at upgrade", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "sql-name-upgrade-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("names every existing account by the same rule and reads them on the Users listing", async () => {
    const file = path.join(directory, "metadata.sqlite");
    const entry = metadata.MIGRATIONS.findIndex(sql => sql.includes("CREATE TABLE project_people"));
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    for (const migration of metadata.MIGRATIONS.slice(0, entry)) old.exec(migration);
    old.pragma(`user_version = ${entry}`);
    const insert = old.prepare(`INSERT INTO accounts (id, name, email, is_admin, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const people = [["first", "Ada Lovelace", "ada@example.test", 1, "active"], ["twin", "Ada Lovelace", "lovelace@example.test", 0, "active"],
      ["digits", "42 Club", "club@example.test", 0, "invited"], ["symbols", "!!!", "field.notes@example.test", 0, "deactivated"],
      ["main", "Main", "main@example.test", 0, "active"]] as const;
    people.forEach(([id, name, email, isAdmin, status], i) => insert.run(id, name, email, isAdmin, status, `2026-01-0${i + 1}T00:00:00.000Z`, "2026-01-01"));
    old.exec("INSERT INTO original_account VALUES (1, 'first')");
    old.close();
    db = metadata.open(file); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
    const session = issueSession(getAccount("first", db)!, db, Date.now());
    expect(names(await (await listUsers(request("/api/users", session.secret))).json() as Listed)).toEqual({
      "ada@example.test": "ada_lovelace", "lovelace@example.test": "ada_lovelace2", "club@example.test": "u42_club",
      "field.notes@example.test": "field_notes", "main@example.test": "main2",
    });
    expect((await (await readAccount(request("/api/account", session.secret))).json()).account.sqlName).toBe("ada_lovelace");
  });
});

it("documents the SQL name on the account contract and its tool", () => {
  const account = buildOpenApiDocument().components.schemas.Account as { properties: Record<string, { pattern?: string; description?: string }>; required: string[] };
  expect(account.required).toContain("sqlName");
  expect(account.properties.sqlName.pattern).toBe("^[a-z][a-z0-9_]{2,31}$");
  expect(account.properties.sqlName.description).toMatch(/fixed/i);
  expect(JSON.stringify(buildTools().find(tool => tool.name === "get_account")?.outputSchema)).toContain("sqlName");
});
