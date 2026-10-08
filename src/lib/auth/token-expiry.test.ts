import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { getAccount, insertAccount, markOriginalAccount } from "@/lib/metadata/accounts";
import { IDENTITIES_MIGRATION, rebuildIdentities } from "@/lib/metadata/migrations-identities";
import { allocateSqlNames, type SqlNameIdentity } from "@/lib/metadata/sql-names";
import { writeStoredSettings } from "@/lib/settings/store";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { mcpResult } from "@/lib/mcp/result";
import { GET as listRoute } from "@/app/api/account/tokens/route";
import { authenticateSession, authenticateToken, createApiToken, issueSession, listApiTokens, requireCurrentActor,
  revokeApiToken, secretHash, type AuthContext } from "./credentials";
import { authenticateBearer, delegateCredential } from "./delegation";
import { maintainCredentials } from "./credential-maintenance";

// Fixture values, written out rather than read from the code under test.
const day = 86_400_000, year = 365 * day, start = Date.parse("2026-03-01T00:00:00Z");
const iso = (time: number) => new Date(time).toISOString();
const LIFETIMES = { never: null, "30d": 30 * day, "90d": 90 * day, "1y": year } as const;

let directory: string, file: string, db: Database.Database;
beforeEach(() => {
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "token-expiry-"));
  file = path.join(directory, "metadata.sqlite");
  db = metadata.open(file);
  const owner = insertAccount({ id: "ada", name: "Ada", email: "ada@example.test", passwordHash: null, isAdmin: true,
    status: "active", now: iso(start) }, db);
  markOriginalAccount(owner.id, db);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

/** A fresh session for the owner at a moment: sessions are not under test here. */
const session = (at: number, store = db): AuthContext => authenticateSession(issueSession(getAccount("ada", store)!, store, at).secret, store, at)!;
const row = (id: string, store = db) => store.prepare("SELECT expires_at, last_used_at, revoked_at FROM auth_tokens WHERE id = ?").get(id) as
  { expires_at: number | null; last_used_at: number | null; revoked_at: number | null } | undefined;

describe("a token made under Never", () => {
  it("works a year on: by authentication, the actor check and a delegated bearer", () => {
    const never = createApiToken(session(start), "Never", db, start);
    expect(never.expiresAt).toBeNull();
    expect(row(never.id)?.expires_at).toBeNull();
    const later = start + year;
    const context = authenticateToken(never.secret, db, later);
    expect(context?.account.id).toBe("ada");
    expect(requireCurrentActor(context, db, later).id).toBe("ada");
    expect(listApiTokens(context!, db, later).map(token => [token.id, token.expiresAt])).toEqual([[never.id, null]]);
    const delegated = delegateCredential(context!, db, later);
    expect(authenticateBearer(delegated, db, later)?.account.id).toBe("ada");
    expect(requireCurrentActor(authenticateBearer(delegated, db, later), db, later).id).toBe("ada");
  });
});

describe("a token made under 30 days", () => {
  it("works until thirty days on, then gets its own refusal from authentication, the actor check and a delegated bearer", () => {
    writeStoredSettings({ "tokens.expiry": "30d" }, db);
    const token = createApiToken(session(start), "Month", db, start);
    expect(token.expiresAt).toBe(iso(start + 30 * day));
    const last = start + 30 * day - 1, expired = start + 30 * day;
    const context = authenticateToken(token.secret, db, last)!;
    expect(context.account.id).toBe("ada");
    const delegated = delegateCredential(context, db, last);
    const before = row(token.id);
    const refusal = expect.objectContaining({ code: "token_expired", status: 401 });
    expect(() => authenticateToken(token.secret, db, expired)).toThrow(refusal);
    expect(() => requireCurrentActor(context, db, expired)).toThrow(refusal);
    expect(() => createApiToken(context, "From an expired token", db, expired)).toThrow(refusal);
    expect(() => authenticateBearer(delegated, db, expired)).toThrow(refusal);
    // A refused use records nothing.
    expect(row(token.id)).toEqual(before);
    expect(listApiTokens(session(expired), db, expired)).toEqual([expect.objectContaining({ id: token.id, expiresAt: iso(expired), revokedAt: null })]);
  });

  it("refuses a revoked token as revoked, whatever its expiry", () => {
    writeStoredSettings({ "tokens.expiry": "30d" }, db);
    const owner = session(start), token = createApiToken(owner, "Month", db, start);
    const context = authenticateToken(token.secret, db, start)!;
    revokeApiToken(owner, token.id, db, start + day);
    expect(authenticateToken(token.secret, db, start + 31 * day)).toBeNull();
    expect(() => requireCurrentActor(context, db, start + 31 * day)).toThrow(expect.objectContaining({ code: "authentication_required" }));
  });
});

