import type { Viewport } from "@/lib/metadata/maps";
import type { ExportImageDefinition, Appearance } from "@/lib/export/image-definition";
import type { RenderImageResult } from "@/lib/export/render-image";
import { decodePng, encodePng, scaleImage } from "@/lib/export/png-codec";
export const CARD_RENDER_SIZE = { width: 990, height: 424 } as const;
export const CARD_STORED_SIZE = { width: 692, height: 296 } as const;
export class PictureRenderError extends Error {
  constructor(readonly state: "failed" | "unsupported") { super(state === "unsupported" ? "This map has a layer the picture renderer cannot draw." : "The picture render was incomplete."); }
}
export function cardDefinition(viewport: Viewport, appearance: Appearance): ExportImageDefinition {
  return { viewport: { ...viewport, pitch: viewport.pitch ?? 0, bearing: viewport.bearing ?? 0 }, size: { ...CARD_RENDER_SIZE }, mapScale: 1, appearance, legend: { visible: false, corner: "bottom-left", size: "s" }, widgets: [], title: null };
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
export function completePicture(result: RenderImageResult, mapId: string, layerIds: readonly string[], style: string): Uint8Array {
  requireComplete(result, mapId, layerIds, style);
  const decoded = decodePng(result.png);
  if (decoded.width !== CARD_RENDER_SIZE.width || decoded.height !== CARD_RENDER_SIZE.height) throw new PictureRenderError("failed");
  return encodePng(scaleImage(decoded, CARD_STORED_SIZE.width, CARD_STORED_SIZE.height));
}
