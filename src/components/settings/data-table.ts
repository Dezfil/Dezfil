import { GOVERNED_REQUESTS } from "@/lib/net/governed-requests";
import type { ProviderCache } from "@/lib/provider-caches";
import type { ServiceTestAnswer, TestedService } from "@/lib/settings/service-test-answer";
import type { ServiceAddressKey, StoredAddressKey } from "@/lib/settings/types";
import type { ReadSetting } from "./server-set";
import { tabAddress } from "./settings-address";

/**
 * The Data & services tab's rows: one card per outside service (the
 * address finder, travel time, OpenStreetMap, Overture, cloud storage),
 * the template catalogue's card, then the private hosts the server may
 * reach; the card on who may add connections or import from links is
 * Security's kind and lives with it.
 * Each row is mapped by key onto the configuration read, which supplies a
 * number's range, default and value in its variable's unit, an address as
 * scheme and host, and whether the server's environment decides it. This
 * table supplies the words, the order, and each number's page unit with
 * its scale: the API keeps the variable's unit, the page the drawn one, so
 * a gap the API holds in milliseconds is typed here in seconds, in tenths
 * for the address finder. A test holds it against the read.
 */

export type ServiceNumberKey =
  | "geocodePaceMs" | "geocodeRequestTimeoutS" | "geocodeMatchCacheHours"
  | "isochronePaceMs" | "isochroneRequestTimeoutS" | "isochroneCacheHours"
  | "overpassTimeoutS" | "overpassCacheHours";

export interface AddressRow {
  readonly kind: "address";
  /** A service's address, or the satellite imagery's tile template (Libraries). */
  readonly key: StoredAddressKey;
  readonly id: string;
  readonly label: string;
  /** The field's accessible name. */
  readonly name: string;
  readonly meta?: string;
  readonly keys: string;
  readonly placeholder: string;
  /** What the service reaches with nothing saved, in words, where it has a default. */
  readonly fallback?: string;
  /** What removing a saved address does, as Remove's dialog says it. */
  readonly removal: string;
  /** What the row says while the address in effect carries a user name or
   * password, where that keeps it from working (the imagery's tile template). */
  readonly userInformation?: string;
}

export interface NumberRow {
  readonly kind: "number";
  readonly key: ServiceNumberKey;
  readonly id: string;
  readonly label: string;
  readonly keys: string;
  /** The unit the page writes after the number. */
  readonly unit: "seconds" | "days" | "hours";
  /** How many of the variable's units make one of the page's. */
  readonly scale: number;
  /** How many decimal places the page takes. */
  readonly places: 0 | 1;
}

export interface CacheRow { readonly kind: "cache"; readonly cache: ProviderCache; readonly id: string; readonly label: string; readonly keys: string }
export interface ReleasesRow { readonly kind: "releases"; readonly id: string; readonly label: string; readonly keys: string }

/** A value only the server's environment sets, drawn locked with its variable. */
export interface LockedRow {
  readonly kind: "locked";
  readonly key: "objectStoreCredentials" | "egressAllowlist";
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
  readonly keys: string;
}

export type DataRow = AddressRow | NumberRow | CacheRow | ReleasesRow | LockedRow;

export interface DataCard {
  readonly id: string;
  readonly title: string;
  /** Words the search matches the card by. */
  readonly keys: string;
  /** The service its Test reaches, at the card's head. */
  readonly test?: TestedService;
  /** The address without which the card shows Not set up and its address row alone. */
  readonly needs?: ServiceAddressKey;
  readonly rows: readonly DataRow[];
}

const gap = (key: ServiceNumberKey, prefix: string, places: 0 | 1): NumberRow => ({
  kind: "number", key, id: `set-${prefix}-gap`, label: "Gap between requests", keys: "pace rate throttle requests per second",
  unit: "seconds", scale: 1000, places,
});
const answerLimit = (key: ServiceNumberKey, prefix: string): NumberRow => ({
  kind: "number", key, id: `set-${prefix}-timeout`, label: "Answer time limit", keys: "timeout deadline wait request",
  unit: "seconds", scale: 1, places: 0,
});
const keep = (key: ServiceNumberKey, prefix: string, label: string, unit: "days" | "hours"): NumberRow => ({
  kind: "number", key, id: `set-${prefix}-keep`, label, keys: "cache keep lifetime fresh hours days",
  unit, scale: unit === "days" ? 24 : 1, places: 0,
});
const cache = (cache: ProviderCache, prefix: string): CacheRow => ({ kind: "cache", cache, id: `set-${prefix}-cache`, label: "Cache", keys: "cache clear disk size" });

