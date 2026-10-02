"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import type { HistoryAvailability } from "@/lib/metadata/history";
import type { Bounds } from "@/lib/geo-bounds";
import { readApiError } from "../api";
import type { LegendLiveText } from "./LegendTab";
import { fetchLayerRender, renderBounds, type LayerRenderData } from "./render-data";
import { useMutationLane } from "./use-mutation-lane";
import { useMapHistory } from "./use-map-history";

import { acceptedMapWrite } from "./builder-write-response";
import { DocumentSequence } from "../document-sequence";

type StateSetter<T> = Dispatch<SetStateAction<T>>;

/** Shared truth for saves, history and the assistant's whole-map resync. */
export function useBuilderMutations({
  mapId, map, setMap, rendersRef, setRenders, setSelectedId, refreshLayer,
}: {
  mapId: string;
  map: MapWithLayers | null;
  setMap: StateSetter<MapWithLayers | null>;
  rendersRef: React.RefObject<Record<string, LayerRenderData>>;
  setRenders: StateSetter<Record<string, LayerRenderData>>;
  setSelectedId: StateSetter<string | null>;
  refreshLayer: (layerId: string) => Promise<void>;
}) {
  const sequence = useMemo(() => new DocumentSequence(mapId), [mapId]);
  const [reloadKey, setReloadKey] = useState(0);
  // Undo/redo availability: seeded by the history read, then derived —
  // any successful edit enables undo and clears redo; undo/redo responses
  // carry the authoritative values.
  const [history, setHistory] = useState<HistoryAvailability>({
    canUndo: false,
    canRedo: false,
  });
  const edited = useCallback(
    () => setHistory({ canUndo: true, canRedo: false }),
    [],
  );
  const authoritativeLayersRef = useRef<Record<string, Layer>>({});
  // Response application is newest-wins per object. A map response
  // embeds the whole layer set as it stood when the server read it, so
  // applying one wholesale can revert a layer its own lane has since
  // confirmed — and then poison the authoritative ref the next commit
  // diffs against. Every confirmation takes a ticket from this counter;
  // a response only speaks for layers nobody confirmed after it was
  // sent.
  const truthSeqRef = useRef(0);
  const layerConfirmedAtRef = useRef<Record<string, number>>({});
  // Structural changes take tickets too: a duplicate's copy must not be
  // removed, and a deletion must not be undone, by a map response sent
  // before they were confirmed.
  const layerRemovedAtRef = useRef<Record<string, number>>({});
  // Optimistic map-field edits (widgets, layer order) take tickets so an
  // earlier response's echo cannot regress them while their own write is
  // still queued — a further edit built from the regressed state would
  // durably drop the queued one.
  const mapFieldEditedAtRef = useRef<
    Partial<Record<"widgets" | "layerOrder" | "legendOrder", number>>
  >({});
  /** The counter's value when the current map state was produced. */
  const mapAppliedAtRef = useRef(0);
  // The last server-confirmed map body: what queued patch bodies merge
  // against when their turn starts, and what the builder falls back to
  // when even the reconciliation read fails — optimistic state must not
  // stand indefinitely as if accepted.
  const serverMapRef = useRef<MapWithLayers | null>(null);
  // Bumped by every whole-map resync (load, applied history step). A save
  // whose request predates the bump may not apply its echo — the resync
  // already holds newer truth, and a stale echo would revert it (two
  // writers converge).
  const reloadEpochRef = useRef(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // In-progress Legend-tab text, mirrored to the canvas legend on every
  // keystroke; a layer's entry clears when its save echoes back, at which
  // point persisted and live text agree anyway.
  const [legendLive, setLegendLive] = useState<Record<string, LegendLiveText>>(
    {},
  );
  const onLegendLive = useCallback((id: string, text: LegendLiveText) => {
    setLegendLive((prev) => ({ ...prev, [id]: { ...prev[id], ...text } }));
  }, []);
  // A recovered read is authoritative for live text too: the lane
  // discards an entry that was waiting for a lost response rather than
  // leaving it over stale state.
  const clearLegendLive = useCallback((layerId: string) => {
    setLegendLive((prev) => {
      if (!(layerId in prev)) return prev;
      const next = { ...prev };
      delete next[layerId];
      return next;
    });
  }, []);

  // The mutation/recovery lane: the ordered write lanes with
  // verify-then-reconcile recovery, newest-wins response application,
  // lane-owned failure banners, and pending-saves accounting — extracted
  // beside MapBuilder (use-mutation-lane.ts), sharing the truth refs above.
  const {
    failures,
    fail,
    clearFailure,
    pendingSaves,
    track,
    applyMapResponse,
    patchMap,
    patchLayer,
  } = useMutationLane({
    mapId,
    sequence,
    map,
    setMap,
    rendersRef,
    authoritativeLayersRef,
    truthSeqRef,
    layerConfirmedAtRef,
    layerRemovedAtRef,
    mapFieldEditedAtRef,
    mapAppliedAtRef,
    serverMapRef,
    reloadEpochRef,
    refreshLayer,
    edited,
    clearLegendLive,
  });

  const request = useCallback<typeof fetch>((input, init) => sequence.enqueue(async () => {
    const response = await fetch(input, { ...init, headers: sequence.headers(init?.headers) });
    if (response.ok) {
      const body: unknown = await response.clone().json().catch(() => null);
      sequence.accept(body);
      serverMapRef.current = acceptedMapWrite(serverMapRef.current, String(input), init?.method ?? "GET", body);
      if (serverMapRef.current) authoritativeLayersRef.current = Object.fromEntries(serverMapRef.current.layers.map((layer) => [layer.id, layer]));
    }
    return response;
  }), [sequence]);

  const turn = useCallback((work: () => Promise<void>) => sequence.enqueue(async () => {
    await work();
    // The turn has settled while later editor intent still waits. Install the
    // accepted document before releasing that intent; never stamp old payloads.
    const response = await fetch(`/api/maps/${mapId}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await readApiError(response));
    const body = await response.json() as MapWithLayers;
    applyMapResponse(body, false, truthSeqRef.current);
    await Promise.all(body.layers.map((layer) => refreshLayer(layer.id)));
  }), [sequence, mapId, applyMapResponse, refreshLayer]);

  // Undo/redo — extracted to use-map-history.ts at the touch; the queue,
  // the generation fence and the keyboard binding live there unchanged.
  const { applyHistory } = useMapHistory({
    mapId,
    sequence,
    track,
    applyMapResponse,
    reload,
    fail,
    clearFailure,
    setHistory,
    setSelectedId,
    rendersRef,
    setRenders,
  });

  return {
    turn, request, sequence, history, setHistory, edited, reloadKey, reload,
    authoritativeLayersRef, truthSeqRef, layerConfirmedAtRef, layerRemovedAtRef,
    mapFieldEditedAtRef, mapAppliedAtRef, serverMapRef, reloadEpochRef,
    legendLive, onLegendLive, failures, fail, clearFailure, pendingSaves,
    track, applyMapResponse, patchMap, patchLayer, applyHistory,
  };
}

/** Loading after assistant mutations uses the same response fences as edits. */
export function useBuilderReload({
  mapId, mutations, importFocusRef, setMap, setMapProjectId, rendersRef, setRenders, setFitBounds,
}: {
  mapId: string;
  mutations: ReturnType<typeof useBuilderMutations>;
  importFocusRef: React.RefObject<{ active: boolean }>;
  setMap: StateSetter<MapWithLayers | null>;
  setMapProjectId: StateSetter<string | null>;
  rendersRef: React.RefObject<Record<string, LayerRenderData>>;
  setRenders: StateSetter<Record<string, LayerRenderData>>;
  setFitBounds: StateSetter<Bounds | null>;
}) {
  const {
    sequence, reloadKey, truthSeqRef, authoritativeLayersRef, layerConfirmedAtRef,
    layerRemovedAtRef, mapFieldEditedAtRef, reloadEpochRef, mapAppliedAtRef,
    serverMapRef, clearFailure, setHistory, fail,
  } = mutations;
  // Load the map and every layer's render data.
  useEffect(() => {
    let cancelled = false;
    void sequence.enqueue(async () => {
      try {
        // Authority demands fresh truth: if a write confirms while the
        // read is on the wire, the body may predate it — re-read rather
        // than install a snapshot that would regress the accepted edit.
        // Contention is transient; the cap only guards a pathological
        // edit storm.
        let body!: MapWithLayers;
        for (let attempt = 0; attempt < 3; attempt++) {
          const seqAtStart = truthSeqRef.current;
          const response = await fetch(`/api/maps/${mapId}`);
          if (!response.ok) throw new Error(await readApiError(response));
          body = (await response.json()) as MapWithLayers & {
            projectId?: string | null;
          };
          if (cancelled) return;
          if (truthSeqRef.current === seqAtStart) break;
        }
        authoritativeLayersRef.current = Object.fromEntries(
          body.layers.map((layer) => [layer.id, layer]),
        );
        // A load is authoritative for the whole map: it supersedes every
        // lane confirmation, so a late response cannot drag it back
        // (this is also the assistant's resync path).
        layerConfirmedAtRef.current = {};
        layerRemovedAtRef.current = {};
        mapFieldEditedAtRef.current = {};
        truthSeqRef.current += 1;
        reloadEpochRef.current += 1;
        mapAppliedAtRef.current = truthSeqRef.current;
        sequence.accept(body);
        serverMapRef.current = body;
        setMap(body);
        setMapProjectId(
          (body as { projectId?: string | null }).projectId ?? null,
        );
        // A recovered reload clears the load lane's standing failure —
        // its banner must not outlive the condition.
        clearFailure("load");
        // Seed the undo/redo buttons; also re-runs after assistant turns.
        void fetch(`/api/maps/${mapId}/history`).then(async (r) => {
          if (r.ok && !cancelled) {
            setHistory((await r.json()) as HistoryAvailability);
          }
        });
        const entries = await Promise.all(
          body.layers.map(
            async (l) => [l.id, await fetchLayerRender(l.id)] as const,
          ),
        );
        if (cancelled) return;
        const nextRenders = Object.fromEntries(entries);
        rendersRef.current = nextRenders;
        setRenders(nextRenders);
        // Frame the data once it has loaded (spec: fit-to-bounds on the data
        // extent). Done here in the load handler, not a reactive effect.
        // During an import's focus window the camera belongs to the newly
        // added layers — no global reframe.
        if (!importFocusRef.current.active) {
          const b = renderBounds(entries.map(([, r]) => r));
          if (b) setFitBounds([...b] as Bounds);
        }
      } catch (e) {
        if (!cancelled)
          fail("load", e instanceof Error ? e.message : "Failed to load map");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sequence, mapId, reloadKey, clearFailure, fail, importFocusRef, truthSeqRef, authoritativeLayersRef, layerConfirmedAtRef, layerRemovedAtRef, mapFieldEditedAtRef, reloadEpochRef, mapAppliedAtRef, serverMapRef, setMap, setMapProjectId, setHistory, rendersRef, setRenders, setFitBounds]);

}
