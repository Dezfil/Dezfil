import { accountChoices } from "@/lib/settings/account";

/**
 * One account's look: seven picks and the eight kinds of surface Liquid
 * reaches, each an account choice in the settings catalogue, whose first
 * value is today's look and the default. The look is the person's screen
 * only. It is kept with the account, read whole (every pick at a value this
 * version offers), and stamped on the document's root as one
 * `data-look-<pick>` attribute per pick that differs from the default,
 * which the look's stylesheets turn into token overrides. The kinds share
 * one attribute, `data-look-liquid`, carried only while Panels is Liquid:
 * the words of the kinds that are on, in the kinds' order, so a stylesheet
 * keys a kind by its word and Glass or Paper leave nothing of them.
 *
 * Data only, and safe for a browser bundle: the server reads an account's
 * stored look through its preferences, and the page stamps a new pick with
 * the same attribute map.
 */
export const LOOK_KEYS = ["color", "contrast", "font", "background", "corners", "rail", "panels",
  "liquidChrome", "liquidPanels", "liquidMap", "liquidButtons", "liquidCards", "liquidInner", "liquidMenus", "liquidDialogs"] as const;
export type LookKey = (typeof LOOK_KEYS)[number];
export type Look = { readonly [K in LookKey]: string };

/** The kinds of surface Liquid reaches, each with the word the root names it by. */
export const LIQUID_KINDS = [
  ["liquidChrome", "chrome"], ["liquidPanels", "panels"], ["liquidMap", "map"], ["liquidButtons", "buttons"],
  ["liquidCards", "cards"], ["liquidInner", "inner"], ["liquidMenus", "menus"], ["liquidDialogs", "dialogs"],
] as const satisfies readonly (readonly [LookKey, string])[];
export type LiquidKind = (typeof LIQUID_KINDS)[number][0];
/** The picks the root names by an attribute of their own. */
type OwnPick = Exclude<LookKey, LiquidKind>;

export type LookAttributes =
  & { readonly [K in OwnPick as `data-look-${K}`]?: string }
  & { readonly "data-look-liquid"?: string };

/** Every attribute a look can put on the root, so a stamp removes what no longer applies. */
export const LOOK_ATTRIBUTES = ["data-look-color", "data-look-contrast", "data-look-font", "data-look-background",
  "data-look-corners", "data-look-rail", "data-look-panels", "data-look-liquid"] as const satisfies readonly (keyof LookAttributes)[];
const KIND_KEYS: readonly string[] = LIQUID_KINDS.map(([key]) => key);

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
 * the default, so Dezfil's default look carries none, and under Liquid the
 * kinds that are on as one word list, absent when none is. */
export function lookAttributes(look: Partial<Record<LookKey, unknown>>): LookAttributes {
  const read = normalizeLook(look);
  const attributes: Record<string, string> = Object.fromEntries(LOOK_KEYS.filter(key => !KIND_KEYS.includes(key) && read[key] !== lookChoices(key)[0])
    .map(key => [`data-look-${key}`, read[key]]));
  const words = read.panels === "liquid" ? LIQUID_KINDS.filter(([key]) => read[key] === "on").map(([, word]) => word) : [];
  if (words.length) attributes["data-look-liquid"] = words.join(" ");
  return attributes as LookAttributes;
}
