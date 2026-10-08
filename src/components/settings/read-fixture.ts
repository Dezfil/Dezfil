import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { disclosedDefinition } from "@/lib/settings/disclosure";
import type { InstanceRead } from "./instance-read";
import type { ReadSetting } from "./server-set";

const EMPTY_CACHE = (budgetMb: number) => ({ bytes: 0, answers: 0, budgetMb });

/**
 * For tests: a configuration read shaped as the server answers it, every
 * definition it carries (none of an account's) in the catalogue's order,
 * each at its disclosed default unless `resolved` says how it resolved.
 */
export type Resolution = Partial<Pick<ReadSetting, "value" | "source" | "locked" | "invalidOverride" | "storedValue">>;

export function instanceReadFixture(resolved: Readonly<Record<string, Resolution>> = {},
  facts: Partial<Omit<InstanceRead, "settings">> = {}): InstanceRead {
  const settings = Object.fromEntries(SETTING_CATALOGUE.filter(definition => definition.scope !== "account").map(definition => {
    const disclosed = disclosedDefinition(definition);
    const setting = { ...disclosed, value: disclosed.defaultValue, source: "default", locked: false, invalidOverride: false, storedValue: null, ...resolved[definition.key] };
    return [definition.key, setting as ReadSetting];
  }));
  return {
    settings, capacities: { geocodeRows: 27, isochroneOrigins: 13 }, maxImageDimension: 4096,
    version: "0.1.0", startedAt: "2026-10-04T09:00:00.000Z", warnings: [],
    // As a fresh data folder reports them: every cache empty, no release list taken yet.
    services: { geocode: EMPTY_CACHE(64), isochrone: EMPTY_CACHE(64), overpass: EMPTY_CACHE(2048), overture: { listed: false } },
    ...facts,
  };
}

/** The read after stored values: each a stored source, or the default for a null. */
export function storedRead(stored: Readonly<Record<string, unknown>>, facts: Partial<Omit<InstanceRead, "settings">> = {}): InstanceRead {
  return instanceReadFixture(Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => [key, { value, source: "stored", storedValue: value }])), facts);
}
