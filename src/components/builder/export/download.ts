import { toCanvas } from "html-to-image";
import type { Corner } from "@/lib/corners";
import {
  resolveMapScale,
  type ExportImageDefinition,
} from "@/lib/export/image-definition";
import { elementScale } from "@/lib/export/space";
import type { CaptureAtSize } from "../../map/capture";

/**
 * The download pipeline: the map stack captured at full resolution,
 * then the preview's own overlay DOM — widget rail (including a docked
 * legend), title, attribution, and any standalone legend — rasterized
 * at the same scale factor and composited over it. The rasterized nodes
 * ARE the preview nodes, so "what is inside the frame is the image"
 * holds for the overlays by construction (spike-validated).
 *
 * Everything here throws on failure — the card owns the busy state and
 * the visible error with retry. A silent no-op is the defect class this
 * feature exists to end.
 */

/** The legend's inset from its corner, in composition pixels at the
 * calibration space — it scales with the space like every other piece of
 * chrome, so it stays the same share of the image. */
const CORNER_INSET = 12;

export interface OverlayLegend {
  /** The scale wrapper around a standalone LegendPanel. A docked legend
   * belongs to `chrome` and is never rasterized a second time here. */
  node: HTMLElement | null;
  corner: Corner;
}

export interface ComposeInput {
  capture: CaptureAtSize;
  definition: ExportImageDefinition;
  mapName: string;
  legend: OverlayLegend | null;
  /** The frame-sized chrome layer: widget rail, title, attribution. One
   * node, one raster — absolutely-positioned children keep their anchors
   * because their positioned ancestor travels with them. */
  chrome: HTMLElement | null;
}

/** A content-download-safe filename from the free-text map name. */
function pngFilename(name: string): string {
  const base = name
    .replace(/[^A-Za-z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${base || "map"}.png`;
}

/** Rasterize a DOM node at `pixelRatio`, with the wrapping cache-buster
 * html-to-image needs disabled — same-origin fonts and styles only. */
async function rasterize(
  node: HTMLElement,
  pixelRatio: number,
): Promise<HTMLCanvasElement> {
  try {
    return await toCanvas(node, { pixelRatio, cacheBust: false });
  } catch {
    throw new Error(
      "An overlay could not be rendered into the image. Try again, and " +
        "report it if it persists.",
    );
  }
}

/** Where a corner-snapped, step-scaled element lands in the output. */
function cornerPosition(
  corner: Corner,
  drawnW: number,
  drawnH: number,
  outW: number,
  outH: number,
  inset: number,
): { x: number; y: number } {
  const x = corner.endsWith("left") ? inset : outW - drawnW - inset;
  const y = corner.startsWith("top") ? inset : outH - drawnH - inset;
  return { x, y };
}

export async function composeAndDownload(input: ComposeInput): Promise<void> {
  const { definition: def } = input;
  // One scale for everything: output pixels per composition pixel. This
  // is a number the definition carries, not something measured off the
  // screen — the preview is displayed scaled, so an on-screen rectangle
  // is no longer the composition's size, and reading one here would
  // silently shrink every overlay by the display factor.
  const scale = resolveMapScale(def);
  const spaceWidth = def.size.width / scale;
  const spaceHeight = def.size.height / scale;

  // The map first — captured at exactly the output size, validated.
  const out = await input.capture({
    width: def.size.width,
    height: def.size.height,
  });
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("The image could not be composed.");

  // The chrome layer spans the frame, so it draws edge to edge. It carries
  // any docked legend; a standalone legend uses corner math below.
  if (input.chrome) {
    const raster = await rasterize(input.chrome, scale);
    ctx.drawImage(raster, 0, 0, def.size.width, def.size.height);
  }

  if (input.legend?.node) {
    const { node, corner } = input.legend;
    // Rasterize the unscaled panel and draw it at its step × the output
    // scale. Its size comes from LAYOUT geometry, never from a client
    // rectangle: the preview's display transform would otherwise shrink
    // the legend in the file by exactly the amount the card shrank it on
    // screen (plan risk; the review's finding).
    const inner = node.firstElementChild as HTMLElement | null;
    const target = inner ?? node;
    const step = elementScale(spaceWidth, spaceHeight, def.legend.size);
    const baseW = target.offsetWidth;
    const baseH = target.offsetHeight;
    if (baseW === 0 || baseH === 0) {
      throw new Error("The legend is not laid out yet. Retry in a moment.");
    }
    const raster = await rasterize(target, scale * step);
    const drawnW = Math.round(baseW * step * scale);
    const drawnH = Math.round(baseH * step * scale);
    const inset = Math.round(
      CORNER_INSET * elementScale(spaceWidth, spaceHeight, "m") * scale,
    );
    const { x, y } = cornerPosition(
      corner,
      drawnW,
      drawnH,
      def.size.width,
      def.size.height,
      inset,
    );
    ctx.drawImage(raster, x, y, drawnW, drawnH);
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    out.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) {
    throw new Error(
      "The browser could not encode the image at this size. Try a " +
        "smaller output width.",
    );
  }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = pngFilename(input.mapName);
    a.click();
  } finally {
    // Give the click a beat before revoking; revoking synchronously can
    // cancel the download in some engines.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
