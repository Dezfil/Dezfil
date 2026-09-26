"use client";

import { useCallback, useEffect, useRef } from "react";
import type { LabelStyle } from "@/lib/style/style";
import type { LabelCount } from "../builder/style-panel/LabelSection";
import { rankAndCapCached, zoomAdmitsLabels } from "./label-thinning";
import type { LabeledFeature } from "@/lib/style/deck-style";
import type { LabelStore, LabelSubject } from "./label-data";
import type { LiveWindowing } from "./text-sublayer";
import { featurePasses } from "@/lib/map-extent";

/** The settled live filters applied CPU-side before ranking (review
 * unfiltered rows consumed the cap and inflated Y). Memoized
 * per (data identity, dim signature) so a settled-filter change filters
 * once, not per build; mid-drag GPU ranges still act on the drawn set
 * only — the selection re-settles on release, which the plan records as
 * the two-lane consistency boundary. */
const filterCache = new WeakMap<
  LabeledFeature[],
  { trigger: string; filtered: LabeledFeature[] }
>();
function effectiveLabelData(
  raw: LabeledFeature[],
  windowing: LiveWindowing | null | undefined,
): LabeledFeature[] {
  if (!windowing || windowing.dims.length === 0) return raw;
  // The trigger keys the dim SIGNATURE only; committed range VALUES move
  // without changing it — the cache key carries both.
  const key =
    windowing.trigger +
    "|" +
    JSON.stringify(
      windowing.dims.map((d) => [d.field, d.range, d.values, d.exclude]),
    );
  const hit = filterCache.get(raw);
  if (hit && hit.trigger === key) return hit.filtered;
  const filtered = raw.filter((f) => featurePasses(f, windowing.dims));
  filterCache.set(raw, { trigger: key, filtered });
  return filtered;
}

/**
 * The deterministic thinning half at the canvas: floor-gated, ranked and
 * capped label data with the honest count recorded per layer — the same
 * set the sublayer renders, never a parallel calculation. Collision (the
 * GPU half) lives in the sublayer; its survivors are uncounted, hence
 * `approximate` whenever labels reach it. Counts flush after each build
 * so the panel's line updates when the drawn set can actually have
 * changed, deduplicated upstream.
 */
export function useLabelPreparation(
  labelStore: Pick<LabelStore, "read">,
  zoomRef: React.RefObject<number>,
  onLabelCounts?: (counts: Record<string, LabelCount | null>) => void,
): {
  prepareLabels: (
    l: LabelSubject,
    label: LabelStyle,
    windowing?: LiveWindowing | null,
  ) => LabeledFeature[];
  flushLabelCounts: () => void;
  /** Clear before each build: a hidden or re-vized layer must not keep
   * republishing its old count. */
  resetLabelCounts: () => void;
} {
  const countsRef = useRef<Record<string, LabelCount | null>>({});
  const onCountsRef = useRef(onLabelCounts);
  useEffect(() => {
    onCountsRef.current = onLabelCounts;
  }, [onLabelCounts]);

  const flushLabelCounts = useCallback(() => {
    onCountsRef.current?.({ ...countsRef.current });
  }, []);

  const resetLabelCounts = useCallback(() => {
    countsRef.current = {};
  }, []);

  const prepareLabels = useCallback(
    (
      l: LabelSubject,
      label: LabelStyle,
      windowing?: LiveWindowing | null,
    ): LabeledFeature[] => {
      const raw = labelStore.read(l, label);
      const effective = effectiveLabelData(raw, windowing);
      if (!effective.length) {
        // A settled empty set is an honest zero, not an absent line: the author chose a label and
        // nothing
        // labelable survives the filters.
        countsRef.current[l.id] = {
          shown: 0,
          total: 0,
          approximate: false,
        };
        return effective;
      }
      const admitted = zoomAdmitsLabels(zoomRef.current ?? 0, label);
      const { data, total } = rankAndCapCached(effective, label);
      const shown = admitted ? data.length : 0;
      countsRef.current[l.id] = { shown, total, approximate: shown > 0 };
      return admitted ? data : [];
    },
    [labelStore, zoomRef],
  );

  return { prepareLabels, flushLabelCounts, resetLabelCounts };
}
