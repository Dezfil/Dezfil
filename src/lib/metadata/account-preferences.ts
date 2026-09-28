import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";
import type { ViewPrefs } from "./settings";

export function accountViewPrefs(accountId: string, db: Database = metadataDb()): ViewPrefs {
  const row = db.prepare("SELECT view_prefs FROM account_preferences WHERE account_id = ?")
    .get(accountId) as { view_prefs: string } | undefined;
  return row ? JSON.parse(row.view_prefs) as ViewPrefs : {};
}

export function setAccountViewPrefs(accountId: string, prefs: ViewPrefs,
  db: Database = metadataDb()): void {
  db.prepare(`INSERT INTO account_preferences (account_id, view_prefs, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (account_id) DO UPDATE SET view_prefs = excluded.view_prefs,
    updated_at = excluded.updated_at`).run(accountId, JSON.stringify(prefs), new Date().toISOString());
}

/** Merge under the write lock so different screens cannot overwrite each other. */
export function mergeAccountViewPrefs(accountId: string, patch: ViewPrefs,
  db: Database = metadataDb()): ViewPrefs {
  return db.transaction(() => {
    const next = accountViewPrefs(accountId, db);
    for (const screen of ["maps", "data", "workflows", "projects"] as const) {
      if (patch[screen]) next[screen] = { ...next[screen], ...patch[screen] };
    }
    setAccountViewPrefs(accountId, next, db);
    return next;
  }).immediate();
}
