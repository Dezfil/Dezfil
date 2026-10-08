import type { Account } from "@/lib/metadata/accounts";
import type { Look } from "@/lib/look";
import type { ApiToken } from "@/lib/metadata/auth-credentials";
import { LANDING_PAGES } from "@/components/auth/entry-settings";
import { DEFAULTS_TABS, rowValueWords, type DefaultsTabId } from "./defaults-table";
import type { InstanceRead } from "./instance-read";
import { capacityText, LIMITS_CARDS, withShownUnit } from "./limits-table";
import { choiceLabel, LOOK_CARDS } from "./look-tab";
import { formatSettingNumber } from "./server-set";
import type { IndexCard, TabDeclarations } from "./settings-search";
import { providerName, serverSettingsRows, type AssistantStatus } from "./system-table";

/**
 * What each tab declares to the search: its cards and rows, under the ids
 * the tab draws them with, by the labels it shows, from the same reads the
 * tab draws from. Password fields and a new token's secret are declared
 * secret, so the search never reads them.
 */

/** The entry screen's values, as a member's General shows them. */
export interface EntryValues {
  readonly instanceName: string | null;
  readonly signInMessage: unknown;
  readonly lostPasswordContact: unknown;
  readonly landingPage: unknown;
}

export interface IndexSources {
  readonly account: Account;
  readonly tokens: readonly ApiToken[] | null;
  /** The person's look, from the own-settings read. */
  readonly look: Look | null;
  /** The configuration read, for an admin. */
  readonly instance: InstanceRead | null;
  /** The entry read, for a member's General. */
  readonly entry: EntryValues | null;
  readonly health: "ready" | "unready" | null;
  readonly assistant: AssistantStatus | null;
}

/** A token's state, as its row in the list says it. */
export function tokenState(token: Pick<ApiToken, "lastUsedAt" | "revokedAt">): string {
  return token.revokedAt ? "Revoked" : token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : "Never used";
}

const text = (value: unknown) => typeof value === "string" ? value : "";

function accountCards(account: Account): IndexCard[] {
  return [{ id: "account", title: "Account", keys: "profile", rows: [
    { id: "set-display-name", label: "Display name", keys: "name profile person", value: account.name },
    { id: "set-sql-name", label: "SQL name", keys: "sql identifier tables owner", value: account.sqlName },
    { id: "set-email", label: "Email", keys: "email address mail sign in", value: account.email },
    { id: "set-current-password-email", label: "Current password to change email", secret: true },
    { id: "password", label: "Change password", keys: "password change new current" },
    { id: "set-current-password", label: "Current password", secret: true },
    { id: "set-new-password", label: "New password", secret: true },
  ] }];
}

function tokenCards(tokens: readonly ApiToken[] | null): IndexCard[] {
  return [{ id: "tokens", title: "API / MCP tokens", keys: "api mcp token", rows: [
    { id: "set-token-name", label: "Token name", keys: "api mcp create new token" },
    { id: "tokens-secret", label: "New token", secret: true },
    // A token is found by its name and its state, never by anything else its record holds.
    ...(tokens ?? []).map(token => ({ id: `token-${token.id}`, label: token.name, value: tokenState(token) })),
  ] }];
}

/** Appearance's rows, by their labels, the words of each pick and the
 * words of the current choice once the look is read. */
function appearanceCards(look: Look | null): IndexCard[] {
  return LOOK_CARDS.map(card => ({ id: card.id, title: card.title, rows: card.rows.map(row => ({
    id: row.id, label: row.label, keys: row.keys, ...(look ? { value: choiceLabel(row.key, look[row.key]) } : {}),
  })) }));
}

function generalCards(values: EntryValues): IndexCard[] {
  const landing = LANDING_PAGES.find(page => page.value === values.landingPage) ?? LANDING_PAGES[0];
  return [
    { id: "card-instance", title: "Instance", keys: "instance name", rows: [
      { id: "set-instance-name", label: "Instance name", keys: "title chip header browser tab name", value: text(values.instanceName) },
    ] },
    { id: "card-sign-in", title: "Sign-in", keys: "sign in login entry page", rows: [
      { id: "set-sign-in-message", label: "Message", keys: "sign-in login welcome page text help", value: text(values.signInMessage) },
      { id: "set-lost-password-contact", label: "Lost password contact", keys: "forgot reset password help admin contact", value: text(values.lostPasswordContact) },
      { id: "set-landing-page", label: "Landing page", keys: "after signing in start home open first page destination", value: landing.label },
    ] },
  ];
}

