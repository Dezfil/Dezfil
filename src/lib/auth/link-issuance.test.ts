import { afterEach, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { issueSession, authenticateSession, createApiToken, authenticateToken } from "./credentials";
import { issueSignInLink } from "./admin";
import { issueLink, revokeSignInCredentials, secretHash } from "./link-issuance.mjs";

const db = open(":memory:");
const now = Date.parse("2026-01-01T00:00:00Z");
afterEach(() => db.exec("DELETE FROM auth_links; DELETE FROM auth_sessions; DELETE FROM auth_tokens; DELETE FROM accounts"));
function account() {
  return insertAccount({ id: "admin", name: "Ada", email: "ada@example.test", passwordHash: "old hash",
    isAdmin: true, status: "active", now: new Date(now).toISOString() }, db);
}

it("parameterizes reset expiry and stores only the shared secret hash", () => {
  const user = account();
  const first = db.transaction(() => issueLink(user.id, "reset", db, now)).immediate();
  const next = db.transaction(() => issueLink(user.id, "reset", db, now + 1, 15 * 60_000)).immediate();
  expect(first.expiresAt).toBe(now + 7 * 24 * 60 * 60_000);
  expect(next.expiresAt).toBe(now + 1 + 15 * 60_000);
  expect(next.secret).toMatch(/^dz_link_[\w-]{43}$/);
  expect(db.prepare("SELECT * FROM auth_links WHERE secret_hash = ?").get(secretHash(next.secret)))
    .toMatchObject({ kind: "reset", revoked_at: null, expires_at: next.expiresAt });
  expect(db.prepare("SELECT revoked_at FROM auth_links WHERE secret_hash = ?").get(secretHash(first.secret)))
    .toEqual({ revoked_at: now + 1 });
  expect(JSON.stringify(db.prepare("SELECT * FROM auth_links").all())).not.toContain(next.secret);
});

it("keeps ordinary admin reset at seven days and retains API tokens", () => {
  const user = account();
  const session = issueSession(user, db, now);
  const actor = authenticateSession(session.secret, db, now)!;
  const token = createApiToken(actor, "Terminal", db, now);
  const link = issueSignInLink(actor, user.id, db, now);
  expect(link.expiresAt).toBe(now + 7 * 24 * 60 * 60_000);
  expect(link.account).toEqual(user);
  expect(authenticateSession(session.secret, db, now)).toBeNull();
  expect(authenticateToken(token.secret, db, now)?.account.id).toBe(user.id);
  expect(db.prepare("SELECT password_hash FROM accounts").get()).toEqual({ password_hash: null });
});

it("requires a caller transaction and rolls back revocations when insertion fails", () => {
  account();
  expect(() => issueLink("admin", "reset", db, now)).toThrow(/transaction/);
  expect(() => revokeSignInCredentials("admin", db, now)).toThrow(/transaction/);
  const before = db.prepare("SELECT * FROM accounts").all();
  db.exec("CREATE TRIGGER reject_link BEFORE INSERT ON auth_links BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  try {
    expect(() => db.transaction(() => {
      revokeSignInCredentials("admin", db, now, { revokeTokens: true });
      issueLink("admin", "reset", db, now);
    }).immediate()).toThrow("injected failure");
    expect(db.prepare("SELECT * FROM accounts").all()).toEqual(before);
  } finally { db.exec("DROP TRIGGER reject_link"); }
});