it.each(Object.entries(LIFETIMES))("stamps a token made under %s from its creation", (choice, lifetime) => {
  writeStoredSettings({ "tokens.expiry": choice }, db);
  const token = createApiToken(session(start), choice, db, start + 7);
  expect(token.expiresAt).toBe(lifetime === null ? null : iso(start + 7 + lifetime));
  expect(row(token.id)?.expires_at).toBe(lifetime === null ? null : start + 7 + lifetime);
});

it("changes no existing token's expiry on a save", () => {
  const owner = session(start);
  const never = createApiToken(owner, "Never", db, start);
  writeStoredSettings({ "tokens.expiry": "30d" }, db);
  const month = createApiToken(owner, "Month", db, start);
  writeStoredSettings({ "tokens.expiry": "1y" }, db);
  writeStoredSettings({ "tokens.expiry": "never" }, db);
  expect([row(never.id)?.expires_at, row(month.id)?.expires_at]).toEqual([null, start + 30 * day]);
  expect(authenticateToken(never.secret, db, start + year)?.account.id).toBe("ada");
  expect(() => authenticateToken(month.secret, db, start + 30 * day)).toThrow(expect.objectContaining({ code: "token_expired" }));
});

it("never sweeps an expired token away: it lists with its expiry until revoked, then goes after the revoked tokens' retention", () => {
  writeStoredSettings({ "tokens.expiry": "30d" }, db);
  const token = createApiToken(session(start), "Month", db, start);
  const long = start + 30 * day + year;
  for (const at of [long, long + 2 * 3_600_000]) maintainCredentials(db, at);
  expect(row(token.id)).toMatchObject({ expires_at: start + 30 * day, revoked_at: null });
  const owner = session(long);
  expect(listApiTokens(owner, db, long).map(listed => [listed.id, listed.expiresAt])).toEqual([[token.id, iso(start + 30 * day)]]);
  revokeApiToken(owner, token.id, db, long);
  maintainCredentials(db, long + 31 * day);
  expect(row(token.id)).toBeUndefined();
});

