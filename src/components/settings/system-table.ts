import { addressIsFolder, DATA_ROW_IDS, FOLDER_WORDS } from "./data-table";
import type { InstanceRead } from "./instance-read";
import { LIMITS_LABELS, LIMITS_ROW_IDS, withShownUnit } from "./limits-table";
import type { ReadSetting } from "./server-set";
import { tabAddress } from "./settings-address";

/**
 * System's Server settings table: one row per setting a server variable
 * decides, in the read's order. A setting Limits draws is named by its
 * Limits row, word for word, and its number takes the unit that row
 * shows, so the row here and the row it links to read alike; the rest by
 * the read's own label and unit. A value stored on Limits or on Data &
 * services links to the row that holds it there. The value is what the
 * read discloses (an address's scheme and host, whether a key is set, the
 * encryption key's state, a number with its unit), never more.
 */

export interface ShownValue {
  readonly text: string;
  /** An identifier, a path or an address: the code face. */
  readonly mono?: boolean;
  /** Nothing set: the quiet ink. */
  readonly muted?: boolean;
  /** Words before the code-face part (none) and after it. */
  readonly after?: string;
}

export type SettingSource =
  | { readonly kind: "environment" }
  | { readonly kind: "default" }
  | { readonly kind: "stored"; readonly href: string | null;
    /** The tab the link names. */
    readonly where: string | null };

export interface ServerSettingRow {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly variable: string;
  readonly value: ShownValue;
  readonly source: SettingSource;
}

const NOT_SET: ShownValue = { text: "Not set", muted: true };
const keysWords = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "key" : "keys"}`;
const isRule = (value: unknown): value is { rule: string } => !!value && typeof value === "object" && "rule" in value;

/** A setting's value as the read discloses it, in the page's words. */
export function shownValue(setting: ReadSetting): ShownValue {
  const value = setting.value;
  // A value the server works out when it needs it: its documented form.
  if (isRule(value)) return { text: setting.documentedDefault };
  if (setting.key === "secretKey") {
    const status = (value as { status?: string } | null)?.status;
    if (status === "data-directory") return { text: "secret.key", mono: true, after: " in the data folder" };
    if (status === "not-yet-present") return { text: "Not created yet", muted: true };
    return { text: "Set" };
  }
  // Public keys: how many, never which.
  if (setting.key === "externalSignInKeys") {
    const count = (value as { count?: number } | null)?.count ?? 0;
    return count ? { text: keysWords(count) } : NOT_SET;
  }
  if (setting.kind === "secret") return (value as { set?: boolean } | null)?.set ? { text: "Set" } : NOT_SET;
  if (setting.kind === "address") {
    const address = value as { set?: boolean; origin?: string; unreadable?: boolean } | null;
    if (!address?.set) return NOT_SET;
    if (addressIsFolder(setting)) return { text: FOLDER_WORDS };
    return address.origin ? { text: address.origin, mono: true } : { text: "Set" };
  }
  if (setting.kind === "number") return { text: withShownUnit(setting.key, value, setting.unit) };
  if (setting.kind === "boolean") return { text: value ? "On" : "Off" };
  if (setting.kind === "list") {
    const items = Array.isArray(value) ? value.map(String) : [];
    return items.length ? { text: items.join(", "), mono: true } : { text: "None", muted: true };
  }
  if (value === null || value === undefined || value === "") return NOT_SET;
  return { text: String(value), mono: setting.kind === "path" };
}

function sourceOf(key: string, setting: ReadSetting): SettingSource {
  if (setting.source === "environment") return { kind: "environment" };
  if (setting.source === "stored") {
    if (LIMITS_ROW_IDS[key]) return { kind: "stored", href: tabAddress("limits", LIMITS_ROW_IDS[key]), where: "Limits" };
    if (DATA_ROW_IDS[key]) return { kind: "stored", href: tabAddress("data", DATA_ROW_IDS[key]), where: "Data & services" };
    return { kind: "stored", href: null, where: null };
  }
  return { kind: "default" };
}

/** The row's own address inside System. */
export const serverSettingRowId = (variable: string) => `env-${variable.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

export function serverSettingsRows(read: Pick<InstanceRead, "settings">): ServerSettingRow[] {
  return Object.entries(read.settings).flatMap(([key, setting]) => setting.environment ? [{
    key, id: serverSettingRowId(setting.environment), label: LIMITS_LABELS[key] ?? setting.label,
    variable: setting.environment, value: shownValue(setting), source: sourceOf(key, setting),
  }] : []);
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** How long the server has run, from its start time: the largest whole unit. */
export function runningFor(startedAt: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(startedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "Running for less than a minute";
  if (minutes < 60) return `Running for ${plural(minutes, "minute")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Running for ${plural(hours, "hour")}`;
  return `Running for ${plural(Math.floor(hours / 24), "day")}`;
}

/** The assistant's status read: on with its provider, or off with the reason. */
export type AssistantStatus = { readonly enabled: true; readonly provider: string } | { readonly enabled: false; readonly reason: string };

/** The assistant's provider, by its name. */
export function providerName(provider: string): string {
  return ({ anthropic: "Anthropic", openai: "OpenAI" } as Record<string, string>)[provider] ?? provider;
}

export const EXTERNAL_SIGN_IN_CARD = { id: "system-external-sign-in", title: "External sign-in", keys: "sign-in service door single sign-on sso login mode generation" } as const;

export interface ExternalSignInRow {
  readonly id: string;
  readonly label: string;
  readonly keys: string;
  /** The row's words, for the card and the search. */
  readonly value: string;
  /** On or off, drawn as a state. */
  readonly state?: "on" | "off";
  readonly mono?: boolean;
}

/** The mode's card: on or off, and while on where people sign in, how many
 * public keys it trusts and both generations. The read holds no key. */
export function externalSignInRows(read: Pick<InstanceRead, "settings" | "externalSignIn">): ExternalSignInRow[] {
  const mode = read.externalSignIn;
  if (!mode) return [];
  const status: ExternalSignInRow = { id: "sys-external-status", label: "Status", keys: "on off enabled disabled", value: mode.enabled ? "On" : "Off", state: mode.enabled ? "on" : "off" };
  if (!mode.enabled) return [status];
  return [status,
    { id: "sys-external-service", label: "Sign-in service", keys: "door address url", value: String(read.settings.externalSignInUrl?.value ?? ""), mono: true },
    { id: "sys-external-keys", label: "Public keys", keys: "keys rotation trust", value: keysWords(mode.keyCount) },
    { id: "sys-external-sign-out-generation", label: "Sign-out generation", keys: "sign everyone out raised", value: String(mode.signOutGeneration) },
    { id: "sys-external-door-generation", label: "Door generation", keys: "floor raised", value: String(mode.doorGeneration) },
  ];
}
