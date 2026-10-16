import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { GET as preview } from "@/app/api/users/[id]/deletion-preview/route";
import { DELETE as remove } from "@/app/api/users/[id]/route";
import { GET as status } from "@/app/api/users/deletions/[id]/route";
import { POST as finish } from "@/app/api/users/deletions/[id]/finish/route";
import { GET as users } from "@/app/api/users/route";
import { authenticateSession, createApiToken, issueSession, type AuthContext } from "./credentials";
import { changeAccountAccess, inviteAccount } from "./admin";
import { admitAccountWork } from "./account-deletion-admission";
import { finishAccountDeletion } from "./account-deletion";
import * as compaction from "@/lib/metadata/account-compaction.mjs";
import { resetSecretKeyCache } from "@/lib/secrets";
const root = process.env.DEZFIL_DATA_DIR!, origin = "http://instance.test";
let directory: string, admin: AuthContext, cookie: string, token: string, memberCookie: string;
const params = (id = "target") => ({ params: Promise.resolve({ id }) });
function request(url: string, method = "GET", body?: unknown, headers: Record<string, string> = { cookie }) {
  return socketRequest(new Request(origin + url, { method, headers: { origin, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
beforeEach(() => {
  directory = mkdtempSync(path.join(root, "delete-http-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); resetSecretKeyCache();
  for (const id of ["target", "admin", "member"]) testAccountScope(undefined, id);
  const db = metadataDb(); db.exec("UPDATE accounts SET last_sign_in_at='time'; UPDATE accounts SET is_admin=1 WHERE id='admin'");
  const session = issueSession(getAccount("admin")!, db, Date.now()); cookie = `dezfil_session=${session.secret}`;
  admin = authenticateSession(session.secret)!; token = createApiToken(admin, "Admin proof").secret;
  memberCookie = `dezfil_session=${issueSession(getAccount("member")!, db, Date.now()).secret}`;
  changeAccountAccess(admin, "target", { status: "deactivated" });
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(); resetSecretKeyCache(); process.env.DEZFIL_DATA_DIR = root; rmSync(directory, { recursive: true, force: true }); });
async function error(response: Response, code: string, statusCode: number) {
  expect(response.status).toBe(statusCode); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ error: { code } });
}
const operations = [
  (headers: Record<string, string>) => preview(request("/api/users/target/deletion-preview", "GET", undefined, headers), params()),
  (headers: Record<string, string>) => remove(request("/api/users/target", "DELETE", {}, headers), params()),
  (headers: Record<string, string>) => status(request("/api/users/deletions/missing", "GET", undefined, headers), params("missing")),
  (headers: Record<string, string>) => finish(request("/api/users/deletions/missing/finish", "POST", undefined, headers), params("missing")),
];
it.each(["anonymous", "non-admin", "revoked-admin"])("refuses %s at every deletion handler before lookup", async mode => {
  const headers: Record<string, string> = mode === "anonymous" ? {} : { cookie: mode === "non-admin" ? memberCookie : cookie };
  if (mode === "revoked-admin") metadataDb().exec("UPDATE auth_sessions SET revoked_at=1 WHERE account_id='admin'");
  const before = readdirSync(directory, { recursive: true });
  for (const invoke of operations) await error(await invoke(headers), mode === "non-admin" ? "forbidden" : "authentication_required", mode === "non-admin" ? 403 : 401);
  expect(readdirSync(directory, { recursive: true })).toEqual(before);
});
it("preserves self precedence, active and absent refusals, body bounds and exact confirmation", async () => {
  await error(await preview(request("/api/users/admin/deletion-preview"), params("admin")), "self_change_refused", 409);
  await error(await remove(request("/api/users/admin", "DELETE", {}), params("admin")), "self_change_refused", 409);
  await error(await preview(request("/api/users/member/deletion-preview"), params("member")), "account_not_deactivated", 409);
  await error(await preview(request("/api/users/missing/deletion-preview"), params("missing")), "not_found", 404);
  const value = await (await preview(request("/api/users/target/deletion-preview"), params())).json();
  for (const body of [{}, { confirm: true, confirmation: value.confirmation }, { confirm: true, confirmation: value.confirmation, email: "TARGET@example.test" }, { ...value, confirm: true }]) {
    await error(await remove(request("/api/users/target", "DELETE", body), params()), "invalid_request", 400);
  }
  await error(await remove(request("/api/users/target", "DELETE", { email: "x".repeat(65_536) }), params()), "request_body_too_large", 413);
  await error(await remove(request("/api/users/target", "DELETE", { confirm: true, confirmation: "0".repeat(64), email: "target@example.test" }), params()), "deletion_changed", 409);
  await error(await remove(request("/api/users/target", "DELETE", {}, { cookie, origin: "https://elsewhere.test" }), params()), "forbidden", 403);
});
it.each(["session", "token"])("carries pending, retry, list recovery and completion through %s handlers", async road => {
  const headers: Record<string, string> = road === "session" ? { cookie } : { authorization: `Bearer ${token}` };
  const value = await (await preview(request("/api/users/target/deletion-preview", "GET", undefined, headers), params())).json();
  const lease = admitAccountWork(["target"]);
  const body = { confirm: true, confirmation: value.confirmation, email: value.account.email };
  const response = await remove(request("/api/users/target", "DELETE", body, headers), params());
  expect(response.status).toBe(202); const accepted = await response.json(); expect(accepted.state).toBe("pending");
  const lookup = () => status(request(`/api/users/deletions/${accepted.id}`, "GET", undefined, headers), params(accepted.id));
  // The status also says the read admitted before the deletion is still held.
  expect(await (await lookup()).json()).toEqual({ ...accepted, admittedReads: 1 });
  expect(await (await remove(request("/api/users/target", "DELETE", body, headers), params())).json()).toEqual(accepted);
  expect(await (await preview(request("/api/users/target/deletion-preview", "GET", undefined, headers), params())).json()).toEqual(accepted);
  expect(() => changeAccountAccess(admin, "target", { status: "active" })).toThrow(expect.objectContaining({ code: "deletion_in_progress" }));
  const fail = vi.spyOn(compaction, "compactMetadataStore").mockImplementation(() => { throw new Error("busy checkpoint"); });
  lease.release(); expect(await finishAccountDeletion(admin, accepted.id)).toEqual({ id: accepted.id, state: "needs-retry" });
  expect(await (await lookup()).json()).toEqual({ id: accepted.id, state: "needs-retry" });
  const listed = await (await users(request("/api/users", "GET", undefined, headers))).json();
  expect(listed.users.map((u: { id: string }) => u.id)).not.toContain("target");
  expect(listed.deletions).toEqual([{ id: accepted.id, state: "needs-retry", account: { id: "target", name: "target", email: "target@example.test", isAdmin: false } }]);
  expect(() => inviteAccount(admin, { name: "Reuse", email: "target@example.test" })).toThrow(expect.objectContaining({ code: "email_taken", extra: {} }));
  fail.mockRestore();
  const finished = await finish(request(`/api/users/deletions/${accepted.id}/finish`, "POST", undefined, headers), params(accepted.id));
  expect(finished.status).toBe(200); expect(await finished.json()).toEqual({ id: accepted.id, state: "completed" });
  await error(await lookup(), "not_found", 404);
  await error(await finish(request(`/api/users/deletions/${accepted.id}/finish`, "POST", undefined, headers), params(accepted.id)), "not_found", 404);
  expect((await (await users(request("/api/users"))).json()).deletions).toEqual([]);
  const reused = inviteAccount(admin, { name: "target", email: "target@example.test" }).account;
  expect(reused.sqlName).not.toBe("target"); expect(reused.id).not.toBe("target");
});
