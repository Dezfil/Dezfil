import type { FitViewOptions } from "@xyflow/react";

/**
 * The reference's measures for the view (reference 13): the zoom range,
 * fit's padding and ceiling, and the far-zoom threshold under which a
 * tile keeps its glyph and name and drops the rest.
 */
export const MIN_ZOOM = 0.18;
export const MAX_ZOOM = 2.2;
export const FAR_ZOOM = 0.6;
/** Fit's padding: the reference's 56px, and in the full view measured
 * from the area the pane leaves free (its right edge plus the gutter,
 * 438), so the first column clears the stage stack standing at that
 * area's top left, and from the band's column at the screen's foot, so
 * the last row never lands under it (reference 13's free rect). `reserve`
 * is what the band keeps at the foot in full view. `helperRight` is what
 * the assistant pane takes on the right when it overlays the canvas, and
 * what a shifted panel moved by: the fit keeps out from under both. */
export function fitOptions(view: "full" | "framed", panel = false, reserve = 0, helperRight = 0): FitViewOptions {
  // An open panel takes the right edge: the fit keeps out from under it.
  const right: `${number}px` = `${(panel ? 386 : 56) + helperRight}px`;
  const padding: FitViewOptions["padding"] =
    view === "full"
      ? { top: "76px", right, bottom: `${56 + reserve}px`, left: "494px" }
      : { top: "56px", right, bottom: "56px", left: "56px" };
  return { padding, minZoom: MIN_ZOOM, maxZoom: 1.15 };
}
/** The minimap appears at this many visible members, nodes and sources
 * combined. */
export const MINIMAP_AT = 6;
