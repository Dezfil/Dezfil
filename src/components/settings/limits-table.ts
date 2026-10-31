import { formatSettingNumber } from "./server-set";

/**
 * The Limits tab's rows: six cards, each row under the label the page
 * shows, mapped by key onto the configuration read. The read supplies
 * the range, the default, the value and whether the page may change it;
 * this table supplies the words, the order, and the unit wherever the
 * page writes one other than the read's (a count takes none, a rate
 * window is "every 10 seconds"). A test holds it against the read, so a
 * new number with no label here fails.
 *
 * Two rows are not settings: the capacities a geocode and a travel-time
 * run have under the current time limits, and the largest image the
 * server renders. Both come from the read's own facts. A capacity row is
 * marked when the read reports its service's address not set.
 *
 * A counted row is a setting with the instance's count beside its value,
 * from the read's own count. A choice row draws the values the read offers
 * in this table's words.
 */

export type LimitsRow =
  | { readonly kind: "setting"; readonly key: string; readonly id: string; readonly label: string; readonly meta?: string; readonly keys: string;
    /** The unit the page writes after the number, where it is not the read's; empty for none. */
    readonly unit?: string }
  | { readonly kind: "counted"; readonly key: string; readonly of: "maps" | "projects" | "people"; readonly id: string; readonly label: string; readonly meta?: string; readonly keys: string; readonly unit: string }
  | { readonly kind: "choice"; readonly key: string; readonly id: string; readonly label: string; readonly meta?: string; readonly keys: string;
    readonly words: Readonly<Record<string, string>>;
    /** The quiet line under the row while its value is not this. */
    readonly noteUnless: string; readonly note: string }
  | { readonly kind: "capacity"; readonly of: "geocode" | "travel"; readonly id: string; readonly label: string; readonly meta?: string; readonly keys: string; readonly key?: undefined;
    /** The read's setting for the address of the service the tool calls. */
    readonly service: string }
  | { readonly kind: "image"; readonly id: string; readonly label: string; readonly meta?: string; readonly keys: string; readonly key?: undefined; readonly unit: string };

export interface LimitsCard {
  readonly id: string;
  readonly title: string;
  /** Words the search matches the card by. */
  readonly keys: string;
  readonly rows: readonly LimitsRow[];
}

const setting = (key: string, id: string, label: string, keys: string, words: { meta?: string; unit?: string } = {}): LimitsRow =>
  ({ kind: "setting", key, id, label, keys, ...(words.meta ? { meta: words.meta } : {}), ...(words.unit !== undefined ? { unit: words.unit } : {}) });
/** No unit after a count. */
const COUNT = { unit: "" };
const EVERY_10_SECONDS = { unit: "every 10 seconds" };
const counted = (key: string, of: "maps" | "projects" | "people", id: string, label: string, keys: string): LimitsRow =>
  ({ kind: "counted", key, of, id, label, keys, meta: "Zero means no limit.", ...COUNT });

export const LIMITS_CARDS: readonly LimitsCard[] = [
  { id: "limits-imports", title: "Imports", keys: "import upload size file", rows: [
    setting("uploadMaxMb", "set-largest-upload", "Largest upload", "file size upload zip archive"),
    setting("dataProcessingTimeoutS", "set-data-processing-time", "Data processing time limit", "upload reception import refresh geometry sketch export timeout"),
    setting("remoteMaxMb", "set-largest-link-import", "Largest link import", "url remote download s3 object store size"),
    setting("remoteTimeoutS", "set-link-import-time", "Link import time limit", "url remote download timeout"),
    setting("osmMaxKm2", "set-osm-area", "OpenStreetMap area", "osm overpass area budget km2 square kilometres"),
    setting("overtureMaxKm2", "set-overture-area", "Overture area", "overture area budget km2 square kilometres places buildings",
      { meta: "For places. Buildings and addresses get a fifth of it." }),
  ] },
  { id: "limits-queries", title: "Queries", keys: "sql query engine", rows: [
    setting("queryTimeoutS", "set-query-time", "Query time limit", "timeout sql layer render", { meta: "Also applies to inspection, previews and published maps." }),
    setting("previewRows", "set-preview-rows", "Rows shown in results", "preview rows result table sql"),
    setting("renderCapFeatures", "set-render-cap", "Features drawn per layer", "render cap features layer map points tiles",
      { meta: "Past this, point layers switch to tiles." }),
    setting("renderCapBytes", "set-render-bytes", "Bytes drawn per layer", "render bytes layer json uncompressed"),
  ] },
  { id: "limits-tools", title: "Tools", keys: "operations tools workflow run", rows: [
    setting("operationConcurrency", "set-tools-at-once", "Tools running at once", "concurrency operations parallel lane",
      { meta: "They share the query engine’s memory.", ...COUNT }),
    setting("operationQueueMax", "set-tools-waiting", "Tools waiting", "queue operations", COUNT),
    setting("operationTimeoutS", "set-tool-time", "Time limit per tool run", "operation timeout run budget"),
    { kind: "capacity", of: "geocode", id: "set-geocode-capacity", label: "Geocode addresses", keys: "geocode geocoding batch rows capacity per run derived", service: "geocoderUrl" },
    { kind: "capacity", of: "travel", id: "set-travel-capacity", label: "Travel-time area", keys: "isochrone travel time origins capacity per run derived", service: "isochroneUrl" },
  ] },
  { id: "limits-images", title: "Image export", keys: "export image png render chromium", rows: [
    { kind: "image", id: "set-largest-image", label: "Largest image", keys: "export image size pixels dimension", unit: "px per side" },
    setting("exportRenderConcurrency", "set-images-at-once", "Images at once", "export render concurrency chromium", COUNT),
    setting("exportRenderTimeoutS", "set-image-time", "Time limit per image", "export render timeout"),
  ] },
  { id: "limits-public", title: "Public requests", keys: "public rate limit anonymous readers visitors", rows: [
    setting("publicRateLimit", "set-public-requests", "Requests per visitor", "rate limit anonymous published view widgets", EVERY_10_SECONDS),
    setting("publicTileRateLimit", "set-public-tiles", "Tile requests per visitor", "rate limit anonymous tiles published", EVERY_10_SECONDS),
  ] },
  { id: "limits-instance", title: "This instance", keys: "instance count hosted quota capacity", rows: [
    counted("mapsLimit", "maps", "set-maps-limit", "Maps on this instance", "maps count limit quota duplicates template copies"),
    counted("projectsLimit", "projects", "set-projects-limit", "Projects on this instance", "projects count limit quota"),
    counted("peopleLimit", "people", "set-people-limit", "People on this instance", "people accounts members count limit quota"),
    { kind: "choice", key: "tokenLifetimeMax", id: "set-longest-token", label: "Longest token lifetime", keys: "api mcp token expiry expire lifetime bound maximum",
      words: { none: "No limit", "30d": "30 days", "90d": "90 days", "1y": "1 year" },
      noteUnless: "none", note: "Tokens made earlier keep their own expiry." },
  ] },
];

