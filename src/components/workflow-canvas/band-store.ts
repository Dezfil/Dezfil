import { privateStateOpen } from "../auth/private-state";

/**
 * Whether the person chose the results band open or closed, kept in the
 * browser's storage, never on the server. Only their own opening, closing
 * or resizing of it is a choice; a run opening the band is not, and is
 * never kept. Until they choose, the band starts as the instance's
 * default says, collapsed unless an admin chose open. Its height is NOT
 * kept (on, -08-29: "it should always be the default height when we open
 * a workflow").
 *
 * The choice has a key of its own. The band's earlier state, kept under
 * `dezfil.workflow.band`, was written at every opening whether anyone
 * chose or not, so it says nothing a person chose and is not read.
 */

const KEY = "dezfil.workflow.band-choice";

/** True for open, false for closed, null while the person never chose. */
export function readBandChoice(): boolean | null {
  if (!privateStateOpen()) return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "open" ? true : raw === "closed" ? false : null;
  } catch {
    return null;
  }
}

export function writeBandChoice(open: boolean): void {
  if (!privateStateOpen()) return;
  try {
    localStorage.setItem(KEY, open ? "open" : "closed");
  } catch {
    // Storage unavailable: the choice just will not be remembered.
  }
}

export const BAND_MIN = 120;
export const BAND_DEFAULT = 250;
/** The card collapsed to its bar (the reference's 49 plus its border). */
export const BAR_HEIGHT = 50;
/** A drag of the top edge that ends below this height collapses the band
 * to its bar; above it the band is open, no shorter than its minimum. */
export const COLLAPSE_BELOW = BAND_MIN - 40;
/** The drag gap above the card (reference 13's split), the column's own. */
export const BAND_GAP = 14;

/** A remembered height that still leaves the canvas usable. */
export function clampHeight(height: number, hostHeight: number): number {
  const max = Math.max(BAND_MIN, hostHeight - 240);
  return Math.min(Math.max(BAND_MIN, Math.round(height)), max);
}
