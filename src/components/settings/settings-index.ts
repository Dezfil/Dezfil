import type { Account } from "@/lib/metadata/accounts";
import type { Look } from "@/lib/look";
import { PARTS } from "@/lib/system/part-test-answer";
import { STORAGE_KINDS } from "@/lib/system/storage-answer";
import type { ApiToken } from "@/lib/metadata/auth-credentials";
import type { CustomPalette } from "@/lib/metadata/palettes";
import { LANDING_PAGES } from "@/components/auth/entry-settings";
import { DEFAULTS_TABS, rowValueWords, type DefaultsTabId } from "./defaults-table";
import { generalRow, INSTANCE_CARD, SIGN_IN_CARD, type GeneralRow } from "./general-table";
import type { InstanceRead } from "./instance-read";
import { addressWords, cardSetUp, catalogueSwitchWords, dataRowWords, dataTabCards, isTemplatesCard, TEMPLATES_CARD } from "./data-table";
import {
  BASEMAPS_CARD, BUILT_IN_META, builtInMeta, builtInRows, hostOf, libraryStyleRowId, offeredWords, SATELLITE_ADDRESS_ROW, SATELLITE_CARD,
  SATELLITE_CREDIT_ROW, satelliteAddressWords, SINGLE_MAP_ROW, switchOn,
} from "./libraries-table";
import { capacityText, countedText, limitChoiceWords, LIMITS_CARDS, withShownUnit } from "./limits-table";
import { colorsWords, PALETTES_CARD, paletteRowId } from "./palettes-table";
import { choiceLabel, LOOK_CARDS, rowShown } from "./look-tab";
import { CONNECTIONS_CARD, PUBLIC_LINKS_CARD, ruleRowWords, SECURITY_CARDS, SIGN_OUT_CARD, type RuleCard } from "./security-table";
import { formatSettingNumber } from "./server-set";
import type { IndexCard, TabDeclarations } from "./settings-search";
import { partMeta, partState, STATUS_ROWS } from "./status-table";
import { FREE_ROW, STORAGE_CARD, STORAGE_ROWS } from "./storage-table";
import { EXTERNAL_SIGN_IN_CARD, externalSignInRows, providerName, instanceAssistant, serverSettingsRows } from "./system-table";

/**
 * What each tab declares to the search: its cards and rows, under the ids
 * the tab draws them with, by the labels it shows, from the same reads the
 * tab draws from. Password fields and a new token's secret are declared
 * secret, so the search never reads them. A service's address field and
 * the satellite imagery's tile address never report what is typed in
 * them, so an address's key never reaches the index.
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
  /** People sign in through a sign-in service: the Account card has no
   * password. Until the mode is read, or if it cannot be, no password row is
   * found: only false offers them. */
  readonly external?: boolean;
  readonly tokens: readonly ApiToken[] | null;
  /** The person's look, from the own-settings read. */
  readonly look: Look | null;
  /** The configuration read, for an admin. */
  readonly instance: InstanceRead | null;
  /** The entry read, for a member's General. */
  readonly entry: EntryValues | null;
  readonly health: "ready" | "unready" | null;
  /** The saved palettes, from the palette read, for an admin's Libraries. */
  readonly palettes: readonly CustomPalette[] | null;
}

/** A token's state, as its row in the list says it: Revoked, or Expired once
 * its expiry has passed, else its use and, when it has one, its expiry. */
export function tokenState(token: Pick<ApiToken, "lastUsedAt" | "revokedAt" | "expiresAt">, now = Date.now()): string {
  const day = (time: string) => new Date(time).toLocaleDateString();
  if (token.revokedAt) return "Revoked";
  if (token.expiresAt && Date.parse(token.expiresAt) <= now) return `Expired ${day(token.expiresAt)}`;
  const use = token.lastUsedAt ? `Last used ${day(token.lastUsedAt)}` : "Never used";
  return token.expiresAt ? `${use} · Expires ${day(token.expiresAt)}` : use;
}

const text = (value: unknown) => typeof value === "string" ? value : "";

function accountCards(account: Account, external: boolean | undefined): IndexCard[] {
  return [{ id: "account", title: "Account", keys: "profile", rows: [
    { id: "set-picture", label: "Picture", keys: "photo avatar face image profile" },
    { id: "set-display-name", label: "Display name", keys: "name profile person", value: account.name },
    { id: "set-sql-name", label: "SQL name", keys: "sql identifier tables owner", value: account.sqlName },
    { id: "set-email", label: "Email", keys: "email address mail sign in", value: account.email },
    ...(external !== false ? [] : [
      { id: "set-current-password-email", label: "Current password to change email", secret: true },
      { id: "password", label: "Change password", keys: "password change new current" },
      { id: "set-current-password", label: "Current password", secret: true },
      { id: "set-new-password", label: "New password", secret: true },
    ]),
  ] }];
}

