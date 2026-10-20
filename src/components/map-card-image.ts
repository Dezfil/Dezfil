import type { PictureShape } from "@/lib/pictures/shapes";
import type { Theme } from "./theme";

/**
 * The address of a map's card image (by theme). The theme rides in the
 * address, so a toggle re-requests the image with no reload and every
 * host of the shared card follows; the route answers the theme's own
 * image or falls back to whatever the map has. The version is the
 * listing's picture version, which changes exactly when a new picture
 * lands, never with the map's edits: a replaced picture is always a new
 * address, so no cached older image can stand in for it, and an edit that
 * changes no picture asks for nothing new. With a size, the address names
 * one of the sizes kept of that picture: its shape and its width.
 */
export function mapCardImageAddress(
  mapId: string,
  version: string,
  theme: Theme,
  size?: { shape: PictureShape; width: number },
): string {
  const kept = size ? `&shape=${size.shape}&width=${size.width}` : "";
  return `/api/maps/${mapId}/thumbnail?v=${encodeURIComponent(version)}&theme=${theme}${kept}`;
}
