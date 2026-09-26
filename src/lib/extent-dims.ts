import {
  NULL_NUM,
  OPEN_END_NUM,
  OPEN_START_NUM,
  type LiveDim,
} from "@/lib/live-filters";
import { NULL_TIME_MS, OPEN_END_MS, OPEN_START_MS } from "@/lib/time";
import type { LayerFilter } from "@/lib/viz";

/**
 * The canvas's numeric constraints, back as ordinary filters.
 *
 * The canvas compares in numeric domains of its own: an open end is a
 * fixed sentinel rather than an absent bound, and a null value sits below
 * every real one so it fails any comparison — the same thing SQL does. A
 * server-side extent has to state the same constraint in the query's
 * terms, so every sentinel must become the open bound it stands for.
 * Passing one through as a literal would turn a half-open scrub into a
 * bound at 1e38 and quietly frame the wrong thing.
 *
 * Range and time have SEPARATE sentinels — the time domain is epoch
 * milliseconds — so each kind is inverted against its own.
 */

/** Epoch ms as a bound the time filter accepts. The trailing `Z` an ISO
 * string carries is NOT accepted — the filter's bound format is
 * timezone-free — so a bound serialized straight from toISOString would be
 * rejected and every bounded time extent would fail. */
function msToTime(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "");
}

export function dimToFilter(dim: LiveDim): LayerFilter | null {
  if (dim.kind === "values") {
    if (!dim.values) return null;
    return {
      field: dim.field,
      kind: "values",
      values: dim.values,
      // Since the named set is what is excluded.
      exclude: dim.exclude ?? true,
    };
  }
  const [lo, hi] = dim.range;
  if (dim.kind === "range") {
    return {
      field: dim.field,
      kind: "range",
      min: lo === OPEN_START_NUM || lo === NULL_NUM ? null : lo,
      max: hi === OPEN_END_NUM ? null : hi,
    };
  }
  const openLo = lo === OPEN_START_MS || lo === NULL_TIME_MS;
  return {
    field: dim.field,
    kind: "timerange",
    min: openLo ? null : msToTime(lo),
    max: hi === OPEN_END_MS ? null : msToTime(hi),
  };
}

export function dimsToFilters(dims: LiveDim[]): LayerFilter[] {
  return dims.map(dimToFilter).filter((f): f is LayerFilter => f !== null);
}
