/**
 * The Limits tab's rows: five cards, each row under the label the page
 * shows, mapped by key onto the configuration read. The read supplies
 * the unit, the range, the default, the value and whether the page may
 * change it; this table supplies only the words and the order. A test
 * holds it against the read, so a new number with no label here fails.
 *
 * Two rows are not settings: the capacities a geocode and a travel-time
 * run have under the current time limits, and the largest image the
 * server renders. Both come from the read's own facts.
 */

export type LimitsRow =
  | { readonly kind: "setting"; readonly key: string; readonly id: string; readonly label: string; readonly meta?: string; readonly keys: string }
  | { readonly kind: "capacity"; readonly of: "geocode" | "travel"; readonly id: string; readonly label: string; readonly meta?: string; readonly keys: string; readonly key?: undefined }
  | { readonly kind: "image"; readonly id: string; readonly label: string; readonly meta?: string; readonly keys: string; readonly key?: undefined };

export interface LimitsCard {
  readonly id: string;
  readonly title: string;
  /** Words the search matches the card by. */
  readonly keys: string;
  readonly rows: readonly LimitsRow[];
}

const setting = (key: string, id: string, label: string, keys: string, meta?: string): LimitsRow =>
  ({ kind: "setting", key, id, label, keys, ...(meta ? { meta } : {}) });

export const LIMITS_CARDS: readonly LimitsCard[] = [
  { id: "limits-imports", title: "Imports", keys: "import upload size file", rows: [
    setting("uploadMaxMb", "set-largest-upload", "Largest upload", "file size upload zip archive"),
    setting("remoteMaxMb", "set-largest-link-import", "Largest link import", "url remote download s3 object store size"),
    setting("remoteTimeoutS", "set-link-import-time", "Link import time limit", "url remote download timeout"),
    setting("osmMaxKm2", "set-osm-area", "OpenStreetMap area", "osm overpass area budget km2 square kilometres"),
    setting("overtureMaxKm2", "set-overture-area", "Overture area", "overture area budget km2 square kilometres places buildings",
      "For places. Buildings and addresses get a fifth of it."),
  ] },
  { id: "limits-queries", title: "Queries", keys: "sql query engine", rows: [
    setting("queryTimeoutS", "set-query-time", "Query time limit", "timeout sql layer render", "Also applies to published maps."),
    setting("previewRows", "set-preview-rows", "Rows shown in results", "preview rows result table sql"),
    setting("renderCapFeatures", "set-render-cap", "Features drawn per layer", "render cap features layer map points tiles",
      "Past this, point layers switch to tiles."),
  ] },
  { id: "limits-tools", title: "Tools", keys: "operations tools workflow run", rows: [
    setting("operationConcurrency", "set-tools-at-once", "Tools running at once", "concurrency operations parallel lane",
      "They share the query engine’s memory."),
    setting("operationQueueMax", "set-tools-waiting", "Tools waiting", "queue operations"),
    setting("operationTimeoutS", "set-tool-time", "Time limit per tool run", "operation timeout run budget"),
    { kind: "capacity", of: "geocode", id: "set-geocode-capacity", label: "Geocode addresses", keys: "geocode geocoding batch rows capacity per run derived" },
    { kind: "capacity", of: "travel", id: "set-travel-capacity", label: "Travel-time area", keys: "isochrone travel time origins capacity per run derived" },
  ] },
  { id: "limits-images", title: "Image export", keys: "export image png render chromium", rows: [
    { kind: "image", id: "set-largest-image", label: "Largest image", keys: "export image size pixels dimension" },
    setting("exportRenderConcurrency", "set-images-at-once", "Images at once", "export render concurrency chromium"),
    setting("exportRenderTimeoutS", "set-image-time", "Time limit per image", "export render timeout"),
  ] },
  { id: "limits-public", title: "Public requests", keys: "public rate limit anonymous readers visitors", rows: [
    setting("publicRateLimit", "set-public-requests", "Requests per visitor", "rate limit anonymous published view widgets"),
    setting("publicTileRateLimit", "set-public-tiles", "Tile requests per visitor", "rate limit anonymous tiles published"),
  ] },
];

/** Every row that draws a setting of the read. */
export function limitsSettingRows(): Extract<LimitsRow, { kind: "setting" }>[] {
  return LIMITS_CARDS.flatMap(card => card.rows).filter((row): row is Extract<LimitsRow, { kind: "setting" }> => row.kind === "setting");
}

/** The label each setting Limits draws is shown under, by key. */
export const LIMITS_LABELS: Readonly<Record<string, string>> = Object.fromEntries(limitsSettingRows().map(row => [row.key, row.label]));

/** Where each setting Limits draws is, as a row address inside the tab. */
export const LIMITS_ROW_IDS: Readonly<Record<string, string>> = Object.fromEntries(limitsSettingRows().map(row => [row.key, row.id]));

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A refusal in the words of the page: each setting it names by the API's
 * key is named by the label its row is shown under. */
export function inLabels(message: string, labels: Readonly<Record<string, string>>): string {
  const keys = Object.keys(labels).sort((a, b) => b.length - a.length);
  if (!keys.length) return message;
  return message.replace(new RegExp(`(?<![\\w.])(${keys.map(escape).join("|")})(?![\\w])`, "g"), key => labels[key]);
}

const grouped = (count: number) => new Intl.NumberFormat("en-US").format(count);

/** What one run of the tool can take under the current time limits. A
 * geocode run always takes at least one address; a travel-time run may
 * take none. */
export function capacityText(of: "geocode" | "travel", count: number): string {
  if (of === "travel" && count <= 0) return "None at these limits";
  const [one, many] = of === "geocode" ? ["address", "addresses"] : ["origin", "origins"];
  return `Up to ${grouped(count)} ${count === 1 ? one : many} per run`;
}
