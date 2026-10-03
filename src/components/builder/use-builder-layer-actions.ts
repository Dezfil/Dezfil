"use client";
import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { MapWithLayers, Layer } from "@/lib/metadata/maps";
import type { HistoryAvailability } from "@/lib/metadata/history";
import { readApiError } from "../api";
import { drawState, setDrawSelection } from "./draw/draw-mode";
import type { DrawIntegration } from "./draw/use-draw-integration";
import type { useBuilderMutations } from "./use-builder-mutations";
import type { LayerRenderData } from "./render-data";

export function useBuilderLayerActions({ mutations, draw, mapId, selectedId, setSelectedId, setMap, setRenders, rendersRef, refreshLayer }: {
  mutations: ReturnType<typeof useBuilderMutations>; draw: DrawIntegration; mapId: string;
  selectedId: string | null; setSelectedId: Dispatch<SetStateAction<string | null>>;
  setMap: Dispatch<SetStateAction<MapWithLayers | null>>;
  setRenders: Dispatch<SetStateAction<Record<string, LayerRenderData>>>;
  rendersRef: RefObject<Record<string, LayerRenderData>>;
  refreshLayer: (id: string) => Promise<void>;
}) {
  const { request, track, patchMap, fail, reload, clearFailure, authoritativeLayersRef, truthSeqRef,
    layerConfirmedAtRef, layerRemovedAtRef, serverMapRef, edited, mapFieldEditedAtRef, setHistory } = mutations;
  const duplicateLayer = useCallback(
    async (layerId: string) => {
      // Structural changes reconcile by reload: after a network-level
      // failure the copy may or may not exist — show the truth beside the
      // banner rather than guessing.
      const unconfirmed = (cause: unknown) => {
        fail(
          `layer:${layerId}`,
          `The layer duplication could not be confirmed. ${
            cause instanceof Error ? cause.message : "Network failure."
          }`,
        );
        reload();
      };
      let response: Response;
      try {
        response = await track(
          request(`/api/layers/${layerId}/duplicate`, { method: "POST" }),
        );
      } catch (cause) {
        unconfirmed(cause);
        return;
      }
      if (!response.ok) {
        fail(`layer:${layerId}`, await readApiError(response));
        return;
      }
      let copy: Layer;
      try {
        copy = (await response.json()) as Layer;
      } catch (cause) {
        unconfirmed(cause);
        return;
      }
      clearFailure(`layer:${layerId}`);
      // The copy takes a ticket: a map response sent before this
      // confirmation embeds a layer set without it, and must not remove
      // it on arrival.
      authoritativeLayersRef.current[copy.id] = copy;
      truthSeqRef.current += 1;
      layerConfirmedAtRef.current[copy.id] = truthSeqRef.current;
      serverMapRef.current = serverMapRef.current
        ? {
            ...serverMapRef.current,
            layers: serverMapRef.current.layers.some((l) => l.id === copy.id) ? serverMapRef.current.layers : [...serverMapRef.current.layers, copy],
          }
        : serverMapRef.current;
      setMap((m) => (m ? { ...m, layers: [...m.layers, copy] } : m));
      setSelectedId(copy.id);
      edited();
      await refreshLayer(copy.id);
    },
    [clearFailure, authoritativeLayersRef, truthSeqRef, layerConfirmedAtRef, serverMapRef, edited, refreshLayer, fail, reload, track, request, setMap, setSelectedId],
  );

  const reorderLayers = useCallback(
    (bottomUpIds: string[]) => {
      // The optimistic order takes a ticket: an earlier response's echo
      // must not regress it while its write is queued.
      truthSeqRef.current += 1;
      mapFieldEditedAtRef.current.layerOrder = truthSeqRef.current;
      // Apply the order locally first: the drop animation needs the list in
      // its final order this frame, not after the server round-trip.
      setMap((m) => {
        if (!m) return m;
        const byId = new Map(m.layers.map((l) => [l.id, l]));
        const layers = bottomUpIds.flatMap((id) => byId.get(id) ?? []);
        return layers.length === m.layers.length ? { ...m, layers } : m;
      });
      void patchMap({ layerOrder: bottomUpIds });
    },
    [mapFieldEditedAtRef, patchMap, truthSeqRef, setMap],
  );

  const deleteLayer = useCallback(
    async (layerId: string) => {
      // the provenance-named owner cascades to its dataset through the
      // sketch route; every other layer keeps the ordinary delete.
      const sketchTable = draw.sketchTableFor(layerId);
      let response: Response;
      try {
        response = await track(
          request(
            sketchTable
              ? `/api/sketches/${sketchTable}`
              : `/api/layers/${layerId}`,
            { method: "DELETE" },
          ),
        );
      } catch (cause) {
        // The delete may or may not have applied — reload shows the truth
        // beside the banner.
        fail(
          `layer:${layerId}`,
          `The layer deletion could not be confirmed. ${
            cause instanceof Error ? cause.message : "Network failure."
          }`,
        );
        reload();
        return;
      }
      if (!response.ok) {
        fail(`layer:${layerId}`, await readApiError(response));
        return;
      }
      clearFailure(`layer:${layerId}`);
      if (selectedId === layerId) setSelectedId(null);
      // The removal takes a ticket: a map response sent before this
      // confirmation still embeds the layer, and must not resurrect it
      // on arrival. The server cascaded bound widgets away in the same
      // undoable step — mirror that here, with the widgets ticket, so a
      // whole-array widget write can never re-introduce them.
      truthSeqRef.current += 1;
      layerRemovedAtRef.current[layerId] = truthSeqRef.current;
      mapFieldEditedAtRef.current.widgets = truthSeqRef.current;
      delete layerConfirmedAtRef.current[layerId];
      delete authoritativeLayersRef.current[layerId];
      serverMapRef.current = serverMapRef.current
        ? {
            ...serverMapRef.current,
            layers: serverMapRef.current.layers.filter(
              (l) => l.id !== layerId,
            ),
            widgets: serverMapRef.current.widgets.filter(
              (w) => w.layerId !== layerId,
            ),
          }
        : serverMapRef.current;
      setMap((m) =>
        m
          ? {
              ...m,
              layers: m.layers.filter((l) => l.id !== layerId),
              widgets: m.widgets.filter((w) => w.layerId !== layerId),
            }
          : m,
      );
      setRenders((r) => {
        const next = { ...r };
        delete next[layerId];
        rendersRef.current = next;
        return next;
      });
      if (sketchTable) {
        if (drawState().selected?.layerId === layerId) setDrawSelection(null);
        void draw.reloadSketches();
        // The cascade writes no history step:
        // edited()'s optimistic canUndo would expose a fake Undo, so the
        // buttons resync from the server instead.
        try {
          const r = await fetch(`/api/maps/${mapId}/history`);
          if (r.ok) setHistory((await r.json()) as HistoryAvailability);
        } catch {
          // Best-effort; the next edit or reload resyncs.
        }
        return;
      }
      edited();
    },
    [draw, clearFailure, selectedId, truthSeqRef, layerRemovedAtRef, mapFieldEditedAtRef, layerConfirmedAtRef, authoritativeLayersRef, serverMapRef, edited, track, fail, reload, mapId, setHistory, request, rendersRef, setMap, setRenders, setSelectedId],
  );

  return { duplicateLayer, reorderLayers, deleteLayer };
}
