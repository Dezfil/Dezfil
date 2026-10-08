import type { INSTANCE_SECURITY_SETTINGS } from "@/lib/settings/instance-security";
import { inLabels } from "./limits-table";
import type { ReadSetting } from "./server-set";

/**
 * The rows of the Security tab's two cards (Sign-in, API tokens), of
 * Publishing's Public links card and of Data & services' Connections and
 * imports card, under the labels the page shows, mapped
 * by key onto the configuration read. The read supplies what a choice
 * offers, a number's range, the default and the kept value; this table
 * supplies the words, the order, how each row is drawn, the unit written
 * after a number and the quiet line a choice opens under its row. A test
 * holds it against the read, so a new row with no entry here fails.
 */

export type RuleKey = (typeof INSTANCE_SECURITY_SETTINGS)[number]["key"];

/** One setting a row draws, with the unit written after a number and,
 * where a row draws several, its own names. */
export interface RuleField {
  readonly key: RuleKey;
  /** Its name before a red line, where the row draws several. */
  readonly label?: string;
  /** Its accessible name, where the row draws several. */
  readonly name?: string;
  readonly unit?: string;
}

/** A quiet line under a row, shown while its choice holds a value it names. */
export interface RuleNote {
  readonly when: (value: unknown) => boolean;
  readonly text: string;
}

export interface RuleRow {
  /** The row's address inside its tab. */
  readonly id: string;
  readonly label: string;
  /** The quiet line under the label. */
  readonly meta?: string;
  /** Words the search also finds the row by. */
  readonly keys: string;
  /** A list of choices, segments, numbers, or a choice that opens a list of sites. */
  readonly draw: "select" | "segments" | "numbers" | "sites";
  readonly fields: readonly RuleField[];
  /** Quiet words after the control. */
  readonly after?: string;
  readonly notes?: readonly RuleNote[];
}

export interface RuleCard {
  readonly id: string;
  readonly title: string;
  /** Words the search matches the card by. */
  readonly keys: string;
  readonly rows: readonly RuleRow[];
}

const one = (key: RuleKey, unit?: string): readonly RuleField[] => [{ key, ...(unit ? { unit } : {}) }];

export const SECURITY_CARDS: readonly RuleCard[] = [
  { id: "security-sign-in", title: "Sign-in", keys: "sign in login session password", rows: [
    { id: "set-session-length", label: "Stay signed in for", meta: "Counted from the last visit.", draw: "select",
      keys: "session length lifetime cookie expire sign out logout", fields: one("security.sessionDays") },
    { id: "set-link-lifetime", label: "Invite and reset links last", draw: "select",
      keys: "invitation invite reset password link expire lifetime", fields: one("security.linkDays") },
    { id: "set-sign-in-attempts", label: "Failed sign-ins before a pause", draw: "numbers", after: "within 15 minutes",
      keys: "rate limit lockout attempts brute force wrong password", fields: [
        { key: "security.failedPerAccount", label: "Per account", name: "Failed sign-ins per account", unit: "per account" },
        { key: "security.failedPerAddress", label: "Per address", name: "Failed sign-ins per address", unit: "per address" },
      ] },
    { id: "set-password-length", label: "Shortest password", meta: "Checked when a password is next set.", draw: "numbers",
      keys: "password minimum length characters policy", fields: one("security.passwordMin", "characters") },
  ] },
  { id: "security-tokens", title: "API tokens", keys: "api mcp token tokens", rows: [
    { id: "set-who-tokens", label: "Who may create tokens", draw: "segments", keys: "api mcp tokens create members admins permission",
      fields: one("tokens.create"), notes: [{ when: value => value === "admins", text: "Tokens members already have keep working." }] },
    { id: "set-token-expiry", label: "New tokens expire after", draw: "select", keys: "api mcp token expiry expire lifetime",
      fields: one("tokens.expiry"), notes: [{ when: value => value !== "never", text: "Tokens made earlier keep their own expiry." }] },
  ] },
];

export const PUBLIC_LINKS_CARD: RuleCard = {
  id: "publishing-public", title: "Public links", keys: "publish public share anonymous link", rows: [
    { id: "set-who-may-publish", label: "Who may publish", draw: "segments", keys: "publish share public link permission members admins nobody off",
      fields: one("publishing.publish"), notes: [{ when: value => value !== "everyone", text: "Maps already published stay public until they are unpublished." }] },
    { id: "set-embedding", label: "Embedding on other sites", draw: "sites",
      keys: "embed embedding iframe frame website intranet code sites listed allowed",
      fields: [{ key: "publishing.embedding" }, { key: "publishing.embedSites", label: "Listed sites", name: "Sites that may embed published maps" }],
      notes: [{ when: value => value === "off", text: "Embed code already on other sites stops showing the map." }] },
  ],
};

