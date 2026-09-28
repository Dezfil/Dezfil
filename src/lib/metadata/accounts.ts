import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

export type AccountStatus = "invited" | "active" | "deactivated";

/** The public account projection never includes password or credential material. */
export interface Account {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  status: AccountStatus;
  isOriginal: boolean;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

const projection = `SELECT a.id, a.name, a.email, a.is_admin, a.status,
  a.created_at, a.updated_at, a.last_sign_in_at,
  EXISTS (SELECT 1 FROM original_account o WHERE o.account_id = a.id) AS is_original
  FROM accounts a`;

interface Row {
  id: string; name: string; email: string; is_admin: number;
  status: AccountStatus; is_original: number; created_at: string;
  updated_at: string; last_sign_in_at: string | null;
}

function fromRow(row: Row): Account {
  return {
    id: row.id, name: row.name, email: row.email, isAdmin: row.is_admin === 1,
    status: row.status, isOriginal: row.is_original === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
    lastSignInAt: row.last_sign_in_at,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function accountCount(db: Database = metadataDb()): number {
  return (db.prepare("SELECT count(*) AS count FROM accounts").get() as { count: number }).count;
}

export function getAccount(id: string, db: Database = metadataDb()): Account | null {
  const row = db.prepare(`${projection} WHERE a.id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function getAccountByEmail(email: string, db: Database = metadataDb()): Account | null {
  const row = db.prepare(`${projection} WHERE a.email = ?`).get(normalizeEmail(email)) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listAccounts(db: Database = metadataDb()): Account[] {
  return (db.prepare(`${projection} ORDER BY a.created_at, a.id`).all() as Row[]).map(fromRow);
}

/** Internal password-verification accessor. Account reads use the projection above. */
export function accountPasswordHash(id: string, db: Database = metadataDb()): string | null {
  const row = db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get(id) as
    { password_hash: string | null } | undefined;
  return row?.password_hash ?? null;
}

/** Storage primitive; authorization and lifecycle transactions belong to auth services. */
export function insertAccount(input: {
  id: string; name: string; email: string; passwordHash: string | null;
  isAdmin: boolean; status: AccountStatus; now: string;
}, db: Database = metadataDb()): Account {
  db.prepare(`INSERT INTO accounts
    (id, name, email, password_hash, is_admin, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.name,
    normalizeEmail(input.email), input.passwordHash, Number(input.isAdmin),
    input.status, input.now, input.now);
  return getAccount(input.id, db)!;
}

export function markOriginalAccount(id: string, db: Database = metadataDb()): void {
  db.prepare("INSERT INTO original_account (singleton, account_id) VALUES (1, ?)").run(id);
}
