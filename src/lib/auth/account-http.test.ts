import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as metadata from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { GET as profile, PATCH as updateProfile } from "@/app/api/account/route";
import { POST as passwordChange } from "@/app/api/account/password/route";
import { GET as tokens, POST as createToken } from "@/app/api/account/tokens/route";
import { DELETE as revokeToken } from "@/app/api/account/tokens/[id]/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createFirstAccount, signIn } from "./accounts";
import { authenticateSession, authenticateToken, createApiToken, revokeApiToken, signOut } from "./credentials";
import { changeAccountAccess, inviteAccount } from "./admin";
import { redeemSignInLink } from "./links";
import { gateRequest } from "./gate";

const password = "field notebooks at dawn", replacement = "paper cranes at sunrise";
const origin = "http://instance.test";
let db: Database, admin: Awaited<ReturnType<typeof createFirstAccount>>, member: typeof admin;
let ownToken: ReturnType<typeof createApiToken>, otherToken: typeof ownToken;
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  admin = await createFirstAccount({ name: "Admin", email: "admin@example.test", password }, db);
  const context = authenticateSession(admin.secret, db)!;
  const invitation = inviteAccount(context, { name: "Member", email: "member@example.test" }, db);
  member = await redeemSignInLink(invitation.secret, password, db);
  ownToken = createApiToken(authenticateSession(member.secret, db)!, "Member CLI", db);
  otherToken = createApiToken(context, "Admin CLI", db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(socketRequest(new Request(origin + path, { method,
    headers: { origin, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })));
}
const cookie = (secret = member.secret) => ({ cookie: `dezfil_session=${secret}` });
const operations = ["read-profile", "update-profile", "password", "list-tokens", "create-token", "revoke-token"] as const;
function input(operation: typeof operations[number], headers: Record<string, string>) {
  if (operation === "read-profile") return request("/api/account", "GET", undefined, headers);
  if (operation === "update-profile") return request("/api/account", "PATCH", { name: "Changed" }, headers);
  if (operation === "password") return request("/api/account/password", "POST", { currentPassword: password, password: replacement }, headers);
  if (operation === "list-tokens") return request("/api/account/tokens", "GET", undefined, headers);
  if (operation === "create-token") return request("/api/account/tokens", "POST", { name: "New CLI" }, headers);
  return request(`/api/account/tokens/${ownToken.id}`, "DELETE", undefined, headers);
}
function invoke(operation: typeof operations[number], req: Request) {
  if (operation === "read-profile") return profile(req);
  if (operation === "update-profile") return updateProfile(req);
  if (operation === "password") return passwordChange(req);
  if (operation === "list-tokens") return tokens(req);
  if (operation === "create-token") return createToken(req);
  return revokeToken(req, { params: Promise.resolve({ id: ownToken.id }) });
}
function state() {
  // Successful authentication may roll/use a credential; refusals cannot change
  // account state, token membership, password material or credential validity.
  return ["SELECT * FROM accounts ORDER BY id", "SELECT id, account_id, secret_hash, revoked_at FROM auth_sessions ORDER BY id",
    "SELECT id, account_id, name, secret_hash, revoked_at FROM auth_tokens ORDER BY id",
    "SELECT * FROM account_preferences ORDER BY account_id"].map(sql => db.prepare(sql).all());
}
async function refusal(response: Response, status: number, code: string, before: unknown) {
  expect.soft(response.status).toBe(status);
  expect.soft(response.headers.get("cache-control")).toBe("private, no-store");
  expect.soft(await response.json().catch(() => null)).toMatchObject({ error: { code } });
  expect(state()).toEqual(before);
}
it.each(operations.flatMap(operation => ["anonymous", "invalid", "revoked-session", "revoked-token", "deactivated", "invalid-bearer-with-cookie"]
  .map(mode => ({ operation, mode }))))("refuses $mode $operation at both gate and handler without writes", async ({ operation, mode }) => {
  const headers: Record<string, string> = mode === "anonymous" ? {} : cookie();
  if (mode === "invalid") headers.cookie = "dezfil_session=invalid";
  if (mode === "revoked-session") signOut(authenticateSession(member.secret, db)!, db);
  if (mode === "revoked-token") {
    revokeApiToken(authenticateSession(member.secret, db)!, ownToken.id, db);
    headers.authorization = `Bearer ${ownToken.secret}`;
  }
  if (mode === "deactivated") changeAccountAccess(authenticateSession(admin.secret, db)!, member.account.id, { status: "deactivated" }, db);
  if (mode === "invalid-bearer-with-cookie") headers.authorization = "Bearer invalid";
  const before = state();
  await refusal(gateRequest(input(operation, headers)), 401, "authentication_required", before);
  await refusal(await invoke(operation, input(operation, headers)), 401, "authentication_required", before);
});
it.each(operations.filter(operation => !["read-profile", "list-tokens"].includes(operation)))("refuses cross-site %s before any mutation", async operation => {
  const headers = { ...cookie(), origin: "https://unrelated.test" }, before = state();
  await refusal(gateRequest(input(operation, headers)), 403, "forbidden", before);
  await refusal(await invoke(operation, input(operation, headers)), 403, "forbidden", before);
});
it.each(["cookie", "bearer"])("supports own-profile and one-time token lifecycle through %s", async kind => {
  const headers = kind === "cookie" ? cookie() : { authorization: `Bearer ${ownToken.secret}` };
  const response = await profile(request("/api/account", "GET", undefined, { ...headers, "x-account-id": admin.account.id }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ account: getAccount(member.account.id, db) });
  const changed = await updateProfile(request("/api/account", "PATCH", { name: "My name" }, headers));
  expect(changed.status).toBe(200); expect((await changed.json()).account.name).toBe("My name");
  expect(getAccount(admin.account.id, db)?.name).toBe("Admin");
  const created = await createToken(request("/api/account/tokens", "POST", { name: " New CLI " }, headers));
  expect(created.status).toBe(201); expect(created.headers.get("cache-control")).toBe("private, no-store");
  const token = await created.json(); expect(token.name).toBe("New CLI"); expect(token.secret).toMatch(/^dz_token_/);
  expect(authenticateToken(token.secret, db)?.account.id).toBe(member.account.id);
  const list = await tokens(request("/api/account/tokens", "GET", undefined, headers));
  expect(list.headers.get("cache-control")).toBe("private, no-store");
  const rows = (await list.json()).tokens;
  expect(rows.map((row: { id: string }) => row.id).sort()).toEqual([ownToken.id, token.id].sort());
  expect(JSON.stringify(rows)).not.toMatch(/secret|hash|dz_token_/i);
  expect(JSON.stringify(db.prepare("SELECT * FROM auth_tokens").all())).not.toContain(token.secret);
  const deleted = await revokeToken(request(`/api/account/tokens/${token.id}`, "DELETE", undefined, headers), { params: Promise.resolve({ id: token.id }) });
  expect(deleted.status).toBe(200); expect(authenticateToken(token.secret, db)).toBeNull();
  expect((await profile(request("/api/account", "GET", undefined, { authorization: `Bearer ${token.secret}` }))).status).toBe(401);
});
it.each(["cookie", "bearer"])("cannot revoke another account's token through %s", async kind => {
  const headers = kind === "cookie" ? cookie() : { authorization: `Bearer ${ownToken.secret}` };
  const before = state();
  await refusal(await revokeToken(request(`/api/account/tokens/${otherToken.id}`, "DELETE", undefined, headers),
    { params: Promise.resolve({ id: otherToken.id }) }), 404, "not_found", before);
  expect(authenticateToken(otherToken.secret, db)?.account.id).toBe(admin.account.id);
});
it.each([
  { name: "Changed", accountId: "someone-else" }, { name: "Changed", isAdmin: true },
  { name: "Changed", status: "deactivated" }, { name: "" }, { name: "x".repeat(81) },
  { name: "Changed", email: 1 }, {},
])("rejects invalid or authority-bearing profile patches atomically: %j", async body => {
  const before = state();
  await refusal(await updateProfile(request("/api/account", "PATCH", body, cookie())), 400, "invalid_request", before);
});
it.each([undefined, "incorrect"])("requires the current password before changing email (%s)", async currentPassword => {
  const before = state();
  await refusal(await updateProfile(request("/api/account", "PATCH", { name: "Changed", email: "new@example.test", currentPassword }, cookie())),
    403, "current_password_required", before);
});
it("refuses duplicate email without saving another field, then replaces the sign-in email", async () => {
  const before = state();
  await refusal(await updateProfile(request("/api/account", "PATCH", { name: "Changed", email: " ADMIN@EXAMPLE.TEST ", currentPassword: password }, cookie())), 409, "email_taken", before);
  const changed = await updateProfile(request("/api/account", "PATCH", { email: " NEW@EXAMPLE.TEST ", currentPassword: password }, cookie()));
  expect(changed.status).toBe(200); expect((await changed.json()).account.email).toBe("new@example.test");
  await expect(signIn("member@example.test", password, db)).rejects.toMatchObject({ code: "invalid_credentials" });
  expect((await signIn("new@example.test", password, db)).account.id).toBe(member.account.id);
});
it.each(["short", "password", "12345678"])("refuses weak password %s without ending sessions or changing credentials", async weak => {
  const before = state();
  await refusal(await passwordChange(request("/api/account/password", "POST", { currentPassword: password, password: weak }, cookie())), 400, "weak_password", before);
});
it("refuses a wrong current password without changing credentials", async () => {
  const before = state();
  await refusal(await passwordChange(request("/api/account/password", "POST", { currentPassword: "wrong", password: replacement }, cookie())), 403, "current_password_required", before);
});
it.each(["cookie", "bearer"])("changes a password through %s with the correct session invalidation", async kind => {
  const other = await signIn(member.account.email, password, db);
  const headers = kind === "cookie" ? cookie() : { authorization: `Bearer ${ownToken.secret}` };
  const response = await passwordChange(request("/api/account/password", "POST", { currentPassword: password, password: replacement }, headers));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ changed: true });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(Boolean(authenticateSession(member.secret, db))).toBe(kind === "cookie");
  expect(authenticateSession(other.secret, db)).toBeNull();
  expect(authenticateToken(ownToken.secret, db)?.account.id).toBe(member.account.id);
  await expect(signIn(member.account.email, password, db)).rejects.toMatchObject({ code: "invalid_credentials" });
  expect((await signIn(member.account.email, replacement, db)).account.id).toBe(member.account.id);
});
it("rejects malformed token creation without adding a credential", async () => {
  for (const body of [{ name: "  " }, { name: "CLI", accountId: admin.account.id }, { name: 1 }, {}]) {
    const before = state();
    await refusal(await createToken(request("/api/account/tokens", "POST", body, cookie())), 400, "invalid_request", before);
  }
});
it.each(["update-profile", "password", "create-token"] as const)("refuses an oversized %s without account or credential changes", async operation => {
  const before = state(), req = input(operation, cookie());
  req.headers.set("content-length", "65537");
  const get = vi.spyOn(req, "body", "get");
  await refusal(await invoke(operation, req), 413, "request_body_too_large", before);
  expect(get).not.toHaveBeenCalled();
});
