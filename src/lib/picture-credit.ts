/**
 * The credit for a page of map pictures. Each picture is a snapshot of a
 * map drawn on its basemap, and the small pictures have no room for the
 * open map's credit, so a page that shows them credits their basemaps on
 * one line. Each picture is credited by the basemap it was drawn on, as
 * the server recorded it when the picture was saved, so a picture keeps
 * its credit whatever its map, the imagery or the instance's styles do
 * until the map is pictured again. A picture saved before pictures
 * recorded it has no record, and its credit is named through the one
 * effective-basemap lookup the builder credits the open map with, as
 * every picture's was: the built-in styles' line, Satellite's configured
 * credit, a library or a single map's own style by its saved credit, the
 * deployment's own style by the credit it configured. A map with no
 * picture shows chart paper, drawn on no basemap, and credits nothing.
 * Dependency-free beyond the basemap domain: reaches the client bundle.
 */

import { BASEMAPS, type AttributionLine, type BasemapKey, type BasemapStyle } from "./basemap";
import { effectiveBasemap, type EffectiveBasemap } from "./basemap-effective";
import type { CustomBasemap } from "./metadata/maps";

/** What a page knows of the instance's basemaps, as the server reads it:
 * every style a map may be drawn on, the deployment default, and the
 * deployment's own style with its credit. */
export interface PictureBasemaps {
  basemaps: BasemapStyle[];
  defaultUrl: string;
  overrideUrl: string | null;
  overrideAttribution: AttributionLine[];
}

/** The built-in styles alone, for a host the server hands nothing. */
export const BUILT_IN_PICTURE_BASEMAPS: PictureBasemaps = {
  basemaps: BASEMAPS,
  defaultUrl: BASEMAPS[0].url,
  overrideUrl: null,
  overrideAttribution: [],
};

/** The basemap a picture was drawn on, as recorded when it was saved: the
 * style's address, its kind, whether the map's own style drew it rather
 * than one of the instance's, and the credit it claimed then. */
export type DrawnBasemap = Pick<EffectiveBasemap, "url" | "kind" | "custom" | "attribution">;

/** A map as a listing carries it: its basemap, whether it has a picture
 * the viewer is served, and the basemap that picture was drawn on (none
 * recorded for a picture saved before pictures recorded it). */
export interface PicturedMap {
  basemap: BasemapKey | null;
  customBasemap: CustomBasemap | null;
  hasThumbnail: boolean;
  thumbnailBasemap?: DrawnBasemap | null;
}

/** The order the credits stand in, whatever order the page lists its
 * maps in: the built-in styles, Satellite, the deployment's own style,
 * then each map's own style by its address. */
const BUILT_IN_URLS = new Set(BASEMAPS.map((b) => b.url));
function standing(url: string, custom: boolean, imagery: boolean): number {
  if (custom) return 3;
  if (imagery) return 1;
  return BUILT_IN_URLS.has(url) ? 0 : 2;
}

/** The credit lines of the basemaps a page's pictures were drawn on, a
 * line shared by two styles named once. Empty when no picture stands on a
 * basemap that claims a credit: the page then carries no line. */
export function picturesCredit(
  maps: readonly PicturedMap[],
  instance: PictureBasemaps,
  theme: "light" | "dark",
): AttributionLine[] {
  const credits = maps
    .filter((m) => m.hasThumbnail)
    .map((m) => {
      // A picture saved before pictures recorded the basemap they were
      // drawn on has no record: it is credited by its map's basemap now.
      const drawn = m.thumbnailBasemap ?? effectiveBasemap({
        key: m.basemap,
        custom: m.customBasemap,
        theme,
        overrideUrl: instance.overrideUrl,
        defaultUrl: instance.defaultUrl,
        basemaps: instance.basemaps,
        overrideAttribution: instance.overrideAttribution,
      });
      return {
        rank: standing(drawn.url, drawn.custom, drawn.kind === "imagery"),
        url: drawn.url,
        lines: drawn.attribution,
      };
    })
    .sort((a, b) => a.rank - b.rank || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const named = new Set<string>();
  const lines: AttributionLine[] = [];
  for (const credit of credits) {
    for (const line of credit.lines) {
      if (named.has(line.label)) continue;
      named.add(line.label);
      lines.push(line);
    }
  }
  return lines;
}