describe("a store from before the token expiry", () => {
  it("reopens with every token kept, none expiring", () => {
    db.close();
    const migrations = metadata.MIGRATIONS;
    const entry = migrations.findIndex(sql => /ALTER TABLE auth_tokens ADD COLUMN expires_at/.test(sql));
    expect(entry).toBe(migrations.length - 1);
    const older = path.join(directory, "older.sqlite");
    const old = new Database(older);
    old.pragma("journal_mode = WAL"); old.pragma("foreign_keys = ON");
    old.function("allocate_sql_names", { deterministic: true }, (accounts: unknown) =>
      JSON.stringify(allocateSqlNames(JSON.parse(String(accounts)) as SqlNameIdentity[])));
    for (let version = 0; version < entry; version++) {
      if (migrations[version] === IDENTITIES_MIGRATION) { rebuildIdentities(old, migrations[version], version + 1); continue; }
      old.exec(migrations[version]); old.pragma(`user_version = ${version + 1}`);
    }
    expect((old.pragma("table_info(auth_tokens)") as { name: string }[]).map(column => column.name)).not.toContain("expires_at");
    old.prepare(`INSERT INTO accounts (id, name, email, is_admin, status, created_at, updated_at, sql_name)
      VALUES ('ada', 'Ada', 'ada@example.test', 1, 'active', ?, ?, 'ada')`).run(iso(start), iso(start));
    old.exec("INSERT INTO original_account VALUES (1, 'ada')");
    old.prepare("INSERT INTO auth_tokens (id, account_id, name, secret_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("kept", "ada", "Kept", secretHash("dz_token_kept-fixture"), start, null, null);
    old.close();
    db = metadata.open(older);
    expect(db.pragma("user_version", { simple: true })).toBe(migrations.length);
    expect((db.pragma("table_info(auth_tokens)") as { name: string; notnull: number }[]).find(column => column.name === "expires_at"))
      .toMatchObject({ name: "expires_at", notnull: 0 });
    expect(row("kept")).toEqual({ expires_at: null, last_used_at: null, revoked_at: null });
    expect(authenticateToken("dz_token_kept-fixture", db, start + year)?.account.id).toBe("ada");
    expect(listApiTokens(session(start + year), db, start + year).map(listed => [listed.id, listed.expiresAt])).toEqual([["kept", null]]);
  });
});

describe("through the API and the generated tools", () => {
  const origin = "http://instance.test";
  const tool = (name: string) => buildTools().find(candidate => candidate.name === name)!;
  const dispatch = (async (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(new Request(String(input), init))) as typeof fetch;
  const valid = async (name: string, result: Awaited<ReturnType<typeof executeTool>>) => {
    const output = fromJsonSchema(tool(name).outputSchema as Parameters<typeof fromJsonSchema>[0]);
    return (await output["~standard"].validate(mcpResult(tool(name), result, null).structuredContent)).issues;
  };
  beforeEach(() => { vi.spyOn(metadata, "metadataDb").mockReturnValue(db); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start); });

  it("gives an expired token's request its own coded refusal, and the listing and creation answers their documented expiry", async () => {
    writeStoredSettings({ "tokens.expiry": "30d" }, db);
    const owner = session(start), token = createApiToken(owner, "Month", db, start);
    const bearer = { authorization: `Bearer ${token.secret}` };
    const created = await executeTool(tool("create_api_token"), { name: "Agent" }, origin, dispatch, bearer);
    expect(created).toMatchObject({ ok: true, status: 201, body: { name: "Agent", expiresAt: iso(start + 30 * day) } });
    expect(await valid("create_api_token", created)).toBeUndefined();
    const listed = await executeTool(tool("list_api_tokens"), {}, origin, dispatch, bearer);
    expect((listed.body as { tokens: { expiresAt: unknown }[] }).tokens.map(listedToken => listedToken.expiresAt))
      .toEqual([iso(start + 30 * day), iso(start + 30 * day)]);
    expect(await valid("list_api_tokens", listed)).toBeUndefined();
    // The documented expiry is a timestamp or null, never missing or another kind.
    const [first] = (listed.body as { tokens: Record<string, unknown>[] }).tokens;
    const { expiresAt: expiry, ...missing } = first;
    expect(expiry).toBe(iso(start + 30 * day));
    for (const stranger of [missing, { ...first, expiresAt: start }]) {
      expect(await valid("list_api_tokens", { ...listed, body: { tokens: [stranger] } })).toBeDefined();
    }
    vi.setSystemTime(start + 30 * day);
    const refused = await listRoute(socketRequest(new Request(`${origin}/api/account/tokens`, { headers: bearer })));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: { code: "token_expired", message: expect.any(String) } });
    const through = await executeTool(tool("list_api_tokens"), {}, origin, dispatch, bearer);
    expect(through).toMatchObject({ ok: false, status: 401, body: { error: { code: "token_expired" } } });
  });
});
