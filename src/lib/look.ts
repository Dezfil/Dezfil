import { accountChoices } from "@/lib/settings/account";

/**
 * One account's look: eight picks, each an account choice in the settings
 * catalogue, whose first value is today's look and the default. The look
 * is the person's screen only. It is kept with the account, read whole
 * (every pick at a value this version offers), and stamped on the
 * document's root as one `data-look-<pick>` attribute per pick that
 * differs from the default, which the look's stylesheets turn into token
 * overrides.
 *
 * Data only, and safe for a browser bundle: the server reads an account's
 * stored look through its preferences, and the page stamps a new pick with
 * the same attribute map.
 */
export const LOOK_KEYS = ["color", "contrast", "font", "background", "corners", "rail", "panels", "transparency"] as const;
export type LookKey = (typeof LOOK_KEYS)[number];
export type Look = { readonly [K in LookKey]: string };

export type LookAttributes = { readonly [K in LookKey as `data-look-${K}`]?: string };

/** Every attribute a look can put on the root, so a stamp removes what no longer applies. */
export const LOOK_ATTRIBUTES = ["data-look-color", "data-look-contrast", "data-look-font", "data-look-background",
  "data-look-corners", "data-look-rail", "data-look-panels", "data-look-transparency"] as const satisfies readonly (keyof LookAttributes)[];

/** The values a pick offers, today's first. */
export function lookChoices(key: LookKey): readonly string[] {
  return accountChoices(`look.${key}`);
}

/** Dezfil's default look: every pick at today's value. */
export function defaultLook(): Look {
  return Object.fromEntries(LOOK_KEYS.map(key => [key, lookChoices(key)[0]])) as Look;
}

/** A stored look read whole. A missing pick, or a value this version does not
 * offer (a retired choice, a value of the wrong kind), reads as that pick's
 * default; picks this version does not have are dropped. Nothing is written
 * back: a retired value stays stored until the person picks again. */
export function normalizeLook(stored: unknown): Look {
  const source = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  return Object.fromEntries(LOOK_KEYS.map(key => {
    const value: unknown = Object.hasOwn(source, key) ? (source as Record<string, unknown>)[key] : undefined;
    const choices = lookChoices(key);
    return [key, typeof value === "string" && choices.includes(value) ? value : choices[0]];
  })) as Look;
}

/** The root element's attributes for a look: only the picks that differ from
 * the default, so Dezfil's default look carries none. */
export function lookAttributes(look: Partial<Record<LookKey, unknown>>): LookAttributes {
  const read = normalizeLook(look);
  return Object.fromEntries(LOOK_KEYS.filter(key => read[key] !== lookChoices(key)[0])
    .map(key => [`data-look-${key}`, read[key]])) as LookAttributes;
}
