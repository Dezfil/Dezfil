import { decodePng, encodePng, scaleImage } from "./png-codec";

/**
 * The thumbnail of a check's image: derived once, inside the check's
 * own budget beside the image's other preparation,
 * then kept by retention for the pane's note. The module knows nothing
 * of the renderer or the store.
 */

/** The thumbnail's width in pixels: three times the note's 44 px, so it reads sharp on a dense display. */
export const THUMBNAIL_WIDTH = 132;

export interface ThumbnailSource { width: number; height: number; png: Uint8Array }
export interface Thumbnail { width: number; height: number; bytes: number; png: Uint8Array }

export function thumbnailOf(image: ThumbnailSource): Thumbnail {
  const height = Math.max(1, Math.round((THUMBNAIL_WIDTH * image.height) / image.width));
  const png = encodePng(scaleImage(decodePng(image.png), THUMBNAIL_WIDTH, height));
  return { width: THUMBNAIL_WIDTH, height, bytes: png.byteLength, png };
}
