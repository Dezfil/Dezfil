import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount, type Account } from "@/lib/metadata/accounts";
import { insertSession, insertToken, listAccountTokens, revokeAccountToken, sessionByHash,
  sessionById, tokenByHash, tokenById } from "@/lib/metadata/auth-credentials";
import { maintainCredentials } from "./credential-maintenance";
import { AuthError } from "./errors";
import { newSecret, secretHash } from "./link-issuance.mjs";
export { newSecret, secretHash } from "./link-issuance.mjs";

export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export interface AuthContext {
  account: Account;
  /** Expiry of a server-issued bearer bound to this session or token. */
  delegationExpiresAt?: number;
  credential: { kind: "session" | "token"; id: string };
}

/** Called inside the account transaction after credential verification. */
export function issueSession(account: Account, db: Database, now: number) {
  const secret = newSecret("session");
  const id = randomUUID();
  insertSession({ id, account_id: account.id, secret_hash: secretHash(secret), created_at: now,
    expires_at: now + SESSION_LIFETIME_MS, last_used_at: now, revoked_at: null }, db);
  return { account, secret, expiresAt: now + SESSION_LIFETIME_MS };
}

export function authenticateSession(secret: string | null, db: Database = metadataDb(), now?: number): AuthContext | null {
  if (!secret) return null;
  maintainCredentials(db, now);
  now ??= Date.now();
  return db.transaction(() => {
    const record = sessionByHash(secretHash(secret), db);
    const account = record && getAccount(record.account_id, db);
    if (!record || !account || record.revoked_at !== null || record.expires_at <= now || account.status !== "active") return null;
    db.prepare("UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?")
      .run(now, now + SESSION_LIFETIME_MS, record.id);
    return { account, credential: { kind: "session" as const, id: record.id } };
  }).immediate();
}

export function authenticateToken(secret: string | null, db: Database = metadataDb(), now?: number): AuthContext | null {
  if (!secret) return null;
  maintainCredentials(db, now);
  now ??= Date.now();
  return db.transaction(() => {
    const record = tokenByHash(secretHash(secret), db);
    const account = record && getAccount(record.account_id, db);
    if (!record || !account || record.revoked_at !== null || account.status !== "active") return null;
    db.prepare("UPDATE auth_tokens SET last_used_at = ? WHERE id = ?").run(now, record.id);
    return { account, credential: { kind: "token" as const, id: record.id } };
  }).immediate();
}

/** Services call this again under their write transaction; contexts are not authority. */
export function requireCurrentActor(context: AuthContext | null, db: Database = metadataDb(), now?: number): Account {
  maintainCredentials(db, now);
  now ??= Date.now();
  if (!context || (context.delegationExpiresAt !== undefined && context.delegationExpiresAt <= now)) throw new AuthError("authentication_required", "Sign in to continue.", 401);
  const record = context.credential.kind === "session"
    ? sessionById(context.credential.id, db) : tokenById(context.credential.id, db);
  const account = record && getAccount(record.account_id, db);
  if (!record || !account || record.revoked_at !== null || account.status !== "active" ||
      account.id !== context.account.id || ("expires_at" in record && record.expires_at <= now)) {
    throw new AuthError("authentication_required", "Sign in to continue.", 401);
  }
  return account;
}

export function signOut(context: AuthContext, db: Database = metadataDb(), now?: number): void {
  maintainCredentials(db, now);
  now ??= Date.now();
  db.transaction(() => {
    requireCurrentActor(context, db, now);
    if (context.credential.kind === "session") {
      db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?").run(now, context.credential.id);
    }
  }).immediate();
}

export function createApiToken(context: AuthContext, name: string, db: Database = metadataDb(), now?: number) {
  maintainCredentials(db, now);
  now ??= Date.now();
  return db.transaction(() => {
    const account = requireCurrentActor(context, db, now);
    if (!name.trim()) throw new AuthError("invalid_request", "Name the token.", 400);
    const id = randomUUID(), secret = newSecret("token");
    insertToken({ id, account_id: account.id, name: name.trim(), secret_hash: secretHash(secret),
      created_at: now, last_used_at: null, revoked_at: null }, db);
    return { ...listAccountTokens(account.id, db).find(token => token.id === id)!, secret };
  }).immediate();
}

export function listApiTokens(context: AuthContext, db: Database = metadataDb(), now?: number) {
  maintainCredentials(db, now);
  now ??= Date.now();
  return db.transaction(() => listAccountTokens(requireCurrentActor(context, db, now).id, db)).immediate();
}

export function revokeApiToken(context: AuthContext, id: string, db: Database = metadataDb(), now?: number): void {
  maintainCredentials(db, now);
  now ??= Date.now();
  db.transaction(() => {
    const account = requireCurrentActor(context, db, now);
    if (!revokeAccountToken(account.id, id, now, db)) throw new AuthError("not_found", "Token not found.", 404);
  }).immediate();
}
