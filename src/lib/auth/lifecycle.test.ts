import type { Database } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { accountPasswordHash, listAccounts } from "@/lib/metadata/accounts";
import { createFirstAccount, signIn, changeOwnPassword, updateOwnProfile } from "./accounts";
import { changeAccountAccess, inviteAccount, issueSignInLink } from "./admin";
import { authenticateSession, authenticateToken, createApiToken, listApiTokens, revokeApiToken,
  requireCurrentActor, secretHash, signOut, type AuthContext } from "./credentials";
import { redeemSignInLink } from "./links";
import { hashPassword, verifyPassword } from "./passwords";

const password = "river otter telescope";
const changedPassword = "paper cranes at sunrise";
const start = Date.parse("2026-01-01T00:00:00Z");
// The stored session length's default, as a fixture.
const SESSION_LIFETIME_MS = 30 * 86_400_000;
let directory: string, file: string, db: Database, admin: AuthContext;
beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "dezfil-auth-"));
  file = path.join(directory, "metadata.sqlite");
  db = open(file);
  const created = await createFirstAccount({ name: "Ada", email: "ada@example.test", password }, db, start);
  admin = authenticateSession(created.secret, db, start)!;
});
afterEach(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
async function member(email = "lin@example.test") {
  const invited = inviteAccount(admin, { name: "Lin", email }, db, start);
  const entered = await redeemSignInLink(invited.secret, password, db, start);
  return { ...entered, context: authenticateSession(entered.secret, db, start)! };
}
function snapshot() {
  return ["accounts", "original_account", "auth_sessions", "auth_tokens", "auth_links", "account_preferences"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}
async function refusedWithoutChange(action: () => unknown, code: string) {
  const before = snapshot();
  await expect(Promise.resolve().then(action)).rejects.toMatchObject({ code });
  expect(snapshot()).toEqual(before);
}

describe("credential storage and current identity", () => {
  it.each(["revoked-token", "deactivated-token", "deactivated-password", "forged-subject"])("refuses %s independently", async scenario => {
    const user = await member();
    const token = createApiToken(user.context, "Terminal", db, start);
    if (scenario === "forged-subject") {
      await refusedWithoutChange(() => createApiToken({ ...user.context, account: admin.account }, "Forged", db, start), "authentication_required");
    } else if (scenario === "deactivated-password") {
      changeAccountAccess(admin, user.account.id, { status: "deactivated" }, db, start);
      await refusedWithoutChange(() => signIn(user.account.email, "wrong password", db, start), "invalid_credentials");
    } else {
      if (scenario === "revoked-token") revokeApiToken(user.context, token.id, db, start);
      else changeAccountAccess(admin, user.account.id, { status: "deactivated" }, db, start);
      const before = snapshot();
      expect(authenticateToken(token.secret, db, start)).toBeNull();
      expect(snapshot()).toEqual(before);
    }
  });
  it("salts slow password hashes, accepts the exact password and keeps credential secrets out of storage and reads", async () => {
    const firstHash = accountPasswordHash(admin.account.id, db)!;
    expect(firstHash).toMatch(/^scrypt\$/);
    expect(firstHash).not.toContain(password);
    expect(await verifyPassword(password, firstHash)).toBe(true);
    expect(await verifyPassword(changedPassword, firstHash)).toBe(false);
    expect(await hashPassword(password)).not.toBe(firstHash);
    const token = createApiToken(admin, "Terminal", db, start);
    const link = inviteAccount(admin, { name: "Grace", email: "grace@example.test" }, db, start);
    const stored = JSON.stringify(snapshot());
    expect(stored).not.toContain(token.secret);
    expect(stored).not.toContain(link.secret);
    expect(stored).not.toContain(password);
    expect(JSON.stringify(listAccounts(db))).not.toMatch(/password|hash|secret/i);
    expect(JSON.stringify(listApiTokens(admin, db, start))).not.toMatch(/hash|secret/i);
    expect(stored).toContain(secretHash(token.secret));
  });

  it("refuses anonymous and invalid credentials without changing records", async () => {
    await refusedWithoutChange(() => requireCurrentActor(null, db, start), "authentication_required");
    const before = snapshot();
    expect(authenticateSession(null, db, start)).toBeNull();
    expect(authenticateSession("invalid", db, start)).toBeNull();
    expect(authenticateToken(null, db, start)).toBeNull();
    expect(authenticateToken("invalid", db, start)).toBeNull();
    expect(snapshot()).toEqual(before);
  });

  it("uses the same failure for wrong passwords, unknown emails and deactivated accounts with wrong passwords", async () => {
    const user = await member();
    const wrong = () => signIn(user.account.email, "wrong password", db, start);
    await refusedWithoutChange(wrong, "invalid_credentials");
    const failure = await wrong().catch(error => ({ code: error.code, message: error.message, status: error.status }));
    expect(await signIn("unknown@example.test", password, db, start).catch(error =>
      ({ code: error.code, message: error.message, status: error.status }))).toEqual(failure);
    changeAccountAccess(admin, user.account.id, { status: "deactivated" }, db, start);
    expect(await wrong().catch(error => ({ code: error.code, message: error.message, status: error.status }))).toEqual(failure);
    await refusedWithoutChange(() => signIn(user.account.email, password, db, start), "account_deactivated");
  });

  it("rolls a session for thirty days, with no shorter idle expiry, and refuses expiry without renewal", async () => {
    const entered = await signIn(admin.account.email, password, db, start);
    const nearExpiry = start + SESSION_LIFETIME_MS - 1;
    expect(authenticateSession(entered.secret, db, nearExpiry)?.account.id).toBe(admin.account.id);
    expect(authenticateSession(entered.secret, db, nearExpiry + SESSION_LIFETIME_MS - 1)).not.toBeNull();
    const expired = await signIn(admin.account.email, password, db, start);
    const before = snapshot();
    expect(authenticateSession(expired.secret, db, start + SESSION_LIFETIME_MS)).toBeNull();
    expect(snapshot()).toEqual(before);
  });

  it("survives reopen but never revives signed-out sessions or revoked tokens", async () => {
    const entered = await signIn(admin.account.email, password, db, start);
    const valid = createApiToken(admin, "Keep", db, start);
    const revoked = createApiToken(admin, "Revoke", db, start);
    const ended = await signIn(admin.account.email, password, db, start);
    signOut(authenticateSession(ended.secret, db, start)!, db, start);
    revokeApiToken(admin, revoked.id, db, start);
    db.close(); db = open(file);
    expect(authenticateSession(entered.secret, db, start + 1)?.account.id).toBe(admin.account.id);
    expect(authenticateToken(valid.secret, db, start + 1)?.account.id).toBe(admin.account.id);
    const before = snapshot();
    expect(authenticateSession(ended.secret, db, start + 1)).toBeNull();
    expect(authenticateToken(revoked.secret, db, start + 1)).toBeNull();
    expect(snapshot()).toEqual(before);
  });

  it("rechecks the credential and subject when an earlier context reaches a mutation", async () => {
    const token = createApiToken(admin, "Disposable", db, start);
    const context = authenticateToken(token.secret, db, start)!;
    revokeApiToken(admin, token.id, db, start);
    await refusedWithoutChange(() => createApiToken(context, "Too late", db, start), "authentication_required");
    const user = await member();
    await refusedWithoutChange(() => createApiToken({ ...user.context, account: admin.account }, "Forged subject", db, start), "authentication_required");
  });
});

describe("password rules and own-account changes", () => {
  it("serializes competing password changes and rejects the stale verification", async () => {
    const results = await Promise.allSettled([
      changeOwnPassword(admin, password, changedPassword, db, start),
      changeOwnPassword(admin, password, "a different long phrase", db, start),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "current_password_required" } });
  });
  it.each(["setup", "invite", "reset", "change"].flatMap(entry =>
    ["short", "password", "12345678", "PASSWORD", "qwerty123", "password1"].map(weak => ({ entry, weak }))))(
    "refuses $weak at $entry without changing stored state", async ({ entry, weak }) => {
      if (entry === "setup") {
        const fresh = open(":memory:");
        try {
          await expect(createFirstAccount({ name: "First", email: "first@example.test", password: weak }, fresh, start))
            .rejects.toMatchObject({ code: "weak_password" });
          expect(listAccounts(fresh)).toEqual([]);
        } finally { fresh.close(); }
      } else if (entry === "change") {
        await refusedWithoutChange(() => changeOwnPassword(admin, password, weak, db, start), "weak_password");
      } else {
        const link = entry === "invite"
          ? inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start)
          : issueSignInLink(admin, (await member()).account.id, db, start);
        await refusedWithoutChange(() => redeemSignInLink(link.secret, weak, db, start), "weak_password");
      }
    });

  it.each(["password", "email-missing-password", "email-wrong-password"])("requires the current password for %s", async operation => {
    const action = () => operation === "password"
      ? changeOwnPassword(admin, "incorrect", changedPassword, db, start)
      : updateOwnProfile(admin, { name: "Changed", email: "other@example.test",
        ...(operation === "email-wrong-password" ? { currentPassword: "incorrect" } : {}) }, db, start);
    await refusedWithoutChange(action, "current_password_required");
  });

  it("accepts eight characters without imposing character classes", async () => {
    const invited = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    const entered = await redeemSignInLink(invited.secret, "marigold", db, start);
    expect((await signIn(entered.account.email, "marigold", db, start)).account.id).toBe(entered.account.id);
  });

  it("changes the name independently and replaces the login email after password verification", async () => {
    expect((await updateOwnProfile(admin, { name: "Ada Lovelace" }, db, start)).name).toBe("Ada Lovelace");
    await updateOwnProfile(admin, { email: " NEW@Example.Test ", currentPassword: password }, db, start);
    await refusedWithoutChange(() => signIn("ada@example.test", password, db, start), "invalid_credentials");
    expect((await signIn("new@example.test", password, db, start)).account.id).toBe(admin.account.id);
  });

  it("preserves the current session on own password change, ends the others and retains tokens", async () => {
    const user = await member();
    const other = await signIn(user.account.email, password, db, start);
    const token = createApiToken(user.context, "CLI", db, start);
    await changeOwnPassword(user.context, password, changedPassword, db, start);
    expect(authenticateSession(user.secret, db, start)).not.toBeNull();
    expect(authenticateSession(other.secret, db, start)).toBeNull();
    expect(authenticateToken(token.secret, db, start)).not.toBeNull();
    await refusedWithoutChange(() => signIn(user.account.email, password, db, start), "invalid_credentials");
    expect((await signIn(user.account.email, changedPassword, db, start)).account.id).toBe(user.account.id);
  });

  it("cannot list or revoke another account's tokens", async () => {
    const user = await member();
    const token = createApiToken(admin, "Admin CLI", db, start);
    expect(listApiTokens(user.context, db, start)).toEqual([]);
    await refusedWithoutChange(() => revokeApiToken(user.context, token.id, db, start), "not_found");
    expect(authenticateToken(token.secret, db, start)?.account.id).toBe(admin.account.id);
  });
});
