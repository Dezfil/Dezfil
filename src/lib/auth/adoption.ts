import type { Database } from "better-sqlite3";
import { setAccountViewPrefs } from "@/lib/metadata/account-preferences";
import { viewPrefs } from "@/lib/metadata/settings";

/** Runs inside the first-account transaction, including personal-key retirement. */
export function adoptLegacyPreferences(accountId: string, db: Database): void {
  setAccountViewPrefs(accountId, viewPrefs(db), db);
  db.prepare("DELETE FROM workspace_settings WHERE key IN ('display_name', 'view_prefs')").run();
}
