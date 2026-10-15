import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { offeredSwitches } from "@/lib/basemap-offer";
import { satelliteBasemap } from "@/lib/basemap-satellite";
import { metadataDb } from "@/lib/metadata/db";
import { normalizeViewerControls } from "@/lib/metadata/maps";
import { publicationAbsent, resolvePublication } from "./publication-scope";

/**
 * Whether a publication's reader may draw the satellite imagery through
 * the publication's own addresses, checked on every request as the
 * published layer tiles are: a revoked or unknown token is refused as
 * they refuse it. A reader is served the imagery only where the published
 * page could show it: the map is on Satellite (its own style, kept even
 * where an admin hid Satellite since), or the page's basemap switcher is
 * on and offers it. Any other publication's token opens no imagery, so a
 * link to an unrelated map cannot spend the instance's key.
 *
 * "none" is an instance with no imagery to draw now, not set up or stored
 * under a key the instance no longer holds: to a reader, both are no
 * imagery, answered as the style answers an instance that configures none.
 */
export function requirePublishedSatellite(token: string, db: Database = metadataDb()): "shown" | "none" {
  const publication = resolvePublication(token, db);
  if (!publication) throw publicationAbsent();
  if (!satelliteBasemap(db)) return "none";
  const { map, viewerControls } = publication;
  const own = map.basemap === "satellite" && map.customBasemap === null;
  const switcher = offeredSwitches(db).satellite && normalizeViewerControls(viewerControls).basemap;
  if (!own && !switcher) throw new ApiError("not_found", "This map does not offer satellite imagery.", 404);
  return "shown";
}
