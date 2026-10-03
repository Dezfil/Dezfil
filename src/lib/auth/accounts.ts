import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { accountCount, accountPasswordHash, getAccount, getAccountByEmail, insertAccount, markOriginalAccount,
  normalizeEmail } from "@/lib/metadata/accounts";
import { revokeSessions } from "@/lib/metadata/auth-credentials";
import { maintainCredentials } from "./credential-maintenance";
import { AuthError, requireAuthenticationWanted } from "./errors";
import { issueSession, requireCurrentActor, type AuthContext } from "./credentials";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./passwords";
import { adoptLegacyPreferences } from "./adoption";

/** Call under the write transaction, after authorizing the caller. */
export function requireAvailableEmail(email: string, exceptId: string | null, db: Database, admin = false): void {
  const duplicate = getAccountByEmail(email, db);
  if (duplicate && duplicate.id !== exceptId) {
    const canReactivate = admin && duplicate.status === "deactivated";
    throw new AuthError("email_taken", canReactivate ? "This account is deactivated. Reactivate it in Users."
      : "An account already uses this email address.", 409,
    canReactivate ? { accountId: duplicate.id, canReactivate: true } : {});
  }
}

async function checkCurrentPassword(accountId: string, password: string | undefined, db: Database, signal?: AbortSignal) {
  const hash = accountPasswordHash(accountId, db);
  const valid = await verifyPassword(password ?? "", hash ?? DUMMY_PASSWORD_HASH, { class: "protected", signal });
  requireAuthenticationWanted(signal);
  if (!hash || !valid) throw new AuthError("current_password_required", "Enter your current password.", 403);
  return hash;
}

function requireUnchangedPassword(accountId: string, hash: string, db: Database): void {
  if (accountPasswordHash(accountId, db) !== hash) {
    throw new AuthError("current_password_required", "Enter your current password.", 403);
  }
}

export function identityFields(name: string, email: string) {
  const identity = { name: name.trim(), email: normalizeEmail(email) };
  if (!identity.name || !/^[^\s@]+@[^\s@]+$/.test(identity.email)) {
    throw new AuthError("invalid_request", "Enter a name and email address.", 400);
  }
  return identity;
}

export async function createFirstAccount(input: { name: string; email: string; password: string },
  db: Database = metadataDb(), now?: number, signal?: AbortSignal) {
  maintainCredentials(db, now);
  // The write transaction repeats this check after asynchronous password work.
  if (accountCount(db) !== 0) throw new AuthError("setup_complete", "This instance is already set up.", 409);
  const fields = identityFields(input.name, input.email);
  const passwordHash = await hashPassword(input.password, { signal });
  return db.transaction(() => {
    requireAuthenticationWanted(signal);
    if (accountCount(db) !== 0) throw new AuthError("setup_complete", "This instance is already set up.", 409);
    const at = now ?? Date.now();
    const account = insertAccount({ id: randomUUID(), ...fields, passwordHash, isAdmin: true,
      status: "active", now: new Date(at).toISOString() }, db);
    markOriginalAccount(account.id, db);
    adoptLegacyPreferences(account.id, db);
    db.prepare("UPDATE accounts SET last_sign_in_at = ? WHERE id = ?").run(new Date(at).toISOString(), account.id);
    return issueSession(getAccount(account.id, db)!, db, at);
  }).immediate();
}

export async function signIn(email: string, password: string, db: Database = metadataDb(), now?: number, signal?: AbortSignal) {
  maintainCredentials(db, now);
  const account = getAccountByEmail(email, db);
  const hash = account && accountPasswordHash(account.id, db);
  const valid = await verifyPassword(password, hash ?? DUMMY_PASSWORD_HASH, { signal });
  requireAuthenticationWanted(signal);
  const invalid = () => new AuthError("invalid_credentials", "Email or password is incorrect.", 401);
  if (!account || !hash || !valid) throw invalid();
  return db.transaction(() => {
    requireAuthenticationWanted(signal);
    const current = getAccount(account.id, db);
    // A reset or email change that won during password work invalidates this attempt.
    if (!current || current.email !== normalizeEmail(email) || accountPasswordHash(account.id, db) !== hash) throw invalid();
    if (current.status === "deactivated") throw new AuthError("account_deactivated", "This account is deactivated. Contact an admin.", 403);
    if (current.status !== "active") throw invalid();
    const at = now ?? Date.now();
    db.prepare("UPDATE accounts SET last_sign_in_at = ? WHERE id = ?")
      .run(new Date(at).toISOString(), account.id);
    return issueSession(getAccount(account.id, db)!, db, at);
  }).immediate();
}

export async function changeOwnPassword(context: AuthContext, currentPassword: string, password: string,
  db: Database = metadataDb(), now?: number, signal?: AbortSignal): Promise<void> {
  const account = requireCurrentActor(context, db, now ?? Date.now());
  const oldHash = await checkCurrentPassword(account.id, currentPassword, db, signal);
  const passwordHash = await hashPassword(password, { class: "protected", signal });
  db.transaction(() => {
    requireAuthenticationWanted(signal);
    const at = now ?? Date.now();
    requireCurrentActor(context, db, at);
    requireUnchangedPassword(account.id, oldHash, db);
    db.prepare("UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, new Date(at).toISOString(), account.id);
    revokeSessions(account.id, at, context.credential.kind === "session" ? context.credential.id : null, db);
  }).immediate();
}

export async function updateOwnProfile(context: AuthContext, patch: { name?: string; email?: string; currentPassword?: string },
  db: Database = metadataDb(), now?: number, signal?: AbortSignal) {
  const account = requireCurrentActor(context, db, now ?? Date.now());
  const oldHash = patch.email === undefined ? null : await checkCurrentPassword(account.id, patch.currentPassword, db, signal);
  return db.transaction(() => {
    requireAuthenticationWanted(signal);
    const at = now ?? Date.now();
    const current = requireCurrentActor(context, db, at);
    if (oldHash) requireUnchangedPassword(account.id, oldHash, db);
    const fields = identityFields(patch.name ?? current.name, patch.email ?? current.email);
    requireAvailableEmail(fields.email, account.id, db);
    db.prepare("UPDATE accounts SET name = ?, email = ?, updated_at = ? WHERE id = ?")
      .run(fields.name, fields.email, new Date(at).toISOString(), account.id);
    return getAccount(account.id, db)!;
  }).immediate();
}
