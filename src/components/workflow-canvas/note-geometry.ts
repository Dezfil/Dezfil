import { GRID } from "./arrange";

/**
 * A note's measures (*The measures*): the minimum a dragged or resized
 * note can be, the default a click or Enter makes, centred on the point,
 * the duplicate's offset, all on the canvas's grid. Pure.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The six colours, in the API's order (held equal to it by a test). */
export const NOTE_COLOR_NAMES = ["yellow", "green", "blue", "pink", "purple", "grey"] as const;

export const NOTE_MIN = { w: 200, h: 112 } as const;
export const NOTE_DEFAULT = { w: 320, h: 176 } as const;
export const DUPLICATE_OFFSET = 32;

export const snap = (v: number) => Math.round(v / GRID) * GRID;

/** A click's note: the default size centred on the point, on the grid. */
export function rectAt(point: { x: number; y: number }): Rect {
  return { x: snap(point.x - NOTE_DEFAULT.w / 2), y: snap(point.y - NOTE_DEFAULT.h / 2), w: NOTE_DEFAULT.w, h: NOTE_DEFAULT.h };
}

/** A drag's note: from corner to corner, whichever way it was drawn, on
 * the grid, no smaller than the minimum (grown right and down). */
export function rectFromDrag(from: { x: number; y: number }, to: { x: number; y: number }): Rect {
  const x = snap(Math.min(from.x, to.x));
  const y = snap(Math.min(from.y, to.y));
  const w = Math.max(NOTE_MIN.w, snap(Math.abs(to.x - from.x)));
  const h = Math.max(NOTE_MIN.h, snap(Math.abs(to.y - from.y)));
  return { x, y, w, h };
}

/** A resize's outcome against the note it started from: the size on the
 * grid, no smaller than the minimum; an axis whose position the drag did
 * not move keeps it exactly (an east handle changes the width alone,
 * even on a note stored off the grid), and one it did (a west or north
 * handle) keeps the far edge where it was (found at review). */
export function settleResize(rect: Rect, before: Rect): Rect {
  const w = Math.max(NOTE_MIN.w, snap(rect.w));
  const h = Math.max(NOTE_MIN.h, snap(rect.h));
  const x = Math.abs(rect.x - before.x) > 0.5 ? before.x + before.w - w : before.x;
  const y = Math.abs(rect.y - before.y) > 0.5 ? before.y + before.h - h : before.y;
  return { x, y, w, h };
}

export function duplicateRect(rect: Rect): Rect {
  return { ...rect, x: rect.x + DUPLICATE_OFFSET, y: rect.y + DUPLICATE_OFFSET };
}

/** The centre of an area, for Enter's placement. */
export function centreOf(area: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: area.x + area.width / 2, y: area.y + area.height / 2 };
}
