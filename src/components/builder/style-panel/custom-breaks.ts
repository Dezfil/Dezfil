import type { QuantileFill } from "@/lib/style/style";
import { niceBreaks } from "@/lib/style/nice-breaks";
import { snapWhole } from "./brush-axis";

/** A hand edit of a classed paint's boundaries: the scale becomes Custom,
 * remembering the named method it came from so a class-count change can
 * recompute. Everything else the paint holds, its whole-number fact
 * included, stays: the edit keeps the classification. */
export function customBreaks(paint: QuantileFill, breaks: number[]): QuantileFill {
  return {
    ...paint,
    breaks,
    method: "custom",
    baseMethod:
      paint.method === "custom"
        ? (paint.baseMethod ?? "quantile")
        : (paint.method ?? "quantile"),
  };
}

/**
 * The boundaries a finished drag leaves. On whole numbers the moved one
 * takes the nearest whole number that keeps the order, or stays where it
 * was when none fits, and the rest stay as they were; otherwise the
 * boundaries read as nicely as computed ones, unless that would merge
 * classes.
 */
export function releasedBreaks(
  original: number[],
  dropped: number[],
  moved: number | null,
  data: { wholeNumbers: boolean; min: number; max: number },
): number[] {
  if (moved === null) return original;
  if (data.wholeNumbers) {
    const previous = moved > 0 ? dropped[moved - 1] : -Infinity;
    const next = moved < dropped.length - 1 ? dropped[moved + 1] : Infinity;
    const snapped = [...dropped];
    snapped[moved] = snapWhole(dropped[moved], previous, next, original[moved]);
    return snapped;
  }
  const nice = niceBreaks(dropped, { lo: data.min, hi: data.max });
  return nice.length === dropped.length ? nice : dropped;
}
