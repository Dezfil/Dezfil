import { HELPER_OFFSET } from "../builder/helper-bands";
import type { Band } from "../builder/helper-bands";

/**
 * The canvas's helper layout (of with overrides): what an open assistant
 * pane does to the host, the selected member's panel and the results
 * band, decided from the view, the width band and whether a panel is up.
 * Pure; the canvas wires it.
 *
 * Framed view: below the three-pane limit the pane replaces an open
 * panel (the selection stays, the panel hides while the pane is open);
 * above 1120 the host gives up the pane's width plus gutter, at or below
 * it the pane overlays the host; at or above the limit both stay, the
 * pane outside the card and the panel inside it. Full view: the pane
 * overlays the canvas at every width; below the limit the panel hides
 * while the pane is open; at or above it the panel shifts left by the
 * pane's width plus gutter and both stay (B); the results band's
 * right edge stops the helper gutter short of the pane's left edge and
 * is never covered ('s no-overlap substance; sets the 12 px gap in place
 * of edge equality).
 */
export type CanvasView = "full" | "framed";

export interface CanvasHelperLayout {
  /** The pane overlays the host rather than narrowing it. */
  paneOverlay: boolean;
  /** What the host gives up on its right (framed, docked). */
  hostRight: number;
  /** The panel hides while the pane is open (the selection stays). */
  panelHidden: boolean;
  /** What the panel moves left by (full view, at or above the limit). */
  panelShift: number;
  /** What the results band gives up on its right (full view): the pane's
   * width plus the helper gutter, so the band's right edge stops that
   * gutter short of the pane's left edge. */
  bandRight: number;
}

/** What the fits read on the right (item 7), from the visible furniture:
 * a panel counts for the fit's 386 px inset only while it shows, and the
 * assistant's width counts once beyond it: as the panel's shift where the
 * panel shows shifted (the pane stands behind it), else as the pane's own
 * width plus gutter where it overlays the area. (Counting a hidden panel
 * and a shifted one both with the pane made the padding exceed the
 * viewport at 1000 and double at 1920.) */
export function fitHelper(layout: CanvasHelperLayout, paneOpen: boolean, panelUp: boolean): { panel: boolean; helperRight: number } {
  const panel = panelUp && !layout.panelHidden;
  const helperRight = panel && layout.panelShift > 0 ? layout.panelShift : paneOpen && layout.paneOverlay ? HELPER_OFFSET : 0;
  return { panel, helperRight };
}

export const NONE: CanvasHelperLayout = { paneOverlay: false, hostRight: 0, panelHidden: false, panelShift: 0, bandRight: 0 };

export function canvasHelperLayout(input: { view: CanvasView; band: Band; paneOpen: boolean; panelUp: boolean }): CanvasHelperLayout {
  const { view, band, paneOpen, panelUp } = input;
  if (!paneOpen) return { ...NONE, paneOverlay: view === "full" || band === "overlay" };
  const coexist = band === "both";
  if (view === "framed") {
    return {
      paneOverlay: band === "overlay",
      hostRight: band === "overlay" ? 0 : HELPER_OFFSET,
      panelHidden: panelUp && !coexist,
      panelShift: 0,
      bandRight: 0,
    };
  }
  return {
    paneOverlay: true,
    hostRight: 0,
    panelHidden: panelUp && !coexist,
    panelShift: panelUp && coexist ? HELPER_OFFSET : 0,
    bandRight: HELPER_OFFSET,
  };
}
