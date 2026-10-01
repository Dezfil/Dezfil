import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { getAccount, insertAccount, markOriginalAccount } from "@/lib/metadata/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { authenticateSession, createApiToken, issueSession } from "./credentials";
import { isAdminRequest } from "./request-policy";

/**
 * The directory: how one signed-in person finds another to share with.
 *
 * Pat (the caller, "Ada Self" is her display name) searches. Active people
 * are found by any part of their display name, case aside, or by their exact
 * email, and each answers as a display name and a SQL name only. Deactivated
 * accounts, invitations not yet redeemed and the caller never answer, nobody
 * answers twice, an empty query answers nothing, and the answer is bounded.
 * Account management stays admin-only.
 */
let db: Database;
const origin = "http://instance.test";
const sessions = new Map<string, string>();
const tokens = new Map<string, string>();

function person(id: string, name: string, email: string, status: "active" | "invited" | "deactivated" = "active", isAdmin = false) {
  insertAccount({ id, name, email, passwordHash: null, isAdmin, status: "active", now: new Date().toISOString() }, db);
  const secret = issueSession(getAccount(id, db)!, db, Date.now()).secret;
  sessions.set(id, secret);
  tokens.set(id, createApiToken(authenticateSession(secret, db)!, "Directory", db).secret);
  if (status !== "active") db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, id);
}
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  sessions.clear(); tokens.clear();
  person("pat", "Ada Self", "pat@example.test");
  markOriginalAccount("pat", db);
  person("ada", "Ada Lovelace", "countess@example.test");
  person("adam", "Adam Smith", "adam@example.test");
  person("elo", "Élodie Ada", "elodie@example.test");
  person("admin", "Ada Admin", "root@example.test", "active", true);
  person("gone", "Ada Gone", "gone@example.test", "deactivated");
  person("invited", "Ada Invited", "invited@example.test", "invited");
  person("dee", "dee@example.test", "dee@example.test");
  person("bo", "Bo", "bo@example.test");
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

async function search(q: string | null, account = "pat", kind: "session" | "token" | "anonymous" = "session") {
  const headers = new Headers({ origin });
  if (kind === "token") headers.set("authorization", `Bearer ${tokens.get(account)}`);
  if (kind === "session") headers.set("cookie", `dezfil_session=${sessions.get(account)}`);
  const url = new URL(`${origin}/api/accounts/search`);
  if (q !== null) url.searchParams.set("q", q);
  const { GET } = await import("@/app/api/accounts/search/route");
  const response = await GET(socketRequest(new Request(url, { headers })));
  return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() as unknown };
}
const sqlName = (id: string) => getAccount(id, db)!.sqlName;
const found = async (q: string | null, account = "pat") => {
  const answer = await search(q, account);
  expect(answer.status, String(q)).toBe(200);
  return (answer.body as { accounts: { name: string; sqlName: string }[] }).accounts;
};

describe("finding people", () => {
  it("matches any part of an active person's display name, case aside and trimmed, answering name and SQL name only", async () => {
    const answer = await search("  aDa ");
    expect(answer).toEqual({ status: 200, cache: "private, no-store", body: { accounts: [
      { name: "Ada Admin", sqlName: sqlName("admin") },
      { name: "Ada Lovelace", sqlName: sqlName("ada") },
      { name: "Adam Smith", sqlName: sqlName("adam") },
      { name: "Élodie Ada", sqlName: sqlName("elo") },
    ] } });
    expect(await found("ÉLOD")).toEqual([{ name: "Élodie Ada", sqlName: sqlName("elo") }]);
    expect(await found("love")).toEqual([{ name: "Ada Lovelace", sqlName: sqlName("ada") }]);
  });

  it("matches an exact email, trimmed and case aside, and never part of one", async () => {
    expect(await found(" COUNTESS@Example.TEST ")).toEqual([{ name: "Ada Lovelace", sqlName: sqlName("ada") }]);
    expect(await found("countess")).toEqual([]);
    expect(await found("countess@example")).toEqual([]);
    expect(await found("gone@example.test")).toEqual([]);
    expect(await found("invited@example.test")).toEqual([]);
  });

  it("answers someone found both ways once, and an exact email first", async () => {
    expect(await found("dee@example.test")).toEqual([{ name: "dee@example.test", sqlName: sqlName("dee") }]);
    const both = await found("example.test");
    expect(both).toEqual([{ name: "dee@example.test", sqlName: sqlName("dee") }]);
    expect((await found("bo@example.test"))[0]).toEqual({ name: "Bo", sqlName: sqlName("bo") });
  });

  it("never offers the caller, a deactivated account or an invitation, and never an email, an admin flag or an identity", async () => {
    const everyone = await found("a");
    const names = everyone.map(entry => entry.name);
    expect(names).not.toContain("Ada Self");
    expect(names).not.toContain("Ada Gone");
    expect(names).not.toContain("Ada Invited");
    for (const entry of everyone) expect(Object.keys(entry).sort()).toEqual(["name", "sqlName"]);
    expect(JSON.stringify(everyone)).not.toMatch(/countess|root@|isAdmin|"id"/);
    expect(await found("pat@example.test")).toEqual([]);
    // Someone else searching finds the caller.
    expect(await found("Ada Self", "bo")).toEqual([{ name: "Ada Self", sqlName: sqlName("pat") }]);
  });

  it("answers nothing to an empty or missing query and at most twenty people to a broad one", async () => {
    expect(await found("")).toEqual([]);
    expect(await found("   ")).toEqual([]);
    expect(await found(null)).toEqual([]);
    for (let n = 1; n <= 25; n++) person(`member${n}`, `Member ${String(n).padStart(2, "0")}`, `member${n}@example.test`);
    const many = await found("member");
    expect(many).toHaveLength(20);
    expect(many[0].name).toBe("Member 01");
    expect(many[19].name).toBe("Member 20");
    const long = await search("x".repeat(321));
    expect(long.status).toBe(400);
    expect(long.body).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("answers alike on a session and a token, and refuses anyone not signed in or deactivated", async () => {
    expect(await search("ada", "pat", "token")).toEqual(await search("ada", "pat", "session"));
    const anonymous = await search("ada", "pat", "anonymous");
    expect(anonymous.status).toBe(401);
    expect(anonymous.cache).toBe("private, no-store");
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'bo'").run();
    expect((await search("ada", "bo")).status).toBe(401);
    expect((await search("ada", "bo", "token")).status).toBe(401);
  });
});

describe("account management stays the admins'", () => {
  it("keeps the users listing admin-only with its full account rows, and the directory outside the admin gate", async () => {
    expect(isAdminRequest("/api/accounts/search")).toBe(false);
    expect(isAdminRequest("/api/users")).toBe(true);
    const { GET } = await import("@/app/api/users/route");
    const read = async (account: string) => {
      const response = await GET(socketRequest(new Request(`${origin}/api/users`, { headers: { origin, cookie: `dezfil_session=${sessions.get(account)}` } })));
      return { status: response.status, body: await response.json() as { users?: { email: string; isAdmin: boolean }[]; error?: { code: string } } };
    };
    const refused = await read("pat");
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe("forbidden");
    const listed = await read("admin");
    expect(listed.status).toBe(200);
    expect(listed.body.users!.map(user => user.email)).toContain("countess@example.test");
    expect(listed.body.users!.find(user => user.email === "root@example.test")!.isAdmin).toBe(true);
  });
});
