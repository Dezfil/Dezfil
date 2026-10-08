import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { settingDefinition } from "@/lib/settings/catalogue";
import { readStoredSettings } from "@/lib/settings/store";

const DAY_MS = 86_400_000;

/** How long sign-ins and links last, when failed sign-ins pause and the
 * shortest password, in the units the auth code applies them. */
export interface SecuritySettings {
  /** A session's length: issue and every renewal set its expiry this far ahead. */
  readonly sessionMs: number;
  /** An invitation's or an admin reset link's lifetime from its issue. */
  readonly linkMs: number;
  /** Failed sign-ins for one account within the window before its next attempt pauses. */
  readonly failedPerAccount: number;
  /** Failed sign-ins from one address within the window before its next attempt pauses. */
  readonly failedPerAddress: number;
  /** The fewest characters a password set from now may have. */
  readonly passwordMin: number;
  /** How long a token made now lasts, as the rule names it. */
  readonly tokenExpiry: TokenExpiry;
  /** The same in milliseconds from creation; null under Never. */
  readonly tokenLifetimeMs: number | null;
}

export type TokenExpiry = "never" | "30d" | "90d" | "1y";
/** A year is 365 days, like the other lifetimes counted in days. */
const TOKEN_LIFETIME_DAYS: Readonly<Record<TokenExpiry, number | null>> = { never: null, "30d": 30, "90d": 90, "1y": 365 };

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
  const tokenExpiry = (stored["tokens.expiry"] ?? settingDefinition("tokens.expiry").defaultValue) as TokenExpiry;
  const days = TOKEN_LIFETIME_DAYS[tokenExpiry];
  return {
    sessionMs: value("security.sessionDays") * DAY_MS,
    linkMs: value("security.linkDays") * DAY_MS,
    failedPerAccount: value("security.failedPerAccount"),
    failedPerAddress: value("security.failedPerAddress"),
    passwordMin: value("security.passwordMin"),
    tokenExpiry,
    tokenLifetimeMs: days === null ? null : days * DAY_MS,
  };
}
