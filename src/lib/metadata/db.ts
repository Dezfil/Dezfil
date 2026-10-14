import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { dataDir } from "@/lib/config";
import { enableWal } from "./busy";
import { MIGRATIONS } from "./migrations";
import { allocateSqlNames, type SqlNameIdentity } from "./sql-names";
import { IDENTITIES_MIGRATION, rebuildIdentities } from "./migrations-identities";
import { activateSettingsStore, observeSettingsStore } from "@/lib/settings/store";

export { MIGRATIONS } from "./migrations";

/**
 * Metadata store. SQLite is the recorded stack deviation (spec, open
 * question 1): everything goes through this module and the repositories next
 * to it so the swap to Postgres touches only this area. Keep the SQL in
 * repositories portable — no SQLite-specific syntax.
 */

const key = Symbol.for("dezfil.metadata-store");
const host = process as typeof process & { [key]?: { instance: Database.Database | null } };
const store: NonNullable<typeof host[typeof key]> = host[key] ??= { instance: null };

export function metadataDb(): Database.Database {
  if (!store.instance?.open) {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    const db = open(path.join(dir, "metadata.sqlite"));
    try { activateSettingsStore(db); }
    catch (error) { db.close(); throw error; }
    store.instance = db;
  }
  return store.instance;
}

/** Open (and migrate) a metadata database at an explicit path — used by tests. */
export function open(file: string): Database.Database {
  const db = new Database(file);
  try {
    enableWal(db);
    db.pragma("foreign_keys = ON");
    migrate(db);
    observeSettingsStore(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrate(db: Database.Database): void {
  // Migrations that derive values with the application's own rules call
  // them as SQL functions, so one derivation serves upgrade and creation.
  db.function("allocate_sql_names", { deterministic: true }, (accounts: unknown) =>
    JSON.stringify(allocateSqlNames(JSON.parse(String(accounts)) as SqlNameIdentity[])));
  for (;;) {
    const next = db.transaction(() => {
      // Read only after admission to the write transaction. Another opener
      // may have advanced any number of migrations while this one waited.
      const applied = db.pragma("user_version", { simple: true }) as number;
      if (applied >= MIGRATIONS.length) return null;
      if (MIGRATIONS[applied] !== IDENTITIES_MIGRATION) {
        db.exec(MIGRATIONS[applied]);
        db.pragma(`user_version = ${applied + 1}`);
      }
      return applied;
    }).immediate();
    if (next === null) return;
    // Foreign-key enforcement must change outside a transaction. The rebuild
    // acquires its own write lock and rechecks the version before doing work.
    if (MIGRATIONS[next] === IDENTITIES_MIGRATION) rebuildIdentities(db, MIGRATIONS[next], next + 1);
  }
}

/** Reset every route bundle's singleton and its settings snapshot together.
 * Explicit stores keep their independent connection lifetime. */
export function closeMetadataDb(): void {
  if (store.instance?.open) store.instance.close();
  store.instance = null;
}
