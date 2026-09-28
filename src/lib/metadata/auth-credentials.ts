import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

/** Internal records. Public token reads use the explicit projection below. */
export interface SessionRecord {
  id: string; secret_hash: string; account_id: string; created_at: number;
  expires_at: number; last_used_at: number; revoked_at: number | null;
}
export interface TokenRecord {
  id: string; account_id: string; name: string; secret_hash: string;
  created_at: number; last_used_at: number | null; revoked_at: number | null;
}
export interface LinkRecord {
  id: string; account_id: string; kind: "invite" | "reset"; secret_hash: string;
  created_at: number; expires_at: number; consumed_at: number | null; revoked_at: number | null;
}
export interface ApiToken {
  id: string; name: string; createdAt: string; lastUsedAt: string | null;
  revokedAt: string | null;
}

export function insertSession(row: SessionRecord, db: Database = metadataDb()): void {
  db.prepare(`INSERT INTO auth_sessions
    (id, secret_hash, account_id, created_at, expires_at, last_used_at, revoked_at)
    VALUES (@id, @secret_hash, @account_id, @created_at, @expires_at, @last_used_at, @revoked_at)`).run(row);
}

export function sessionByHash(hash: string, db: Database = metadataDb()): SessionRecord | null {
  return db.prepare("SELECT * FROM auth_sessions WHERE secret_hash = ?").get(hash) as SessionRecord | undefined ?? null;
}

export function sessionById(id: string, db: Database = metadataDb()): SessionRecord | null {
  return db.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(id) as SessionRecord | undefined ?? null;
}

export function revokeSessions(accountId: string, now: number, exceptId: string | null = null,
  db: Database = metadataDb()): void {
  db.prepare(`UPDATE auth_sessions SET revoked_at = ?
    WHERE account_id = ? AND revoked_at IS NULL AND (? IS NULL OR id <> ?)`)
    .run(now, accountId, exceptId, exceptId);
}

export function insertToken(row: TokenRecord, db: Database = metadataDb()): void {
  db.prepare(`INSERT INTO auth_tokens
    (id, account_id, name, secret_hash, created_at, last_used_at, revoked_at)
    VALUES (@id, @account_id, @name, @secret_hash, @created_at, @last_used_at, @revoked_at)`).run(row);
}

export function tokenByHash(hash: string, db: Database = metadataDb()): TokenRecord | null {
  return db.prepare("SELECT * FROM auth_tokens WHERE secret_hash = ?").get(hash) as TokenRecord | undefined ?? null;
}

export function tokenById(id: string, db: Database = metadataDb()): TokenRecord | null {
  return db.prepare("SELECT * FROM auth_tokens WHERE id = ?").get(id) as TokenRecord | undefined ?? null;
}

function tokenProjection(row: Omit<TokenRecord, "account_id" | "secret_hash">): ApiToken {
  return {
    id: row.id, name: row.name, createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  };
}

export function listAccountTokens(accountId: string, db: Database = metadataDb()): ApiToken[] {
  const rows = db.prepare(`SELECT id, name, created_at, last_used_at, revoked_at
    FROM auth_tokens WHERE account_id = ? ORDER BY created_at, id`).all(accountId) as
    Omit<TokenRecord, "account_id" | "secret_hash">[];
  return rows.map(tokenProjection);
}

/** The account predicate makes a token belonging to someone else a no-op. */
export function revokeAccountToken(accountId: string, tokenId: string, now: number,
  db: Database = metadataDb()): boolean {
  return db.prepare(`UPDATE auth_tokens SET revoked_at = COALESCE(revoked_at, ?)
    WHERE id = ? AND account_id = ?`).run(now, tokenId, accountId).changes > 0;
}

export function insertLink(row: LinkRecord, db: Database = metadataDb()): void {
  db.prepare(`INSERT INTO auth_links
    (id, account_id, kind, secret_hash, created_at, expires_at, consumed_at, revoked_at)
    VALUES (@id, @account_id, @kind, @secret_hash, @created_at, @expires_at, @consumed_at, @revoked_at)`).run(row);
}

export function linkByHash(hash: string, db: Database = metadataDb()): LinkRecord | null {
  return db.prepare("SELECT * FROM auth_links WHERE secret_hash = ?").get(hash) as LinkRecord | undefined ?? null;
}

export function revokeLinks(accountId: string, now: number, db: Database = metadataDb()): void {
  db.prepare(`UPDATE auth_links SET revoked_at = ?
    WHERE account_id = ? AND revoked_at IS NULL AND consumed_at IS NULL`).run(now, accountId);
}
