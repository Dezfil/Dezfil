"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { HistoryAvailability } from "@/lib/metadata/history";
import type { DocumentSequence } from "../document-sequence";
import { readApiError } from "../api";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { FailureKey } from "./use-mutation-lane";
import { fetchLayerRender, type LayerRenderData } from "./render-data";

/**
 * Undo/redo coordination, extracted from MapBuilder at the touch (the
 * decomposition rule: the feature that touches the monster file extracts
 * the piece it works on). Behavior is unchanged: one press one step
 * through a serialized queue, a generation fence so a superseded repaint
 * never overwrites a newer one, the whole-map response applied as
 * authoritative, and the Cmd/Ctrl+Z / Shift+Cmd+Z / Ctrl+Y binding that
 * yields to text editing. The draw session's own undo intercepts in the
 * capture phase before the bubble-phase listener here ever sees the
 * chord.
 */
export function useMapHistory(opts: {
  mapId: string;
  sequence: DocumentSequence;
  track: <T>(promise: Promise<T>) => Promise<T>;
  applyMapResponse: (
    body: MapWithLayers,
    partial: boolean,
    epoch: number,
  ) => void;
  reload: () => void;
  fail: (key: FailureKey, message: string) => void;
  clearFailure: (key: FailureKey) => void;
  setHistory: Dispatch<SetStateAction<HistoryAvailability>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  rendersRef: MutableRefObject<Record<string, LayerRenderData>>;
  setRenders: Dispatch<SetStateAction<Record<string, LayerRenderData>>>;
}): { applyHistory: (direction: "undo" | "redo") => Promise<void> } {
  const {
    mapId,
    sequence,    track,
    applyMapResponse,
    reload,
    fail,
    clearFailure,
    setHistory,
    setSelectedId,
    rendersRef,
    setRenders,
  } = opts;
  const historyGenerationRef = useRef(0);

  // Undo/redo: the response is the refreshed map plus fresh availability
  // — swap it in and refetch render data for every layer (an undo can
  // change SQL, viz, filters, or the layer set), but never touch the
  // camera: the viewport is deliberately outside the timeline.
  const applyHistory = useCallback(
    (direction: "undo" | "redo"): Promise<void> => {
      // One press, one step: history requests run one at a time, so two
      // are never in flight together and their responses cannot land out
      // of order. The repaint carries a generation, so a superseded
      // batch never overwrites a newer one's result.
      const result = sequence.enqueue(async () => {
        if (sequence.stale) return;
        const generation = (historyGenerationRef.current += 1);
        // Literal paths (not an interpolated verb) so the parity suite can
        // match each call to its documented operation.
        const url =
          direction === "undo"
            ? `/api/maps/${mapId}/undo`
            : `/api/maps/${mapId}/redo`;
        let response: Response;
        try {
          response = await track(sequence.writeFetch(url, { method: "POST", headers: sequence.headers() }));
        } catch (cause) {
          fail(
            "history",
            `The ${direction} could not be confirmed. ${
              cause instanceof Error ? cause.message : "Network failure."
            }`,
          );
          reload();
          return;
        }
        if (sequence.stale) { fail("history", await readApiError(response)); return; }
        if (!response.ok) {
          // 409 = nothing to apply — the optimistic flag overshot (a no-op
          // edit); resync the buttons instead of surfacing an error.
          if (response.status === 409) {
            try {
              const r = await fetch(`/api/maps/${mapId}/history`);
              if (r.ok) setHistory((await r.json()) as HistoryAvailability);
            } catch {
              // The availability read is best-effort; the buttons resync on
              // the next edit or reload.
            }
            return;
          }
          fail("history", await readApiError(response));
          return;
        }
        let body: MapWithLayers & { history: HistoryAvailability };
        try {
          body = (await response.json()) as MapWithLayers & {
            history: HistoryAvailability;
          };
        } catch (cause) {
          fail(
            "history",
            `The ${direction} could not be confirmed. ${
              cause instanceof Error ? cause.message : "Network failure."
            }`,
          );
          reload();
          return;
        }
        clearFailure("history");
        const { history: fresh, ...mapBody } = body;
        // An applied step is authoritative for the whole map — it
        // supersedes every lane, exactly as a reload does.
        applyMapResponse(mapBody as MapWithLayers, false, Infinity);
        setHistory(fresh);
        setSelectedId((sel) =>
          sel && mapBody.layers.some((l) => l.id === sel) ? sel : null,
        );
        const entries = await Promise.all(
          mapBody.layers.map(
            async (l) => [l.id, await fetchLayerRender(l.id)] as const,
          ),
        );
        if (generation !== historyGenerationRef.current) return;
        const nextRenders = Object.fromEntries(entries);
        rendersRef.current = nextRenders;
        setRenders(nextRenders);
      });
      return result;
    },
    [
      mapId,
      sequence,
      track,
      applyMapResponse,
      reload,
      clearFailure,
      fail,
      setHistory,
      setSelectedId,
      rendersRef,
      setRenders,
    ],
  );

  // Cmd/Ctrl+Z and Shift+Cmd+Z / Ctrl+Y — yielding to text editing,
  // where the browser's native undo stays native. Sliders and color
  // wells hold focus after a drag; they have no text undo, so the
  // shortcut works right after dragging one.
  useEffect(() => {
    const inTextEditing = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      if (t.isContentEditable) return true;
      if (t instanceof HTMLTextAreaElement) return true;
      return (
        t instanceof HTMLInputElement &&
        ["text", "search", "number", "email", "url", "password"].includes(
          t.type,
        )
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Undo is a deliberate act: a held chord auto-repeats ~30 times a
      // second, and each repeat would be another step plus a full
      // repaint.
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      const redo = (key === "z" && e.shiftKey) || key === "y";
      const undo = key === "z" && !e.shiftKey;
      if (!undo && !redo) return;
      if (inTextEditing(e.target)) return;
      e.preventDefault();
      void applyHistory(redo ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyHistory]);

  return { applyHistory };
}
