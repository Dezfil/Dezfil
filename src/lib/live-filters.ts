import { isAggregated, type LayerFilter, type LayerViz } from "@/lib/viz";
import {
  timeToMs,
  windowToRange,
  type TimeWindowMs,
} from "@/lib/time";

/**
 * Live filters: the range and time filters a slider edits are enforced on
 * the client — the rendered data ships without them, so a drag moves
 * features in and out of the map with zero writes and zero refetches. This
 * module is the one place that decides WHICH filters those are and HOW
 * their bounds compare, so the server's render split and the client's GPU
 * enforcement cannot drift (the dock model, generalized).
 *
 * Everything here mirrors the SQL in query/compile.ts row for row: bounds
 * are inclusive, a fully open filter keeps NULL rows (SQL's TRUE no-op),
 * and any real bound excludes them (NULL fails every SQL comparison).
 */

/** GPU filter dimensions per layer — deck's DataFilterExtension maximum.
 * Filters beyond the slots stay in SQL and settle on release, as before. */
export const LIVE_FILTER_SLOTS = 4;

export type LiveFilter = Extract<LayerFilter, { kind: "range" | "timerange" }>;

export function isLiveKind(f: LayerFilter): f is LiveFilter {
  return f.kind === "range" || f.kind === "timerange";
}

/**
 * The filters delegated to the client for a layer: the first slots-worth of
 * range/time filters, in filter order. Aggregated layers delegate nothing —
 * their cells are computed server-side, so the client has nothing it could
 * re-filter. A docked timeline field is guaranteed a slot even past the
 * cutoff — playback must never sit on an undelegated filter.
 */
export function liveFilters(
  viz: LayerViz,
  filters: LayerFilter[],
  dockedField?: string | null,
): LiveFilter[] {
  if (isAggregated(viz)) return [];
  const candidates = filters.filter(isLiveKind);
  const picked = candidates.slice(0, LIVE_FILTER_SLOTS);
  const docked = dockedField
    ? candidates.find((f) => f.kind === "timerange" && f.field === dockedField)
    : undefined;
  if (docked && !picked.includes(docked)) {
    picked.pop();
    picked.push(docked);
  }
  return picked;
}

// ---- the numeric domain (mirrors the time conventions in time.ts) ----

/** What a NULL or unparseable numeric value maps to: below every open
 * bound, so it fails any real comparison — matching SQL. */
export const NULL_NUM = -3.0e38;

/** Open-ended bounds, kept well inside NULL_NUM so a null value stays
 * excluded even from a half-open range. */
export const OPEN_START_NUM = -1.0e38;
export const OPEN_END_NUM = 1.0e38;

/** The GPU compares in float32; values and bounds are clamped to the same
 * safe magnitude so their ordering — the only thing a filter reads — is
 * preserved on both sides of every comparison. */
const F32_SAFE = 1.0e37;

function clampNum(n: number): number {
  return Math.max(-F32_SAFE, Math.min(F32_SAFE, n));
}

/** A numeric feature value as the GPU filter consumes it. */
export function numToValue(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? clampNum(n) : NULL_NUM;
}

/** Numeric bounds as the GPU filter range — open ends widened to the
 * representable edges; fully open keeps NULL values (SQL's TRUE no-op). */
export function numToRange(
  min: number | null,
  max: number | null,
): [number, number] {
  if (min === null && max === null) return [NULL_NUM, OPEN_END_NUM];
  return [
    min === null ? OPEN_START_NUM : clampNum(min),
    max === null ? OPEN_END_NUM : clampNum(max),
  ];
}

// ---- resolved dimensions (what the canvas and the viewer consume) ----

/** One GPU dimension of a layer's live filtering: the field, how its
 * values parse, and the settled bounds resolved to the numeric domain. A
 * `values` dimension (category widget selections) rides the same numeric
 * slots — membership resolves to 1 (in) or NULL_NUM (out) against a
 * fixed [1, 1] range, so the shared extension never changes shape; the
 * selected set keys the accessor's update trigger instead. */
export interface LiveDim {
  field: string;
  kind: "range" | "timerange" | "values";
  range: [number, number];
  /** The category values named by the dimension (`values` kind only). */
  values?: string[];
  /** True inverts the set (exclusion) — matching SQL's NOT IN,
   * NULL rows included in what drops. */
  exclude?: boolean;
}

/** A category selection as a GPU dimension. The set names the
 * EXCLUDED categories; rows outside it pass. */
export function selectionDim(
  field: string,
  values: string[],
  exclude = true,
): LiveDim {
  return { field, kind: "values", range: [1, 1], values, exclude };
}

/** A live filter's bounds resolved into its GPU dimension. */
export function liveDim(f: LiveFilter): LiveDim {
  if (f.kind === "range") {
    return { field: f.field, kind: f.kind, range: numToRange(f.min, f.max) };
  }
  const win: TimeWindowMs = [
    f.min === null ? null : timeToMs(f.min),
    f.max === null ? null : timeToMs(f.max),
  ];
  return { field: f.field, kind: f.kind, range: windowToRange(win) };
}

/** A feature value in a dimension's domain. */
export function dimValue(kind: "range" | "timerange", raw: unknown): number {
  return kind === "range" ? numToValue(raw) : timeToMs(raw);
}

/** A feature value in any dimension's domain, `values` kind included —
 * matching mirrors SQL's CAST(field AS VARCHAR) [NOT] IN (…) exactly:
 * NULL passes neither form, and matching is exact on the server-provided
 * strings. */
export function dimFeatureValue(
  dim: Pick<LiveDim, "kind" | "values" | "exclude">,
  raw: unknown,
): number {
  if (dim.kind !== "values") return dimValue(dim.kind, raw);
  if (raw == null) return NULL_NUM;
  const named = (dim.values ?? []).includes(String(raw));
  return (dim.exclude ? !named : named) ? 1 : NULL_NUM;
}

/** Per-feature GPU values, padded to the fixed slot count — the extension's
 * size never changes, so a layer's deck id only changes when it gains or
 * loses its first live filter (the extension-lifecycle lesson). */
export function dimValues(
  dims: LiveDim[],
  props: Record<string, unknown> | null | undefined,
): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  dims.slice(0, LIVE_FILTER_SLOTS).forEach((d, i) => {
    out[i] = dimFeatureValue(d, props?.[d.field]);
  });
  return out;
}

/** GPU ranges padded to the fixed slot count; unused slots pass their
 * padded value by construction. */
export function dimRanges(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  ranges.slice(0, LIVE_FILTER_SLOTS).forEach((r, i) => {
    out[i] = r;
  });
  return out;
}
