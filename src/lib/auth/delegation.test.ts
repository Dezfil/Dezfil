import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { createFirstAccount } from "./accounts";
import { authenticateSession, authenticateToken, createApiToken, listApiTokens, requireCurrentActor, revokeApiToken, signOut } from "./credentials";
import { delegateCredential, authenticateDelegation, DELEGATION_LIFETIME_MS } from "./delegation";
import { instanceFetch } from "./instance-fetch";
import { requireRequestAuth } from "./http";
import { socketRequest } from "@/lib/assistant/testing/socket-request";

let db: Database, session: Awaited<ReturnType<typeof createFirstAccount>>;
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  session = await createFirstAccount({ name: "Caller", email: "caller@example.test", password: "field notebooks at dawn" }, db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const actor = () => authenticateSession(session.secret, db)!;
const parentActor = (kind: string) => kind === "session" ? actor() : authenticateToken(createApiToken(actor(), "CLI", db).secret, db)!;
it.each(["session", "token"])("issues a short-lived bearer bound to the %s without a durable credential", kind => {
  const context = parentActor(kind), before = listApiTokens(context, db), now = Date.now();
  const secret = delegateCredential(context, db, now);
  expect(secret).not.toContain(session.secret);
  expect(authenticateDelegation(secret, db, now)).toMatchObject({ account: { id: session.account.id }, credential: context.credential, delegationExpiresAt: now + DELEGATION_LIFETIME_MS });
  expect(listApiTokens(context, db)).toEqual(before);
  expect(db.serialize().includes(Buffer.from(secret))).toBe(false);
  expect(authenticateDelegation(secret, db, now + DELEGATION_LIFETIME_MS)).toBeNull();
  expect(() => requireCurrentActor(authenticateDelegation(secret, db, now)!, db, now + DELEGATION_LIFETIME_MS)).toThrow("Sign in");
});
it("refuses tampered claims, signatures and malformed credentials", () => {
  const secret = delegateCredential(actor(), db);
  const [payload, signature] = secret.slice("dz_delegation_".length).split(".");
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), accountId: "someone-else" })).toString("base64url");
  for (const bad of ["", "invalid", secret + ".extra", `dz_delegation_${changed}.${signature}`, secret.slice(0, -1) + (secret.endsWith("0") ? "1" : "0")]) {
    expect(authenticateDelegation(bad, db), bad.slice(0, 20)).toBeNull();
  }
});
it.each([
  { kind: "session", mode: "revoked" }, { kind: "token", mode: "revoked" },
  { kind: "session", mode: "expired" },
  { kind: "session", mode: "deactivated" }, { kind: "token", mode: "deactivated" },
])("refuses a delegation and a new mint whose $kind parent is $mode", ({ kind, mode }) => {
  const context = parentActor(kind), secret = delegateCredential(context, db);
  if (mode === "revoked") {
    if (kind === "session") signOut(context, db); else revokeApiToken(context, context.credential.id, db);
  }
  if (mode === "expired") db.prepare("UPDATE auth_sessions SET expires_at = 0 WHERE id = ?").run(context.credential.id);
  if (mode === "deactivated") db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(context.account.id);
  expect(authenticateDelegation(secret, db)).toBeNull();
  expect(() => delegateCredential(context, db)).toThrow("Sign in");
});
it.each(["session", "token"])("reads current roles and never extends a %s delegation's lifetime by delegating again", kind => {
  const now = Date.now(), secret = delegateCredential(parentActor(kind), db, now);
  db.prepare("UPDATE accounts SET is_admin = 0 WHERE id = ?").run(session.account.id);
  const delegated = authenticateDelegation(secret, db, now + 1)!;
  expect(delegated.account.isAdmin).toBe(false);
  const nested = delegateCredential(delegated, db, now + 100);
  expect(authenticateDelegation(nested, db, now + DELEGATION_LIFETIME_MS)).toBeNull();
  expect(() => delegateCredential(delegated, db, now + DELEGATION_LIFETIME_MS)).toThrow("Sign in");
});
it("validates a bearer delegation at a real handler boundary without cookie-origin replay", () => {
  const context = actor(), secret = delegateCredential(context, db);
  const request = socketRequest(new Request("http://127.0.0.1:3216/api/account", { method: "PATCH", headers: { authorization: `Bearer ${secret}` } }));
  expect(requireRequestAuth(request)).toMatchObject({ account: { id: context.account.id }, credential: context.credential });
});
it("shares the ephemeral signer across separately loaded server modules", async () => {
  const secret = delegateCredential(actor(), db);
  vi.resetModules();
  const other = await import("./delegation");
  expect(other.authenticateDelegation(secret, db)?.account.id).toBe(session.account.id);
});
it("does not update a token's last-used stamp for delegated reads", () => {
  const context = parentActor("token"), before = listApiTokens(context, db), now = Date.now();
  const secret = delegateCredential(context, db, now);
  expect(authenticateDelegation(secret, db, now + 1000)?.credential).toEqual(context.credential);
  expect(listApiTokens(context, db)).toEqual(before);
});
it("overwrites untrusted authorization, omits cookies and rechecks before each dispatch", async () => {
  const context = actor();
  const transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const call = instanceFetch("http://127.0.0.1:3216", context, transport);
  const input = new Request("http://127.0.0.1:3216/api/account", { headers: { cookie: "should-never-travel", authorization: "Bearer untrusted" } });
  expect((await call(input)).status).toBe(200);
  const init = transport.mock.calls[0][1] as RequestInit;
  expect(authenticateDelegation(new Headers(init.headers).get("authorization")!.slice(7), db)?.credential).toEqual(context.credential);
  expect(new Headers(init.headers).has("cookie")).toBe(false);
  expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "manual" });
  signOut(context, db);
  expect((await call(input)).status).toBe(401); expect(transport).toHaveBeenCalledTimes(1);
});
it("refuses other origins and URL credentials before sending anything", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const call = instanceFetch("http://127.0.0.1:3216", actor(), transport);
  for (const url of ["https://127.0.0.1:3216/api/account", "http://127.0.0.1:3217/api/account", "http://localhost:3216/api/account", "http://user:pass@127.0.0.1:3216/api/account"]) {
    await expect(call(url)).rejects.toThrow("outside this instance");
  }
  expect(transport).not.toHaveBeenCalled();
});
it("a real redirect cannot deliver the credential to a second HTTP origin", async () => {
  const captured: string[] = [], leaked: unknown[] = [];
  const trap = createServer((req, res) => { leaked.push(req.headers.authorization); res.end("unexpected"); });
  await new Promise<void>(resolve => trap.listen(0, "127.0.0.1", resolve));
  const destination = `http://127.0.0.1:${(trap.address() as AddressInfo).port}/private`;
  const source = createServer((req, res) => { captured.push(req.headers.authorization ?? ""); res.writeHead(307, { location: destination }); res.end(); });
  await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  try {
    const context = actor();
    await expect(instanceFetch(base, context)(base + "/api/account")).rejects.toThrow("redirected");
    expect(captured).toHaveLength(1);
    expect(authenticateDelegation(captured[0].slice(7), db)?.credential).toEqual(context.credential);
    expect(leaked).toEqual([]);
  } finally {
    source.closeAllConnections(); trap.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => trap.close(() => resolve()))]);
  }
});
