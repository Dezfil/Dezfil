import type { Database } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { getAccount, listAccounts } from "@/lib/metadata/accounts";
import { createFirstAccount, signIn, updateOwnProfile } from "./accounts";
import { adminAccounts, changeAccountAccess, inviteAccount, issueSignInLink } from "./admin";
import { authenticateSession, authenticateToken, createApiToken, type AuthContext } from "./credentials";
import { redeemSignInLink } from "./links";

const password = "river otter telescope";
const newPassword = "paper cranes at sunrise";
const start = Date.parse("2026-01-01T00:00:00Z");
// The stored link lifetime's default, as a fixture.
const LINK_LIFETIME_MS = 7 * 86_400_000;
let directory: string, file: string, db: Database, admin: AuthContext;
beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "dezfil-safeguards-"));
  file = path.join(directory, "metadata.sqlite"); db = open(file);
  const first = await createFirstAccount({ name: "Ada", email: "ada@example.test", password }, db, start);
  admin = authenticateSession(first.secret, db, start)!;
});
afterEach(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
async function member() {
  const invited = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
  const entered = await redeemSignInLink(invited.secret!, password, db, start);
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

describe("first-account transaction", () => {
  it("refuses a second setup without creating another account or session", async () => {
    await refusedWithoutChange(() => createFirstAccount({ name: "Another", email: "other@example.test", password }, db, start), "setup_complete");
  });

  it("serializes competing first-account submissions on separate connections", async () => {
    const first = open(path.join(directory, "race.sqlite"));
    const second = open(path.join(directory, "race.sqlite"));
    try {
      const outcomes = await Promise.allSettled([first, second].map((connection, index) =>
        createFirstAccount({ name: `Person ${index}`, email: `person${index}@example.test`, password }, connection, start)));
      expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "setup_complete" } });
      expect(listAccounts(first)).toHaveLength(1);
      expect(listAccounts(first)[0]).toMatchObject({ isAdmin: true, isOriginal: true });
      expect(first.prepare("SELECT count(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
    } finally { first.close(); second.close(); }
  });

  it("rolls back every setup write on failure so setup remains retryable", async () => {
    const fresh = open(":memory:");
    try {
      fresh.exec("CREATE TRIGGER reject_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
      await expect(createFirstAccount({ name: "First", email: "first@example.test", password }, fresh, start)).rejects.toThrow("injected failure");
      expect(listAccounts(fresh)).toEqual([]);
      expect(fresh.prepare("SELECT * FROM original_account").all()).toEqual([]);
      fresh.exec("DROP TRIGGER reject_session");
      expect((await createFirstAccount({ name: "First", email: "first@example.test", password }, fresh, start)).account.isOriginal).toBe(true);
    } finally { fresh.close(); }
  });
});

describe("sign-in link lifecycle", () => {
  it("refuses a seven-day-expired link independently of replacement", async () => {
    const link = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    await refusedWithoutChange(() => redeemSignInLink(link.secret!, password, db, start + LINK_LIFETIME_MS), "invalid_link");
  });
  it("consumes a link once; replay cannot change the password or add a session", async () => {
    const link = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    const accepted = await redeemSignInLink(link.secret!, password, db, start);
    expect(accepted.account).toMatchObject({ id: link.account.id, status: "active", isAdmin: false });
    await refusedWithoutChange(() => redeemSignInLink(link.secret!, newPassword, db, start), "invalid_link");
    expect((await signIn(accepted.account.email, password, db, start)).account.id).toBe(accepted.account.id);
  });

  it("serializes competing redemption on separate connections", async () => {
    const link = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    const other = open(file);
    try {
      const results = await Promise.allSettled([db, other].map(connection => redeemSignInLink(link.secret!, password, connection, start)));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "invalid_link" } });
      expect(db.prepare("SELECT count(*) AS count FROM auth_sessions WHERE account_id = ?").get(link.account.id)).toEqual({ count: 1 });
    } finally { other.close(); }
  });

  it("refuses unknown, replaced and seven-day-expired links without account or session changes", async () => {
    await refusedWithoutChange(() => redeemSignInLink("unknown", password, db, start), "invalid_link");
    const old = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    const replacement = issueSignInLink(admin, old.account.id, db, start);
    await refusedWithoutChange(() => redeemSignInLink(old.secret!, password, db, start), "invalid_link");
    expect(replacement.expiresAt).toBe(start + LINK_LIFETIME_MS);
    await refusedWithoutChange(() => redeemSignInLink(replacement.secret, password, db, replacement.expiresAt), "invalid_link");
  });

  it("allows a link immediately before its expiry", async () => {
    const link = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    expect((await redeemSignInLink(link.secret!, password, db, link.expiresAt! - 1)).account.id).toBe(link.account.id);
  });

  it("ends sessions and invalidates the password at reset, retaining tokens and the same account", async () => {
    const user = await member();
    const token = createApiToken(user.context, "Terminal", db, start);
    const link = issueSignInLink(admin, user.account.id, db, start);
    expect(authenticateSession(user.secret, db, start)).toBeNull();
    expect(authenticateToken(token.secret, db, start)?.account.id).toBe(user.account.id);
    await refusedWithoutChange(() => signIn(user.account.email, password, db, start), "invalid_credentials");
    expect((await redeemSignInLink(link.secret, newPassword, db, start)).account.id).toBe(user.account.id);
    expect(listAccounts(db)).toHaveLength(2);
  });

  it("does not let a link reactivate a deactivated account", async () => {
    const link = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    changeAccountAccess(admin, link.account.id, { status: "deactivated" }, db, start);
    await refusedWithoutChange(() => redeemSignInLink(link.secret!, password, db, start), "invalid_link");
  });

  it("rolls back link consumption if session creation fails", async () => {
    const link = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, start);
    const before = snapshot();
    db.exec("CREATE TRIGGER reject_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await expect(redeemSignInLink(link.secret!, password, db, start)).rejects.toThrow("injected failure");
    expect(snapshot()).toEqual(before);
    db.exec("DROP TRIGGER reject_session");
    expect((await redeemSignInLink(link.secret!, password, db, start)).account.id).toBe(link.account.id);
  });
});

