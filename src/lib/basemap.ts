/**
 * Built-in basemaps: OpenFreeMap styles — keyless and permitted for production
 * use (dark, light, and streets, selectable per map). A map stores a key (or
 * null). Null means Auto: the builder canvas follows the app theme — unless
 * DEZFIL_BASEMAP_URL is set, which pins Auto in both themes (air-gapped
 * instances). On published views Auto follows the publication's effective
 * theme — the authored default, or a reader's switch for the current page load
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
}

/** The credit for every vector style and the deployment default.
 * OpenFreeMap's own terms make naming them optional ("You do not need to
 * display the OpenFreeMap part"), so the line stays lean: the required
 * OpenMapTiles and OpenStreetMap credits only. */
const OPENFREEMAP_ATTRIBUTION: AttributionLine[] = [
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
    attribution: OPENFREEMAP_ATTRIBUTION,
  },
  {
    key: "light",
    label: "Light",
    url: "https://tiles.openfreemap.org/styles/positron",
    kind: "vector",
    attribution: OPENFREEMAP_ATTRIBUTION,
  },
  {
    key: "streets",
    label: "Streets",
    url: "https://tiles.openfreemap.org/styles/liberty",
    kind: "vector",
    attribution: OPENFREEMAP_ATTRIBUTION,
  },
];

export function isBasemapKey(value: unknown): value is BasemapKey {
  return (BASEMAP_KEYS as readonly unknown[]).includes(value);
}

/**
 * Satellite imagery is configured, never shipped: no imagery service is
 * free to point an unknown number of installs at, so an instance that
 * wants one supplies a raster tile template carrying its own key, plus
 * the credit that provider requires. The style itself is served from the
 * instance, so every basemap stays URL-shaped.
 */
export const SATELLITE_STYLE_URL = "/api/basemaps/satellite";

/** The configured imagery tile template, if any. Server-side only: it
 * may carry a key, so it never travels to the browser as a value. */
export function satelliteTileUrl(): string | null {
  return process.env.DEZFIL_SATELLITE_URL?.trim() || null;
}

/** The credit the configured imagery provider requires. */
export function satelliteAttribution(): AttributionLine[] {
  const text = process.env.DEZFIL_SATELLITE_ATTRIBUTION?.trim();
  return text ? [{ label: text }] : [];
}

/** The satellite entry, present only where imagery is configured. */
export function satelliteBasemap(): BasemapStyle | null {
  if (!satelliteTileUrl()) return null;
  return {
    key: "satellite",
    label: "Satellite",
    url: SATELLITE_STYLE_URL,
    kind: "imagery",
    attribution: satelliteAttribution(),
  };
}

/** Every style this instance offers: the three built in, plus satellite
 * when it is configured. */
export function availableBasemaps(): BasemapStyle[] {
  const satellite = satelliteBasemap();
  return satellite ? [...BASEMAPS, satellite] : BASEMAPS;
}

/** The MapLibre style document served for the configured imagery. */
export function satelliteStyleDocument(): Record<string, unknown> | null {
  const tiles = satelliteTileUrl();
  if (!tiles) return null;
  const credit = satelliteAttribution()[0]?.label;
  return {
    version: 8,
    name: "Satellite",
    sources: {
      satellite: {
        type: "raster",
        tiles: [tiles],
        tileSize: 256,
        maxzoom: 19,
        ...(credit ? { attribution: credit } : {}),
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": BASEMAP_FALLBACKS.dark },
      },
      { id: "satellite", type: "raster", source: "satellite" },
    ],
  };
}

/** The deployment default: the env override, else the dark style. */
export function basemapUrl(): string {
  return process.env.DEZFIL_BASEMAP_URL || BASEMAPS[0].url;
}

/** The deployment override, if set — it pins Auto maps in both themes. */
export function basemapOverrideUrl(): string | null {
  return process.env.DEZFIL_BASEMAP_URL || null;
}

/**
 * The credit for a deployment override. An instance that points the
 * basemap at its own style is served by its own provider, so the built-in
 * credit would name the wrong party: the override carries its own
 * attribution string, and without one nothing is claimed.
 */
export function basemapOverrideAttribution(): AttributionLine[] {
  const text = process.env.DEZFIL_BASEMAP_ATTRIBUTION?.trim();
  return text ? [{ label: text }] : [];
}

/** A map's effective basemap: its explicit choice, else the deployment default. */
export function resolveBasemapUrl(key: BasemapKey | null): string {
  const chosen = key ? availableBasemaps().find((b) => b.key === key) : undefined;
  return chosen ? chosen.url : basemapUrl();
}

/** Whether a published Auto basemap follows the effective theme (spec
 * only a genuine Auto with no deployment override does. */
export function basemapFollowsTheme(key: BasemapKey | null): boolean {
  return key === null && !basemapOverrideUrl();
}

/** The Auto style for an effective published theme. The
 * deployment override still pins Auto in both themes. */
export function autoBasemapUrlForTheme(theme: "light" | "dark"): string {
  return basemapOverrideUrl() ?? BASEMAPS.find((b) => b.key === theme)!.url;
}

/** A map's effective basemap kind. Null (Auto / deployment default) is
 * vector — Auto only ever moves between the bundled vector styles, and a
 * deployment override is treated as vector so the groups keep working. */
export function resolveBasemapKind(key: BasemapKey | null): BasemapKind {
  return (key && availableBasemaps().find((b) => b.key === key)?.kind) || "vector";
}

/** A map's effective credit lines. Null is the deployment default: the
 * override's own attribution when one is set, else the built-in credit. */
export function resolveBasemapAttribution(
  key: BasemapKey | null,
): AttributionLine[] {
  const chosen =
    key && availableBasemaps().find((b) => b.key === key)?.attribution;
  if (chosen) return chosen;
  if (basemapOverrideUrl()) return basemapOverrideAttribution();
  return OPENFREEMAP_ATTRIBUTION;
}

/** Background shown while/if basemap tiles are unreachable — data still
 * renders. Keyed by theme; the dark value is the historical constant,
 * and what published views keep using. */
export const BASEMAP_FALLBACKS = {
  dark: "#0b0e14",
  light: "#e9ecef",
} as const;

export const BASEMAP_FALLBACK_COLOR = BASEMAP_FALLBACKS.dark;
