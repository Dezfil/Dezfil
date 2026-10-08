import { INSTANCE_SECURITY_SETTINGS } from "./instance-security";

/**
 * The rules every signed-in account follows, as the runtime read reports them:
 * who may create API tokens, how long a new one lasts, who may publish, how far
 * published pages embed, who may add database connections and who may import
 * from links. Keyed and valued as the change operation takes them.
 *
 * Data and one decision only, so the screens and the services read the same
 * sentence: a screen draws an action disabled with it, and the service that
 * takes the action refuses with it.
 */
export const RULE_KEYS = [
  "tokens.create", "tokens.expiry", "publishing.publish", "publishing.embedding", "connections.create", "imports.links",
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

type Row = (typeof INSTANCE_SECURITY_SETTINGS)[number];
type ChoiceOf<K extends RuleKey> = Extract<Row, { key: K }>["write"] extends { readonly values: readonly (infer V)[] } ? V : never;
/** Each rule's value, one of its choices. */
export type InstanceRules = { readonly [K in RuleKey]: ChoiceOf<K> };

/** The four rules that decide who may take an action. A narrowed one refuses
 * new reach and takes nothing away: what already exists keeps working. */
export const WHO_MAY_RULES = ["tokens.create", "publishing.publish", "connections.create", "imports.links"] as const;
export type WhoMayRule = (typeof WHO_MAY_RULES)[number];

/** What a person Admins only excludes reads, in the product's member form. */
const ADMINS_ONLY: Readonly<Record<WhoMayRule, string>> = {
  "tokens.create": "Only admins can create tokens on this instance.",
  "publishing.publish": "Only admins can publish maps on this instance.",
  "connections.create": "Only admins can add database connections on this instance.",
  "imports.links": "Only admins can import from links on this instance.",
};
/** No one is publishing's alone, and stops admins too. */
const NO_ONE = "No one can publish maps on this instance.";

/**
 * The sentence for a person this rule's value excludes, or null when it lets
 * them through: Everyone lets everyone through, Admins only lets admins
 * through, No one lets nobody through. A value the rule does not know lets
 * everyone through, as Everyone does.
 */
export function ruleRefusal(key: WhoMayRule, value: unknown, isAdmin: boolean): string | null {
  if (value === "admins") return isAdmin ? null : ADMINS_ONLY[key];
  if (value === "none" && key === "publishing.publish") return NO_ONE;
  return null;
}
