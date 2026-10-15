import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import * as metadata from "@/lib/metadata/db";
import { insertAccount, markOriginalAccount } from "@/lib/metadata/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { issueSession, secretHash } from "./credentials";
import { issueLink } from "./link-issuance.mjs";
import { recoverAdmin } from "./recovery.mjs";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./passwords";
import { createFirstAccount, signIn } from "./accounts";
import { withLoginLimit } from "./login-limits";
import { AuthError } from "./errors";
import { enter } from "./entry";
import { PATCH as profile } from "@/app/api/account/route";
import { POST as passwordChange } from "@/app/api/account/password/route";

const native = vi.hoisted(() => ({ calls: [] as { password: string; done: boolean; callback: (error: Error | null, key: Buffer) => void }[] }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(),
  scrypt: (password: string, _salt: Buffer, _length: number, _options: unknown, callback: (error: Error | null, key: Buffer) => void) => native.calls.push({ password, callback, done: false }),
}));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const now = 1_800_000_000_000, origin = "http://instance.test";
let db: Database, directory: string, cookie: string, extra: Database[];
let pending: Promise<unknown>[], controllers: AbortController[];
const track = <T>(p: Promise<T>) => { pending.push(p); p.catch(() => {}); return p; };
const control = () => { const value = new AbortController(); controllers.push(value); return value; };
const state = () => (process as unknown as Record<symbol, { active: number; activeProtected: number; ordinary: unknown[]; protected: unknown[] }>)[Symbol.for("dezfil.password-derivations")];
async function finish(index: number, error: Error | null = null) {
  const call = native.calls[index];
  if (call && !call.done) { call.done = true; call.callback(error, Buffer.alloc(32)); }
  await flush();
}
function rows(store = db) { return ["accounts", "auth_sessions", "auth_tokens", "auth_links"].map(table => store.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()); }
function budgets() { return db.prepare("SELECT failures, pending FROM auth_login_limits").all(); }
function req(url: string, body: unknown, abort: AbortController, source = "192.0.2.1", signed = false, method = "POST") {
  return socketRequest(new Request(origin + url, { method, signal: abort.signal, headers: { origin, "content-type": "application/json", ...(signed ? { cookie } : {}) }, body: JSON.stringify(body) }), source);
}
const login = (email = "person@example.test", source = "192.0.2.1", abort = control(), password = "correct") => track(enter(req("/api/auth/sign-in", { email, password }, abort, source), "sign-in"));
function holds(count: number) {
  return Array.from({ length: count }, () => { const abort = control(); return { abort, promise: track(verifyPassword("hold", DUMMY_PASSWORD_HASH, { signal: abort.signal })) }; });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); native.calls.length = 0; pending = []; controllers = []; extra = [];
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "credential-admission-"));
  db = metadata.open(path.join(directory, "metadata.sqlite")); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  const account = insertAccount({ id: "person", name: "Person", email: "person@example.test", passwordHash: DUMMY_PASSWORD_HASH, isAdmin: true, status: "active", now: new Date(now).toISOString() }, db);
  markOriginalAccount(account.id, db);
  insertAccount({ id: "recipient", name: "Recipient", email: "recipient@example.test", passwordHash: DUMMY_PASSWORD_HASH, isAdmin: false, status: "active", now: new Date(now).toISOString() }, db);
  cookie = `dezfil_session=${issueSession(account, db, now).secret}`;
});
afterEach(async () => {
  for (const abort of controllers) abort.abort(); await flush();
  for (let i = 0; i < native.calls.length; i++) await finish(i);
  await Promise.allSettled(pending); vi.restoreAllMocks(); vi.useRealTimers();
  for (const store of extra) store.close(); db.close(); rmSync(directory, { recursive: true, force: true });
});

const entries = ["setup", "known", "dummy", "link", "recovery", "profile", "password"] as const;
function entry(kind: typeof entries[number], abort: AbortController) {
  if (kind === "setup") return track(enter(req("/api/auth/setup", { name: "First", email: "first@example.test", password: "fresh field notebooks" }, abort), "setup"));
  if (kind === "known" || kind === "dummy") return login(kind === "known" ? "person@example.test" : "missing@example.test", "192.0.2.1", abort);
  if (kind === "profile") return track(profile(req("/api/account", { name: "Changed", email: "person@example.test", currentPassword: "correct" }, abort, "192.0.2.1", true, "PATCH")));
  if (kind === "password") return track(passwordChange(req("/api/account/password", { currentPassword: "correct", password: "new field notebooks" }, abort, "192.0.2.1", true)));
  const secret = kind === "recovery"
    ? new URLSearchParams(new URL(recoverAdmin({ dataDir: directory, origin }, now).url).hash.slice(1)).get("secret")!
    : db.transaction(() => issueLink("recipient", "reset", db, now)).immediate().secret;
  expect(native.calls.filter(call => call.password !== "hold")).toHaveLength(0); // Issuance does no password work.
  return track(enter(req("/api/auth/redeem", { secret, password: "new field notebooks" }, abort), "redeem"));
}

