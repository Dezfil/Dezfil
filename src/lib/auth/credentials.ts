import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount, type Account } from "@/lib/metadata/accounts";
import { insertSession, insertToken, listAccountTokens, revokeAccountToken, sessionByHash,
  sessionById, tokenByHash, tokenById, type TokenRecord } from "@/lib/metadata/auth-credentials";
import { maintainCredentials } from "./credential-maintenance";
import { AuthError } from "./errors";
import { newSecret, secretHash } from "./link-issuance.mjs";
import { requireRule } from "./instance-rules";
import { securitySettings } from "./security-settings";
export { newSecret, secretHash } from "./link-issuance.mjs";

export interface AuthContext {
  account: Account;
  /** Expiry of a server-issued bearer bound to this session or token. */
  delegationExpiresAt?: number;
  workKey?: string;
  credential: { kind: "session" | "token"; id: string };
}

/** Called inside the account transaction after credential verification. The
 * session lasts the length stored now. */
export function issueSession(account: Account, db: Database, now: number) {
  const secret = newSecret("session");
  const id = randomUUID();
  const expiresAt = now + securitySettings(db).sessionMs;
  insertSession({ id, account_id: account.id, secret_hash: secretHash(secret), created_at: now,
    expires_at: expiresAt, last_used_at: now, revoked_at: null }, db);
  return { account, secret, expiresAt };
}

/** A session is judged by the expiry it holds, never by its last use, so
 * storing a shorter length ends no session: its next use renews it by the
 * length stored now. */
export function authenticateSession(secret: string | null, db: Database = metadataDb(), now?: number): AuthContext | null {
  if (!secret) return null;
  maintainCredentials(db, now);
  now ??= Date.now();
  return db.transaction(() => {
    const record = sessionByHash(secretHash(secret), db);
    const account = record && getAccount(record.account_id, db);
    if (!record || !account || record.revoked_at !== null || record.expires_at <= now || account.status !== "active") return null;
    db.prepare("UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?")
      .run(now, now + securitySettings(db).sessionMs, record.id);
    return { account, credential: { kind: "session" as const, id: record.id } };
  }).immediate();
}

/** Only an expiry a token carries is compared: one made under Never has none
 * and never expires. */
export function tokenExpired(token: Pick<TokenRecord, "expires_at">, now: number): boolean {
  return token.expires_at !== null && token.expires_at <= now;
}
/** An expired token's own refusal, distinct from a credential that never worked. */
export function expiredToken(): AuthError {
  return new AuthError("token_expired", "This API token has expired. Create a new one to continue.", 401);
}

/** A revoked token, or one whose account is not active, is unknown; an
 * expired one is refused as expired, and its use records nothing. */
export function authenticateToken(secret: string | null, db: Database = metadataDb(), now?: number): AuthContext | null {
  if (!secret) return null;
  maintainCredentials(db, now);
  now ??= Date.now();
  return db.transaction(() => {
    const record = tokenByHash(secretHash(secret), db);
    const account = record && getAccount(record.account_id, db);
    if (!record || !account || record.revoked_at !== null || account.status !== "active") return null;
    if (tokenExpired(record, now)) throw expiredToken();
    db.prepare("UPDATE auth_tokens SET last_used_at = ? WHERE id = ?").run(now, record.id);
    return { account, credential: { kind: "token" as const, id: record.id } };
  }).immediate();
}

/** Services call this again under their write transaction; contexts are not authority. */
export function requireCurrentActor(context: AuthContext | null, db: Database = metadataDb(), now?: number): Account {
  maintainCredentials(db, now);
  now ??= Date.now();
  const refused = () => new AuthError("authentication_required", "Sign in to continue.", 401);
  if (!context || (context.delegationExpiresAt !== undefined && context.delegationExpiresAt <= now)) throw refused();
  const session = context.credential.kind === "session" ? sessionById(context.credential.id, db) : null;
  const token = context.credential.kind === "token" ? tokenById(context.credential.id, db) : null;
  const record = session ?? token;
  const account = record && getAccount(record.account_id, db);
  if (!record || !account || record.revoked_at !== null || account.status !== "active" ||
      account.id !== context.account.id || (session !== null && session.expires_at <= now)) {
    throw refused();
  }
  if (token !== null && tokenExpired(token, now)) throw expiredToken();
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
    // Who may create tokens is the instance's rule; tokens made earlier keep working.
    requireRule(account.id, "tokens.create", db);
    if (!name.trim()) throw new AuthError("invalid_request", "Name the token.", 400);
    const id = randomUUID(), secret = newSecret("token");
    // The lifetime stored at creation, kept whatever a later save says; Never stores none.
    const lifetime = securitySettings(db).tokenLifetimeMs;
    insertToken({ id, account_id: account.id, name: name.trim(), secret_hash: secretHash(secret),
      created_at: now, last_used_at: null, revoked_at: null, expires_at: lifetime === null ? null : now + lifetime }, db);
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
