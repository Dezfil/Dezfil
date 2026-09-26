/**
 * Nice rounding for classification breaks — pure math, shared by the
 * server-side classifier and the builder's drag handles (which snap a
 * released boundary the same way, so hand-dragged values read as nicely as
 * computed ones).
 */

/** How far a break may move to become nice, as a share of the local class
 * width. 0.1 keeps equal intervals visibly even while still finding round
 * numbers at every magnitude. */
export const NICE_MARGIN = 0.1;

/**
 * Round classification breaks to nice values: each boundary takes the
 * coarsest decimal step whose rounding error stays within NICE_MARGIN of
 * the local class width, so wide ranges get whole numbers and narrow
 * ranges keep just enough decimals — one relative rule, no magnitude
 * tables. Integer columns snap to integers first (a count is an integer
 * by construction). Separation wins over prettiness: a collision reverts
 * to the exact value, and the result is always strictly ascending. The
 * data extent bounds the outermost breaks so rounding can never empty the
 * first or last class.
 */
export function niceBreaks(
  breaks: number[],
  meta: { integer?: boolean; lo?: number; hi?: number } = {},
): number[] {
  if (breaks.length === 0) return [];
  let values = [...breaks].sort((a, b) => a - b);
  if (meta.integer) {
    values = [...new Set(values.map((v) => Math.round(v)))];
  }
  const lo = Number.isFinite(meta.lo) ? (meta.lo as number) : -Infinity;
  const hi = Number.isFinite(meta.hi) ? (meta.hi as number) : Infinity;
  const out = values.map((v, i) => {
    const prev = i > 0 ? values[i - 1] : lo;
    const next = i < values.length - 1 ? values[i + 1] : hi;
    const gap = Math.min(v - prev, next - v);
    const tolerance = Number.isFinite(gap) && gap > 0 ? gap * NICE_MARGIN : 0;
    return roundNice(v, tolerance, meta.integer ? 0 : undefined);
  });
  for (let i = 1; i < out.length; i++) {
    if (out[i] <= out[i - 1]) out[i] = values[i];
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The coarsest power-of-ten rounding of `value` that stays within
 * `tolerance`; `minExp` floors the step (0 = never below whole numbers). */
export function roundNice(
  value: number,
  tolerance: number,
  minExp = -12,
): number {
  if (!Number.isFinite(value) || tolerance <= 0 || value === 0) return value;
  const startExp = Math.floor(Math.log10(Math.abs(value))) + 1;
  for (let exp = startExp; exp >= minExp; exp--) {
    const step = 10 ** exp;
    const rounded = Math.round(value / step) * step;
    if (Math.abs(rounded - value) <= tolerance) {
      // Strip float artifacts (0.30000000000000004 → 0.3).
      return Number(rounded.toPrecision(15));
    }
  }
  return value;
}
