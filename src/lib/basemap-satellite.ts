import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { tileTemplateRefusal } from "@/lib/settings/address-admission";
import { resolveServiceAddress } from "@/lib/settings/service-address";
import { readStoredSettings } from "@/lib/settings/store";
import {
  BASEMAP_FALLBACKS,
  SATELLITE_MAX_ZOOM,
  SATELLITE_STYLE_URL,
  SATELLITE_TILE_SCHEME,
  satelliteTilesUrl,
  type AttributionLine,
  type BasemapStyle,
} from "./basemap";

/**
 * The satellite imagery in effect, for the server alone: the tile template
 * may carry a key, so it never leaves the server. The style document a
 * browser or the server's renderer loads names the instance's own tile
 * address, and the server fetches each tile from the template and passes
 * it back (`basemap-satellite-tiles.ts`).
 *
 * The template and its credit are each set by their variable or stored by
 * an admin beside it, a set variable winning. The template is read through
 * the address resolver, which refuses a stored one the instance's key no
 * longer opens rather than fall back to anything.
 */

/** The template in effect, or null while none is set. Throws the coded
 * unreadable refusal for a stored template the key no longer opens. */
export function satelliteTileUrl(db: Database = metadataDb()): string | null {
  return resolveServiceAddress("satelliteUrl", db).address;
}

/** Whether imagery is set up, its template can be read now and the
 * template's own rule lets it be drawn: one carrying a user name or
 * password, which only its variable can set, counts as no imagery. */
function satelliteReadable(db: Database): boolean {
  try {
    const template = satelliteTileUrl(db);
    return template !== null && tileTemplateRefusal(template) === null;
  } catch (error) {
    if (error instanceof ApiError && error.code === "service_address_unreadable") return false;
    throw error;
  }
}

/** The credit the imagery provider requires: the variable while it is set,
 * else what an admin stored, else none. */
export function satelliteAttribution(db: Database = metadataDb()): AttributionLine[] {
  const variable = process.env.DEZFIL_SATELLITE_ATTRIBUTION;
  const text = variable !== undefined && variable !== ""
    ? variable.trim()
    : readStoredSettings(db).satelliteAttribution;
  return typeof text === "string" && text ? [{ label: text }] : [];
}

/** The Satellite entry, present while a template is set, readable and drawable. */
export function satelliteBasemap(db: Database = metadataDb()): BasemapStyle | null {
  if (!satelliteReadable(db)) return null;
  return {
    key: "satellite",
    label: "Satellite",
    url: SATELLITE_STYLE_URL,
    kind: "imagery",
    attribution: satelliteAttribution(db),
  };
}

/** The MapLibre style document served for the imagery at a style address,
 * its tiles under that address, or null while no template is set or the
 * one in effect carries a user name or password. Throws the coded
 * unreadable refusal, never a default. */
export function satelliteStyleDocument(
  styleUrl: string = SATELLITE_STYLE_URL,
  db: Database = metadataDb(),
): Record<string, unknown> | null {
  const template = satelliteTileUrl(db);
  if (!template || tileTemplateRefusal(template)) return null;
  const credit = satelliteAttribution(db)[0]?.label;
  return {
    version: 8,
    name: "Satellite",
    sources: {
      satellite: {
        type: "raster",
        tiles: [satelliteTilesUrl(styleUrl)],
        scheme: SATELLITE_TILE_SCHEME,
        tileSize: 256,
        maxzoom: SATELLITE_MAX_ZOOM,
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
