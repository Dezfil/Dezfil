import type { Database } from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { accountCount } from "@/lib/metadata/accounts";
import { writeStoredSettings } from "@/lib/settings/store";
import { setSetting } from "@/lib/metadata/settings";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken, signOut } from "./credentials";
import { inviteAccount, changeAccountAccess } from "./admin";
import { currentSession, enter, entryInformation, leave } from "./entry";
import { gateRequest } from "./gate";
import { SESSION_COOKIE } from "./http";

// The stored per-account count's default, as a fixture.
const LOGIN_ACCOUNT_LIMIT = 5;
let db: Database;
const password = "field notebooks at dawn";
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function request(path: string, body?: unknown, headers: Record<string, string> = {}, origin = "http://instance.test") {
  return socketRequest(new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: {
    ...(body === undefined ? {} : { "content-type": "application/json", origin }), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
const cookie = (secret: string) => `${SESSION_COOKIE}=${secret}`;
const first = () => createFirstAccount({ name: "Ada", email: "ada@example.test", password }, db);
const rows = () => db.prepare("SELECT * FROM auth_sessions ORDER BY id").all();

it("refuses a cross-site cookie sign-out before revoking or rolling the session", async () => {
  const signed = await first(); const before = rows();
  const response = await leave(request("/api/auth/sign-out", {}, { cookie: cookie(signed.secret), origin: "https://unrelated.test" }));
  expect.soft(response.status).toBe(403);
  expect(rows()).toEqual(before);
});
it("refuses a missing mutation Origin without changing the session", async () => {
  const signed = await first(); const before = rows();
  const input = request("/api/auth/sign-out", {}, { cookie: cookie(signed.secret) }); input.headers.delete("origin");
  expect.soft((await leave(input)).status).toBe(403);
  expect(rows()).toEqual(before);
});
it("refuses cross-site setup before creating an account even if an Authorization header is supplied", async () => {
  const response = await enter(request("/api/auth/setup", { name: "Ada", email: "ada@example.test", password },
    { origin: "https://unrelated.test", authorization: "Bearer not-a-credential" }), "setup");
  expect.soft(response.status).toBe(403);
  expect(accountCount(db)).toBe(0);
});
it("discards forged origin provenance before judging a cookie mutation", async () => {
  const signed = await first(); const before = rows();
  const response = await leave(request("/api/auth/sign-out", {}, { cookie: cookie(signed.secret), origin: "https://forged.test",
    "x-forwarded-host": "forged.test", "x-forwarded-proto": "https", "x-forwarded-port": "443", "x-dezfil-ingress": "forged" }));
  expect.soft(response.status).toBe(403); expect(rows()).toEqual(before);
});
it("exposes only entry metadata and removes the legacy prefill once setup exists", async () => {
  setSetting("display_name", "Legacy name", db); setSetting("instance_name", "Field atlas", db);
  setSetting("view_prefs", '{"maps":{"view":"list"}}', db);
  const before = await entryInformation(request("/api/auth/entry"));
  expect(before.headers.get("cache-control")).toBe("private, no-store");
  expect(await before.json()).toEqual({ externalSignIn: { enabled: false, doorUrl: null }, instanceName: "Field atlas", signInMessage: "", lostPasswordContact: "", landingPage: "home", passwordMin: 8, setupRequired: true, prefillName: "Legacy name" });
  const signed = await first();
  const after = await entryInformation(request("/api/auth/entry", undefined, { cookie: cookie(signed.secret) }));
  expect(await after.json()).toEqual({ externalSignIn: { enabled: false, doorUrl: null }, instanceName: "Field atlas", signInMessage: "", lostPasswordContact: "", landingPage: "home", passwordMin: 8, setupRequired: false });
});
it("names the shortest password the entry screens take: 8 for the first account, then the stored one", async () => {
  writeStoredSettings({ "security.passwordMin": 12 }, db);
  expect((await (await entryInformation(request("/api/auth/entry"))).json()).passwordMin).toBe(8);
  await first();
  expect((await (await entryInformation(request("/api/auth/entry"))).json()).passwordMin).toBe(12);
  writeStoredSettings({ "security.passwordMin": null }, db);
  expect((await (await entryInformation(request("/api/auth/entry"))).json()).passwordMin).toBe(8);
});
it.each(["http://instance.test", "https://instance.test"])("sets an HttpOnly SameSite cookie using trusted transport at %s", async origin => {
  const response = await enter(request("/api/auth/setup", { name: "Ada", email: "ada@example.test", password }, {}, origin), "setup");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const set = response.headers.get("set-cookie")!;
  expect(set).toMatch(/HttpOnly/i); expect(set).toMatch(/SameSite=lax/i); expect(set).toMatch(/Max-Age=2592000/i);
  expect(/; Secure/i.test(set)).toBe(origin.startsWith("https"));
  expect(JSON.stringify(await response.json())).not.toMatch(/password|hash|dz_session/);
});
it("gives the cookie the stored session length at entry, on a session read and through the gate", async () => {
  writeStoredSettings({ "security.sessionDays": "7" }, db);
  const entered = await enter(request("/api/auth/setup", { name: "Ada", email: "ada@example.test", password }), "setup");
  const set = entered.headers.get("set-cookie")!;
  expect(set).toMatch(/Max-Age=604800(;|$)/i);
  const session = set.split(";")[0];
  writeStoredSettings({ "security.sessionDays": "1" }, db);
  const current = await currentSession(request("/api/auth/session", undefined, { cookie: session }));
  expect(current.status).toBe(200);
  expect(current.headers.get("set-cookie")).toMatch(/Max-Age=86400(;|$)/i);
  const gated = gateRequest(request("/maps", undefined, { cookie: session }));
  expect(gated.headers.get("set-cookie")).toMatch(/Max-Age=86400(;|$)/i);
});
it("replaces another account's cookie on redemption and refuses replay without another write", async () => {
  const admin = await first();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Lin", email: "lin@example.test" }, db);
  const response = await enter(request("/api/auth/redeem", { secret: invitation.secret, password }, { cookie: cookie(admin.secret) }), "redeem");
  expect(response.status).toBe(200);
  const replacement = response.headers.get("set-cookie")!.split(";")[0];
  expect(replacement).not.toBe(cookie(admin.secret));
  const current = await currentSession(request("/api/auth/session", undefined, { cookie: replacement }));
  expect((await current.json()).account.id).toBe(invitation.account.id);
  const before = rows();
  const replay = await enter(request("/api/auth/redeem", { secret: invitation.secret, password: "different field notebooks" }, { cookie: replacement }), "redeem");
  expect(replay.status).toBe(401); expect(replay.headers.get("set-cookie")).toBeNull(); expect(rows()).toEqual(before);
});
it("ends the current session and refuses cookie replay, including forged identity headers", async () => {
  const signed = await first();
  const response = await leave(request("/api/auth/sign-out", {}, { cookie: cookie(signed.secret) }));
  expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  const replay = await currentSession(request("/api/auth/session", undefined, { cookie: cookie(signed.secret), "x-account-id": signed.account.id, "x-account-admin": "true" }));
  expect(replay.status).toBe(401); expect(replay.headers.get("cache-control")).toBe("private, no-store");
});
it("does not fall back from an invalid bearer to a valid cookie", async () => {
  const signed = await first();
  expect((await currentSession(request("/api/auth/session", undefined, { cookie: cookie(signed.secret), authorization: "Bearer invalid" }))).status).toBe(401);
});
it("accepts an explicit valid bearer without cookie-origin authority", async () => {
  const signed = await first(); const context = authenticateSession(signed.secret, db)!;
  const token = createApiToken(context, "CLI", db);
  signOut(context, db);
  const input = request("/api/auth/sign-out", {}, { authorization: `Bearer ${token.secret}`, cookie: cookie(signed.secret), origin: "https://unrelated.test" });
  expect((await leave(input)).status).toBe(200);
  expect((await currentSession(request("/api/auth/session", undefined, { authorization: `Bearer ${token.secret}` }))).status).toBe(200);
});
it("keeps unknown, wrong-password and deactivated wrong-password failures identical", async () => {
  const admin = await first(), context = authenticateSession(admin.secret, db)!;
  const invitation = inviteAccount(context, { name: "Lin", email: "lin@example.test" }, db);
  await enter(request("/api/auth/redeem", { secret: invitation.secret, password }), "redeem");
  changeAccountAccess(context, invitation.account.id, { status: "deactivated" }, db);
  const responses = [];
  for (const email of ["unknown@example.test", "ada@example.test", "lin@example.test"]) {
    const response = await enter(request("/api/auth/sign-in", { email, password: "incorrect" }), "sign-in");
    expect(response.status).toBe(401); responses.push(await response.json());
  }
  expect(responses[0]).toEqual(responses[1]); expect(responses[1]).toEqual(responses[2]);
  const valid = await enter(request("/api/auth/sign-in", { email: "lin@example.test", password }), "sign-in");
  expect(valid.status).toBe(403); expect((await valid.json()).error.code).toBe("account_deactivated");
});

it("cannot forge a clean source to escape an account limit after failures on the real socket source", async () => {
  await first();
  const before = rows();
  for (let index = 0; index < LOGIN_ACCOUNT_LIMIT; index++) {
    const failed = await enter(request("/api/auth/sign-in", { email: "ada@example.test", password: "incorrect" },
      { "x-forwarded-for": `192.0.2.${index + 1}`, "x-dezfil-ingress": "forged" }), "sign-in");
    expect(failed.status).toBe(401);
  }
  const response = await enter(request("/api/auth/sign-in", { email: "ada@example.test", password },
    { "x-forwarded-for": "198.51.100.1", forwarded: "for=198.51.100.1", "x-dezfil-ingress": "forged" }), "sign-in");
  expect(response.status).toBe(429);
  const body = await response.json();
  expect(body.error.code).toBe("rate_limited");
  expect(Number(response.headers.get("retry-after"))).toBe(body.error.retryAfter);
  expect(body.error.retryAfter).toBeGreaterThan(0);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(rows()).toEqual(before);
});
it.each(["setup", "sign-in", "redeem"] as const)("refuses oversized %s before credentials or accounts change", async mode => {
  const before = rows();
  const input = request(`/api/auth/${mode}`, { name: "Ada", email: "ada@example.test", password, secret: "unused" }, { "content-length": "65537" });
  const get = vi.spyOn(input, "body", "get");
  const response = await enter(input, mode);
  expect(response.status).toBe(413); expect((await response.json()).error.code).toBe("request_body_too_large");
  expect(get).not.toHaveBeenCalled(); expect(rows()).toEqual(before); expect(accountCount(db)).toBe(0);
});

it("serves stored General values anonymously and restores defaults after clearing", async () => {
  await first();
  writeStoredSettings({ signInMessage: " Welcome aboard ", lostPasswordContact: " Ask the steward ", landingPage: "sql" }, db);
  const response = await entryInformation(request("/api/auth/entry"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ externalSignIn: { enabled: false, doorUrl: null }, instanceName: null, setupRequired: false,
    signInMessage: "Welcome aboard", lostPasswordContact: "Ask the steward", landingPage: "sql", passwordMin: 8 });
  writeStoredSettings({ signInMessage: null, lostPasswordContact: null, landingPage: null }, db);
  expect(await (await entryInformation(request("/api/auth/entry"))).json()).toEqual({ externalSignIn: { enabled: false, doorUrl: null }, instanceName: null,
    setupRequired: false, signInMessage: "", lostPasswordContact: "", landingPage: "home", passwordMin: 8 });
});

it.each(["session", "account", "bookkeeping"])("a full store rolls back password sign-in at %s and issues no cookie", async target => {
  const signed = await first();
  const sessions = rows();
  const account = db.prepare("SELECT * FROM accounts").all();
  db.exec("CREATE TABLE refused_write (bytes BLOB)");
  const trigger = target === "session" ? "BEFORE INSERT ON auth_sessions"
    : target === "account" ? "BEFORE UPDATE ON accounts"
      : "BEFORE UPDATE ON auth_login_limits WHEN NEW.pending = 0 AND (SELECT count(*) FROM auth_sessions) > 1";
  db.exec(`CREATE TRIGGER refused_sign_in ${trigger} BEGIN INSERT INTO refused_write VALUES(zeroblob(1048576)); END;
    CREATE TRIGGER refused_renewal BEFORE UPDATE ON auth_sessions BEGIN INSERT INTO refused_write VALUES(zeroblob(1048576)); END;`);
  db.pragma(`max_page_count = ${db.pragma("page_count", { simple: true })}`);
  const response = await enter(request("/api/auth/sign-in", { email: "ada@example.test", password }), "sign-in");
  expect(response.status).toBe(507);
  expect((await response.json()).error.code).toBe("storage_exhausted");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(rows()).toEqual(sessions);
  expect(db.prepare("SELECT * FROM accounts").all()).toEqual(account);
  expect(authenticateSession(signed.secret, db)?.account.id).toBe(signed.account.id);
  expect(rows()).toEqual(sessions);
});

it("leaves a sign-in link unspent if its session cannot be written", async () => {
  const admin = await first();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Lin", email: "lin@example.test" }, db);
  const before = ["accounts", "auth_sessions", "auth_links", "auth_tokens"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  db.exec(`CREATE TABLE refused_write (bytes BLOB);
    CREATE TRIGGER refused_session BEFORE INSERT ON auth_sessions BEGIN INSERT INTO refused_write VALUES(zeroblob(1048576)); END;`);
  db.pragma(`max_page_count = ${db.pragma("page_count", { simple: true })}`);
  const response = await enter(request("/api/auth/redeem", { secret: invitation.secret, password }), "redeem");
  expect(response.status).toBe(507); expect((await response.json()).error.code).toBe("storage_exhausted");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(["accounts", "auth_sessions", "auth_links", "auth_tokens"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).toEqual(before);
});
