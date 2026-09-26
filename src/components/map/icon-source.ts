/**
 * The icon source descriptor — the one piece of the canvas's icon branch
 * that decides *what image* deck rasterizes: the bundled Maki glyph, or
 * the layer's sanitized custom SVG as an encoded inline image. Both tint
 * as alpha masks through the fill channel. Extracted from MapCanvas as
 * at-touch slice, so Maki and custom resolve through one tested path.
 */

import { makiUrl } from "@/lib/maki";

export interface IconSource {
  url: string;
  width: number;
  height: number;
  mask: true;
}

/** Rasterization box. The Maki set declares 256×256 (the 15px lesson:
 * deck's atlas copies the browser's raster at the declared size, and a
 * small declaration ships blurry glyphs). A custom SVG keeps its own
 * aspect inside a bounded box — the box is the renderer's, the persisted
 * markup is never resized. */
const BASE = 256;
const MIN_EDGE = 64;
const MAX_EDGE = 1024;

/** Aspect (w/h) from the markup's root viewBox, else width/height, else
 * square. Reads the attributes textually — the markup is the
 * sanitizer's accepted output, but this stays defensive anyway. */
export function svgAspect(svg: string): number {
  const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)?.[1];
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return parts[2] / parts[3];
    }
  }
  const w = Number.parseFloat(
    /(?:^|\s)width\s*=\s*["']([\d.]+)/i.exec(svg)?.[1] ?? "",
  );
  const h = Number.parseFloat(
    /(?:^|\s)height\s*=\s*["']([\d.]+)/i.exec(svg)?.[1] ?? "",
  );
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return w / h;
  }
  return 1;
}

export function iconSource(
  glyph: string,
  customSvg: string | null | undefined,
): IconSource {
  if (typeof customSvg === "string" && customSvg.trim()) {
    const aspect = svgAspect(customSvg);
    // Height anchors at the Maki raster size; width follows the aspect
    // inside hard bounds so a sliver never collapses or explodes the
    // atlas. The data URI is the descriptor's identity, so a markup
    // change re-rasterizes by construction.
    const width = Math.min(
      MAX_EDGE,
      Math.max(MIN_EDGE, Math.round(BASE * aspect)),
    );
    // The browser rasterizes an SVG at its own declared size and deck
    // fits that bitmap into the descriptor box afterwards — so the DATA
    // URI's root always carries the bounded box, whatever the markup
    // declared: no natural size decodes blank (the smoke), a small
    // declaration re-creates the 15px blur, a giant one bypasses the
    // raster bound. Persisted markup is never resized;
    // when a viewBox is present the aspect survives the rewrite by
    // construction, and when only width/height were declared they fed
    // the aspect this box was computed from.
    const sized = customSvg.replace(/<svg[^>]*/i, (root) => {
      const stripped = root.replace(
        /\s(?:width|height)\s*=\s*("[^"]*"|'[^']*')/gi,
        "",
      );
      return `${stripped} width="${width}" height="${BASE}"`;
    });
    // Known bound, recorded not hidden: deck's
    // auto-packer keys the atlas by this URL, so each DISTINCT markup
    // an editing session tries appends one bitmap (≤ ~1 MB at this box)
    // until the layer rebuilds. A stable id can't replace this — deck
    // would then serve the old bitmap for new markup. Re-picking the
    // same markup reuses its slot by construction.
    return {
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`,
      width,
      height: BASE,
      mask: true,
    };
  }
  return { url: makiUrl(glyph), width: BASE, height: BASE, mask: true };
}
