/** A pixel's luminance, 0 to 255. */
export const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * How many samples one straight edge spreads over along a line that
 * crosses it: the distance from where the line first passes 10 percent of
 * the step between its two flat sides to where it first passes 90 percent,
 * interpolated between samples. The flat levels are the medians of the
 * line's first and last quarters, so a filter's overshoot at the edge does
 * not move them. A hard edge sampled by pixels has one partial pixel, so
 * it rises over at most 1.6 samples between pixel centres; the same edge
 * enlarged threefold rises over more than two.
 */
export function edgeRise(samples: readonly number[]): number {
  const quarter = Math.max(1, Math.floor(samples.length / 4));
  const start = median(samples.slice(0, quarter)), end = median(samples.slice(-quarter));
  if (Math.abs(end - start) < 32) throw new Error("The line crosses no edge of enough contrast to measure.");
  const values = end > start ? [...samples] : samples.map((value) => start + end - value);
  const [low, high] = end > start ? [start, end] : [end, start];
  const crossing = (fraction: number) => {
    const level = low + (high - low) * fraction;
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] < level && values[i] >= level) return i - 1 + (level - values[i - 1]) / (values[i] - values[i - 1]);
    }
    throw new Error("The line never reaches the edge's far level.");
  };
  return crossing(0.9) - crossing(0.1);
}
