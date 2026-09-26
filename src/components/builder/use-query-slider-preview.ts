"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layer } from "@/lib/metadata/maps";
import type { LayerFilter, LayerViz } from "@/lib/viz";
import type {
  SliderPreviewData,
  SliderPreviewResult,
  SliderPreviewWork,
  SliderPreviewWorkResult,
} from "@/lib/slider-preview";
import { readApiError } from "../api";

export interface QuerySliderDraft extends SliderPreviewResult {
  viz: LayerViz;
  filters: LayerFilter[];
  /** Authoritative data has replaced the worker result and is painting. */
  settled?: boolean;
}

interface ActiveDraft {
  generation: number;
  viz: LayerViz;
  filters: LayerFilter[];
}

interface CachedSource {
  key: string;
  data?: SliderPreviewData;
  pending?: Promise<SliderPreviewData | null>;
}

interface QueuedWork {
  work: SliderPreviewWork;
  layerId: string;
  generation: number;
}

/** Values that change which source columns/rows a preview endpoint returns.
 * Cell size and slider bounds are deliberately absent. */
function sourceKey(layer: Layer): string {
  const vizShape =
    layer.viz.type === "hexbin" || layer.viz.type === "grid"
      ? {
          type: layer.viz.type,
          aggregate: layer.viz.aggregate,
          // The height aggregate shapes the source columns too; the height
          // value itself deliberately doesn't.
          elevation: layer.viz.elevation?.aggregate ?? null,
        }
      : layer.viz.type === "heatmap"
        ? { type: layer.viz.type, weight: layer.viz.weight }
        : { type: layer.viz.type };
  return JSON.stringify({
    sql: layer.sql,
    viz: vizShape,
    rangeFields: layer.filters
      .filter((filter) => filter.kind !== "values")
      .map((filter) => [filter.field, filter.kind]),
    discrete: layer.filters.filter((filter) => filter.kind === "values"),
    style: layer.style,
  });
}

