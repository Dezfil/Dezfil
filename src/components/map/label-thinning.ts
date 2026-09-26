/**
 * The deterministic half of label thinning (automatic mode): filters
 * arrive upstream (label data is derived from the effective filtered
 * features), then the zoom floor, then priority ranking and the cap —
 * in the disposed order. Collision is the GPU's and comes after; its
 * survivors are not enumerable, which is why the count here is the
 * pre-collision truth the panel words as "up to".
 *
 * Ranking is memoizable per (data identity, priorityField, cap) — the
 * zoom floor is a cheap gate applied per render so camera motion never
 * re-sorts (the lesson: per-tick derivation over 100k features is the
 * defect class this feature exists to end).
 */

import type { LabelStyle } from "@/lib/style/style";
import type { LabeledFeature } from "@/lib/style/deck-style";

export interface RankedLabels {
  /** Ranked (when a priority column is set) and capped label data. */
  data: LabeledFeature[];
  /** The labelable total before ranking/cap — the count line's Y. */
  total: number;
}

/** Priority value for ranking and for deck's collision priority: the
 * chosen numeric column, nulls and non-numerics last. */
export function labelPriority(
  feature: LabeledFeature,
  field: string,
): number {
  const raw = feature.properties?.[field];
  // Explicit null/absent/empty first — Number(null) is 0, which would
  // rank a missing value above every negative one.
  if (raw === null || raw === undefined || raw === "") {
    return Number.NEGATIVE_INFINITY;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Rank descending by the priority column (stable — ties and no-column
 * keep feature order) and apply the cap. */
export function rankAndCap(
  data: LabeledFeature[],
  label: Pick<LabelStyle, "priorityField" | "cap">,
): RankedLabels {
  const total = data.length;
  let ranked = data;
  if (label.priorityField) {
    const field = label.priorityField;
    ranked = data
      .map((feature, index) => ({ feature, index }))
      .sort((a, b) => {
        const diff =
          labelPriority(b.feature, field) - labelPriority(a.feature, field);
        return diff !== 0 ? diff : a.index - b.index;
      })
      .map((entry) => entry.feature);
  }
  if (label.cap != null && ranked.length > label.cap) {
    ranked = ranked.slice(0, label.cap);
  }
  return { data: ranked, total };
}

/** The zoom floor: below it, no labels — a cheap per-render gate. */
export function zoomAdmitsLabels(
  zoom: number,
  label: Pick<LabelStyle, "zoomFloor">,
): boolean {
  return label.zoomFloor == null || zoom >= label.zoomFloor;
}

/** Collision density → deck's collision test size scale: sparser
 * demands more empty space around each survivor. Monotonic by
 * construction — the spec's own criterion for the control. */
export function collisionSizeScale(density: number | undefined): number {
  const d = density ?? 0.5;
  return 4 - 3 * Math.min(1, Math.max(0, d));
}

/** Rank+cap memoized per data identity (the arrays labelStore hands out
 * are stable across appearance edits — the contract), so camera motion
 * and appearance changes never re-sort 100k features. */
const rankCache = new WeakMap<
  LabeledFeature[],
  { key: string; result: RankedLabels }
>();

export function rankAndCapCached(
  data: LabeledFeature[],
  label: Pick<LabelStyle, "priorityField" | "cap">,
): RankedLabels {
  const key = `${label.priorityField ?? ""}|${label.cap ?? ""}`;
  const hit = rankCache.get(data);
  if (hit && hit.key === key) return hit.result;
  const result = rankAndCap(data, label);
  rankCache.set(data, { key, result });
  return result;
}
