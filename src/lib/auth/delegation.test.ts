import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken, listApiTokens, requireCurrentActor, signOut } from "./credentials";
import { delegateSession, authenticateDelegation, DELEGATION_LIFETIME_MS } from "./delegation";
import { instanceFetch, loopbackCredential } from "./instance-fetch";
import { requireRequestAuth } from "./http";
import { socketRequest } from "@/lib/assistant/testing/socket-request";

let db: Database, session: Awaited<ReturnType<typeof createFirstAccount>>;
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  session = await createFirstAccount({ name: "Caller", email: "caller@example.test", password: "field notebooks at dawn" }, db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const actor = () => authenticateSession(session.secret, db)!;
it("issues a short-lived bearer bound to the session without a durable credential", () => {
  const context = actor(), before = listApiTokens(context, db), now = Date.now();
  const secret = delegateSession(context, db, now);
  expect(secret).not.toContain(session.secret);
  expect(authenticateDelegation(secret, db, now)).toMatchObject({ account: { id: session.account.id }, credential: context.credential, delegationExpiresAt: now + DELEGATION_LIFETIME_MS });
  expect(listApiTokens(context, db)).toEqual(before);
  expect(db.serialize().includes(Buffer.from(secret))).toBe(false);
  expect(authenticateDelegation(secret, db, now + DELEGATION_LIFETIME_MS)).toBeNull();
  expect(() => requireCurrentActor(authenticateDelegation(secret, db, now)!, db, now + DELEGATION_LIFETIME_MS)).toThrow("Sign in");
});
it("refuses tampered claims, signatures and malformed credentials", () => {
  const secret = delegateSession(actor(), db);
  const [payload, signature] = secret.slice("dz_delegation_".length).split(".");
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), accountId: "someone-else" })).toString("base64url");
  for (const bad of ["", "invalid", secret + ".extra", `dz_delegation_${changed}.${signature}`, secret.slice(0, -1) + (secret.endsWith("0") ? "1" : "0")]) {
    expect(authenticateDelegation(bad, db), bad.slice(0, 20)).toBeNull();
  }
});
it.each(["revoked", "expired", "deactivated"])("refuses a delegation whose parent is %s", mode => {
  const context = actor(), secret = delegateSession(context, db);
  if (mode === "revoked") signOut(context, db);
  if (mode === "expired") db.prepare("UPDATE auth_sessions SET expires_at = 0 WHERE id = ?").run(context.credential.id);
  if (mode === "deactivated") db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(context.account.id);
  expect(authenticateDelegation(secret, db)).toBeNull();
});
it("reads current roles and never extends a delegation's lifetime by delegating again", () => {
  const now = Date.now(), secret = delegateSession(actor(), db, now);
  db.prepare("UPDATE accounts SET is_admin = 0 WHERE id = ?").run(session.account.id);
  const delegated = authenticateDelegation(secret, db, now + 1)!;
  expect(delegated.account.isAdmin).toBe(false);
  const nested = delegateSession(delegated, db, now + 100);
  expect(authenticateDelegation(nested, db, now + DELEGATION_LIFETIME_MS)).toBeNull();
});
it("validates a bearer delegation at a real handler boundary without cookie-origin replay", () => {
  const context = actor(), secret = delegateSession(context, db);
  const request = socketRequest(new Request("http://127.0.0.1:3216/api/account", { method: "PATCH", headers: { authorization: `Bearer ${secret}` } }));
  expect(requireRequestAuth(request)).toMatchObject({ account: { id: context.account.id }, credential: context.credential });
});
it("shares the ephemeral signer across separately loaded server modules", async () => {
  const secret = delegateSession(actor(), db);
  vi.resetModules();
  const other = await import("./delegation");
  expect(other.authenticateDelegation(secret, db)?.account.id).toBe(session.account.id);
});
it("forwards a presented bearer and derives a delegation only for a cookie caller", () => {
  const context = actor(), token = createApiToken(context, "CLI", db);
  const request = socketRequest(new Request("http://127.0.0.1:3216/api/mcp", { method: "POST", headers: { authorization: `Bearer ${token.secret}` } }));
  expect(loopbackCredential(request, requireRequestAuth(request))).toBe(token.secret);
  const cookie = socketRequest(new Request("http://127.0.0.1:3216/api/assistant/messages", { method: "POST", headers: { origin: "http://127.0.0.1:3216", cookie: `dezfil_session=${session.secret}` } }));
  expect(authenticateDelegation(loopbackCredential(cookie, requireRequestAuth(cookie)), db)?.account.id).toBe(context.account.id);
});
it("overwrites untrusted authorization, omits cookies and rechecks before each dispatch", async () => {
  const context = actor(), secret = delegateSession(context, db);
  const transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const call = instanceFetch("http://127.0.0.1:3216", secret, transport);
  const input = new Request("http://127.0.0.1:3216/api/account", { headers: { cookie: "should-never-travel", authorization: "Bearer untrusted" } });
  expect((await call(input)).status).toBe(200);
  const init = transport.mock.calls[0][1] as RequestInit;
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${secret}`);
  expect(new Headers(init.headers).has("cookie")).toBe(false);
  expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "manual" });
  signOut(context, db);
  expect((await call(input)).status).toBe(401); expect(transport).toHaveBeenCalledTimes(1);
});
it("refuses other origins and URL credentials before sending anything", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const call = instanceFetch("http://127.0.0.1:3216", delegateSession(actor(), db), transport);
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
    const secret = delegateSession(actor(), db);
    await expect(instanceFetch(base, secret)(base + "/api/account")).rejects.toThrow("redirected");
    expect(captured).toEqual([`Bearer ${secret}`]); expect(leaked).toEqual([]);
  } finally {
    source.closeAllConnections(); trap.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => trap.close(() => resolve()))]);
  }
});
