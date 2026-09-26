"use client";

import { useCallback, useMemo, useRef } from "react";
import type { MapWithLayers, Layer } from "@/lib/metadata/maps";
import type { LayerFilter } from "@/lib/viz";
import type { LayerRenderData } from "./render-data";
import type { HeatmapPreviewSetter } from "../map/MapCanvas";
import { liveFilters, liveDim, type LiveDim } from "@/lib/live-filters";

/**
 * Live-filter orchestration for the builder — kept beside MapBuilder like
 * the timeline hook (the split note). Resolves every layer's live
 * dimensions for the canvas, routes mid-drag previews to the canvas's
 * imperative setter, and decides when a filters edit actually changes the
 * data the server must ship — the only time a refetch runs.
 */

type RangeSetter = (
  layerId: string,
  field: string,
  range: [number, number],
) => void;

export interface LiveFiltersState {
  /** For the canvas: every live-filtered layer's dimensions, settled. */
  canvas: Record<string, LiveDim[]>;
  /** For the canvas: receives the imperative per-frame range setter. */
  onLiveRangeSetter: (set: RangeSetter) => void;
  /** Receives the canvas's adaptive heatmap preview channel. */
  onHeatmapPreviewSetter: (set: HeatmapPreviewSetter) => void;
  /** The fields of one layer currently enforced on the client. */
  liveFields: (layerId: string) => string[];
  /** Route a mid-drag range straight to the canvas — no React, no writes. */
  preview: RangeSetter;
  /** Hold/release adaptive heatmap quality around a delegated filter edit. */
  begin: (layerId: string) => void;
  end: (layerId: string, accepted: boolean) => void;
  /** True when replacing the layer's filters changes what the server ships
   * — membership moved between SQL and the client, or an SQL-applied
   * filter changed. Bound edits on delegated filters return false. */
  needsRefresh: (layer: Layer, next: LayerFilter[]) => boolean;
}

/** The docked field, when the map's timeline sits on this layer. */
function dockedField(map: MapWithLayers | null, layerId: string): string | null {
  const t = map?.timeline;
  return t && t.layerId === layerId ? t.field : null;
}

/** The filters a layer keeps in SQL under the shared rule. */
function undelegated(
  layer: { viz: Layer["viz"]; filters: LayerFilter[] },
  filters: LayerFilter[],
  docked: string | null,
): LayerFilter[] {
  const live = new Set<LayerFilter>(liveFilters(layer.viz, filters, docked));
  return filters.filter((f) => !live.has(f));
}

export function useLiveFilters({
  map,
  renders,
}: {
  map: MapWithLayers | null;
  renders: Record<string, LayerRenderData>;
}): LiveFiltersState {
  // A heatmap can decline delegation (its unfiltered result may not ship —
  // the server falls back to SQL and says so); every other layer follows
  // the rule alone. Enforcing the same bounds the SQL already applied
  // would merely be a no-op, but the render flag keeps the two sides'
  // intent aligned.
  const canvas = useMemo(() => {
    const out: Record<string, LiveDim[]> = {};
    for (const l of map?.layers ?? []) {
      if (l.viz.type === "heatmap" && !renders[l.id]?.liveFiltered) continue;
      const dims = liveFilters(l.viz, l.filters, dockedField(map, l.id)).map(
        liveDim,
      );
      if (dims.length > 0) out[l.id] = dims;
    }
    return out;
  }, [map, renders]);

  const liveFields = useCallback(
    (layerId: string) => (canvas[layerId] ?? []).map((d) => d.field),
    [canvas],
  );

  const setterRef = useRef<RangeSetter | null>(null);
  const heatmapPreviewRef = useRef<HeatmapPreviewSetter | null>(null);
  const onLiveRangeSetter = useCallback((set: RangeSetter) => {
    setterRef.current = set;
  }, []);
  const preview = useCallback<RangeSetter>((layerId, field, range) => {
    setterRef.current?.(layerId, field, range);
  }, []);
  const onHeatmapPreviewSetter = useCallback((set: HeatmapPreviewSetter) => {
    heatmapPreviewRef.current = set;
  }, []);
  const begin = useCallback((layerId: string) => {
    heatmapPreviewRef.current?.(layerId, "filter", true);
  }, []);
  const end = useCallback((layerId: string, accepted: boolean) => {
    heatmapPreviewRef.current?.(layerId, "filter", false, { accepted });
  }, []);

  const needsRefresh = useCallback(
    (layer: Layer, next: LayerFilter[]) => {
      // A heatmap always refetches: the delegation gate above rides the
      // render response, which only a refetch can update.
      if (layer.viz.type === "heatmap") return true;
      const docked = dockedField(map, layer.id);
      const before = undelegated(layer, layer.filters, docked);
      const after = undelegated(layer, next, docked);
      return (
        before.length !== after.length ||
        before.some((f, i) => f !== after[i])
      );
    },
    [map],
  );

  return {
    canvas,
    onLiveRangeSetter,
    onHeatmapPreviewSetter,
    liveFields,
    preview,
    begin,
    end,
    needsRefresh,
  };
}
