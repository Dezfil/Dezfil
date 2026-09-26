import type { Theme } from "./theme";

/**
 * The address of a map's card image (by theme). The theme rides in the
 * address, so a toggle re-requests the image with no reload and every
 * host of the shared card follows; the route answers the theme's own
 * image or falls back to whatever the map has. The version key keeps the
 * browser's cache honest across edits.
 */
export function mapCardImageAddress(
  mapId: string,
  updatedAt: string,
  theme: Theme,
): string {
  return `/api/maps/${mapId}/thumbnail?v=${encodeURIComponent(updatedAt)}&theme=${theme}`;
}
