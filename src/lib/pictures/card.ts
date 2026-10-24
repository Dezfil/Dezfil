import type { Viewport } from "@/lib/metadata/maps";
import type { ExportImageDefinition, Appearance } from "@/lib/export/image-definition";
import type { RenderImageResult } from "@/lib/export/render-image";
import { pngDimensions } from "@/lib/export/png-codec";
import { webpDimensions, type PictureRenderRequest, type PictureSize } from "@/lib/export/picture-encode";
import { DEFAULT_WIDTH, KEPT_SHAPE, PICTURE_SHAPE, pictureHeight, type PictureShape } from "./shapes";

/** The picture a read answers when it names no shape or width: the kept
 * shape at the width cards have always been served, as a PNG. */
export const CARD_STORED_SIZE = { width: DEFAULT_WIDTH, height: pictureHeight(DEFAULT_WIDTH) } as const;
/** WebP quality for the kept sizes: labels stay clean at every size. */
export const PICTURE_QUALITY = 0.9;

export class PictureRenderError extends Error {
  constructor(readonly state: "failed" | "unsupported") { super(state === "unsupported" ? "This map has a layer the picture renderer cannot draw." : "The picture render was incomplete."); }
}

/** One kept size, listed under the kept shape's name. */
export interface SizedPicture {
  shape: PictureShape;
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** One appearance's picture: the default PNG and every kept size. */
export interface PictureImages {
  png: Uint8Array;
  sized: SizedPicture[];
}

/** An appearance's render: the saved camera (the page frames it like Fit
 * and keeps only its tilt and rotation), the shape's frame at its master
 * scale, no overlays. */
export function cardDefinition(viewport: Viewport, appearance: Appearance): ExportImageDefinition {
  const { frame, scale } = PICTURE_SHAPE;
  return {
    viewport: { ...viewport, pitch: viewport.pitch ?? 0, bearing: viewport.bearing ?? 0 },
    size: { width: frame.width * scale, height: frame.height * scale },
    mapScale: scale,
    appearance,
    legend: { visible: false, corner: "bottom-left", size: "s" },
    widgets: [],
    title: null,
  };
}

/** What the renderer is asked beside the definition: the shape's frame,
 * its kept sizes, and the default PNG last. */
export function pictureRequest(): PictureRenderRequest {
  const sizes: PictureSize[] = PICTURE_SHAPE.widths.map((width) => ({ width, height: pictureHeight(width), type: "image/webp" }));
  sizes.push({ ...CARD_STORED_SIZE, type: "image/png" });
  return { frame: { padding: { ...PICTURE_SHAPE.padding } }, sizes, quality: PICTURE_QUALITY };
}

function requireComplete(result: RenderImageResult, mapId: string, layerIds: readonly string[], style: string): void {
  let declaration;
  try { declaration = JSON.parse(result.consumed ?? "null"); } catch { throw new PictureRenderError("failed"); }
  if (!declaration || !Array.isArray(declaration.unsupported)) throw new PictureRenderError("failed");
  if (declaration.unsupported.length) throw new PictureRenderError("unsupported");
  const layers = Array.isArray(declaration.layers) ? declaration.layers.map((l: { id?: unknown }) => l?.id) : [];
  if (declaration.map !== mapId || !Array.isArray(declaration.failures) || declaration.failures.length || result.abandoned.length ||
      declaration.paintedStyle !== style || declaration.requestedStyle !== style || layers.length !== layerIds.length || layerIds.some(id => !layers.includes(id))) throw new PictureRenderError("failed");
}

/** An appearance's render, accepted only when complete and of the asked
 * sizes: the master at the shape's frame and scale, every kept size in its
 * format at its pixels, and the default PNG. */
export function completePicture(result: RenderImageResult, mapId: string, layerIds: readonly string[], style: string): PictureImages {
  requireComplete(result, mapId, layerIds, style);
  const { frame, scale } = PICTURE_SHAPE;
  let master;
  try { master = pngDimensions(result.png); } catch { throw new PictureRenderError("failed"); }
  if (master.width !== frame.width * scale || master.height !== frame.height * scale) throw new PictureRenderError("failed");
  const asked = pictureRequest().sizes;
  const encoded = result.encoded ?? [];
  if (encoded.length !== asked.length) throw new PictureRenderError("failed");
  let png: Uint8Array | null = null;
  const sized: SizedPicture[] = [];
  asked.forEach((size, i) => {
    const bytes = encoded[i];
    let found: { width: number; height: number } | null = null;
    if (size.type === "image/png") { try { found = pngDimensions(bytes); } catch { found = null; } }
    else found = webpDimensions(bytes);
    if (!found || found.width !== size.width || found.height !== size.height) throw new PictureRenderError("failed");
    if (size.type === "image/png") png = bytes;
    else sized.push({ shape: KEPT_SHAPE, width: size.width, height: size.height, bytes });
  });
  if (!png) throw new PictureRenderError("failed");
  return { png, sized };
}