export const DATA_CARDS: readonly DataCard[] = [
  { id: "data-geocoder", title: "Address finder", test: "geocode", needs: "geocoderUrl",
    keys: "geocoder geocoding nominatim place search address finder", rows: [
      { kind: "address", key: "geocoderUrl", id: "set-geocoder-address", label: "Address", name: "Address finder address",
        keys: "geocoder url endpoint nominatim", placeholder: "https://nominatim.example/search",
        removal: "Place search and geocoding stop until an address is saved again." },
      gap("geocodePaceMs", "geocoder", 1),
      answerLimit("geocodeRequestTimeoutS", "geocoder"),
      keep("geocodeMatchCacheHours", "geocoder", "Keep found addresses for", "days"),
      cache("geocode", "geocoder"),
    ] },
  { id: "data-travel", title: "Travel time", test: "isochrone", needs: "isochroneUrl",
    keys: "isochrone travel time area routing valhalla", rows: [
      { kind: "address", key: "isochroneUrl", id: "set-travel-address", label: "Address", name: "Travel time address",
        keys: "isochrone valhalla routing travel time url endpoint", placeholder: "https://valhalla.example/isochrone",
        removal: "Travel-time areas stop until an address is saved again." },
      gap("isochronePaceMs", "travel", 0),
      answerLimit("isochroneRequestTimeoutS", "travel"),
      keep("isochroneCacheHours", "travel", "Keep areas for", "days"),
      cache("isochrone", "travel"),
    ] },
  { id: "data-osm", title: "OpenStreetMap", test: "overpass", keys: "osm overpass openstreetmap download import", rows: [
    { kind: "address", key: "overpassUrl", id: "set-osm-address", label: "Address", name: "OpenStreetMap address",
      keys: "overpass url endpoint server", placeholder: "https://overpass.example/api/interpreter",
      removal: "OpenStreetMap imports go to the public Overpass server again." },
    { kind: "number", key: "overpassTimeoutS", id: "set-osm-timeout", label: "Time budget per query", keys: "overpass timeout query budget",
      unit: "seconds", scale: 1, places: 0 },
    keep("overpassCacheHours", "osm", "Keep answers for", "hours"),
    cache("overpass", "osm"),
  ] },
  { id: "data-overture", title: "Overture Maps", keys: "overture places buildings transportation divisions addresses base release", rows: [
    { kind: "releases", id: "set-overture-list", label: "Release list", keys: "overture releases cache refresh check newest" },
  ] },
  { id: "data-storage", title: "Cloud storage", test: "s3", keys: "s3 gcs azure bucket object store minio cloud storage", rows: [
    { kind: "address", key: "s3Endpoint", id: "set-s3-address", label: "S3 address", name: "S3 address",
      meta: "For s3:// links read without the server’s credentials.", keys: "s3 endpoint minio ceph url compatible",
      placeholder: "https://objects.example", fallback: "Amazon S3",
      removal: "s3:// links are read from Amazon S3 again." },
    { kind: "locked", key: "objectStoreCredentials", id: "set-store-credentials", label: "Read with the server’s credentials",
      meta: "Anyone who may import from links can then read what the server can.",
      keys: "credentials private buckets signed aws gcs azure object store" },
  ] },
  { id: "data-private", title: "Private network", keys: "egress allowlist allow list private network internal lan intranet hosts outside addresses", rows: [
    { kind: "locked", key: "egressAllowlist", id: "set-private-hosts", label: "Hosts the server may reach",
      keys: "egress allowlist private internal hosts addresses ranges cidr" },
  ] },
];

/**
 * Templates: whether the server reads the template catalogue and where,
 * its Test, and what the downloaded templates hold, with Remove all. The
 * switch is kept at once and Reset returns it on; the address is a
 * service address's own form, a folder its variable names shown with no
 * path; the downloads are the template list's, read when the card opens
 * and never by the search.
 */