it.each(entries.flatMap(kind => ["queued", "running"].map(phase => ({ kind, phase }))))("cancels $phase $kind without credentials, link consumption or account writes", async ({ kind, phase }) => {
  let store = db;
  if (kind === "setup") { store = metadata.open(":memory:"); extra.push(store); vi.mocked(metadata.metadataDb).mockReturnValue(store); }
  if (phase === "queued") holds(2);
  const abort = control(), result = entry(kind, abort); await flush();
  const before = rows(store), nativeCount = native.calls.length;
  expect(nativeCount).toBe(phase === "queued" ? 2 : 1);
  abort.abort(); await flush();
  expect((await result).status).toBe(499);
  expect(rows(store)).toEqual(before);
  // Sign-in keeps the source's place after started work; a current-password
  // check keeps the account's; a queued departure keeps neither.
  expect(budgets()).toEqual(kind === "known" || kind === "dummy"
    ? [{ failures: 0, pending: 0 }, { failures: 0, pending: phase === "running" ? 1 : 0 }]
    : kind === "profile" || kind === "password" ? [{ failures: 0, pending: phase === "running" ? 1 : 0 }] : []);
  // Native cancellation never releases a running slot or admits extra work.
  expect(state().active).toBe(phase === "queued" ? 2 : 1);
  expect(state().ordinary).toHaveLength(0); expect(state().protected).toHaveLength(0);
  for (let i = 0; i < nativeCount; i++) await finish(i);
  expect(native.calls).toHaveLength(nativeCount); expect(rows(store)).toEqual(before);
});

it("retains protected classification for the second password derivation and cancels it before any write", async () => {
  const abort = control();
  const changed = entry("password", abort); await flush();
  const check = track(profile(req("/api/account", { email: "person@example.test", currentPassword: "other protected" }, control(), "192.0.2.2", true, "PATCH"))); await flush();
  expect(native.calls.map(call => call.password)).toEqual(["correct"]);
  await finish(0);
  expect(native.calls.map(call => call.password)).toEqual(["correct", "other protected"]);
  expect(state().activeProtected).toBe(1); expect(state().protected).toHaveLength(1);
  await finish(1); expect((await check).status).toBe(200);
  expect(native.calls.map(call => call.password)).toEqual(["correct", "other protected", "new field notebooks"]);
  expect(state().activeProtected).toBe(1);
  const before = rows(); abort.abort(); expect((await changed).status).toBe(499);
  await finish(2); expect(rows()).toEqual(before);
});

it.each(["overflow", "deadline"])("refunds known and dummy sign-in reservations on %s, then admits an immediate retry", async mode => {
  const blockers = holds(mode === "overflow" ? 8 : 2), before = rows();
  const attempts = [login(), login("missing@example.test", "192.0.2.2")]; await flush();
  if (mode === "deadline") await vi.advanceTimersByTimeAsync(5000);
  for (const promise of attempts) {
    const response = await promise;
    expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: { code: "authentication_busy", message: "Authentication is busy. Try again shortly.", retryAfter: 1 } });
  }
  expect(budgets()).toEqual(Array.from({ length: 4 }, () => ({ failures: 0, pending: 0 })));
  expect(rows()).toEqual(before);
  for (const blocker of blockers) blocker.abort.abort(); await finish(0); await finish(1);
  const retry = login(); await flush(); expect(native.calls).toHaveLength(3); await finish(2);
  expect((await retry).status).toBe(200); expect(budgets().every(row => (row as { pending: number }).pending === 0)).toBe(true);
});

