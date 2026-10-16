import type { AttributionLine, BasemapKey } from "@/lib/basemap";
import { LIBRARY_LIMITS, OFFERED_SETTING, SINGLE_MAP_STYLES_SETTING } from "@/lib/basemap";
import type { ServiceTestAnswer } from "@/lib/settings/service-test-answer";
import { addressState, testAnswerWords, type AddressRow } from "./data-table";
import { serviceSetUp } from "./limits-table";
import type { ReadSetting } from "./server-set";

/**
 * The Libraries tab's rows: what the instance offers every map. Basemaps
 * lists the built-in styles, Satellite while imagery is set up, and the
 * styles an admin added by their address, each offered or hidden where a
 * basemap is chosen, with whether a map may take a style address of its
 * own; Satellite imagery holds the tile address and its credit; Palettes
 * the palettes people saved (its own table). Each row is mapped by key
 * onto the configuration read, which supplies the switches, the address
 * as scheme and host, the credit, whether the environment decides one,
 * and the library; this table supplies the words, the order and the row
 * addresses. A test holds it against the read.
 */

type Settings = Readonly<Record<string, ReadSetting>>;

/** A style in the library as the configuration read gives it, hidden ones included. */
export interface LibraryStyleRead {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly attribution: readonly AttributionLine[];
  readonly offered: boolean;
  readonly addedAt: string;
}

export const BASEMAPS_CARD = { id: "card-basemaps", title: "Basemaps", keys: "basemap styles background maps library add style url offered hidden" } as const;
export const SATELLITE_CARD = { id: "card-satellite", title: "Satellite imagery", keys: "satellite imagery aerial photo raster tiles" } as const;

/** A style the instance ships or draws from its imagery, by its switch. */
export interface BuiltInStyleRow {
  readonly key: BasemapKey;
  readonly setting: (typeof OFFERED_SETTING)[BasemapKey];
  readonly id: string;
  readonly label: string;
  readonly keys: string;
}

export const BUILT_IN_STYLES: readonly BuiltInStyleRow[] = (["dark", "light", "streets", "satellite"] as const).map(key => ({
  key, setting: OFFERED_SETTING[key], id: `lib-style-${key}`, label: key === "dark" ? "Dark" : key === "light" ? "Light" : key === "streets" ? "Streets" : "Satellite",
  keys: `basemap style ${key} offered hidden picker`,
}));

/** What a built-in style's row says under its name. */
export const BUILT_IN_META = "OpenFreeMap · built in";

/** Whether a map may take a style address the library does not offer. */
export const SINGLE_MAP_ROW = {
  key: SINGLE_MAP_STYLES_SETTING, id: "set-custom-styles", label: "Style addresses on single maps",
  keys: "custom basemap style url builder paste any address", on: "Allowed",
} as const;

/** The switches the Basemaps card's Reset returns: the built-in styles', Satellite's and the single-map switch, never an added style. */
export const BASEMAP_SWITCHES: readonly string[] = [...BUILT_IN_STYLES.map(row => row.setting), SINGLE_MAP_ROW.key];

/** The Add a style form's bounds: the library's own. */
export const STYLE_LIMITS = { name: LIBRARY_LIMITS.name, address: LIBRARY_LIMITS.address } as const;

/** The one sentence the Add a style form says. */
export const STYLE_PUBLIC = "Its address is public to anyone who sees a map drawn on it, published readers included.";

/** What Remove asks before an added style leaves the library. */
export const STYLE_REMOVAL = "Maps that already use it keep it.";

/** An added style's row, by its id. */
export const libraryStyleRowId = (id: string) => `lib-style-${id}`;

/** The tile address: the Data & services address row's kind, its key the imagery's template. */
export const SATELLITE_ADDRESS_ROW: AddressRow = {
  kind: "address", key: "satelliteUrl", id: "set-satellite-address", label: "Tile address", name: "Satellite tile address",
  keys: "satellite imagery url template key tiles source", placeholder: "https://imagery.example.org/{z}/{x}/{y}.jpg",
  removal: "Satellite leaves the basemap pickers. Maps on it keep their choice and draw the default style until an address is saved again.",
  userInformation: "Satellite imagery is not drawn from an address that carries a user name or password. Put the key in the path or the query.",
};

export const SATELLITE_CREDIT_ROW = {
  key: "satelliteAttribution", id: "set-satellite-credit", label: "Credit", keys: "satellite attribution credit copyright imagery provider", maxLength: 160,
} as const;

/** The label each row of the tab is named by in a refusal, by key. */
export const LIBRARIES_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(BUILT_IN_STYLES.map(row => [row.setting, row.label])),
  [SINGLE_MAP_ROW.key]: SINGLE_MAP_ROW.label,
  satelliteUrl: SATELLITE_ADDRESS_ROW.name,
  satelliteAttribution: SATELLITE_CREDIT_ROW.label,
};

/** The imagery as the read reports its template: set up and readable, set
 * but unreadable with the instance's key, or not set up. */
export type ImageryState = "ready" | "unreadable" | "none";

export function imageryState(settings: Settings): ImageryState {
  if (serviceSetUp(settings, "satelliteUrl") !== true) return "none";
  return (settings.satelliteUrl?.value as { unreadable?: boolean } | null)?.unreadable ? "unreadable" : "ready";
}

/** The host of an origin the read discloses, without its scheme. */
export function hostOf(address: string): string {
  try { return new URL(address).host; } catch { return address; }
}

/** The built-in rows the Basemaps card draws: Satellite only while imagery is set up and readable. */
export function builtInRows(settings: Settings): BuiltInStyleRow[] {
  const imagery = imageryState(settings) === "ready";
  return BUILT_IN_STYLES.filter(row => row.key !== "satellite" || imagery);
}

/** What a built-in row says under its name: the built-in styles' source, Satellite's host. */
export function builtInMeta(row: BuiltInStyleRow, settings: Settings): string {
  if (row.key !== "satellite") return BUILT_IN_META;
  const origin = (settings.satelliteUrl?.value as { origin?: string } | null)?.origin;
  return origin ? hostOf(origin) : "";
}

/** Whether a switch is on as the read reports it: on unless stored off. */
export const switchOn = (settings: Settings, key: string) => settings[key]?.value !== false;

/** A style row's words for the search: what it says under its name, and Offered or Hidden. */
export const offeredWords = (meta: string, offered: boolean) => `${meta}${meta ? " · " : ""}${offered ? "Offered" : "Hidden"}`;

/** The tile address as the search and the card read it: scheme and host, Set while unreadable, or Not set up. Never more. */
export function satelliteAddressWords(settings: Settings): string {
  const state = addressState(SATELLITE_ADDRESS_ROW, settings.satelliteUrl);
  if (settings.satelliteUrl?.source === "environment") return (settings.satelliteUrl.value as { origin?: string } | null)?.origin ?? "Set";
  return state.kind === "saved" ? state.origin : state.kind === "unreadable" ? "Set" : "Not set up";
}

/** The satellite Test's answer line: a tile's time, or its one reason. */
export function satelliteTestWords(answer: ServiceTestAnswer): { readonly passed: boolean; readonly text: string } {
  if (answer.result === "passed" && "milliseconds" in answer) {
    return { passed: true, text: `A tile arrived in ${new Intl.NumberFormat("en-US").format(answer.milliseconds)} ms` };
  }
  if (answer.result === "failed" && answer.reason === "unexpected_answer") return { passed: false, text: "Answered, but not with a tile image." };
  return testAnswerWords(answer);
}
