/**
 * Where the one tooltip stands, as arithmetic over boxes: the hint layer
 * measures, this decides. By default the bubble stands below its control,
 * horizontally centred, flipped above near the bottom edge and shifted to
 * stay inside the viewport's padded box. A control inside the rail asks for
 * the bubble beside it: a gap right of the icon, on its centre line (the
 * stylesheet lifts the bubble by half its height), slid rather than
 * flipped at the edges, so a name never covers the icon under it.
 */

export const EDGE_PAD = 8;
export const GAP = 6;

export type HintPlace = "below" | "beside";
export interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }
export interface Viewport { width: number; height: number }
export interface ShownHint {
  x: number;
  y: number;
  above: boolean;
  beside: boolean;
  /** The trigger's top edge, kept for the measured second pass. */
  anchorTop: number;
}

/** The first placement, before the bubble has a size: its width estimated
 * from the text. */
export function placeHint(rect: Box, text: string, viewport: Viewport, place: HintPlace): ShownHint {
  if (place === "beside") {
    return { x: rect.right + GAP, y: rect.top + rect.height / 2, above: false, beside: true, anchorTop: rect.top };
  }
  const approxWidth = Math.min(340, text.length * 6.6 + 20);
  let x = rect.left + rect.width / 2 - approxWidth / 2;
  x = Math.max(EDGE_PAD, Math.min(x, viewport.width - approxWidth - EDGE_PAD));
  const below = rect.bottom + GAP;
  const above = below + 28 > viewport.height - EDGE_PAD;
  return { x, y: above ? rect.top - GAP : below, above, beside: false, anchorTop: rect.top };
}

/** The second pass, once the bubble has rendered: pull it fully inside the
 * padded viewport. A bubble below its control flips to the control's top
 * edge when its real height crosses the bottom; one beside a rail icon
 * slides along the rail instead. */
export function settleHint(shown: ShownHint, bubble: Box, viewport: Viewport): ShownHint {
  let { x, y, above } = shown;
  if (bubble.right > viewport.width - EDGE_PAD) x -= bubble.right - (viewport.width - EDGE_PAD);
  if (x < EDGE_PAD) x = EDGE_PAD;
  if (shown.beside) {
    if (bubble.bottom > viewport.height - EDGE_PAD) y -= bubble.bottom - (viewport.height - EDGE_PAD);
    else if (bubble.top < EDGE_PAD) y += EDGE_PAD - bubble.top;
  } else if (!above && bubble.bottom > viewport.height - EDGE_PAD) {
    // The rendered height crossed the bottom: flip to the anchor's top
    // edge (the stylesheet translates the bubble up by its own height).
    above = true;
    y = shown.anchorTop - GAP;
  }
  return { ...shown, x, y, above };
}