it("holds a running aborted sign-in's native slot until settlement while charging only its source immediately", async () => {
  const abort = control(), first = login("person@example.test", "192.0.2.1", abort);
  const second = login("recipient@example.test", "192.0.2.2"), third = login("missing@example.test", "192.0.2.3"); await flush();
  expect(native.calls).toHaveLength(2); abort.abort(); expect((await first).status).toBe(499);
  expect(db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket IN (?, ?)").all(`account:${secretHash("person@example.test")}`, `source:${secretHash("192.0.2.1")}`)).toEqual([{ failures: 0, pending: 0 }, { failures: 0, pending: 1 }]);
  expect(native.calls).toHaveLength(2); await finish(0); expect(native.calls).toHaveLength(3);
  await finish(1); await finish(2); expect((await second).status).toBe(200); expect((await third).status).toBe(401);
  expect(db.prepare("SELECT count(*) n FROM auth_sessions WHERE account_id = 'person'").get()).toEqual({ n: 1 });
});

it("keeps a clean-source correct-password attempt's ordinary turn after the account failure budget is tripped", async () => {
  for (let i = 0; i < 5; i++) await withLoginLimit("person@example.test", `198.51.100.${i + 1}`, async () => { throw new AuthError("invalid_credentials", "Email or password is incorrect.", 401); }, db).catch(() => {});
  expect(db.prepare("SELECT failures FROM auth_login_limits WHERE bucket = ?").get(`account:${secretHash("person@example.test")}`)).toEqual({ failures: 5 });
  const predecessors = [track(hashPassword("first field notebook")), track(hashPassword("second field notebook"))];
  const clean = login("person@example.test", "192.0.2.10", control(), "clean correct"), later = login("missing@example.test", "192.0.2.11", control(), "later ordinary"); await flush();
  const secret = db.transaction(() => issueLink("recipient", "reset", db, now)).immediate().secret;
  const protectedWork = track(enter(req("/api/auth/redeem", { secret, password: "protected notebook" }, control()), "redeem")); await flush();
  await finish(0); expect(native.calls[2].password).toBe("protected notebook");
  await finish(1); expect(native.calls[3].password).toBe("clean correct");
  expect(native.calls.some(call => call.password === "later ordinary")).toBe(false);
  await finish(3); expect((await clean).status).toBe(200);
  expect(native.calls[4].password).toBe("later ordinary");
  await finish(2); await finish(4); await Promise.all(predecessors); expect((await protectedWork).status).toBe(200); expect((await later).status).toBe(401);
  expect(budgets().every(row => (row as { pending: number }).pending === 0)).toBe(true);
});

it("admits a correct-password retry from a source that abandoned started work after the account budget was tripped", async () => {
  for (let i = 0; i < 5; i++) await withLoginLimit("person@example.test", `198.51.100.${i + 1}`, async () => { throw new AuthError("invalid_credentials", "Email or password is incorrect.", 401); }, db).catch(() => {});
  const accountKey = `account:${secretHash("person@example.test")}`, source = "192.0.2.10";
  const abort = control(), abandoned = login("person@example.test", source, abort);
  await flush(); expect(native.calls).toHaveLength(1);
  abort.abort(); expect((await abandoned).status).toBe(499);
  await finish(0);
  expect(db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket = ?").get(accountKey)).toEqual({ failures: 5, pending: 0 });
  const retry = login("person@example.test", source);
  await flush(); await finish(1);
  expect((await retry).status).toBe(200);
  expect(native.calls).toHaveLength(2);
  expect(db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket = ?").get(`source:${secretHash(source)}`)).toEqual({ failures: 0, pending: 1 });
  expect(db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket = ?").get(accountKey)).toEqual({ failures: 0, pending: 0 });
});

it("mixes setup, known and dummy sign-ins, validated links and signed-in checks under one native bound", async () => {
  const fresh = metadata.open(":memory:"); extra.push(fresh);
  const setup = track(createFirstAccount({ name: "First", email: "first@example.test", password: "setup notebook" }, fresh));
  const known = login(); await flush();
  const ordinary = Array.from({ length: 6 }, (_, i) => login(`missing${i}@example.test`, `192.0.2.${i + 10}`));
  const checked = track(profile(req("/api/account", { email: "person@example.test", currentPassword: "profile check" }, control(), "192.0.2.30", true, "PATCH")));
  const secret = db.transaction(() => issueLink("recipient", "reset", db, now)).immediate().secret;
  const redeemed = track(enter(req("/api/auth/redeem", { secret, password: "link notebook" }, control()), "redeem")); await flush();
  expect(native.calls).toHaveLength(2); expect(state().ordinary).toHaveLength(6); expect(state().protected).toHaveLength(2);
  const before = rows(); expect((await entry("password", control())).status).toBe(503); expect(rows()).toEqual(before);
  for (let i = 0; i < 10; i++) { await finish(i); expect(state().active).toBeLessThanOrEqual(2); expect(state().activeProtected).toBeLessThanOrEqual(1); }
  await setup; expect((await known).status).toBe(200); expect((await checked).status).toBe(200); expect((await redeemed).status).toBe(200);
  for (const promise of ordinary) expect((await promise).status).toBe(401);
  expect(native.calls).toHaveLength(10); expect(state().active).toBe(0);
});

it("refuses a timed-out second password derivation without changing the password or sessions", async () => {
  const changed = entry("password", control()); await flush();
  const checked = track(profile(req("/api/account", { email: "person@example.test", currentPassword: "protected blocker" }, control(), "192.0.2.2", true, "PATCH"))); await flush();
  await finish(0); const before = rows();
  expect(native.calls.map(call => call.password)).toEqual(["correct", "protected blocker"]);
  await vi.advanceTimersByTimeAsync(5000);
  expect((await changed).status).toBe(503); expect(rows()).toEqual(before);
  expect(native.calls).toHaveLength(2); await finish(1); expect((await checked).status).toBe(200);
});

it("validates links and current identity before admitting protected work", async () => {
  const blocked = [0, 1, 2].map(() => track(hashPassword("protected notebook", { class: "protected" })));
  const invalid = await enter(req("/api/auth/redeem", { secret: "invalid", password: "new field notebook" }, control()), "redeem");
  expect(invalid.status).toBe(401); expect((await invalid.json()).error.code).toBe("invalid_link");
  const anonymous = await profile(req("/api/account", { email: "changed@example.test", currentPassword: "correct" }, control(), "192.0.2.1", false, "PATCH"));
  expect(anonymous.status).toBe(401); expect(native.calls).toHaveLength(1);
  for (let i = 0; i < 3; i++) await finish(i); await Promise.all(blocked);
});

it("refunds a native sign-in failure without adding a login failure", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const before = rows(), failed = login(); await flush(); await finish(0, new Error("native failure"));
  expect((await failed).status).toBe(500); expect(rows()).toEqual(before);
  expect(budgets()).toEqual([{ failures: 0, pending: 0 }, { failures: 0, pending: 0 }]);
  expect(state().active).toBe(0);
});


it("cuts off repeated started cancellations from one source without charging any account", async () => {
  for (let wave = 0; wave < 10; wave++) {
    const size = Math.min(8, 20 - wave * 2);
    const aborts = Array.from({ length: size }, control);
    const attempts = aborts.map((abort, i) => login(`abandoned${wave}-${i}@example.test`, "192.0.2.1", abort));
    await flush();
    expect(native.calls).toHaveLength((wave + 1) * 2);
    expect(state().ordinary).toHaveLength(size - 2);
    for (const abort of aborts) abort.abort();
    for (const attempt of attempts) expect((await attempt).status).toBe(499);
    expect(db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket = ?").get(`source:${secretHash("192.0.2.1")}`)).toEqual({ failures: 0, pending: (wave + 1) * 2 });
    await finish(wave * 2); await finish(wave * 2 + 1, new Error("abandoned native failure"));
  }
  expect((await login("another@example.test")).status).toBe(429);
  expect(native.calls).toHaveLength(20);
  expect(db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket LIKE 'account:%'").all().every(row => (row as { failures: number; pending: number }).failures === 0 && (row as { pending: number }).pending === 0)).toBe(true);
  const clean = login("person@example.test", "192.0.2.2"); await flush(); await finish(20);
  expect((await clean).status).toBe(200);
});

it("charges only the source when cancellation follows native settlement but precedes sign-in completion", async () => {
  const abort = control(), attempt = login("person@example.test", "192.0.2.1", abort);
  await flush();
  native.calls[0].done = true; native.calls[0].callback(null, Buffer.alloc(32));
  await Promise.resolve();
  expect(state().active).toBe(0);
  abort.abort();
  expect((await attempt).status).toBe(499);
  expect(budgets()).toEqual([{ failures: 0, pending: 0 }, { failures: 0, pending: 1 }]);
});


it("refunds cancellation before an invalid stored hash can start native work", async () => {
  db.prepare("UPDATE accounts SET password_hash = 'invalid' WHERE id = 'person'").run();
  const abort = control();
  const attempt = track(withLoginLimit("person@example.test", "192.0.2.1", () => signIn("person@example.test", "correct", db, undefined, abort.signal), db));
  abort.abort();
  await expect(attempt).rejects.toMatchObject({ name: "AbortError" });
  expect(native.calls).toHaveLength(0);
  expect(budgets()).toEqual([{ failures: 0, pending: 0 }, { failures: 0, pending: 0 }]);
});
