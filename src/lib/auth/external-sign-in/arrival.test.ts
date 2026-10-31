import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { externalFixture } from "../../../../test-support/external-sign-in";
import { arriveExternalSignIn } from "./arrival";
import { getAccountByEmail, insertAccount } from "@/lib/metadata/accounts";
import { authenticateSession, issueSession } from "../credentials";
import { writeStoredSettings } from "@/lib/settings/store";
let f: ReturnType<typeof externalFixture>;
beforeEach(() => { f = externalFixture(); }); afterEach(() => f.close());
const arrive = (value = f.ticket(), session?: string) => arriveExternalSignIn(f.request(value, session));
function account(id: string, status: "active" | "invited" | "deactivated" = "invited", identity: string | null = null) {
  const a = insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: "unchanged-password", isAdmin: false, status, now: new Date().toISOString() }, f.db);
  f.db.prepare("UPDATE accounts SET external_identity=? WHERE id=?").run(identity, id); return a;
}
it("accepts the owner, atomically creates one session and id, and clears the start", async () => {
  const ticket = f.ticket(), response = await arrive(ticket); expect(response.status).toBe(200);
  expect((await response.json()).account).toMatchObject({ name: "Owner", status: "active", isAdmin: true });
  expect(response.headers.get("set-cookie")).toContain("_start=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  expect(f.db.prepare("SELECT id FROM auth_ticket_ids").all()).toEqual([{ id: ticket.claims.jti }]);
  expect(f.db.prepare("SELECT * FROM auth_sessions").all()).toHaveLength(1);
  const repeated = await arrive(ticket); expect(repeated.status).toBe(401); expect(f.db.prepare("SELECT * FROM auth_sessions").all()).toHaveLength(1);
});
it("refuses other identities, including one holding the owner's email, without changing any account or credential", async () => {
  for (const email of ["unknown@example.test", "owner@example.test"]) {
    const before = f.snapshot(), response = await arrive(f.ticket({ sub: "other-id", email }));
    expect(response.status).toBe(403); expect((await response.json()).error.message).toBe(`There is no account for ${email} on this instance. Ask its admin for an invitation.`);
    expect(f.snapshot()).toEqual(before);
  }
});
it.each(["active", "invited"] as const)("binds an unbound %s account while preserving its admin-given name and password", async status => {
  account("member", status); const response = await arrive(f.ticket({ sub: "member-id", email: "member@example.test", name: "Different" }));
  expect(response.status).toBe(200); expect(getAccountByEmail("member@example.test", f.db)).toMatchObject({ name: "member", status: "active" });
  expect(f.db.prepare("SELECT external_identity,password_hash FROM accounts WHERE id='member'").get()).toEqual({ external_identity: "member-id", password_hash: "unchanged-password" });
});
it("follows a bound identity's verified email, but refuses email collisions and rebinding", async () => {
  account("member", "active", "member-id"); account("other", "active", "other-id");
  expect((await arrive(f.ticket({ sub: "member-id", email: "new@example.test" }))).status).toBe(200);
  expect(getAccountByEmail("new@example.test", f.db)?.id).toBe("member");
  for (const patch of [{ sub: "member-id", email: "other@example.test" }, { sub: "foreign-id", email: "new@example.test" }]) {
    const before = f.snapshot(); const response = await arrive(f.ticket(patch)); expect([403, 409]).toContain(response.status); expect(f.snapshot()).toEqual(before);
  }
});
it("refuses deactivated accounts without activating or binding them", async () => {
  account("inactive", "deactivated"); const before = f.snapshot();
  const response = await arrive(f.ticket({ sub: "inactive-id", email: "inactive@example.test" }));
  expect(response.status).toBe(403); expect((await response.json()).error.message).toBe("This account is deactivated. Contact an admin."); expect(f.snapshot()).toEqual(before);
});
it("refuses a signed-in browser before reading the body, renewing a session or charging the source", async () => {
  const member = account("member", "active"), signed = issueSession(member, f.db, Date.now());
  const input = f.request(f.ticket(), signed.secret), body = vi.spyOn(input, "body", "get");
  const before = f.snapshot(), budgets = f.db.prepare("SELECT * FROM auth_login_limits").all();
  const response = await arriveExternalSignIn(input); expect(response.status).toBe(409);
  expect((await response.json()).error.account.id).toBe(member.id); expect(body).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
  expect(f.db.prepare("SELECT * FROM auth_login_limits").all()).toEqual(budgets); expect(authenticateSession(signed.secret, f.db)?.account.id).toBe(member.id);
});
it("refuses a cross-origin signed-in browser without disclosing its account", async () => {
  const member = account("member", "active"), signed = issueSession(member, f.db, Date.now());
  const input = f.request(f.ticket(), signed.secret), body = vi.spyOn(input, "body", "get");
  input.headers.set("origin", "https://elsewhere.test");
  const before = f.snapshot(), budgets = f.db.prepare("SELECT * FROM auth_login_limits").all();
  const response = await arriveExternalSignIn(input);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: "forbidden", message: "This request must come from the same instance." } });
  expect(body).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
  expect(f.db.prepare("SELECT * FROM auth_login_limits").all()).toEqual(budgets);
});
it("commits only failure charges and reaches the address limit on fresh starts", async () => {
  writeStoredSettings({ "security.failedPerAddress": 10 }, f.db); const before = f.snapshot();
  for (let n = 0; n < 10; n++) expect((await arrive(f.ticket({ aud: "wrong" }))).status).toBe(401);
  const response = await arrive(); expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBeTruthy();
  expect(f.snapshot()).toEqual(before); expect(f.db.prepare("SELECT failures,pending FROM auth_login_limits").all()).toEqual([{ failures: 10, pending: 0 }]);
});
it("bounds declared and streamed request bodies before any identity change", async () => {
  const before = f.snapshot(), declared = f.request(); declared.headers.set("content-length", "8193"); const read = vi.spyOn(declared, "body", "get");
  expect((await arriveExternalSignIn(declared)).status).toBe(413); expect(read).not.toHaveBeenCalled();
  expect((await arriveExternalSignIn(f.request(f.ticket(), undefined, { ticket: "x".repeat(8193) }))).status).toBe(413); expect(f.snapshot()).toEqual(before);
});
it("rolls back account, budget, session and ticket id when a write after session insertion fails", async () => {
  const ticket = f.ticket(), before = f.snapshot(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
  f.db.exec("CREATE TRIGGER fail_ticket BEFORE INSERT ON auth_ticket_ids WHEN (SELECT count(*) FROM auth_sessions)=1 BEGIN SELECT RAISE(ABORT, 'injected after session'); END");
  expect((await arrive(ticket)).status).toBe(500); expect(f.snapshot()).toEqual(before); expect(f.db.prepare("SELECT * FROM auth_login_limits").all()).toEqual([]);
  log.mockRestore(); f.db.exec("DROP TRIGGER fail_ticket");
  expect((await arrive(ticket)).status).toBe(200);
});
it("two simultaneous presentations through separate connections yield exactly one session", async () => {
  const ticket = f.ticket(), other = f.connection();
  try {
    const responses = await Promise.all([arriveExternalSignIn(f.request(ticket), f.db), arriveExternalSignIn(f.request(ticket), other)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 401]); expect(f.db.prepare("SELECT * FROM auth_sessions").all()).toHaveLength(1);
  } finally { other.close(); }
});

it("uses the ticket name or email only for an owner without a configured name", async () => {
  const ticket = f.ticket({ name: undefined });
  expect((await arrive(ticket)).status).toBe(200);
  expect(getAccountByEmail("owner@example.test", f.db)?.name).toBe("owner@example.test");
});
it("keeps the configured owner name, including a name equal to the email", async () => {
  f.db.exec("UPDATE accounts SET name='owner@example.test'");
  expect((await arrive()).status).toBe(200);
  expect(getAccountByEmail("owner@example.test", f.db)?.name).toBe("owner@example.test");
});
it("a ticket from another browser changes no identity or credential", async () => {
  const ticket = f.ticket(), other = f.ticket(), before = f.snapshot();
  const response = await arrive({ ...ticket, cookie: other.cookie }); expect(response.status).toBe(401); expect(f.snapshot()).toEqual(before);
});