export const TEMPLATES_CARD = {
  id: "data-templates", title: "Templates", test: "templates",
  keys: "templates catalogue examples finished maps workflows download",
  catalogue: {
    key: "templates.catalogue", id: "set-templates-catalogue", label: "Catalogue", name: "Use the catalogue", on: "In use", off: "Off",
    keys: "use the catalogue read list switch on off",
  },
  address: {
    kind: "address", key: "templatesCatalogueUrl", id: "set-templates-address", label: "Catalogue address", name: "Template catalogue address",
    keys: "templates catalogue url index address folder release mirror", placeholder: "https://templates.example/index.json",
    removal: "The default catalogue is read again.",
  },
  downloads: { id: "set-templates-downloads", label: "Downloaded", keys: "downloads downloaded remove all disk space versions" },
} as const satisfies { readonly address: AddressRow; readonly test: TestedService } & Record<string, unknown>;

export type TemplatesCardRows = typeof TEMPLATES_CARD;

/** The tab's cards in the order it draws them: the services, then
 * Templates, then the private network the server may reach. */
export function dataTabCards(): readonly (DataCard | TemplatesCardRows)[] {
  return DATA_CARDS.flatMap((card): (DataCard | TemplatesCardRows)[] => card.id === "data-private" ? [TEMPLATES_CARD, card] : [card]);
}

export const isTemplatesCard = (card: DataCard | TemplatesCardRows): card is TemplatesCardRows => card.id === TEMPLATES_CARD.id;

/** Every row the tab's service cards draw, top to bottom. */
export function dataRows(): DataRow[] {
  return DATA_CARDS.flatMap(card => card.rows);
}

/** Every number the tab draws. */
export function serviceNumberRows(): NumberRow[] {
  return dataRows().filter((row): row is NumberRow => row.kind === "number");
}

/** Every address the tab draws. */
export function addressRows(): AddressRow[] {
  return dataRows().filter((row): row is AddressRow => row.kind === "address");
}

/** Where each address, number and switch the tab draws is, as a row address inside the tab. */
export const DATA_ROW_IDS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(dataRows().flatMap(row => row.kind === "address" || row.kind === "number" ? [[row.key, row.id]] : [])),
  [TEMPLATES_CARD.catalogue.key]: TEMPLATES_CARD.catalogue.id,
  [TEMPLATES_CARD.address.key]: TEMPLATES_CARD.address.id,
};

/** The address of a row this tab draws, by its setting's key, for a link from another tab. */
export function dataRowAddress(key: string): string | null {
  return DATA_ROW_IDS[key] ? tabAddress("data", DATA_ROW_IDS[key]) : null;
}

/** The label each number, address and switch is named by in a refusal, by key. */
export const DATA_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(dataRows().flatMap((row): [string, string][] =>
    row.kind === "number" ? [[row.key, row.label]] : row.kind === "address" ? [[row.key, row.name]] : [])),
  [TEMPLATES_CARD.catalogue.key]: TEMPLATES_CARD.catalogue.name,
  [TEMPLATES_CARD.address.key]: TEMPLATES_CARD.address.name,
};

const round = (value: number, places: number) => Number(value.toFixed(places));

/** A number of the read, in the variable's unit, as the page shows it.
 * A value off the page's grid shows as it is, never rounded onto it. */
export function toPage(row: Pick<NumberRow, "scale">, value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? round(value / row.scale, 6) : null;
}

/** A number the page took, in the variable's unit, as the write sends it. */
export function toApi(row: Pick<NumberRow, "scale">, value: number): number {
  return Math.round(value * row.scale);
}

/** The range the page takes, from the read's range in the variable's unit. */
export function pageRange(row: Pick<NumberRow, "scale">, write: ReadSetting["write"]): { min?: number; max?: number } {
  if (write?.kind !== "integer" && write?.kind !== "decimal") return {};
  return { min: round(write.min / row.scale, 6), max: round(write.max / row.scale, 6) };
}

