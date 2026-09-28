import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount, insertAccount, listAccounts } from "@/lib/metadata/accounts";
import { insertLink, revokeLinks, revokeSessions } from "@/lib/metadata/auth-credentials";
import { identityFields, requireAvailableEmail } from "./accounts";
import { newSecret, requireCurrentActor, secretHash, type AuthContext } from "./credentials";
import { AuthError } from "./errors";

export const LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function requireAdmin(context: AuthContext, db: Database, now: number) {
  const account = requireCurrentActor(context, db, now);
  if (!account.isAdmin) throw new AuthError("forbidden", "An admin account is required.", 403);
  return account;
}

function makeLink(accountId: string, kind: "invite" | "reset", db: Database, now: number) {
  const secret = newSecret("link");
  revokeLinks(accountId, now, db);
  insertLink({ id: randomUUID(), account_id: accountId, kind, secret_hash: secretHash(secret),
    created_at: now, expires_at: now + LINK_LIFETIME_MS, consumed_at: null, revoked_at: null }, db);
  return { account: getAccount(accountId, db)!, secret, expiresAt: now + LINK_LIFETIME_MS };
}

export function adminAccounts(context: AuthContext, db: Database = metadataDb(), now = Date.now()) {
  return db.transaction(() => { requireAdmin(context, db, now); return listAccounts(db); }).immediate();
}

export function inviteAccount(context: AuthContext, input: { name: string; email: string; isAdmin?: boolean },
  db: Database = metadataDb(), now = Date.now()) {
  const fields = identityFields(input.name, input.email);
  return db.transaction(() => {
    requireAdmin(context, db, now);
    requireAvailableEmail(fields.email, null, db, true);
    const account = insertAccount({ id: randomUUID(), ...fields, passwordHash: null, isAdmin: input.isAdmin === true,
      status: "invited", now: new Date(now).toISOString() }, db);
    return makeLink(account.id, "invite", db, now);
  }).immediate();
}

export function issueSignInLink(context: AuthContext, accountId: string, db: Database = metadataDb(), now = Date.now()) {
  return db.transaction(() => {
    requireAdmin(context, db, now);
    const account = getAccount(accountId, db);
    if (!account) throw new AuthError("not_found", "Account not found.", 404);
    db.prepare("UPDATE accounts SET password_hash = NULL, updated_at = ? WHERE id = ?")
      .run(new Date(now).toISOString(), accountId);
    revokeSessions(accountId, now, null, db);
    return makeLink(accountId, account.status === "invited" ? "invite" : "reset", db, now);
  }).immediate();
}

export function changeAccountAccess(context: AuthContext, accountId: string,
  patch: { isAdmin?: boolean; status?: "active" | "deactivated" }, db: Database = metadataDb(), now = Date.now()) {
  return db.transaction(() => {
    const actor = requireAdmin(context, db, now);
    const account = getAccount(accountId, db);
    if (!account) throw new AuthError("not_found", "Account not found.", 404);
    if (actor.id === accountId && (patch.isAdmin === false || patch.status === "deactivated")) {
      throw new AuthError("self_change_refused", "Another admin must make this change.", 409);
    }
    const status = patch.status === "active" && account.lastSignInAt === null
      ? "invited" : patch.status ?? account.status;
    db.prepare("UPDATE accounts SET is_admin = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(Number(patch.isAdmin ?? account.isAdmin), status, new Date(now).toISOString(), accountId);
    const remaining = db.prepare("SELECT count(*) AS count FROM accounts WHERE is_admin = 1 AND status = 'active'").get() as { count: number };
    if (remaining.count === 0) throw new AuthError("last_admin", "Keep at least one active admin.", 409);
    if (status === "deactivated") revokeSessions(accountId, now, null, db);
    return getAccount(accountId, db)!;
  }).immediate();
}
