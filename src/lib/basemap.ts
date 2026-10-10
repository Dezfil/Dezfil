/**
 * Built-in basemaps: OpenFreeMap styles — keyless and permitted for production
 * use (dark, light, and streets, selectable per map). A map stores a key (or
 * null). Null means Auto: the builder canvas follows the app theme — unless
 * the deployment's own style is set, which pins Auto in both themes
 * (air-gapped instances; the server reads it and hands it down). On
 * published views Auto follows the publication's effective theme — the
 * authored default, or a reader's switch for the current page load
 * (retired the remembered per-link override) — while the deployment override
 * stays fixed in both themes. A published reader may also pick a style for the
 * current load, and there the Dark/Light pair moves with the theme control;
 * every explicit choice still stays fixed in the builder. Server defaults
 * outside a publication keep null's original meaning, the deployment default.
 */

export const BASEMAP_KEYS = [
  "dark",
  "light",
  "streets",
  "satellite",
] as const;

export type BasemapKey = (typeof BASEMAP_KEYS)[number];

/** Vector styles carry the OpenMapTiles content groups;
 * imagery is a raster photo — no groups, and its own credit. */
export type BasemapKind = "vector" | "imagery";

/** One line of the on-map credit; rendered as a link when href is set. */
export interface AttributionLine {
  label: string;
  href?: string;
}

export interface BasemapStyle {
  key: BasemapKey;
  label: string;
  url: string;
  kind: BasemapKind;
  attribution: AttributionLine[];
  /** False where an admin hid the style: it is drawn where a map is on it
   * and listed nowhere a basemap is chosen. Absent means offered. */
  offered?: boolean;
}

/** The credit for every vector style and the deployment default.
 * OpenFreeMap's own terms make naming them optional ("You do not need to
 * display the OpenFreeMap part"), so the line stays lean: the required
 * OpenMapTiles and OpenStreetMap credits only. */
export const BUILT_IN_ATTRIBUTION: AttributionLine[] = [
  { label: "© OpenMapTiles", href: "https://openmaptiles.org" },
  // The OpenStreetMap credit has to be followable: their guidance asks
  // for a link to the copyright page, so a bare label is not a credit.
  {
    label: "OpenStreetMap contributors",
    href: "https://www.openstreetmap.org/copyright",
  },
];

export const BASEMAPS: BasemapStyle[] = [
  {
    key: "dark",
    label: "Dark",
    url: "https://tiles.openfreemap.org/styles/dark",
    kind: "vector",
    attribution: BUILT_IN_ATTRIBUTION,
  },
  {
    key: "light",
    label: "Light",
    url: "https://tiles.openfreemap.org/styles/positron",
    kind: "vector",
    attribution: BUILT_IN_ATTRIBUTION,
  },
  {
    key: "streets",
    label: "Streets",
    url: "https://tiles.openfreemap.org/styles/liberty",
    kind: "vector",
    attribution: BUILT_IN_ATTRIBUTION,
  },
];

/** The instance setting that offers each style, keyed as the change
 * operation takes it: off, the style is drawn where a map is on it and
 * offered nowhere a basemap is chosen. */
export const OFFERED_SETTING = {
  dark: "basemaps.dark",
  light: "basemaps.light",
  streets: "basemaps.streets",
  satellite: "basemaps.satellite",
} as const satisfies Record<BasemapKey, string>;

/** A style an admin added to the instance's library by its address, as a
 * person choosing a basemap is offered it: a map that takes it keeps its own
 * copy of the name, the address and the credit. */
export interface LibraryStyleOffer {
  id: string;
  name: string;
  url: string;
  attribution: AttributionLine[];
}

/** The library's bounds: how many styles it holds, and a style's name and
 * address lengths. */
export const LIBRARY_LIMITS = { styles: 50, name: 60, address: 2048 } as const;

export function isBasemapKey(value: unknown): value is BasemapKey {
  return (BASEMAP_KEYS as readonly unknown[]).includes(value);
}

/**
 * Satellite imagery is configured, never shipped: no imagery service is
 * free to point an unknown number of installs at, so an instance that
 * wants one supplies a raster tile template carrying its own key, plus
 * the credit that provider requires. The style itself is served from the
 * instance, so every basemap stays URL-shaped. The template and the
 * credit in effect, and the lists of styles an instance draws and offers,
 * are the server's to read (`basemap-satellite.ts`, `basemap-offer.ts`):
 * this module reaches the browser and reads no configuration.
 */
export const SATELLITE_STYLE_URL = "/api/basemaps/satellite";

/** A built-in style's own address. */
export function builtInBasemapUrl(key: "dark" | "light" | "streets"): string {
  return BASEMAPS.find((b) => b.key === key)!.url;
}

/** The styles of a list a person may choose: an entry marked as not
 * offered is drawn where a map is on it, and listed nowhere a basemap is
 * chosen. */
export function offeredOnly(basemaps: BasemapStyle[]): BasemapStyle[] {
  return basemaps.filter((b) => b.offered !== false);
}

/** A key's kind in a list of styles. Null (Auto), or a key the list lacks,
 * is vector: Auto only ever moves between the built-in vector styles. */
export function basemapKindIn(
  basemaps: BasemapStyle[],
  key: BasemapKey | null,
): BasemapKind {
  return (key && basemaps.find((b) => b.key === key)?.kind) || "vector";
}

/** A key's credit in a list of styles, else the built-in credit. */
export function basemapCreditIn(
  basemaps: BasemapStyle[],
  key: BasemapKey | null,
): AttributionLine[] {
  return (
    (key && basemaps.find((b) => b.key === key)?.attribution) ||
    BUILT_IN_ATTRIBUTION
  );
}

/** Background shown while/if basemap tiles are unreachable — data still
 * renders. Keyed by theme; the dark value is the historical constant,
 * and what published views keep using. */
export const BASEMAP_FALLBACKS = {
  dark: "#0b0e14",
  light: "#e9ecef",
} as const;

export const BASEMAP_FALLBACK_COLOR = BASEMAP_FALLBACKS.dark;
