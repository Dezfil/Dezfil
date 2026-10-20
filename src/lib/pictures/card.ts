import type { Viewport } from "@/lib/metadata/maps";
import type { ExportImageDefinition, Appearance } from "@/lib/export/image-definition";
import type { RenderImageResult } from "@/lib/export/render-image";
import { pngDimensions } from "@/lib/export/png-codec";
import { webpDimensions, type PictureRenderRequest, type PictureSize } from "@/lib/export/picture-encode";
import { PICTURE_SHAPES, pictureHeight, type PictureShape } from "./shapes";

/** The picture a read answers when it names no shape or width: the card
 * shape at the size cards have always been served, as a PNG. */
export const CARD_STORED_SIZE = { width: 692, height: 296 } as const;
/** WebP quality for the kept sizes: labels stay clean at every size. */
export const PICTURE_QUALITY = 0.9;

export class PictureRenderError extends Error {
  constructor(readonly state: "failed" | "unsupported") { super(state === "unsupported" ? "This map has a layer the picture renderer cannot draw." : "The picture render was incomplete."); }
}

/** One kept size of one shape. */
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

/** A shape's render: the saved camera (the page frames it like Fit and
 * keeps only its tilt and rotation), the shape's frame at its master
 * scale, no overlays. */
export function cardDefinition(viewport: Viewport, appearance: Appearance, shape: PictureShape = "card"): ExportImageDefinition {
  const { frame, scale } = PICTURE_SHAPES[shape];
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

/** What the renderer is asked beside the definition: the shape's frame
 * and its kept sizes, and for the card the default PNG last. */
export function pictureRequest(shape: PictureShape): PictureRenderRequest {
  const spec = PICTURE_SHAPES[shape];
  const sizes: PictureSize[] = spec.widths.map((width) => ({ width, height: pictureHeight(shape, width), type: "image/webp" }));
  if (shape === "card") sizes.push({ ...CARD_STORED_SIZE, type: "image/png" });
  return { frame: { padding: { ...spec.padding } }, sizes, quality: PICTURE_QUALITY };
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

/** One shape's render, accepted only when complete and of the asked
 * sizes: the master at the shape's frame and scale, and every kept size in
 * its format at its pixels. The card's render also yields the default PNG. */
export function completeShape(result: RenderImageResult, mapId: string, layerIds: readonly string[], style: string, shape: PictureShape): { png: Uint8Array | null; sized: SizedPicture[] } {
  requireComplete(result, mapId, layerIds, style);
  const { frame, scale } = PICTURE_SHAPES[shape];
  let master;
  try { master = pngDimensions(result.png); } catch { throw new PictureRenderError("failed"); }
  if (master.width !== frame.width * scale || master.height !== frame.height * scale) throw new PictureRenderError("failed");
  const asked = pictureRequest(shape).sizes;
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
    else sized.push({ shape, width: size.width, height: size.height, bytes });
  });
  return { png, sized };
}