/** A number as the page writes it, with its unit. */
export function numberWords(row: NumberRow, value: unknown): string {
  const shown = toPage(row, value);
  return shown === null ? "" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(shown)} ${row.unit}`;
}

/** Whether a card's service is set up: always, unless it needs an address
 * the read reports not set. */
export function cardSetUp(card: DataCard, settings: Readonly<Record<string, { readonly value: unknown }>>): boolean {
  if (!card.needs) return true;
  const value = settings[card.needs]?.value as { set?: unknown } | null | undefined;
  return value?.set !== false;
}

/** What an address row shows above its field: nothing for a service with no
 * address and no default; the default in words or as scheme and host; a
 * saved address as scheme and host, or set and unreadable. Never more of
 * an address than the read discloses. */
export type AddressState =
  | { readonly kind: "none" }
  | { readonly kind: "default"; readonly text: string; readonly mono: boolean }
  | { readonly kind: "saved"; readonly origin: string }
  | { readonly kind: "unreadable" };

export function addressState(row: AddressRow, setting: Pick<ReadSetting, "value" | "source"> | undefined): AddressState {
  const value = setting?.value as { set?: boolean; origin?: string; unreadable?: boolean; rule?: string } | null | undefined;
  if (setting?.source === "stored") {
    return value?.origin ? { kind: "saved", origin: value.origin } : { kind: "unreadable" };
  }
  if (value?.set && value.origin) return { kind: "default", text: value.origin, mono: true };
  if (row.fallback) return { kind: "default", text: row.fallback, mono: false };
  return { kind: "none" };
}

/** What a folder on the server reads as where its variable names one in
 * place of an address (the template catalogue's): never its path. */
export const FOLDER_WORDS = "A folder on the server";

/** Whether the read says a folder is set, which it never names. */
export function addressIsFolder(setting: Pick<ReadSetting, "value"> | undefined): boolean {
  return (setting?.value as { folder?: unknown } | null | undefined)?.folder === true;
}

/** An address as the search and a locked field read it: scheme and host,
 * a folder with no path, the default's words, Set for one that cannot be
 * read, or Not set up. */
export function addressWords(row: AddressRow, setting: Pick<ReadSetting, "value" | "source"> | undefined): string {
  const value = setting?.value as { set?: boolean; origin?: string } | null | undefined;
  if (addressIsFolder(setting)) return FOLDER_WORDS;
  if (setting?.source === "environment") return value?.origin ?? (value?.set ? "Set" : "");
  const state = addressState(row, setting);
  return state.kind === "saved" ? state.origin : state.kind === "default" ? state.text : state.kind === "unreadable" ? "Set" : "Not set up";
}

/** A locked row's value, in the page's words: the hosts one per line, or a switch On or Off. */
export function lockedLines(row: LockedRow, value: unknown): string[] {
  if (row.key === "objectStoreCredentials") return [value ? "On" : "Off"];
  return Array.isArray(value) ? value.map(String) : [];
}

/** What the services keep, as the configuration read reports it. */
export interface ServiceFacts {
  readonly geocode?: CacheFacts;
  readonly isochrone?: CacheFacts;
  readonly overpass?: CacheFacts;
  readonly overture?: ReleaseListFacts;
}

/** A row's value in the words its card shows it with, as the search reads
 * it. An address gives what the read discloses, never a field's text. */
export function dataRowWords(row: DataRow, settings: Readonly<Record<string, ReadSetting>>, services: ServiceFacts | undefined): string {
  switch (row.kind) {
    case "address": return addressWords(row, settings[row.key]);
    case "number": return settings[row.key] ? numberWords(row, settings[row.key].value) : "";
    case "cache": return cacheWords(row.cache, services?.[row.cache]);
    case "releases": return releaseListWords(services?.overture);
    case "locked": {
      const lines = lockedLines(row, settings[row.key]?.value);
      return lines.length ? lines.join(", ") : "None";
    }
  }
}

/** The Private network note: exactly the requests the egress check governs. */
export function governedNote(): string {
  const labels = GOVERNED_REQUESTS.map(request => request.label.replace(/^[A-Z][a-z]*\b/, word => word.toLowerCase()));
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels.join("");
  return `Every other private address is refused for ${list}.`;
}

const MIB = 1024 * 1024;
const grouped = (count: number) => new Intl.NumberFormat("en-US").format(count);
const oneDecimal = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

/** A size on disk, in the largest unit that keeps it readable. */
export function sizeWords(bytes: number): string {
  const mb = bytes / MIB;
  if (mb >= 1024) return `${oneDecimal(mb / 1024)} GB`;
  if (mb >= 10) return `${grouped(Math.round(mb))} MB`;
  if (mb >= 0.1) return `${oneDecimal(mb)} MB`;
  return `${grouped(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

const NOUNS: Readonly<Record<ProviderCache, readonly [string, string]>> = {
  geocode: ["address", "addresses"], isochrone: ["area", "areas"], overpass: ["answer", "answers"],
};

export interface CacheFacts { readonly bytes: number; readonly answers: number; readonly budgetMb: number }

/** A cache's use against its budget and how many answers it holds, or Empty. */
export function cacheWords(cache: ProviderCache, facts: CacheFacts | undefined): string {
  if (!facts || (facts.answers === 0 && facts.bytes === 0)) return "Empty";
  const [one, many] = NOUNS[cache];
  return `${sizeWords(facts.bytes)} of ${sizeWords(facts.budgetMb * MIB)} · ${grouped(facts.answers)} ${facts.answers === 1 ? one : many}`;
}

/** How full a cache is, in whole percent of its budget. */
export function cacheShare(facts: CacheFacts | undefined): number {
  if (!facts || facts.budgetMb <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * facts.bytes / (facts.budgetMb * MIB))));
}

