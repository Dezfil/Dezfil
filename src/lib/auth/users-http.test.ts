import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { getAccount, listAccounts } from "@/lib/metadata/accounts";
import { GET as users, POST as invite } from "@/app/api/users/route";
import { PATCH as access } from "@/app/api/users/[id]/route";
import { POST as reset } from "@/app/api/users/[id]/sign-in-link/route";
import { POST as redeem } from "@/app/api/auth/redeem/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createFirstAccount, signIn } from "./accounts";
import { authenticateSession, authenticateToken, createApiToken, revokeApiToken, signOut } from "./credentials";
import { changeAccountAccess, inviteAccount } from "./admin";
import { redeemSignInLink } from "./links";
import { gateRequest } from "./gate";
const origin = "http://instance.test", password = "field notebooks at dawn";
let db: Database, admin: Awaited<ReturnType<typeof createFirstAccount>>, member: typeof admin;
let token: ReturnType<typeof createApiToken>;
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  admin = await createFirstAccount({ name: "Admin", email: "admin@example.test", password }, db);
  const link = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Member", email: "member@example.test" }, db);
  member = await redeemSignInLink(link.secret!, password, db);
  token = createApiToken(authenticateSession(member.secret, db)!, "Member CLI", db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const cookie = (secret = admin.secret) => ({ cookie: `dezfil_session=${secret}` });
function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = cookie()) {
  return new NextRequest(socketRequest(new Request(origin + path, { method,
    headers: { origin, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })));
}
const params = (id = member.account.id) => ({ params: Promise.resolve({ id }) });
const operations = ["list", "invite", "access", "reset"] as const;
function input(operation: typeof operations[number], headers: Record<string, string>) {
  if (operation === "list") return request("/api/users", "GET", undefined, headers);
  if (operation === "invite") return request("/api/users", "POST", { name: "Other", email: "other@example.test", isAdmin: true }, headers);
  if (operation === "access") return request(`/api/users/${member.account.id}`, "PATCH", { isAdmin: true }, headers);
  return request(`/api/users/${member.account.id}/sign-in-link`, "POST", undefined, headers);
}
function invoke(operation: typeof operations[number], req: Request) {
  if (operation === "list") return users(req);
  if (operation === "invite") return invite(req);
  if (operation === "access") return access(req, params());
  return reset(req, params());
}
function state() {
  return ["SELECT * FROM accounts ORDER BY id", "SELECT * FROM original_account", "SELECT * FROM auth_links ORDER BY id",
    "SELECT id, account_id, secret_hash, revoked_at FROM auth_sessions ORDER BY id",
    "SELECT id, account_id, name, secret_hash, revoked_at FROM auth_tokens ORDER BY id"].map(sql => db.prepare(sql).all());
}
async function refusal(response: Response, status: number, code: string, before: unknown) {
  expect.soft(response.status).toBe(status); expect.soft(response.headers.get("cache-control")).toBe("private, no-store");
  expect.soft(await response.json().catch(() => null)).toMatchObject({ error: { code } }); expect(state()).toEqual(before);
}
it.each(operations.flatMap(operation => ["anonymous", "invalid", "revoked-session", "revoked-token", "non-admin-cookie", "non-admin-token", "demoted-token"]
  .map(mode => ({ operation, mode }))))("refuses $mode admin $operation at gate and handler", async ({ operation, mode }) => {
  const headers: Record<string, string> = mode === "anonymous" ? {} : cookie();
  let status = 401;
  if (mode === "invalid") headers.authorization = "Bearer invalid";
  if (mode === "revoked-session") signOut(authenticateSession(admin.secret, db)!, db);
  if (mode === "revoked-token") {
    const context = authenticateSession(admin.secret, db)!, credential = createApiToken(context, "Revoked CLI", db);
    revokeApiToken(context, credential.id, db); headers.authorization = `Bearer ${credential.secret}`;
  }
  if (mode === "non-admin-cookie") { headers.cookie = cookie(member.secret).cookie; status = 403; }
  if (mode === "non-admin-token" || mode === "demoted-token") {
    headers.authorization = `Bearer ${token.secret}`; status = 403;
    if (mode === "demoted-token") {
      const context = authenticateSession(admin.secret, db)!;
      changeAccountAccess(context, member.account.id, { isAdmin: true }, db);
      expect(authenticateToken(token.secret, db)?.account.isAdmin).toBe(true);
      changeAccountAccess(context, member.account.id, { isAdmin: false }, db);
    }
  }
  const before = state();
  await refusal(gateRequest(input(operation, headers)), status, status === 401 ? "authentication_required" : "forbidden", before);
  await refusal(await invoke(operation, input(operation, headers)), status, status === 401 ? "authentication_required" : "forbidden", before);
});
it("redirects anonymous Users visits and refuses non-admin pages before dispatch", async () => {
  const response = gateRequest(request("/users", "GET", undefined, {}));
  expect(response.status).toBe(307); expect(response.headers.get("location")).toBe(origin + "/sign-in");
  await refusal(gateRequest(request("/users", "GET", undefined, cookie(member.secret))), 403, "forbidden", state());
  const allowed = gateRequest(request("/users"));
  expect(allowed.headers.get("x-middleware-next")).toBe("1"); expect(allowed.headers.get("cache-control")).toBe("private, no-store");
});
it.each(["invite", "access", "reset"] as const)("refuses cross-site admin %s without state changes", async operation => {
  const headers = { ...cookie(), origin: "https://unrelated.test" }, before = state();
  await refusal(gateRequest(input(operation, headers)), 403, "forbidden", before);
  await refusal(await invoke(operation, input(operation, headers)), 403, "forbidden", before);
});
it.each(["invited", "active", "deactivated"] as const)("reserves a normalized duplicate email for a %s account", async status => {
  const context = authenticateSession(admin.secret, db)!;
  const pending = inviteAccount(context, { name: "Pending", email: "pending@example.test" }, db);
  if (status !== "invited") await redeemSignInLink(pending.secret!, password, db);
  if (status === "deactivated") changeAccountAccess(context, pending.account.id, { status }, db);
  const before = state(), response = await invite(request("/api/users", "POST", { name: "Duplicate", email: " PENDING@EXAMPLE.TEST " }));
  expect(response.status).toBe(409); expect(state()).toEqual(before);
  expect(await response.json()).toMatchObject({ error: { code: "email_taken", ...(status === "deactivated" ? { accountId: pending.account.id, canReactivate: true } : {}) } });
  if (status === "deactivated") {
    const result = await access(request(`/api/users/${pending.account.id}`, "PATCH", { status: "active" }), params(pending.account.id));
    expect(result.status).toBe(200); expect((await result.json()).account.id).toBe(pending.account.id); expect(listAccounts(db)).toHaveLength(3);
  }
});
it.each([false, true].flatMap(other => [{ other, patch: { isAdmin: false } }, { other, patch: { status: "deactivated" } }]))("refuses self changes with another admin = $other", async ({ other, patch }) => {
  if (other) changeAccountAccess(authenticateSession(admin.secret, db)!, member.account.id, { isAdmin: true }, db);
  const before = state();
  await refusal(await access(request(`/api/users/${admin.account.id}`, "PATCH", patch), params(admin.account.id)), 409, "self_change_refused", before);
});
it.each([{ isAdmin: false, status: "invalid" }, { isAdmin: "yes" }, { name: "Changed" }, { status: "invited" }, {}])("refuses invalid access patch before any write: %j", async patch => {
  const before = state();
  await refusal(await access(request(`/api/users/${member.account.id}`, "PATCH", patch), params()), 400, "invalid_request", before);
});
it.each(["cookie", "bearer"])("lists safe account projections and issues a one-time invitation through %s", async kind => {
  const credential = createApiToken(authenticateSession(admin.secret, db)!, "Admin CLI", db);
  const headers = kind === "cookie" ? cookie() : { authorization: `Bearer ${credential.secret}` };
  const created = await invite(request("/api/users", "POST", { name: "Invited admin", email: " NEW@EXAMPLE.TEST ", isAdmin: true }, headers));
  expect(created.status).toBe(201); expect(created.headers.get("cache-control")).toBe("private, no-store");
  const issued = await created.json(), url = new URL(issued.signInUrl);
  expect(url.origin).toBe(origin); expect(url.pathname).toBe("/accept"); expect(url.search).toBe("");
  const secret = new URLSearchParams(url.hash.slice(1)).get("secret")!;
  expect(issued.account).toMatchObject({ status: "invited", email: "new@example.test", isAdmin: true, isOriginal: false });
  expect(new Date(issued.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.99 * 24 * 60 * 60 * 1000);
  const listed = await users(request("/api/users", "GET", undefined, headers));
  expect(listed.headers.get("cache-control")).toBe("private, no-store"); const list = await listed.json();
  expect(list.users).toHaveLength(3); expect(list.users.find((user: { isOriginal: boolean }) => user.isOriginal).id).toBe(admin.account.id);
  expect(JSON.stringify(list)).not.toMatch(/secret|password|hash|signInUrl/);
  const accepted = await redeem(request("/api/auth/redeem", "POST", { secret, password }));
  expect(accepted.status).toBe(200); expect((await accepted.json()).account.id).toBe(issued.account.id);
  expect(accepted.headers.get("set-cookie")).not.toContain(admin.secret);
  const before = state(); await refusal(await redeem(request("/api/auth/redeem", "POST", { secret, password: "changed field notebooks" })), 401, "invalid_link", before);
});
it("reset replaces links, invalidates password and sessions, keeps tokens, and refuses expired/reused links", async () => {
  const response = await reset(request(`/api/users/${member.account.id}/sign-in-link`, "POST"), params());
  expect(response.status).toBe(200); const first = await response.json();
  const secretOf = (value: { signInUrl: string }) => new URLSearchParams(new URL(value.signInUrl).hash.slice(1)).get("secret")!;
  expect(authenticateSession(member.secret, db)).toBeNull(); expect(authenticateToken(token.secret, db)).not.toBeNull();
  await expect(signIn(member.account.email, password, db)).rejects.toMatchObject({ code: "invalid_credentials" });
  const newer = await (await reset(request(`/api/users/${member.account.id}/sign-in-link`, "POST"), params())).json();
  const before = state();
  await refusal(await redeem(request("/api/auth/redeem", "POST", { secret: secretOf(first), password })), 401, "invalid_link", before);
  db.prepare("UPDATE auth_links SET expires_at = ? WHERE account_id = ?").run(Date.now() - 1, member.account.id);
  await refusal(await redeem(request("/api/auth/redeem", "POST", { secret: secretOf(newer), password })), 401, "invalid_link", state());
  const fresh = await (await reset(request(`/api/users/${member.account.id}/sign-in-link`, "POST"), params())).json();
  await refusal(await redeem(request("/api/auth/redeem", "POST", { secret: secretOf(fresh), password: "12345678" })), 400, "weak_password", state());
  const accepted = await redeem(request("/api/auth/redeem", "POST", { secret: secretOf(fresh), password: "marigold" }));
  expect(accepted.status).toBe(200); expect((await accepted.json()).account.id).toBe(member.account.id);
  await refusal(await redeem(request("/api/auth/redeem", "POST", { secret: secretOf(fresh), password })), 401, "invalid_link", state());
});
it("serializes competing demotions and keeps an active admin and the original marker", async () => {
  changeAccountAccess(authenticateSession(admin.secret, db)!, member.account.id, { isAdmin: true }, db);
  const responses = await Promise.all([
    access(request(`/api/users/${member.account.id}`, "PATCH", { isAdmin: false }), params()),
    access(request(`/api/users/${admin.account.id}`, "PATCH", { isAdmin: false }, cookie(member.secret)), params(admin.account.id)),
  ]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 403]);
  expect(listAccounts(db).filter(account => account.isAdmin && account.status === "active")).toHaveLength(1);
  expect(getAccount(admin.account.id, db)?.isOriginal).toBe(true);
});
it("deactivation and reactivation preserve identity and token eligibility without reviving sessions", async () => {
  const revoked = await access(request(`/api/users/${member.account.id}`, "PATCH", { status: "deactivated" }), params());
  expect(revoked.status).toBe(200); expect(authenticateSession(member.secret, db)).toBeNull(); expect(authenticateToken(token.secret, db)).toBeNull();
  const restored = await access(request(`/api/users/${member.account.id}`, "PATCH", { status: "active" }), params());
  expect(restored.status).toBe(200); expect(authenticateSession(member.secret, db)).toBeNull(); expect(authenticateToken(token.secret, db)?.account.id).toBe(member.account.id);
  expect(listAccounts(db)).toHaveLength(2);
});
it.each([{ name: "New", email: "new@example.test", isAdmin: "yes" }, { name: "New", email: "new@example.test", status: "active" },
  { name: "New", email: "bad" }, { name: "", email: "new@example.test" }, {}])("refuses malformed invitations without account or link writes: %j", async body => {
  const before = state(); await refusal(await invite(request("/api/users", "POST", body)), 400, "invalid_request", before);
});
it("does not let a stale admin check survive demotion during body parsing", async () => {
  changeAccountAccess(authenticateSession(admin.secret, db)!, member.account.id, { isAdmin: true }, db);
  const req = request("/api/users", "POST", { name: "New", email: "new@example.test" });
  const stream = req.body;
  vi.spyOn(req, "body", "get").mockImplementation(() => {
    changeAccountAccess(authenticateSession(member.secret, db)!, admin.account.id, { isAdmin: false }, db);
    return stream;
  });
  const response = await invite(req); expect(response.status).toBe(403);
  expect(listAccounts(db)).toHaveLength(2); expect(db.prepare("SELECT count(*) AS count FROM auth_links").get()).toEqual({ count: 1 });
});
it.each(["access", "reset"])("refuses unknown account %s without writes", async operation => {
  const before = state();
  const response = operation === "access" ? await access(request("/api/users/missing", "PATCH", { isAdmin: true }), params("missing"))
    : await reset(request("/api/users/missing/sign-in-link", "POST"), params("missing"));
  await refusal(response, 404, "not_found", before);
});
it.each(["invite", "access"] as const)("refuses oversized %s before a user or link change", async operation => {
  const before = state(), req = input(operation, cookie()); req.headers.set("content-length", "65537");
  const get = vi.spyOn(req, "body", "get");
  await refusal(await invoke(operation, req), 413, "request_body_too_large", before);
  expect(get).not.toHaveBeenCalled();
});
