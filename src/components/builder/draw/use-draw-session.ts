"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readApiError } from "../../api";
import {
  registerDrawClose,
  registerDrawUndo,
  type DrawSelection,
} from "./draw-mode";

/**
 * The draw session: dock open to dock close is one session — the first
 * commit mints dataset and layer on the server, every later commit joins
 * them, closing announces the saved layer, and an empty session touches
 * nothing. Client calls are serialized through one lane so a
 * double-click can never mint two sketches; the server serializes again
 * underneath for non-browser callers.
 */

export interface SketchFeatureBody {
  kind: string;
  geometry: unknown;
}

interface SessionState {
  table: string;
  layerId: string;
  layerName: string;
  committed: { id: string; kind: string }[];
}

export interface DrawSessionApi {
  session: SessionState | null;
  commit: (feature: SketchFeatureBody) => Promise<void>;
  deleteFeature: (selection: DrawSelection) => Promise<void>;
  moveVertex: (
    selection: DrawSelection,
    vertexIndex: number,
    position: [number, number],
  ) => Promise<void>;
}

export function useDrawSession(opts: {
  mapId: string;
  /** The map reload — a minted layer arrives like any other new layer,
   * and the minted id is selected. */
  onLayerMinted: (layerId: string) => void;
  /** Refresh every layer reading the table — a duplicate or another SQL
   * layer over the sketch must not keep stale rows. */
  refreshTable: (table: string) => Promise<void> | void;
  /** The sketch summaries resync after every mutation. */
  reloadSketches: () => Promise<void>;
  /** The builder's transient notice — announcements and refusals alike. */
  announce: (message: string) => void;
  /** Clears a selection whose feature was deleted. */
  onSelectionGone: () => void;
}): DrawSessionApi {
  const {
    mapId,
    onLayerMinted,
    refreshTable,
    reloadSketches,
    announce,
    onSelectionGone,
  } = opts;
  const [session, setSession] = useState<SessionState | null>(null);
  const sessionRef = useRef<SessionState | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // Closing the dock fences in-flight commits: a create or
  // append that settles after the close must not repopulate the session
  // it belonged to. The counter bumps at close; captured before every
  // await, checked before every setSession.
  const generationRef = useRef(0);
  const laneRef = useRef<Promise<void>>(Promise.resolve());

  const lane = useCallback((work: () => Promise<void>): Promise<void> => {
    const run = laneRef.current.then(work, work);
    laneRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const commit = useCallback(
    (feature: SketchFeatureBody): Promise<void> =>
      lane(async () => {
        const current = sessionRef.current;
        const generation = generationRef.current;
        try {
          if (!current) {
            const r = await fetch(`/api/maps/${mapId}/sketches`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ feature }),
            });
            if (!r.ok) {
              announce(await readApiError(r));
              return;
            }
            const made = (await r.json()) as {
              table: string;
              layerId: string;
              layerName: string;
              featureId: string;
            };
            if (generation !== generationRef.current) return;
            setSession({
              table: made.table,
              layerId: made.layerId,
              layerName: made.layerName,
              committed: [{ id: made.featureId, kind: feature.kind }],
            });
            onLayerMinted(made.layerId);
            await reloadSketches();
            return;
          }
          const r = await fetch(
            `/api/sketches/${current.table}/features`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ feature }),
            },
          );
          if (!r.ok) {
            announce(await readApiError(r));
            return;
          }
          const body = (await r.json()) as { featureId: string };
          if (generation === generationRef.current)
            setSession({
              ...current,
              committed: [
                ...current.committed,
                { id: body.featureId, kind: feature.kind },
              ],
            });
          await refreshTable(current.table);
          await reloadSketches();
        } catch (cause) {
          announce(
            `The shape could not be saved. ${
              cause instanceof Error ? cause.message : "Network failure."
            }`,
          );
        }
      }),
    [lane, mapId, announce, onLayerMinted, refreshTable, reloadSketches],
  );

  const deleteFeature = useCallback(
    (selection: DrawSelection): Promise<void> =>
      lane(async () => {
        try {
          const r = await fetch(
            `/api/sketches/${selection.table}/features/${selection.featureId}`,
            { method: "DELETE" },
          );
          if (!r.ok) {
            announce(await readApiError(r));
            return;
          }
          const current = sessionRef.current;
          if (current && current.table === selection.table)
            setSession({
              ...current,
              committed: current.committed.filter(
                (c) => c.id !== selection.featureId,
              ),
            });
          onSelectionGone();
          await refreshTable(selection.table);
          await reloadSketches();
        } catch (cause) {
          announce(
            `The shape could not be deleted. ${
              cause instanceof Error ? cause.message : "Network failure."
            }`,
          );
        }
      }),
    [lane, announce, onSelectionGone, refreshTable, reloadSketches],
  );

  const moveVertex = useCallback(
    (
      selection: DrawSelection,
      vertexIndex: number,
      position: [number, number],
    ): Promise<void> =>
      lane(async () => {
        try {
          const r = await fetch(
            `/api/sketches/${selection.table}/features/${selection.featureId}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ vertexIndex, position }),
            },
          );
          if (!r.ok) {
            announce(await readApiError(r));
            return;
          }
          await refreshTable(selection.table);
          await reloadSketches();
        } catch (cause) {
          announce(
            `The vertex could not be moved. ${
              cause instanceof Error ? cause.message : "Network failure."
            }`,
          );
        }
      }),
    [lane, announce, refreshTable, reloadSketches],
  );

  // The session's undo: remove the latest committed shape.
  useEffect(() => {
    registerDrawUndo(() => {
      const current = sessionRef.current;
      if (!current || current.committed.length === 0) return;
      const last = current.committed[current.committed.length - 1];
      void lane(async () => {
        try {
          const r = await fetch(
            `/api/sketches/${current.table}/features/${last.id}`,
            { method: "DELETE" },
          );
          if (!r.ok) {
            announce(await readApiError(r));
            return;
          }
          const s = sessionRef.current;
          if (s)
            setSession({
              ...s,
              committed: s.committed.filter((c) => c.id !== last.id),
            });
          await refreshTable(current.table);
          await reloadSketches();
        } catch (cause) {
          announce(
            `The undo could not be confirmed. ${
              cause instanceof Error ? cause.message : "Network failure."
            }`,
          );
        }
      });
    });
    return () => registerDrawUndo(null);
  }, [lane, announce, refreshTable, reloadSketches]);

  // Closing the dock ends the session: announce what was
  // saved; an empty session vanishes silently.
  useEffect(() => {
    registerDrawClose(() => {
      const current = sessionRef.current;
      generationRef.current += 1;
      setSession(null);
      if (!current || current.committed.length === 0) return;
      const n = current.committed.length;
      announce(
        `${current.layerName} saved · ${n} ${n === 1 ? "shape" : "shapes"} · ${current.table}`,
      );
    });
    return () => registerDrawClose(null);
  }, [announce]);

  return { session, commit, deleteFeature, moveVertex };
}
