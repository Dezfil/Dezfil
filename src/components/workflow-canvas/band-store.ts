/**
 * The results band's state per viewer: whether it is open, kept in the
 * browser's storage, never on the server. Absent until a viewer ever had
 * it otherwise: the band starts collapsed, and opens once when the page
 * session first meets a run. Its height is NOT kept (on, -08-29: "it
 * should always be the default height when we open a workflow"); the field
 * stays in the stored shape so an older store still reads, and is written
 * as null.
 */

const KEY = "dezfil.workflow.band";

export interface BandState {
  open: boolean | null;
  height: number | null;
}

export function readBand(): BandState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { open: null, height: null };
    const parsed = JSON.parse(raw) as Partial<BandState>;
    return {
      open: typeof parsed.open === "boolean" ? parsed.open : null,
      height: typeof parsed.height === "number" && Number.isFinite(parsed.height) ? parsed.height : null,
    };
  } catch {
    return { open: null, height: null };
  }
}

export function writeBand(state: BandState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable: the band just will not be remembered.
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