/** Data & services' card on who may add database connections and import
 * from links: rules every account follows, drawn as Security's are. */
export const CONNECTIONS_CARD: RuleCard = {
  id: "data-who", title: "Connections and imports", keys: "permission members admins who may", rows: [
    { id: "set-who-connects", label: "Who may add database connections", draw: "segments",
      keys: "postgis database connection create add members admins", fields: one("connections.create"),
      notes: [{ when: value => value === "admins", text: "Members keep the connections they already have." }] },
    { id: "set-who-imports", label: "Who may import from links", meta: "Web addresses and cloud storage", draw: "segments",
      keys: "url import link remote s3 http download members admins", fields: one("imports.links") },
  ],
};

/** Every row the Security tab and the Public links card draw, top to bottom. */
export function ruleRows(): RuleRow[] {
  return [...SECURITY_CARDS, PUBLIC_LINKS_CARD].flatMap(card => card.rows);
}

type ChoiceKey = "security.sessionDays" | "security.linkDays" | "tokens.create" | "tokens.expiry" | "publishing.publish" | "publishing.embedding"
  | "connections.create" | "imports.links";

/** The words each choice is shown with, in the order the read offers them. */
export const RULE_CHOICE_WORDS: { readonly [K in ChoiceKey]: Readonly<Record<string, string>> } = {
  "security.sessionDays": { "1": "1 day", "7": "7 days", "30": "30 days", "90": "90 days" },
  "security.linkDays": { "1": "1 day", "3": "3 days", "7": "7 days", "14": "14 days" },
  "tokens.create": { everyone: "Everyone", admins: "Admins only" },
  "tokens.expiry": { never: "Never", "30d": "30 days", "90d": "90 days", "1y": "1 year" },
  "publishing.publish": { everyone: "Everyone", admins: "Admins only", none: "No one" },
  "publishing.embedding": { any: "Any site", listed: "Listed sites", off: "Off" },
  "connections.create": { everyone: "Everyone", admins: "Admins only" },
  "imports.links": { everyone: "Everyone", admins: "Admins only" },
};

/** A choice's words; a value it does not word shows as itself. */
export function ruleChoiceWords(key: string, value: unknown): string {
  return (RULE_CHOICE_WORDS as Readonly<Record<string, Readonly<Record<string, string>>>>)[key]?.[String(value)] ?? String(value ?? "");
}

/** The label each setting is named by in a refusal, by key. */
export const RULE_LABELS: Readonly<Record<string, string>> = Object.fromEntries([...ruleRows(), ...CONNECTIONS_CARD.rows].flatMap(row =>
  row.fields.map(field => [field.key, field.name ?? row.label])));

/** The refusals of two rows that only hold together, in the page's words. */
const TOGETHER: Readonly<Record<string, string>> = {
  "security.failedPerAddress must be at least security.failedPerAccount.": "Allow at least as many per address as per account.",
  "publishing.embedSites must list at least one site while publishing.embedding is listed.": "Add at least one site, or choose Any site.",
};

/** A refusal's words as the page shows them; whether it names the two rows
 * that only hold together, so it is not prefixed with one field's name. */
export function ruleRefusalWords(message: string): { readonly text: string; readonly together: boolean } {
  const together = TOGETHER[message.trim()];
  return together ? { text: together, together: true } : { text: inLabels(message, RULE_LABELS), together: false };
}

/** The listed sites as the field shows them: one per line. */
export function sitesText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join("\n") : typeof value === "string" ? value : "";
}

/** The field's lines as the write takes them: each trimmed, blank lines dropped. */
export function sitesList(text: unknown): string[] {
  return String(text ?? "").split("\n").map(line => line.trim()).filter(Boolean);
}

type Settings = Readonly<Record<string, ReadSetting>>;

/** A row's value in the words its card shows it with, as the search reads
 * it: a choice in its words, the counts with their units, the shortest
 * password with its unit, and the listed sites after Listed sites. */
export function ruleRowWords(row: RuleRow, settings: Settings): string {
  const value = (key: string) => settings[key]?.value;
  if (row.draw === "numbers") {
    return row.fields.map(field => `${value(field.key) ?? ""}${field.unit ? ` ${field.unit}` : ""}`).join(", ");
  }
  const [first] = row.fields;
  const words = ruleChoiceWords(first.key, value(first.key));
  if (row.draw === "sites" && value(first.key) === "listed") {
    const sites = sitesList(sitesText(value("publishing.embedSites")));
    return sites.length ? `${words}: ${sites.join(", ")}` : words;
  }
  return words;
}
