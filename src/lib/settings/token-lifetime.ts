import { settingDefinition } from "./catalogue";
import { tokenLifetimeMax } from "./instance-limit-values";
import type { SettingValue } from "./types";

export type TokenExpiry = "never" | "30d" | "90d" | "1y";
/** A year is 365 days, like the other lifetimes counted in days. */
export const TOKEN_LIFETIME_DAYS: Readonly<Record<TokenExpiry, number | null>> = { never: null, "30d": 30, "90d": 90, "1y": 365 };

export function offeredTokenLifetimes(stored: Readonly<Record<string, SettingValue>>): TokenExpiry[] {
  const bound = tokenLifetimeMax(stored).value;
  const choices: TokenExpiry[] = ["never", "30d", "90d", "1y"];
  return bound === "none" ? choices : choices.filter(choice => choice !== "never" && TOKEN_LIFETIME_DAYS[choice]! <= TOKEN_LIFETIME_DAYS[bound]!);
}

/** Report the effective rule without rewriting its stored choice or any credential. */
export function effectiveTokenExpiry(stored: Readonly<Record<string, SettingValue>>): TokenExpiry {
  const chosen = (stored["tokens.expiry"] ?? settingDefinition("tokens.expiry").defaultValue) as TokenExpiry;
  const offer = offeredTokenLifetimes(stored);
  return offer.includes(chosen) ? chosen : offer[offer.length - 1];
}