function tokenCards(tokens: readonly ApiToken[] | null): IndexCard[] {
  return [{ id: "tokens", title: "API / MCP tokens", keys: "api mcp token", rows: [
    { id: "set-token-name", label: "Token name", keys: "api mcp create new token" },
    { id: "tokens-secret", label: "New token", secret: true },
    // A token is found by its name and its state, never by anything else its record holds.
    ...(tokens ?? []).map(token => ({ id: `token-${token.id}`, label: token.name, value: tokenState(token) })),
  ] }, { id: "mcp", title: "MCP server", keys: "mcp server endpoint client connect setup configuration", rows: [
    { id: "set-mcp-client", label: "MCP client", keys: "claude code desktop codex cursor configuration copy" },
    { id: "mcp-check", label: "Check connection", keys: "test connection tools" },
  ] }];
}

/** Appearance's rows, by their labels, the words of each pick and the
 * words of the current choice once the look is read. A row under another
 * pick's value is found only while the look shows it. */
function appearanceCards(look: Look | null): IndexCard[] {
  return LOOK_CARDS.map(card => ({ id: card.id, title: card.title, rows: card.rows.filter(row => look ? rowShown(row, key => look[key]) : !("under" in row)).map(row => ({
    id: row.id, label: row.label, keys: row.keys, ...(look ? { value: choiceLabel(row.key, look[row.key]) } : {}),
  })) }));
}