/** Every row that draws a number of the read. */
export function limitsSettingRows(): Extract<LimitsRow, { kind: "setting" | "counted" }>[] {
  return LIMITS_CARDS.flatMap(card => card.rows).filter((row): row is Extract<LimitsRow, { kind: "setting" | "counted" }> => row.kind === "setting" || row.kind === "counted");
}

/** Every row that draws a setting of the read, a number or a choice. */
const rowsWithSetting = () => LIMITS_CARDS.flatMap(card => card.rows).flatMap(row => row.key === undefined ? [] : [{ key: row.key, label: row.label, id: row.id }]);

/** The label each setting Limits draws is shown under, by key. */
export const LIMITS_LABELS: Readonly<Record<string, string>> = Object.fromEntries(rowsWithSetting().map(row => [row.key, row.label]));

/** Where each setting Limits draws is, as a row address inside the tab. */
export const LIMITS_ROW_IDS: Readonly<Record<string, string>> = Object.fromEntries(rowsWithSetting().map(row => [row.key, row.id]));

/** The unit the page writes after each setting Limits draws, by key, where
 * it is not the read's own; empty for a count. */
export const LIMITS_UNITS: Readonly<Record<string, string>> = Object.fromEntries(limitsSettingRows().flatMap(row => row.unit !== undefined ? [[row.key, row.unit]] : []));

/** The unit a setting is shown with: the page's own where Limits names one, else the read's. */
export function shownUnit(key: string, readUnit: string | undefined): string {
  return Object.hasOwn(LIMITS_UNITS, key) ? LIMITS_UNITS[key] : readUnit ?? "";
}

/** A setting's number as the page writes it: grouped, with the unit it is shown with. */
export function withShownUnit(key: string, value: unknown, readUnit: string | undefined): string {
  const unit = shownUnit(key, readUnit);
  return `${formatSettingNumber(value)}${unit ? ` ${unit}` : ""}`;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A refusal in the words of the page: each setting it names by the API's
 * key is named by the label its row is shown under. */
export function inLabels(message: string, labels: Readonly<Record<string, string>>): string {
  const keys = Object.keys(labels).sort((a, b) => b.length - a.length);
  if (!keys.length) return message;
  return message.replace(new RegExp(`(?<![\\w.])(${keys.map(escape).join("|")})(?![\\w])`, "g"), key => labels[key]);
}

const grouped = (count: number) => new Intl.NumberFormat("en-US").format(count);

/** What a counted row shows beside its value. */
export const countedText = (count: number) => `${grouped(count)} now`;

/** A choice row's value in its words; a value it does not word shows as itself. */
export function limitChoiceWords(row: Extract<LimitsRow, { kind: "choice" }>, value: unknown): string {
  return row.words[String(value)] ?? String(value ?? "");
}

/** Whether the read reports a service's address set: an address discloses
 * only whether it is set and where; null when the read does not say. */
export function serviceSetUp(settings: Readonly<Record<string, { readonly value: unknown }>>, key: string): boolean | null {
  const value = settings[key]?.value;
  if (typeof value !== "object" || value === null) return null;
  const set = (value as { set?: unknown }).set;
  return typeof set === "boolean" ? set : null;
}

/** What one run of the tool can take under the current time limits. A
 * geocode run always takes at least one address; a travel-time run may
 * take none. */
export function capacityText(of: "geocode" | "travel", count: number): string {
  if (of === "travel" && count <= 0) return "None at these limits";
  const [one, many] = of === "geocode" ? ["address", "addresses"] : ["origin", "origins"];
  return `Up to ${grouped(count)} ${count === 1 ? one : many} per run`;
}
