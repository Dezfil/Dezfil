"use client";

import { useCallback, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SharedHistory as HistoryAvailability } from "./shared-history";
import { editHeaders } from "@/lib/edit-basis";
import type { DocumentSequence } from "../document-sequence";
import { readApiError } from "../api";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { FailureKey } from "./use-mutation-lane";
import type { ReplaceRenders } from "./use-layer-renders";

/**
 * Undo/redo coordination, extracted from MapBuilder at the touch (the
 * decomposition rule: the feature that touches the monster file extracts
 * the piece it works on). One press one step through a serialized queue,
 * the whole-map response applied as authoritative, its repaint a render
 * replacement (so a superseded repaint never overwrites a newer answer),
 * and the Cmd/Ctrl+Z / Shift+Cmd+Z / Ctrl+Y binding that
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
  target: (direction: "undo" | "redo") => string | null;
  setHistory: Dispatch<SetStateAction<HistoryAvailability>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  replaceRenders: ReplaceRenders;
}): { applyHistory: (direction: "undo" | "redo") => Promise<void> } {
  const {
    mapId,
    sequence,    track,
    applyMapResponse,
    reload,
    fail,
    clearFailure,
    setHistory, target,
    setSelectedId,
    replaceRenders,
  } = opts;

  // Undo/redo: the response is the refreshed map plus fresh availability
  // — swap it in and refetch render data for every layer (an undo can
  // change SQL, viz, filters, or the layer set), but never touch the
  // camera: the viewport is deliberately outside the timeline.
  const applyHistory = useCallback(
    (direction: "undo" | "redo"): Promise<void> => {
      // One press, one step: history requests run one at a time, so two
      // are never in flight together and their responses cannot land out
      // of order. The repaint is a render replacement: whatever was sent
      // after it, for any layer, outranks it.
      const editRevision = target(direction);
      if (!editRevision) return Promise.resolve();
      const result = sequence.enqueue(async () => {
        if (sequence.stale) return;
        // Literal paths (not an interpolated verb) so the parity suite can
        // match each call to its documented operation.
        const url =
          direction === "undo"
            ? `/api/maps/${mapId}/undo`
            : `/api/maps/${mapId}/redo`;
        let response: Response;
        try {
          response = await track(fetch(url, { method: "POST", headers: editHeaders({ editRevision }) }).then(response => sequence.observe(response)));
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
        await replaceRenders(mapBody.layers.map((l) => l.id));
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
      setHistory, target,
      setSelectedId,
      replaceRenders,
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
