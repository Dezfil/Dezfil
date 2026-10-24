import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";
import { allocateSqlName } from "./sql-names";

export type AccountStatus = "invited" | "active" | "deactivated";
export type IdentityStatus = AccountStatus | "deleting" | "deleted";

/** Retained identity is separate from a readable account profile. */
export function accountSqlNames(ids: Iterable<string | null>, db: Database = metadataDb()): Map<string, string> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = db.prepare("SELECT id, sql_name FROM accounts WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(wanted)) as { id: string; sql_name: string }[];
  return new Map(rows.map(row => [row.id, row.sql_name]));
}

/** Adoption survives removal of the original profile. Existing accounts also
 * refuse setup in an incomplete legacy store; setup never guesses a new owner. */
export function setupComplete(db: Database = metadataDb()): boolean {
  return db.prepare("SELECT 1 FROM original_account UNION ALL SELECT 1 FROM accounts LIMIT 1").get() !== undefined;
}

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
  /** The version of the account's picture, present while it has one. */
  pictureVersion?: string;
}

const projection = `SELECT a.id, a.name, a.email, a.sql_name, a.is_admin, a.status,
  a.created_at, a.updated_at, a.last_sign_in_at, a.picture_version,
  EXISTS (SELECT 1 FROM original_account o WHERE o.account_id = a.id) AS is_original
  FROM accounts a`;

interface Row {
  id: string; name: string; email: string; sql_name: string; is_admin: number;
  status: AccountStatus; is_original: number; created_at: string;
  updated_at: string; last_sign_in_at: string | null; picture_version: string | null;
}

function fromRow(row: Row): Account {
  return {
    id: row.id, name: row.name, email: row.email, sqlName: row.sql_name, isAdmin: row.is_admin === 1,
    status: row.status, isOriginal: row.is_original === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
    lastSignInAt: row.last_sign_in_at,
    ...pictureOf(row.picture_version),
  };
}

/** The picture reference a person carries: present only while they have one. */
function pictureOf(version: string | null): { pictureVersion?: string } {
  return version ? { pictureVersion: version } : {};
}

/** How a resource names the person who owns it, or whose SQL home it is:
 * the display name and the SQL name, never the email. */
export interface AccountLabel {
  name: string;
  sqlName: string;
}

/** How a read that draws a person's face names them: their label and, while
 * they have a picture, its version, which changes whenever it is replaced.
 * Runners, change authors and deleted actors keep the plain label. */
export interface PersonLabel extends AccountLabel {
  pictureVersion?: string;
}

export function personLabel(name: string, sqlName: string, pictureVersion: string | null): PersonLabel {
  return { name, sqlName, ...pictureOf(pictureVersion) };
}

/** The face-bearing labels of a set of accounts, by identity; unknown
 * identities are left out. */
export function accountPeople(ids: Iterable<string | null>, db: Database = metadataDb()): Map<string, PersonLabel> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = db.prepare("SELECT id, name, sql_name, picture_version FROM accounts WHERE status NOT IN ('deleting', 'deleted') AND id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(wanted)) as { id: string; name: string; sql_name: string; picture_version: string | null }[];
  return new Map(rows.map(row => [row.id, personLabel(row.name, row.sql_name, row.picture_version)]));
}

/** The labels of a set of accounts, by identity; unknown identities are
 * left out. */
export function accountLabels(ids: Iterable<string | null>, db: Database = metadataDb()): Map<string, AccountLabel> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = db.prepare("SELECT id, name, sql_name FROM accounts WHERE status NOT IN ('deleting', 'deleted') AND id IN (SELECT value FROM json_each(?))")
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
  const row = db.prepare(`${projection} WHERE a.id = ? AND a.status NOT IN ('deleting', 'deleted')`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function getAccountByEmail(email: string, db: Database = metadataDb()): Account | null {
  const row = db.prepare(`${projection} WHERE a.email = ? AND a.status NOT IN ('deleting', 'deleted')`).get(normalizeEmail(email)) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listAccounts(db: Database = metadataDb()): Account[] {
  return (db.prepare(`${projection} WHERE a.status NOT IN ('deleting', 'deleted') ORDER BY a.created_at, a.id`).all() as Row[]).map(fromRow);
}

/** Internal password-verification accessor. Account reads use the projection above. */
export function accountPasswordHash(id: string, db: Database = metadataDb()): string | null {
  const row = db.prepare("SELECT password_hash FROM accounts WHERE id = ? AND status NOT IN ('deleting', 'deleted')").get(id) as
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
