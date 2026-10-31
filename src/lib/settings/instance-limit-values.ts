import type { Database } from "better-sqlite3";
import { readStoredSettings } from "./store";
import { resolveChoice, resolveNumericSetting, type ResolvedSetting } from "./resolver";
import type { NumericOverrides } from "./state";
import type { SettingValue } from "./types";

/** Read from the caller's transaction, including changes made by another connection. */
export function countLimitValues(db: Database) {
  const input = { stored: readStoredSettings(db) as NumericOverrides };
  return {
    maps: resolveNumericSetting("mapsLimit", input).value,
    projects: resolveNumericSetting("projectsLimit", input).value,
    people: resolveNumericSetting("peopleLimit", input).value,
  };
}

export type TokenLifetimeMax = "none" | "30d" | "90d" | "1y";
export function tokenLifetimeMax(stored: Readonly<Record<string, SettingValue>>): ResolvedSetting<TokenLifetimeMax> {
  return resolveChoice("tokenLifetimeMax", stored) as ResolvedSetting<TokenLifetimeMax>;
}
