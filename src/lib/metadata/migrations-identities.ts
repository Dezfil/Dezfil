import type { Database } from "better-sqlite3";

/** The opener disables foreign keys before this referenced-table rebuild.
 * Its transaction restores the original indexes/triggers and checks integrity
 * before committing. No existing row is transformed. */
export const IDENTITIES_MIGRATION = `
  CREATE TABLE accounts_rebuilt (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    password_hash TEXT,
    is_admin INTEGER DEFAULT 0 CHECK (is_admin IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'deactivated', 'deleting', 'deleted')),
    created_at TEXT,
    updated_at TEXT,
    last_sign_in_at TEXT,
    sql_name TEXT NOT NULL,
    CHECK ((status = 'deleted' AND name IS NULL AND email IS NULL AND password_hash IS NULL
      AND is_admin IS NULL AND created_at IS NULL AND updated_at IS NULL AND last_sign_in_at IS NULL)
      OR (status != 'deleted' AND name IS NOT NULL AND email IS NOT NULL AND is_admin IS NOT NULL
        AND created_at IS NOT NULL AND updated_at IS NOT NULL))
  );
  INSERT INTO accounts_rebuilt SELECT * FROM accounts;
  DROP TABLE accounts;
  ALTER TABLE accounts_rebuilt RENAME TO accounts;
`;

interface SchemaEntry { type: string; name: string; tbl_name: string; sql: string | null }
function schema(db: Database): SchemaEntry[] {
  return db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE NOT (type = 'table' AND name = 'accounts') ORDER BY type, name`).all() as SchemaEntry[];
}

/** Must run outside a transaction: SQLite ignores foreign_keys changes inside
 * one. legacy_alter_table prevents the temporary absence of accounts from
 * rewriting or rejecting other tables' unchanged trigger definitions. */
export function rebuildIdentities(db: Database, sql: string, version: number): void {
  if (db.inTransaction) throw new Error("Identity migration requires its own transaction.");
  const legacy = db.pragma("legacy_alter_table", { simple: true });
  try {
    db.pragma("foreign_keys = OFF");
    db.pragma("legacy_alter_table = ON");
    db.transaction(() => {
      const before = schema(db);
      db.exec(sql);
      for (const entry of before) {
        if (entry.tbl_name === "accounts" && entry.sql) db.exec(entry.sql);
      }
      if (JSON.stringify(schema(db)) !== JSON.stringify(before)) throw new Error("Identity migration changed unrelated schema.");
      if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("Identity migration failed foreign key integrity.");
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error("Identity migration failed store integrity.");
      db.pragma(`user_version = ${version}`);
    }).immediate();
  } finally {
    db.pragma(`legacy_alter_table = ${legacy ? "ON" : "OFF"}`);
    db.pragma("foreign_keys = ON");
  }
}
