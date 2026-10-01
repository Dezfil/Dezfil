import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";
import { allocateSqlName } from "./sql-names";

export type AccountStatus = "invited" | "active" | "deactivated";

/** The public account projection never includes password or credential material. */
export interface Account {
  id: string;
  name: string;
  email: string;
  /** The account's SQL name: derived at creation (or upgrade), fixed after. */
  sqlName: string;
  isAdmin: boolean;
  status: AccountStatus;
  isOriginal: boolean;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

const projection = `SELECT a.id, a.name, a.email, a.sql_name, a.is_admin, a.status,
  a.created_at, a.updated_at, a.last_sign_in_at,
  EXISTS (SELECT 1 FROM original_account o WHERE o.account_id = a.id) AS is_original
  FROM accounts a`;

interface Row {
  id: string; name: string; email: string; sql_name: string; is_admin: number;
  status: AccountStatus; is_original: number; created_at: string;
  updated_at: string; last_sign_in_at: string | null;
}

function fromRow(row: Row): Account {
  return {
    id: row.id, name: row.name, email: row.email, sqlName: row.sql_name, isAdmin: row.is_admin === 1,
    status: row.status, isOriginal: row.is_original === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
    lastSignInAt: row.last_sign_in_at,
  };
}

/** How a resource names the person who owns it, or whose SQL home it is:
 * the display name and the SQL name, never the email. */
export interface AccountLabel {
  name: string;
  sqlName: string;
}

/** The labels of a set of accounts, by identity; unknown identities are
 * left out. */
export function accountLabels(ids: Iterable<string | null>, db: Database = metadataDb()): Map<string, AccountLabel> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = db.prepare("SELECT id, name, sql_name FROM accounts WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(wanted)) as { id: string; name: string; sql_name: string }[];
  return new Map(rows.map(row => [row.id, { name: row.name, sqlName: row.sql_name }]));
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

/** Storage primitive; authorization and lifecycle transactions belong to auth services.
 * Every creation path passes through here, so every account receives its SQL
 * name, derived from the identity it was created with and fixed thereafter. */
export function insertAccount(input: {
  id: string; name: string; email: string; passwordHash: string | null;
  isAdmin: boolean; status: AccountStatus; now: string;
}, db: Database = metadataDb()): Account {
  const email = normalizeEmail(input.email);
  const taken = db.prepare("SELECT 1 FROM accounts WHERE sql_name = ?");
  const sqlName = allocateSqlName({ name: input.name, email }, name => taken.get(name) !== undefined);
  db.prepare(`INSERT INTO accounts
    (id, name, email, password_hash, is_admin, status, created_at, updated_at, sql_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.name,
    email, input.passwordHash, Number(input.isAdmin),
    input.status, input.now, input.now, sqlName);
  return getAccount(input.id, db)!;
}

export function markOriginalAccount(id: string, db: Database = metadataDb()): void {
  db.prepare("INSERT INTO original_account (singleton, account_id) VALUES (1, ?)").run(id);
}
