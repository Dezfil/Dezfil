/**
 * The legend card's width rule, ruled in the field: the card fits its longest RENDERED line, between a floor and the cap,
 * with a constant gap to the border. CSS alone cannot express it — a
 * wrapped block pins at its max-width even when its drawn lines are
 * shorter — so the card is measured at the cap and shrunk to the widest
 * line. Shrinking to the widest line preserves every break (all lines
 * are ≤ that width), so one pass settles.
 */

export const LEGEND_MIN_WIDTH = 180;
export const LEGEND_MAX_WIDTH = 240;
/** The card's horizontal padding (13px 15px in the stylesheet). */
const PAD = 30;
/** A fluid element (a gradient ramp) contributes a floor, not a wish. */
const RAMP_MIN = 90;
/** Sub-pixel and inline-button padding headroom on wrapped text. */
const SLOP = 4;

/** The class names the measurement must recognise — CSS-module hashes,
 * passed from the component that owns them. */
export interface LegendFitClasses {
  rows: string[];
  fluid: string[];
}

function widestLineOf(el: HTMLElement, scale: number): number {
  let widest = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0) widest = Math.max(widest, rect.width / scale);
    }
  }
  return widest + SLOP;
}

function childNeed(child: HTMLElement, scale: number, fluid: string[]): number {
  if (fluid.some((cls) => child.classList.contains(cls))) return RAMP_MIN;
  const wraps = getComputedStyle(child).whiteSpace !== "nowrap";
  if (wraps && child.textContent?.trim()) return widestLineOf(child, scale);
  // Nowrap text truncates its paint, not its layout: scrollWidth is the
  // full wish. Fixed marks (swatches, glyphs) answer the same way.
  return Math.max(child.scrollWidth, child.getBoundingClientRect().width / scale);
}

/**
 * Measure at the cap, shrink to the widest rendered line, clamp. The
 * card may sit inside a scale transform (the export composition), so
 * transformed rect readings are corrected back to layout pixels.
 */
export function fitLegendWidth(
  card: HTMLElement,
  classes: LegendFitClasses,
): number {
  card.style.width = `${LEGEND_MAX_WIDTH}px`;
  const scale = card.offsetWidth
    ? card.getBoundingClientRect().width / card.offsetWidth
    : 1;
  let widest = 0;
  const rowSelector = classes.rows.map((c) => `.${CSS.escape(c)}`).join(", ");
  for (const row of card.querySelectorAll<HTMLElement>(rowSelector)) {
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    let need = 0;
    let children = 0;
    for (const child of row.children) {
      if (!(child instanceof HTMLElement)) continue;
      need += childNeed(child, scale, classes.fluid);
      children += 1;
    }
    if (children > 1) need += gap * (children - 1);
    widest = Math.max(widest, need);
  }
  const width = Math.min(
    LEGEND_MAX_WIDTH,
    Math.max(LEGEND_MIN_WIDTH, Math.ceil(widest) + PAD),
  );
  card.style.width = `${width}px`;
  return width;
}