/** Maps, Workflows & SQL or Publishing: each row by its label, its words
 * and its value as the tab shows it. */
function defaultsCards(tab: DefaultsTabId, read: InstanceRead): IndexCard[] {
  return DEFAULTS_TABS[tab].map(card => ({ id: card.id, title: card.title, keys: card.keys, rows: card.rows.map(row => ({
    id: row.id, label: row.label, keys: row.keys, value: rowValueWords(row, read.settings),
  })) }));
}

function limitsCards(read: InstanceRead): IndexCard[] {
  return LIMITS_CARDS.map(card => ({ id: card.id, title: card.title, keys: card.keys, rows: card.rows.map(row => {
    const value = row.kind === "capacity" ? capacityText(row.of, row.of === "geocode" ? read.capacities.geocodeRows : read.capacities.isochroneOrigins)
      : row.kind === "image" ? `${formatSettingNumber(read.maxImageDimension)} ${row.unit}`
        : read.settings[row.key] ? withShownUnit(row.key, read.settings[row.key].value, read.settings[row.key].unit) : "";
    return { id: row.id, label: row.label, keys: row.keys, value };
  }) }));
}

function systemCards(read: InstanceRead, health: IndexSources["health"], assistant: AssistantStatus | null): IndexCard[] {
  const folder = typeof read.settings.dataDir?.value === "string" ? read.settings.dataDir.value : "";
  const state = health === "ready" ? "Writable" : health === "unready" ? "Not writable" : "";
  return [
    { id: "system-status", title: "Status", keys: "health version ready", rows: [
      { id: "sys-version", label: "Version", keys: "release build dezfil", value: read.version },
      { id: "sys-data-folder", label: "Data folder", keys: "data directory disk volume writable", value: [folder, state].filter(Boolean).join(" ") },
    ] },
    { id: "system-assistant", title: "Assistant", keys: "status on off", rows: assistant ? [
      { id: "sys-assistant-status", label: "Status", keys: "on off enabled disabled assistant",
        value: assistant.enabled ? "On" : `Off ${assistant.reason}` },
      { id: "sys-assistant-provider", label: "Provider", keys: "provider anthropic openai",
        value: assistant.enabled ? providerName(assistant.provider) : "None" },
    ] : [] },
    { id: "system-settings", title: "Server settings", keys: "environment variables configuration effective",
      rows: serverSettingsRows(read).map(row => ({ id: row.id, label: row.label, keys: `${row.variable} environment variable server`,
        value: row.value.text + (row.value.after ?? "") })) },
  ];
}

/** The declarations with what the text fields on screen hold now in place
 * of each row's served value. A row its tab declares secret stays out of
 * the index whatever is reported under it: the index drops it, its value
 * and its name. */
export function withLiveValues(tabs: TabDeclarations, live: ReadonlyMap<string, string>): TabDeclarations {
  if (!live.size) return tabs;
  const out: TabDeclarations = {};
  for (const [tab, cards] of Object.entries(tabs) as [keyof TabDeclarations, TabDeclarations[keyof TabDeclarations]][]) {
    out[tab] = cards?.map(card => ({ ...card, rows: card.rows.map(row => live.has(row.id) ? { ...row, value: live.get(row.id) } : row) }));
  }
  return out;
}

/** Every tab's declaration this person's search may hold, from what has been read so far. */
export function settingsDeclarations(sources: IndexSources, admin: boolean): TabDeclarations {
  const general = admin && sources.instance
    ? { instanceName: sources.instance.settings.instanceName?.value as string | null, signInMessage: sources.instance.settings.signInMessage?.value,
      lostPasswordContact: sources.instance.settings.lostPasswordContact?.value, landingPage: sources.instance.settings.landingPage?.value }
    : !admin ? sources.entry : null;
  return {
    account: accountCards(sources.account),
    tokens: tokenCards(sources.tokens),
    appearance: appearanceCards(sources.look),
    ...(general ? { general: generalCards(general) } : {}),
    ...(admin && sources.instance ? {
      maps: defaultsCards("maps", sources.instance), workflows: defaultsCards("workflows", sources.instance),
      publishing: defaultsCards("publishing", sources.instance),
      limits: limitsCards(sources.instance), system: systemCards(sources.instance, sources.health, sources.assistant),
    } : {}),
  };
}
