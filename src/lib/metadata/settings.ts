import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

/**
 * Instance settings and legacy personal values retained for first-account
 * adoption. Authenticated personal reads and writes use account storage.
 */

const DISPLAY_NAME_KEY = "display_name";

export const DEFAULT_DISPLAY_NAME = "Dezfil User";

export function getSetting(
  key: string,
  db: Database = metadataDb(),
): string | null {
  const row = db
    .prepare(`SELECT value FROM workspace_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(
  key: string,
  value: string,
  db: Database = metadataDb(),
): void {
  db.prepare(
    `INSERT INTO workspace_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

export function displayName(db: Database = metadataDb()): string {
  return getSetting(DISPLAY_NAME_KEY, db) ?? DEFAULT_DISPLAY_NAME;
}

export function setDisplayName(name: string, db: Database = metadataDb()): void {
  setSetting(DISPLAY_NAME_KEY, name, db);
}

/** Per-screen view preferences: how the Maps and Data screens
 * were last arranged. Stored whole under one key; screens patch their own
 * slice and the merge happens here. */

/** The instance's optional name: absent = unnamed. */
const INSTANCE_NAME_KEY = "instance_name";

export function instanceName(db: Database = metadataDb()): string | null {
  return getSetting(INSTANCE_NAME_KEY, db);
}

/** Null clears — an unnamed instance is a real state, not a default. */
export function setInstanceName(
  name: string | null,
  db: Database = metadataDb(),
): void {
  if (name === null) {
    db.prepare(`DELETE FROM workspace_settings WHERE key = ?`).run(
      INSTANCE_NAME_KEY,
    );
    return;
  }
  setSetting(INSTANCE_NAME_KEY, name, db);
}

const VIEW_PREFS_KEY = "view_prefs";

export interface ScreenPrefs {
  view?: "grid" | "list";
  sort?: string;
}

export interface ViewPrefs {
  maps?: ScreenPrefs;
  data?: ScreenPrefs;
  /** The workflows list, remembered like the others. */
  workflows?: ScreenPrefs;
  /** The Projects list, remembered like the others. */
  projects?: ScreenPrefs;
}

export function viewPrefs(db: Database = metadataDb()): ViewPrefs {
  const raw = getSetting(VIEW_PREFS_KEY, db);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ViewPrefs;
  } catch {
    return {};
  }
}

export function mergeViewPrefs(
  patch: ViewPrefs,
  db: Database = metadataDb(),
): ViewPrefs {
  const current = viewPrefs(db);
  const next: ViewPrefs = {
    maps: { ...current.maps, ...patch.maps },
    data: { ...current.data, ...patch.data },
    workflows: { ...current.workflows, ...patch.workflows },
    // Present only once written, so older stores keep their exact shape.
    ...(current.projects || patch.projects
      ? { projects: { ...current.projects, ...patch.projects } }
      : {}),
  };
  setSetting(VIEW_PREFS_KEY, JSON.stringify(next), db);
  return next;
}
