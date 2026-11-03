/**
 * The one axis a classed histogram draws on: its bars, its colour strip
 * and its boundary handles all place values through this mapping, linear
 * or logarithmic between the distribution's extent as the statistics read
 * answered it. Pure, so the brush and its tests share it.
 */

export type AxisKind = "linear" | "log";

export interface BrushAxis {
  /** A value's place along the axis, 0 at the minimum, 1 at the maximum.
   * A value outside the extent is held at its end before it is placed, so
   * a boundary below every value, even at or under zero on a log axis,
   * sits at the start. */
  position(value: number): number;
  /** The value at a place along the axis. */
  value(position: number): number;
}

export function brushAxis(min: number, max: number, kind: AxisKind): BrushAxis {
  const log = kind === "log" && min > 0 && max > min;
  const to = log ? Math.log : (v: number) => v;
  const lo = to(min);
  const span = to(max) - lo || 1;
  return {
    position: (value) => (to(Math.min(Math.max(value, min), max)) - lo) / span,
    value: (position) => {
      const at = lo + Math.min(Math.max(position, 0), 1) * span;
      return log ? Math.exp(at) : at;
    },
  };
}

/** The class a value falls in: a value on a break belongs to the lower
 * class, as the map's colouring places it. */
export function classIndex(breaks: number[], value: number): number {
  let i = 0;
  while (i < breaks.length && value > breaks[i]) i++;
  return i;
}

/**
 * The value a bar between two edges is coloured by. On whole numbers it is
 * the first whole number the bar can hold, so a narrow bar holding only
 * the 1s takes the class of 1; otherwise, and for a bar that holds no
 * whole number, its middle on the axis.
 */
export function barValue(lo: number, hi: number, kind: AxisKind, wholeNumbers: boolean, last: boolean): number {
  if (wholeNumbers) {
    const first = Math.ceil(lo);
    if (first < hi || (last && first <= hi)) return first;
  }
  return kind === "log" && lo > 0 ? Math.sqrt(lo * hi) : (lo + hi) / 2;
}

/** Handles nearer than this share of the track would overlap their grips. */
export const CROWDED = 0.045;

export type HandleLane = "mid" | "up" | "down";

/**
 * Where each handle's grip rides: on the track, or, when it would sit
 * within a grip's width of its neighbour, staggered above and below it in
 * turn, so every grip can be taken on its own while each stays at its true
 * position along the axis.
 */
export function handleLanes(positions: number[], crowded = CROWDED): HandleLane[] {
  const lanes: HandleLane[] = positions.map(() => "mid");
  const turn: HandleLane[] = ["up", "down", "mid"];
  let start = 0;
  for (let i = 1; i <= positions.length; i++) {
    const together = i < positions.length && positions[i] - positions[i - 1] < crowded;
    if (together) continue;
    if (i - start > 1) for (let k = start; k < i; k++) lanes[k] = turn[(k - start) % turn.length];
    start = i;
  }
  return lanes;
}

/**
 * A released boundary on whole numbers: the whole number nearest the drop
 * that keeps the boundaries in order, strictly between its neighbours.
 * When no whole number lies between them, the boundary stays where it was.
 */
export function snapWhole(dropped: number, previous: number, next: number, original: number): number {
  const candidates = [Math.round(dropped), Math.floor(dropped), Math.ceil(dropped)];
  const allowed = candidates.filter((k) => k > previous && k < next);
  if (allowed.length > 0) {
    return allowed.reduce((best, k) => (Math.abs(k - dropped) < Math.abs(best - dropped) ? k : best));
  }
  // The drop lies past the neighbours' whole numbers: the nearest one inside.
  const low = Math.floor(previous) + 1;
  const high = Math.ceil(next) - 1;
  if (low > high) return original;
  return Math.min(Math.max(Math.round(dropped), low), high);
}

/** The way each arrow key moves a boundary along the axis. */
export const ARROW_STEP: Readonly<Record<string, 1 | -1>> = {
  ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1,
};

/**
 * Where one arrow-key press takes a boundary: on whole numbers the next
 * whole number that way, otherwise one step of the axis rounded to that
 * step's own precision, so every press reaches a different value and the
 * release keeps it; a boundary outside the data's extent comes in to its
 * end. Null when no such value lies that way before the neighbour or the
 * extent's end: the boundary stays.
 */
export function keyedBreak(
  breaks: number[],
  index: number,
  direction: 1 | -1,
  axis: BrushAxis,
  data: { wholeNumbers: boolean; min: number; max: number; steps: number },
): number | null {
  const b = breaks[index];
  let target = direction > 0 ? Math.floor(b) + 1 : Math.ceil(b) - 1;
  if (!data.wholeNumbers) {
    const stepped = axis.value(axis.position(b) + direction / data.steps);
    const digits = -Math.floor(Math.log10(Math.abs(stepped - b)));
    target = Number(stepped.toFixed(Math.min(Math.max(digits, 0), 100)));
  }
  target = Math.min(Math.max(target, data.min), data.max);
  const previous = index > 0 ? breaks[index - 1] : -Infinity;
  const next = index < breaks.length - 1 ? breaks[index + 1] : Infinity;
  return direction * (target - b) > 0 && target > previous && target < next ? target : null;
}

/** Where a drag to a place along the axis puts a boundary: that place's
 * value, held a step of the axis from each neighbour and inside the
 * data's extent. */
export function draggedBreak(
  breaks: number[],
  index: number,
  place: number,
  axis: BrushAxis,
  data: { min: number; max: number; steps: number },
): number {
  const lo = index > 0 ? axis.value(axis.position(breaks[index - 1]) + 1 / data.steps) : data.min;
  const hi = index < breaks.length - 1 ? axis.value(axis.position(breaks[index + 1]) - 1 / data.steps) : data.max;
  return Math.min(Math.max(axis.value(place), lo), hi);
}
