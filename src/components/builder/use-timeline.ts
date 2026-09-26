"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { FieldStats } from "@/lib/layer-service";
import { isAggregated } from "@/lib/viz";
import { liveFilters } from "@/lib/live-filters";
import {
  timeToMs,
  msToBound,
  windowToRange,
  type TimeWindowMs,
} from "@/lib/time";

/**
 * Timeline orchestration for the builder — kept beside MapBuilder instead
 * of inside it (the split note). Resolves the map's dock against the
 * current layers, fetches the docked field's stats for the widget, routes
 * live window moves through the live-filter preview (canvas enforcement
 * lives there now), and turns a settled window into exactly one filter
 * write with the render refetch skipped — docked data does not depend on
 * the window.
 */

export interface TimelineBarState {
  title: string;
  extent: [number, number];
  bins: number[];
  window: TimeWindowMs;
  speed: number;
  onWindow: (win: [number, number]) => void;
  onSettle: (win: [number, number]) => Promise<boolean>;
  onSpeed: (speed: number) => void;
  onClose: () => void;
}

export interface TimelineState {
  /** For the widget; null = nothing docked (or the dock is unresolvable). */
  bar: TimelineBarState | null;
  dock: (layerId: string, field: string) => void;
  undock: () => void;
}

export function useTimeline({
  map,
  patchMap,
  patchLayer,
  refreshLayer,
  preview,
}: {
  map: MapWithLayers | null;
  patchMap: (body: Record<string, unknown>) => Promise<boolean>;
  patchLayer: (
    layerId: string,
    body: Record<string, unknown>,
    opts?: { skipRefresh?: boolean },
  ) => Promise<unknown | null>;
  refreshLayer: (layerId: string) => Promise<void>;
  /** The live-filter preview channel: playback and widget
   * drags move the docked dimension through it. */
  preview: (layerId: string, field: string, range: [number, number]) => void;
}): TimelineState {
  // Resolve the dock against current state; drift (layer gone, filter
  // removed, viz aggregated since) degrades to "no timeline", never an
  // error — the dock record itself is left alone.
  const resolved = useMemo(() => {
    const dock = map?.timeline ?? null;
    if (!dock || !map) return null;
    const layer = map.layers.find((l) => l.id === dock.layerId);
    if (!layer || isAggregated(layer.viz)) return null;
    const index = layer.filters.findIndex(
      (f) => f.kind === "timerange" && f.field === dock.field,
    );
    if (index === -1) return null;
    const filter = layer.filters[index];
    if (filter.kind !== "timerange") return null;
    return { dock, layer, filter, index };
  }, [map]);

  const window = useMemo<TimeWindowMs>(
    () =>
      resolved
        ? [
            resolved.filter.min === null ? null : timeToMs(resolved.filter.min),
            resolved.filter.max === null ? null : timeToMs(resolved.filter.max),
          ]
        : [null, null],
    [resolved],
  );

  // The widget needs the field's full extent and histogram. Keyed by the
  // layer's SQL too: editing the query can change the extent.
  const statsKey = resolved
    ? `${resolved.layer.id} ${resolved.dock.field} ${resolved.layer.sql}`
    : null;
  const [stats, setStats] = useState<{
    key: string;
    extent: [number, number];
    bins: number[];
  } | null>(null);
  useEffect(() => {
    if (!statsKey || !resolved) return;
    if (stats?.key === statsKey) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch(
        `/api/layers/${resolved.layer.id}/fields/${encodeURIComponent(
          resolved.dock.field,
        )}`,
      );
      if (!response.ok || cancelled) return;
      const s = (await response.json()) as FieldStats;
      if (cancelled || s.kind !== "time" || s.min == null || s.max == null)
        return;
      setStats({
        key: statsKey,
        extent: [timeToMs(s.min), timeToMs(s.max)],
        bins: s.bins,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [statsKey, resolved, stats]);

  // Live moves ride the shared preview channel and bypass React.
  const onWindow = useCallback(
    (win: [number, number]) => {
      if (!resolved) return;
      preview(resolved.layer.id, resolved.dock.field, windowToRange(win));
    },
    [resolved, preview],
  );

  // Since a time filter is live docked or not, so a dock move usually
  // changes nothing the server ships. The exception: past the slot cap the
  // dock guarantee reshuffles which filters stay in SQL — refresh exactly
  // the layers whose delegated set actually shifts.
  const dockShifts = useCallback(
    (layerId: string, prevField: string | null, nextField: string | null) => {
      const layer = map?.layers.find((l) => l.id === layerId);
      if (!layer) return false;
      const a = liveFilters(layer.viz, layer.filters, prevField);
      const b = liveFilters(layer.viz, layer.filters, nextField);
      return a.length !== b.length || a.some((f, i) => f !== b[i]);
    },
    [map],
  );

  const dock = useCallback(
    (layerId: string, field: string) => {
      const previous = map?.timeline ?? null;
      void patchMap({ timeline: { layerId, field } }).then((ok) => {
        if (!ok) return;
        const prevField =
          previous && previous.layerId === layerId ? previous.field : null;
        if (dockShifts(layerId, prevField, field)) void refreshLayer(layerId);
        if (
          previous &&
          previous.layerId !== layerId &&
          dockShifts(previous.layerId, previous.field, null)
        ) {
          void refreshLayer(previous.layerId);
        }
      });
    },
    [map, patchMap, refreshLayer, dockShifts],
  );

  const undock = useCallback(() => {
    const previous = map?.timeline ?? null;
    void patchMap({ timeline: null }).then((ok) => {
      if (
        ok &&
        previous &&
        dockShifts(previous.layerId, previous.field, null)
      ) {
        void refreshLayer(previous.layerId);
      }
    });
  }, [map, patchMap, refreshLayer, dockShifts]);

  const bar = useMemo<TimelineBarState | null>(() => {
    if (!resolved || !stats || stats.key !== statsKey) return null;
    const { layer, dock: d, filter, index } = resolved;
    const [lo0, hi0] = stats.extent;
    return {
      title: `${layer.name} · ${d.field}`,
      extent: stats.extent,
      bins: stats.bins,
      window,
      speed: d.speed,
      onWindow,
      // One write per settle; bounds at the extent store as open, exactly
      // like the rail brush. The refetch is skipped — the docked layer's
      // data does not depend on its window.
      onSettle: (win) => {
        const min = win[0] <= lo0 ? null : msToBound(win[0]);
        const max = win[1] >= hi0 ? null : msToBound(win[1]);
        if (min === filter.min && max === filter.max) {
          return Promise.resolve(true);
        }
        const filters = layer.filters.map((f, i) =>
          i === index ? { ...f, min, max } : f,
        );
        return patchLayer(layer.id, { filters }, { skipRefresh: true })
          .then((updated) => updated !== null)
          .catch(() => false);
      },
      onSpeed: (speed) => {
        void patchMap({
          timeline: { layerId: d.layerId, field: d.field, speed },
        });
      },
      onClose: undock,
    };
  }, [resolved, stats, statsKey, window, onWindow, patchLayer, patchMap, undock]);

  return { bar, dock, undock };
}