export type ReleaseListFacts = { readonly listed: false } | { readonly listed: true; readonly releases: number; readonly newest: string; readonly listedAt: string };

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** When the list was taken, in its largest whole unit. */
export function checkedWords(listedAt: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(listedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Checked ${plural(hours, "hour")} ago`;
  return `Checked ${plural(Math.floor(hours / 24), "day")} ago`;
}

/** How many releases the Overture pane offers and the newest. */
export function releasesWords(releases: number, newest: string): string {
  return `${plural(releases, "release")}, newest ${newest}`;
}

/** The release list as its row says it: how many, the newest, and when it was checked. */
export function releaseListWords(facts: ReleaseListFacts | undefined, now = Date.now()): string {
  if (!facts?.listed) return "Not checked yet";
  return `${releasesWords(facts.releases, facts.newest)} · ${checkedWords(facts.listedAt, now)}`;
}

/** How many templates the catalogue's index lists, and the time it took. */
export function catalogueListedWords(templates: number, milliseconds: number): string {
  const listed = templates === 0 ? "Lists no templates" : `Lists ${grouped(templates)} ${templates === 1 ? "template" : "templates"}`;
  return `${listed}, answered in ${grouped(milliseconds)} ms`;
}

/** A Test's answer line: the time taken (Overture: how many and the
 * newest; the template catalogue: how many and the time), or its one
 * reason. Never more than the answer's closed shape. */
export function testAnswerWords(answer: ServiceTestAnswer): { readonly passed: boolean; readonly text: string } {
  if (answer.result === "passed") {
    if ("releases" in answer) return { passed: true, text: releasesWords(answer.releases, answer.newest) };
    if ("templates" in answer) return { passed: true, text: catalogueListedWords(answer.templates, answer.milliseconds) };
    return { passed: true, text: `Answered in ${grouped(answer.milliseconds)} ms` };
  }
  switch (answer.reason) {
    case "not_set_up": return { passed: false, text: "Not set up." };
    case "refused": return { passed: false, text: answer.message };
    case "unreachable": return { passed: false, text: "Could not reach the service." };
    case "timed_out": return { passed: false, text: "No answer within the time limit." };
    case "status": return { passed: false, text: `Answered with status ${answer.status}.` };
    case "unexpected_answer": return { passed: false, text: "Answered, but not as the service does." };
  }
}

/** What the downloaded templates hold, as their row says it. */
export interface DownloadsFacts { readonly versions: number; readonly bytes: number }

const versionsWords = (count: number) => `${grouped(count)} ${count === 1 ? "version" : "versions"}`;

/** The Downloaded row: how many versions and their size, or None. */
export function downloadsWords(downloads: DownloadsFacts): string {
  return downloads.versions === 0 ? "None" : `${versionsWords(downloads.versions)} · ${sizeWords(downloads.bytes)}`;
}

/** What Remove all asks before it removes the downloads: what goes, and
 * what stays, which is the surprise. */
export function downloadsRemovalWords(downloads: DownloadsFacts): string {
  return `${versionsWords(downloads.versions)} (${sizeWords(downloads.bytes)}) ${downloads.versions === 1 ? "is" : "are"} removed. ` +
    "Shipped templates and every copy stay, and a template the catalogue lists downloads again when it is next opened.";
}

/** The catalogue switch's row, as the card and the search read it: In use,
 * or Off as Settings' other switches read off. */
export function catalogueSwitchWords(settings: Readonly<Record<string, { readonly value: unknown }>>): string {
  return settings[TEMPLATES_CARD.catalogue.key]?.value === false ? TEMPLATES_CARD.catalogue.off : TEMPLATES_CARD.catalogue.on;
}
