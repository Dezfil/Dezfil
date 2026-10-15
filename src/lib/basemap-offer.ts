import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { readStoredSettings } from "@/lib/settings/store";
import {
  BASEMAPS,
  BUILT_IN_ATTRIBUTION,
  OFFERED_SETTING,
  SINGLE_MAP_STYLES_SETTING,
  readerStyleUrl,
  type AttributionLine,
  type BasemapKey,
  type BasemapKind,
  type BasemapStyle,
} from "./basemap";
import { satelliteBasemap } from "./basemap-satellite";

/**
 * Which basemaps this instance draws and which it offers, for the server
 * alone: both read the store and the deployment's configuration.
 *
 * The drawing list is every style a map may be on and still be drawn: the
 * three built in, and Satellite while imagery is set up and readable. A map
 * on a key the list lacks draws the deployment default. The offer is the
 * drawing list less the styles an admin hid: what a person may choose. Only
 * the surfaces where a basemap is chosen take the offer (the builder's
 * picker, a published page's switcher, the runtime read, a new map's
 * default); every surface that draws a map takes the drawing list, so a
 * map already on a hidden style keeps drawing it everywhere.
 */

/** Whether each style is offered now: on unless an admin turned it off. */
export function offeredSwitches(db: Database = metadataDb()): Record<BasemapKey, boolean> {
  const stored = readStoredSettings(db);
  return Object.fromEntries(Object.entries(OFFERED_SETTING)
    .map(([key, setting]) => [key, stored[setting] !== false])) as Record<BasemapKey, boolean>;
}

/** Whether a map may take a style address the library does not offer: on
 * unless an admin turned it off. */
export function singleMapStylesAllowed(db: Database = metadataDb()): boolean {
  return readStoredSettings(db)[SINGLE_MAP_STYLES_SETTING] !== false;
}

/** Every style a map may be on and still be drawn. */
export function drawingBasemaps(db: Database = metadataDb()): BasemapStyle[] {
  const satellite = satelliteBasemap(db);
  return satellite ? [...BASEMAPS, satellite] : BASEMAPS;
}

/** The styles a person may choose: the drawing list less the hidden ones. */
export function offeredBasemaps(db: Database = metadataDb()): BasemapStyle[] {
  const offered = offeredSwitches(db);
  return drawingBasemaps(db).filter((b) => offered[b.key]);
}

/** The drawing list with each style marked offered or not, for a page that
 * both draws a map and lets a person choose its basemap. */
export function basemapChoices(db: Database = metadataDb()): BasemapStyle[] {
  const offered = offeredSwitches(db);
  return drawingBasemaps(db).map((b) => ({ ...b, offered: offered[b.key] }));
}

/** The same list as a publication's reader reaches each style: Satellite
 * at the publication's own address, which answers a reader who is not
 * signed in. */
export function readerBasemapChoices(token: string, db: Database = metadataDb()): BasemapStyle[] {
  return basemapChoices(db).map((b) => ({ ...b, url: readerStyleUrl(b.url, token) }));
}

/** The deployment's own style, if set: it pins Auto maps in both themes. */
export function basemapOverrideUrl(): string | null {
  return process.env.DEZFIL_BASEMAP_URL || null;
}

/** The deployment default: its own style, else the dark style. */
export function basemapUrl(): string {
  return basemapOverrideUrl() ?? BASEMAPS[0].url;
}

/**
 * The credit for the deployment's own style. An instance that points the
 * basemap at its own style is served by its own provider, so the built-in
 * credit would name the wrong party: the override carries its own
 * attribution string, and without one nothing is claimed.
 */
export function basemapOverrideAttribution(): AttributionLine[] {
  const text = process.env.DEZFIL_BASEMAP_ATTRIBUTION?.trim();
  return text ? [{ label: text }] : [];
}

/** A map's drawn basemap: its explicit choice while the drawing list has
 * it, else the deployment default. */
export function resolveBasemapUrl(key: BasemapKey | null, db: Database = metadataDb()): string {
  const chosen = key ? drawingBasemaps(db).find((b) => b.key === key) : undefined;
  return chosen ? chosen.url : basemapUrl();
}

/** Whether a published Auto basemap follows the effective theme: only a
 * genuine Auto with no deployment style does. */
export function basemapFollowsTheme(key: BasemapKey | null): boolean {
  return key === null && !basemapOverrideUrl();
}

/** The Auto style for an effective published theme. The deployment's own
 * style still pins Auto in both themes. */
export function autoBasemapUrlForTheme(theme: "light" | "dark"): string {
  return basemapOverrideUrl() ?? BASEMAPS.find((b) => b.key === theme)!.url;
}

/** A map's drawn basemap kind. Null (Auto or the deployment default) is
 * vector: a deployment style is treated as vector so the groups keep
 * working. */
export function resolveBasemapKind(key: BasemapKey | null, db: Database = metadataDb()): BasemapKind {
  return (key && drawingBasemaps(db).find((b) => b.key === key)?.kind) || "vector";
}

/** A map's drawn credit. Null is the deployment default: the deployment
 * style's own attribution when one is set, else the built-in credit. */
export function resolveBasemapAttribution(key: BasemapKey | null, db: Database = metadataDb()): AttributionLine[] {
  const chosen = key && drawingBasemaps(db).find((b) => b.key === key)?.attribution;
  if (chosen) return chosen;
  if (basemapOverrideUrl()) return basemapOverrideAttribution();
  return BUILT_IN_ATTRIBUTION;
}