export function useQuerySliderPreview({
  onError,
  onSuccess,
}: {
  onError: (message: string) => void;
  /** A preview delivered — the lane succeeded; its standing failure can
   * clear (a banner never outlives its condition). */
  onSuccess: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, QuerySliderDraft>>({});
  const workerRef = useRef<Worker | null>(null);
  const sourcesRef = useRef<Record<string, CachedSource>>({});
  const activeRef = useRef<Record<string, ActiveDraft>>({});
  const nextWorkRef = useRef(0);
  const workRef = useRef<
    Record<number, { layerId: string; generation: number }>
  >({});
  const inFlightRef = useRef<Record<string, boolean>>({});
  const pendingWorkRef = useRef<Record<string, QueuedWork>>({});
  const settleFramesRef = useRef<
    Record<string, { first: number; second: number | null }>
  >({});

  useEffect(() => {
    const worker = new Worker(
      new URL("./slider-preview.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<SliderPreviewWorkResult>) => {
      const meta = workRef.current[event.data.id];
      delete workRef.current[event.data.id];
      if (!meta) return;
      delete inFlightRef.current[meta.layerId];
      const active = activeRef.current[meta.layerId];
      if (active?.generation === meta.generation) {
        if (!event.data.ok) {
          onError(event.data.error);
        } else {
          onSuccess();
          const result = event.data.result;
          setDrafts((current) => ({
            ...current,
            [meta.layerId]: {
              ...result,
              viz: active.viz,
              filters: active.filters,
            },
          }));
        }
      }

      // A worker cannot interrupt the operation already running, but it
      // never needs to process every pointer event that arrived meanwhile.
      // Keep only the newest pending state and launch it when the slot frees.
      const queued = pendingWorkRef.current[meta.layerId];
      delete pendingWorkRef.current[meta.layerId];
      const latest = activeRef.current[meta.layerId];
      if (!queued || latest?.generation !== queued.generation) return;
      inFlightRef.current[meta.layerId] = true;
      workRef.current[queued.work.id] = {
        layerId: queued.layerId,
        generation: queued.generation,
      };
      worker.postMessage(queued.work);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [onError, onSuccess]);

  const prepare = useCallback(
    async (layer: Layer): Promise<SliderPreviewData | null> => {
      const key = sourceKey(layer);
      const cached = sourcesRef.current[layer.id];
      if (cached?.key === key && cached.data) return cached.data;
      if (cached?.key === key && cached.pending) return cached.pending;
      const pending = (async () => {
        try {
          const response = await fetch(`/api/layers/${layer.id}/slider-preview`);
          if (!response.ok) throw new Error(await readApiError(response));
          const data = (await response.json()) as SliderPreviewData;
          const current = sourcesRef.current[layer.id];
          if (current?.key === key) {
            sourcesRef.current[layer.id] = { key, data };
          }
          return data;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Preview data failed.";
          onError(message);
          if (sourcesRef.current[layer.id]?.key === key) {
            delete sourcesRef.current[layer.id];
          }
          return null;
        }
      })();
      sourcesRef.current[layer.id] = { key, pending };
      return pending;
    },
    [onError],
  );

  const preview = useCallback(
    (layer: Layer, viz: LayerViz, filters: LayerFilter[]) => {
      const generation =
        (activeRef.current[layer.id]?.generation ?? 0) + 1;
      activeRef.current[layer.id] = { generation, viz, filters };
      void prepare(layer).then((source) => {
        const active = activeRef.current[layer.id];
        if (!source || !active || active.generation !== generation) return;
        const worker = workerRef.current;
        if (!worker) return;
        const id = ++nextWorkRef.current;
        const work: SliderPreviewWork = { id, source, viz, filters };
        if (inFlightRef.current[layer.id]) {
          pendingWorkRef.current[layer.id] = {
            work,
            layerId: layer.id,
            generation,
          };
          return;
        }
        inFlightRef.current[layer.id] = true;
        workRef.current[id] = { layerId: layer.id, generation };
        worker.postMessage(work);
      });
    },
    [prepare],
  );

  const end = useCallback((layerId: string) => {
    delete activeRef.current[layerId];
    delete pendingWorkRef.current[layerId];
    setDrafts((current) => {
      if (!(layerId in current)) return current;
      const next = { ...current };
      delete next[layerId];
      return next;
    });
  }, []);

  /** Replace a visible worker result with authoritative render data before
   * the preview identity is removed, preventing a blank deck transition. */
  const reconcile = useCallback(
    (layer: Layer, geojson: unknown) => {
      delete activeRef.current[layer.id];
      delete pendingWorkRef.current[layer.id];
      setDrafts((current) => {
        const draft = current[layer.id];
        if (!draft) return current;
        return {
          ...current,
          [layer.id]: {
            ...draft,
            geojson: geojson as QuerySliderDraft["geojson"],
            approximate: false,
            viz: layer.viz,
            filters: layer.filters,
            settled: true,
          },
        };
      });
    },
    [],
  );

  // This effect runs only after React has committed the authoritative draft.
  // Give deck.gl two paint opportunities, then remove the now-identical
  // preview identity. A newer interaction keeps its active draft instead.
  useEffect(() => {
    for (const [layerId, draft] of Object.entries(drafts)) {
      if (!draft.settled || settleFramesRef.current[layerId]) continue;
      const entry = { first: 0, second: null as number | null };
      entry.first = requestAnimationFrame(() => {
        entry.second = requestAnimationFrame(() => {
          delete settleFramesRef.current[layerId];
          if (!activeRef.current[layerId]) end(layerId);
        });
      });
      settleFramesRef.current[layerId] = entry;
    }
  }, [drafts, end]);

  useEffect(
    () => () => {
      for (const entry of Object.values(settleFramesRef.current)) {
        cancelAnimationFrame(entry.first);
        if (entry.second !== null) cancelAnimationFrame(entry.second);
      }
    },
    [],
  );

  const approximate = useMemo(
    () => Object.values(drafts).some((draft) => draft.approximate),
    [drafts],
  );

  return { drafts, approximate, prepare, preview, reconcile, end };
}