describe("administration boundaries", () => {
  it("rechecks a token's admin status instead of trusting its earlier account snapshot", async () => {
    const user = await member();
    changeAccountAccess(admin, user.account.id, { isAdmin: true }, db, start);
    const token = createApiToken(authenticateSession(user.secret, db, start)!, "Admin CLI", db, start);
    const earlier = authenticateToken(token.secret, db, start)!;
    changeAccountAccess(admin, user.account.id, { isAdmin: false }, db, start);
    await refusedWithoutChange(() => inviteAccount(earlier, { name: "Other", email: "other@example.test" }, db, start), "forbidden");
    expect(authenticateToken(token.secret, db, start)?.account.isAdmin).toBe(false);
  });

  it("refuses a sign-in whose password was reset while verification was running", async () => {
    const user = await member();
    const pending = signIn(user.account.email, password, db, start);
    issueSignInLink(admin, user.account.id, db, start);
    const before = snapshot();
    await expect(pending).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(snapshot()).toEqual(before);
  });
  it.each(["list", "invite", "reset", "role", "deactivate"].flatMap(operation => ["session", "token"].map(kind => ({ operation, kind }))))("refuses non-admin $operation through $kind", async ({ operation, kind }) => {
    const user = await member();
    const token = createApiToken(user.context, "Terminal", db, start);
    {
      const caller = kind === "session" ? user.context : authenticateToken(token.secret, db, start)!;
      const action = () => {
        if (operation === "list") return adminAccounts(caller, db, start);
        if (operation === "invite") return inviteAccount(caller, { name: "Other", email: "other@example.test" }, db, start);
        if (operation === "reset") return issueSignInLink(caller, admin.account.id, db, start);
        return changeAccountAccess(caller, admin.account.id, operation === "role" ? { isAdmin: false } : { status: "deactivated" }, db, start);
      };
      await refusedWithoutChange(action, "forbidden");
    }
  });

  it.each([false, true].flatMap(otherAdmin => ["deactivate", "demote"].map(operation => ({ otherAdmin, operation }))))("refuses self-$operation with another admin = $otherAdmin", async ({ otherAdmin, operation }) => {
    if (otherAdmin) {
      const user = await member();
      changeAccountAccess(admin, user.account.id, { isAdmin: true }, db, start);
    }
    await refusedWithoutChange(() => changeAccountAccess(admin, admin.account.id,
      operation === "deactivate" ? { status: "deactivated" } : { isAdmin: false }, db, start), "self_change_refused");
  });

  it.each(["role", "deactivate"])("competing %s changes cannot remove every active admin", async operation => {
    const user = await member();
    changeAccountAccess(admin, user.account.id, { isAdmin: true }, db, start);
    const second = authenticateSession(user.secret, db, start)!;
    const other = open(file);
    try {
      const patch = operation === "role" ? { isAdmin: false } : { status: "deactivated" as const };
      const results = await Promise.allSettled([
        Promise.resolve().then(() => changeAccountAccess(admin, user.account.id, patch, db, start)),
        Promise.resolve().then(() => changeAccountAccess(second, admin.account.id, patch, other, start)),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(listAccounts(db).filter(account => account.isAdmin && account.status === "active")).toHaveLength(1);
      expect(getAccount(admin.account.id, db)?.isOriginal).toBe(true);
    } finally { other.close(); }
  });

  it("refuses all live access when deactivated and restores token eligibility on reactivation without reviving sessions", async () => {
    const user = await member();
    const token = createApiToken(user.context, "Terminal", db, start);
    changeAccountAccess(admin, user.account.id, { status: "deactivated" }, db, start);
    const before = snapshot();
    expect(authenticateSession(user.secret, db, start)).toBeNull();
    expect(authenticateToken(token.secret, db, start)).toBeNull();
    expect(snapshot()).toEqual(before);
    await refusedWithoutChange(() => createApiToken(user.context, "Too late", db, start), "authentication_required");
    changeAccountAccess(admin, user.account.id, { status: "active" }, db, start);
    expect(authenticateSession(user.secret, db, start)).toBeNull();
    expect(authenticateToken(token.secret, db, start)?.account.id).toBe(user.account.id);
    expect((await signIn(user.account.email, password, db, start)).account.id).toBe(user.account.id);
    expect(listAccounts(db)).toHaveLength(2);
  });

  it.each(["invited", "active", "deactivated"] as const)("reserves normalized duplicate emails for %s accounts", async status => {
    const invited = inviteAccount(admin, { name: "Lin", email: " Lin@Example.Test " }, db, start);
    if (status !== "invited") await redeemSignInLink(invited.secret!, password, db, start);
    if (status === "deactivated") changeAccountAccess(admin, invited.account.id, { status }, db, start);
    const action = () => inviteAccount(admin, { name: "Duplicate", email: "LIN@example.test" }, db, start);
    await refusedWithoutChange(action, "email_taken");
    if (status === "deactivated") {
      expect(() => action()).toThrow(expect.objectContaining({ extra: { accountId: invited.account.id, canReactivate: true } }));
    }
    await refusedWithoutChange(() => updateOwnProfile(admin, { name: "Changed", email: "lin@example.test", currentPassword: password }, db, start), "email_taken");
  });
});