function generalCards(values: EntryValues): IndexCard[] {
  const landing = LANDING_PAGES.find(page => page.value === values.landingPage) ?? LANDING_PAGES[0];
  const row = (key: GeneralRow["key"], keys: string, value: string) => ({ id: generalRow(key).id, label: generalRow(key).label, keys, value });
  return [
    { id: INSTANCE_CARD.id, title: INSTANCE_CARD.title, keys: "instance name", rows: [
      row("instanceName", "title chip header browser tab name", text(values.instanceName)),
    ] },
    { id: SIGN_IN_CARD.id, title: SIGN_IN_CARD.title, keys: "sign in login entry page", rows: [
      row("signInMessage", "sign-in login welcome page text help", text(values.signInMessage)),
      row("lostPasswordContact", "forgot reset password help admin contact", text(values.lostPasswordContact)),
      row("landingPage", "after signing in start home open first page destination", landing.label),
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

/** Security's cards, or Publishing's Public links: each row by its label,
 * its words and its value as the card shows it. */
function ruleCards(cards: readonly RuleCard[], read: InstanceRead): IndexCard[] {
  return cards.map(card => ({ id: card.id, title: card.title, keys: card.keys, rows: card.rows.map(row => ({
    id: row.id, label: row.label, keys: row.keys, value: ruleRowWords(row, read.settings),
  })) }));
}

/** Data & services: each row the tab draws, by its label, its words and
 * its value as the card shows it. A service with no address is declared
 * as the tab draws it, its address row alone; an address row's value is
 * what the read discloses, never what its field holds. The template
 * catalogue's downloads are read when its card opens, never by a search,
 * so their row is declared by its name and words alone. */
function dataCards(read: InstanceRead): IndexCard[] {
  return [...dataTabCards().map((card): IndexCard => {
    if (isTemplatesCard(card)) return templatesCard(read);
    const rows = cardSetUp(card, read.settings) ? card.rows : card.rows.filter(row => row.kind === "address");
    return { id: card.id, title: card.title, keys: card.keys, rows: rows.map(row => ({
      id: row.id, label: row.label, keys: row.keys, value: dataRowWords(row, read.settings, read.services),
    })) };
  }), ...ruleCards([CONNECTIONS_CARD], read)];
}

function templatesCard(read: InstanceRead): IndexCard {
  const { catalogue, address, downloads } = TEMPLATES_CARD;
  return { id: TEMPLATES_CARD.id, title: TEMPLATES_CARD.title, keys: TEMPLATES_CARD.keys, rows: [
    ...(read.settings[catalogue.key] ? [{ id: catalogue.id, label: catalogue.label, keys: catalogue.keys, value: catalogueSwitchWords(read.settings) }] : []),
    { id: address.id, label: address.label, keys: address.keys, value: addressWords(address, read.settings[address.key]) },
    { id: downloads.id, label: downloads.label, keys: downloads.keys },
  ] };
}

/** Libraries: each basemap row by its name, what it says under it and
 * Offered or Hidden; the single-map switch; the tile address as the read
 * discloses it and the credit; each saved palette by its name and how
 * many colors. Never an address's whole text, and never the add forms'
 * fields, which are not on screen until opened. */
function librariesCards(read: InstanceRead, palettes: readonly CustomPalette[] | null | undefined): IndexCard[] {
  const settings = read.settings;
  return [
    { ...BASEMAPS_CARD, rows: [
      ...builtInRows(settings).map(row => ({ id: row.id, label: row.label, keys: row.keys,
        value: offeredWords(builtInMeta(row, settings) || BUILT_IN_META, switchOn(settings, row.setting)) })),
      ...(read.basemapStyles ?? []).map(style => ({ id: libraryStyleRowId(style.id), label: style.name, keys: "basemap style added library",
        value: offeredWords(hostOf(style.url), style.offered) })),
      { id: SINGLE_MAP_ROW.id, label: SINGLE_MAP_ROW.label, keys: SINGLE_MAP_ROW.keys,
        value: switchOn(settings, SINGLE_MAP_ROW.key) ? SINGLE_MAP_ROW.on : "Not allowed" },
    ] },
    { ...SATELLITE_CARD, rows: [
      { id: SATELLITE_ADDRESS_ROW.id, label: SATELLITE_ADDRESS_ROW.label, keys: SATELLITE_ADDRESS_ROW.keys, value: satelliteAddressWords(settings) },
      { id: SATELLITE_CREDIT_ROW.id, label: SATELLITE_CREDIT_ROW.label, keys: SATELLITE_CREDIT_ROW.keys,
        value: typeof settings[SATELLITE_CREDIT_ROW.key]?.value === "string" ? settings[SATELLITE_CREDIT_ROW.key].value as string : "" },
    ] },
    { ...PALETTES_CARD, rows: (palettes ?? []).map(palette => ({ id: paletteRowId(palette.name), label: palette.label, keys: "saved palette ramp",
      value: colorsWords(palette.stops.length) })) },
  ];
}

function limitsCards(read: InstanceRead): IndexCard[] {
  return LIMITS_CARDS.map(card => ({ id: card.id, title: card.title, keys: card.keys, rows: card.rows.map(row => {
    const value = row.kind === "capacity" ? capacityText(row.of, row.of === "geocode" ? read.capacities.geocodeRows : read.capacities.isochroneOrigins)
      : row.kind === "image" ? `${formatSettingNumber(read.maxImageDimension)} ${row.unit}`
        : !read.settings[row.key] ? ""
          : row.kind === "choice" ? limitChoiceWords(row, read.settings[row.key].value)
            : row.kind === "counted" ? `${withShownUnit(row.key, read.settings[row.key].value, read.settings[row.key].unit)} · ${countedText(read.instanceLimits[row.of].count)}`
              : withShownUnit(row.key, read.settings[row.key].value, read.settings[row.key].unit);
    return { id: row.id, label: row.label, keys: row.keys, value };
  }) }));
}

function systemCards(read: InstanceRead, health: IndexSources["health"]): IndexCard[] {
  const assistant = instanceAssistant(read);
  // Each part as its row shows it before a Test: what is known of it and its state.
  const parts = PARTS.map(part => {
    const row = STATUS_ROWS[part], meta = partMeta(part, read), state = partState(part, read.parts, health ?? "checking", null);
    return { id: row.id, label: row.label, keys: row.keys, value: [meta?.text, state.tone === "checking" ? "" : state.text].filter(Boolean).join(" ") };
  });
  return [
    { id: "system-status", title: "Status", keys: "health version ready", rows: [
      { id: "sys-version", label: "Version", keys: "release build dezfil", value: read.version },
      ...parts,
    ] },
    // Storage by its rows' names and words: its sizes are read when System
    // opens, never by a search.
    { ...STORAGE_CARD, rows: [...STORAGE_KINDS.map(kind => STORAGE_ROWS[kind]), FREE_ROW].map(({ id, label, keys }) => ({ id, label, keys })) },
    { id: "system-assistant", title: "Assistant", keys: "instance key", rows: [
      { id: "sys-assistant-status", label: "Instance key", keys: "set not set enabled disabled assistant credential variable",
        value: assistant.set ? "Set" : `Not set ${assistant.reason}` },
      { id: "sys-assistant-provider", label: "Provider", keys: "provider anthropic openai",
        value: assistant.set ? providerName(assistant.provider) : "None" },
    ] },
    ...(read.externalSignIn ? [{ id: EXTERNAL_SIGN_IN_CARD.id, title: EXTERNAL_SIGN_IN_CARD.title, keys: EXTERNAL_SIGN_IN_CARD.keys,
      rows: externalSignInRows(read).map(({ id, label, keys, value }) => ({ id, label, keys, value })) }] : []),
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
    account: accountCards(sources.account, sources.external),
    tokens: tokenCards(sources.tokens),
    assistant: [{ id: "ai-key", title: "Your AI key", keys: "assistant api key provider anthropic openai own", rows: [
      { id: "set-ai-key", label: "Key", keys: "assistant api key replace remove add anthropic openai" },
      { id: "ai-key-field", label: "API key", secret: true },
    ] }],
    appearance: appearanceCards(sources.look),
    ...(general ? { general: generalCards(general) } : {}),
    ...(admin && sources.instance ? {
      maps: defaultsCards("maps", sources.instance), libraries: librariesCards(sources.instance, sources.palettes),
      workflows: defaultsCards("workflows", sources.instance),
      publishing: [...ruleCards([PUBLIC_LINKS_CARD], sources.instance), ...defaultsCards("publishing", sources.instance)],
      data: dataCards(sources.instance),
      limits: limitsCards(sources.instance), security: [...ruleCards(SECURITY_CARDS, sources.instance), SIGN_OUT_CARD],
      system: systemCards(sources.instance, sources.health),
    } : {}),
  };
}
