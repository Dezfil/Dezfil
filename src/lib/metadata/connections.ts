import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";
import { encryptSecret, decryptSecret } from "@/lib/secrets";

/**
 * PostGIS connections. Credentials are write-only: nothing this module
 * returns carries the password — attach strings get it through the
 * dedicated internal accessor, and API/UI layers only ever see this
 * shape.
 */

export interface PgConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  createdAt: string;
  status: PgConnectionStatus;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  serverVersion: string | null;
  postgisVersion: string | null;
}

export interface NewPgConnection
  extends Omit<
    PgConnection,
    | "createdAt"
    | "status"
    | "lastCheckedAt"
    | "lastCheckError"
    | "serverVersion"
    | "postgisVersion"
  > {
  password: string;
}

export type PgConnectionOutcome = "connected" | "failing" | "no_postgis";
export type PgConnectionStatus = PgConnectionOutcome | "not_checked_lately" | "never_checked";

export interface ConnectionCheck {
  outcome: PgConnectionOutcome;
  checkedAt?: string;
  error?: string | null;
  serverVersion?: string | null;
  postgisVersion?: string | null;
}

export interface PgConnectionUpdate {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

interface Row {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password_encrypted: string;
  ssl: 0 | 1;
  created_at: string;
  last_checked_at: string | null;
  last_check_outcome: PgConnectionOutcome | null;
  last_check_error: string | null;
  server_version: string | null;
  postgis_version: string | null;
}

export function connectionStatusAt(
  outcome: PgConnectionOutcome | null,
  checkedAt: string | null,
  now: Date = new Date(),
): PgConnectionStatus {
  if (!outcome || !checkedAt) return "never_checked";
  if (
    outcome === "connected" &&
    now.getTime() - new Date(checkedAt).getTime() >= STALE_AFTER_MS
  ) {
    return "not_checked_lately";
  }
  return outcome;
}

function fromRow(r: Row, now: Date = new Date()): PgConnection {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    database: r.database,
    username: r.username,
    ssl: r.ssl === 1,
    createdAt: r.created_at,
    status: connectionStatusAt(r.last_check_outcome, r.last_checked_at, now),
    lastCheckedAt: r.last_checked_at,
    lastCheckError: r.last_check_error,
    serverVersion: r.server_version,
    postgisVersion: r.postgis_version,
  };
}

export function insertConnection(
  c: NewPgConnection,
  db: Database = metadataDb(),
): PgConnection {
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO pg_connections
       (id, name, host, port, database, username, password_encrypted, ssl, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id,
    c.name,
    c.host,
    c.port,
    c.database,
    c.username,
    encryptSecret(c.password),
    c.ssl ? 1 : 0,
    createdAt,
  );
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    database: c.database,
    username: c.username,
    ssl: c.ssl,
    createdAt,
    status: "never_checked",
    lastCheckedAt: null,
    lastCheckError: null,
    serverVersion: null,
    postgisVersion: null,
  };
}

export function listConnections(
  db: Database = metadataDb(),
  now: Date = new Date(),
): PgConnection[] {
  const rows = db
    .prepare(`SELECT * FROM pg_connections ORDER BY created_at, name`)
    .all() as Row[];
  return rows.map((row) => fromRow(row, now));
}

export function getConnection(
  id: string,
  db: Database = metadataDb(),
  now: Date = new Date(),
): PgConnection | null {
  const row = db
    .prepare(`SELECT * FROM pg_connections WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? fromRow(row, now) : null;
}

/** Best-effort status memory. A bookkeeping failure never changes the
 * source operation's own result, and the log carries no error detail that
 * could contain a submitted credential. */
export function recordConnectionCheck(
  id: string,
  check: ConnectionCheck,
  db: Database = metadataDb(),
): boolean {
  try {
    const checkedAt = check.checkedAt ?? new Date().toISOString();
    const info = db
      .prepare(
        `UPDATE pg_connections
         SET last_checked_at = ?,
             last_check_outcome = ?,
             last_check_error = ?,
             server_version = COALESCE(?, server_version),
             postgis_version = CASE
               WHEN ? = 'no_postgis' THEN NULL
               ELSE COALESCE(?, postgis_version)
             END
         WHERE id = ?`,
      )
      .run(
        checkedAt,
        check.outcome,
        check.outcome === "failing" ? (check.error ?? "The last check failed.") : null,
        check.serverVersion ?? null,
        check.outcome,
        check.postgisVersion ?? null,
        id,
      );
    return info.changes > 0;
  } catch {
    console.error("[connections] status memory could not be recorded.");
    return false;
  }
}

/** Internal-only: the decrypted password for attach strings. Never expose
 * through any API response (write-only credentials). */
export function connectionPassword(
  id: string,
  db: Database = metadataDb(),
): string | null {
  const row = db
    .prepare(`SELECT password_encrypted FROM pg_connections WHERE id = ?`)
    .get(id) as { password_encrypted: string } | undefined;
  return row ? decryptSecret(row.password_encrypted) : null;
}

export function renameConnection(
  id: string,
  name: string,
  db: Database = metadataDb(),
): boolean {
  return (
    db.prepare(`UPDATE pg_connections SET name = ? WHERE id = ?`).run(name, id)
      .changes > 0
  );
}

/** Replace the editable fields only after the caller has accepted the merged
 * candidate. The id, created time, and status memory stay on the same row. */
export function updateConnection(
  id: string,
  values: PgConnectionUpdate,
  db: Database = metadataDb(),
): PgConnection | null {
  const info = db
    .prepare(
      `UPDATE pg_connections
       SET name = ?, host = ?, port = ?, database = ?, username = ?,
           password_encrypted = ?, ssl = ?
       WHERE id = ?`,
    )
    .run(
      values.name,
      values.host,
      values.port,
      values.database,
      values.username,
      encryptSecret(values.password),
      values.ssl ? 1 : 0,
      id,
    );
  return info.changes > 0 ? getConnection(id, db) : null;
}

export function deleteConnection(
  id: string,
  db: Database = metadataDb(),
): boolean {
  return (
    db.prepare(`DELETE FROM pg_connections WHERE id = ?`).run(id).changes > 0
  );
}
