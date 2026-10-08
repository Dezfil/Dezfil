import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { settingDefinition } from "@/lib/settings/catalogue";
import { readStoredSettings } from "@/lib/settings/store";

const DAY_MS = 86_400_000;

/** How long sign-ins and links last and when failed sign-ins pause, in the
 * units the auth code applies them. */
export interface SecuritySettings {
  /** A session's length: issue and every renewal set its expiry this far ahead. */
  readonly sessionMs: number;
  /** An invitation's or an admin reset link's lifetime from its issue. */
  readonly linkMs: number;
  /** Failed sign-ins for one account within the window before its next attempt pauses. */
  readonly failedPerAccount: number;
  /** Failed sign-ins from one address within the window before its next attempt pauses. */
  readonly failedPerAddress: number;
}

/**
 * The Security rows, resolved from the store on every call: the stored value
 * where the catalogue accepts it, else the product's own. Nothing is kept
 * between calls, so a save applies from the next issue, renewal or attempt
 * without a restart, and a caller hands it the store its transaction holds.
 * The auth code reads these rows here and nowhere else.
 */
export function securitySettings(db: Database = metadataDb()): SecuritySettings {
  const stored = readStoredSettings(db);
  const value = (key: string) => Number(stored[key] ?? settingDefinition(key).defaultValue);
  return {
    sessionMs: value("security.sessionDays") * DAY_MS,
    linkMs: value("security.linkDays") * DAY_MS,
    failedPerAccount: value("security.failedPerAccount"),
    failedPerAddress: value("security.failedPerAddress"),
  };
}
