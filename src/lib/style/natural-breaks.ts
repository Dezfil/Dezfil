/**
 * Natural breaks (Fisher–Jenks) over a sorted sample: class boundaries fall
 * where within-class variance is minimal, so classes hug the clusters in the
 * data instead of splitting them. This is the classic exact dynamic program
 * (O(classes · n²)) — affordable because classification always runs on a
 * bounded sample, so cost stays flat at any table size.
 */

/** Squared deviation from the mean of sorted[a..b] (inclusive), via prefix sums. */
function buildCost(sorted: number[]) {
  const n = sorted.length;
  const sum = new Float64Array(n + 1);
  const sumSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + sorted[i];
    sumSq[i + 1] = sumSq[i] + sorted[i] * sorted[i];
  }
  return (a: number, b: number): number => {
    const m = b - a + 1;
    const s = sum[b + 1] - sum[a];
    return Math.max(0, sumSq[b + 1] - sumSq[a] - (s * s) / m);
  };
}

/**
 * Interior class boundaries (upper bound of each class except the last) for
 * `classes` natural classes over ascending `sorted` values. Fewer distinct
 * values than classes yield fewer boundaries — callers dedup anyway.
 */
export function naturalBreakValues(
  sorted: number[],
  classes: number,
): number[] {
  const n = sorted.length;
  if (n === 0) return [];
  let distinct = 1;
  for (let i = 1; i < n; i++) if (sorted[i] !== sorted[i - 1]) distinct++;
  const k = Math.min(classes, distinct);
  if (k <= 1) return [];

  const cost = buildCost(sorted);
  // dp[i]: minimal cost of splitting sorted[0..i] into the current class
  // count; starts[c-1][i]: where the last of c+1 classes begins.
  let dp = new Float64Array(n);
  for (let i = 0; i < n; i++) dp[i] = cost(0, i);
  const starts: Int32Array[] = [];
  for (let c = 1; c < k; c++) {
    const next = new Float64Array(n).fill(Infinity);
    const start = new Int32Array(n);
    for (let i = c; i < n; i++) {
      let best = Infinity;
      let bestJ = c;
      for (let j = c; j <= i; j++) {
        const v = dp[j - 1] + cost(j, i);
        if (v < best) {
          best = v;
          bestJ = j;
        }
      }
      next[i] = best;
      start[i] = bestJ;
    }
    starts.push(start);
    dp = next;
  }

  const breaks: number[] = [];
  let end = n - 1;
  for (let c = k - 1; c >= 1; c--) {
    const first = starts[c - 1][end];
    breaks.push(sorted[first - 1]);
    end = first - 1;
  }
  return breaks.reverse();
}
