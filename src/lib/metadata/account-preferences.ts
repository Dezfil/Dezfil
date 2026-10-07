import type { Database } from "better-sqlite3";
import { normalizeLook, type Look } from "@/lib/look";
import { metadataDb } from "./db";
import type { ViewPrefs } from "./settings";

/** How the SQL console's source list groups datasets: by person (one's own,
 * then each other person's) or by project. */
export type SourceGrouping = "person" | "project";
export const SOURCE_GROUPINGS: readonly SourceGrouping[] = ["person", "project"];

/** One account's list preferences, stored as one document: each screen's
 * view and sort, and the source list's grouping and the look beside them. */
type Stored = ViewPrefs & { sourceGrouping?: SourceGrouping; look?: unknown };

function stored(accountId: string, db: Database): Stored {
  const row = db.prepare("SELECT view_prefs FROM account_preferences WHERE account_id = ?")
    .get(accountId) as { view_prefs: string } | undefined;
  return row ? JSON.parse(row.view_prefs) as Stored : {};
}

function store(accountId: string, document: Stored, db: Database): void {
  db.prepare(`INSERT INTO account_preferences (account_id, view_prefs, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (account_id) DO UPDATE SET view_prefs = excluded.view_prefs,
    updated_at = excluded.updated_at`).run(accountId, JSON.stringify(document), new Date().toISOString());
}

export function accountViewPrefs(accountId: string, db: Database = metadataDb()): ViewPrefs {
  const prefs = stored(accountId, db);
  delete prefs.sourceGrouping;
  return prefs;
}

/** Replace the view preferences whole, keeping the source-list grouping. */
export function setAccountViewPrefs(accountId: string, prefs: ViewPrefs,
  db: Database = metadataDb()): void {
  const { sourceGrouping } = stored(accountId, db);
  store(accountId, { ...prefs, ...(sourceGrouping ? { sourceGrouping } : {}) }, db);
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

/** The account's source-list grouping: by person until it chooses otherwise. */
export function accountSourceGrouping(accountId: string, db: Database = metadataDb()): SourceGrouping {
  return stored(accountId, db).sourceGrouping === "project" ? "project" : "person";
}

/** The account's look, every pick at its kept value or its default. A value
 * this version does not offer reads as the default and is left as stored. */
export function accountLook(accountId: string, db: Database = metadataDb()): Look {
  return normalizeLook((stored(accountId, db) as Stored | null)?.look);
}

/** Remember the account's source-list grouping, leaving its view preferences as they are. */
export function setAccountSourceGrouping(accountId: string, grouping: SourceGrouping,
  db: Database = metadataDb()): void {
  db.transaction(() => store(accountId, { ...stored(accountId, db), sourceGrouping: grouping }, db)).immediate();
}
