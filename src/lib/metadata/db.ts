import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { dataDir } from "@/lib/config";
import { MIGRATIONS } from "./migrations";

export { MIGRATIONS } from "./migrations";

/**
 * Metadata store. SQLite is the recorded stack deviation (spec, open
 * question 1): everything goes through this module and the repositories next
 * to it so the swap to Postgres touches only this area. Keep the SQL in
 * repositories portable — no SQLite-specific syntax.
 */

let instance: Database.Database | null = null;

export function metadataDb(): Database.Database {
  if (!instance) {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    instance = open(path.join(dir, "metadata.sqlite"));
  }
  return instance;
}

/** Open (and migrate) a metadata database at an explicit path — used by tests. */
export function open(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const applied = db.pragma("user_version", { simple: true }) as number;
  for (let v = applied; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Reset the singleton — used by tests that point DEZFIL_DATA_DIR elsewhere. */
export function closeMetadataDb(): void {
  instance?.close();
  instance = null;
}
