"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PickedFeature } from "../../map/canvas-pointer";
import type { SketchGeometry } from "@/lib/sketch/geometry";
import {
  drawState,
  resetDraw,
  setDrawSelection,
  useDrawMode,
  type DrawModeState,
  type DrawSelection,
} from "./draw-mode";
import { useDrawSession, type DrawSessionApi } from "./use-draw-session";
import {
  sketchSentence,
  useMapSketches,
} from "./use-map-sketches";

/**
 * The builder's whole draw integration, one hook so the monster file
 * carries wiring lines only: the sketch summaries and their derived
 * maps, the session, the selected feature's ground-truth geometry for
 * its selection mark and vertex handles, the Delete-key binding on a
 * selection, and the canvas pick seam's composite (armed picker first,
 * then sketch selection).
 */

/** The selected drawn feature and its stored geometry, read from the
 * sketch features API rather than the render — the overlay draws the
 * selection mark for every kind from it and the handles for the two
 * vertex-editable kinds. */
export interface SelectedSketchGeometry {
  selection: DrawSelection;
  geometry: SketchGeometry;
}

export interface DrawIntegration {
  mode: DrawModeState;
  session: DrawSessionApi;
  /** LayerId → the card's honest content line + the dataset it names. */
  cardLines: Map<string, { sentence: string; table: string }>;
  /** The sketch table an owner layer cascades to; undefined otherwise. */
  sketchTableFor: (layerId: string) => string | undefined;
  /** Resync the summaries — the cascade path calls it after a delete. */
  reloadSketches: () => Promise<void>;
  /** Named for the builder's wiring line, which passes it through
   * unchanged; it has carried every kind's geometry since 0188. */
  selectedRing: SelectedSketchGeometry | null;
  moveVertex: (
    selection: DrawSelection,
    index: number,
    position: [number, number],
  ) => Promise<void>;
  onCanvasFeaturePick: (layerId: string, feature: PickedFeature) => boolean;
}

export function useDrawIntegration(opts: {
  request?: typeof fetch;
  mapId: string;
  reloadKey: number;
  /** Reload the map; the minted layer id arrives selected. */
  reload: () => void;
  selectLayer: (layerId: string) => void;
  refreshLayer: (layerId: string) => Promise<void> | void;
  /** The map's layers, for refreshing every reader of a mutated table. */
  layers: { id: string; sql: string }[];
  announce: (message: string) => void;
  /** The pick-mode half of the seam — an armed picker answers first. */
  offerPickedLayer: (layerId: string) => boolean;
}): DrawIntegration {
  const {
    mapId,
    reloadKey,
    reload,
    selectLayer,
    refreshLayer,
    layers,
    announce,
    offerPickedLayer,
  } = opts;
  const mode = useDrawMode();

  // The store is module-global; a map is not. Leaving a map
  // — client navigation or unmount — closes the dock and drops the
  // selection silently, so the next map can never inherit them and a
  // stray Delete can never mutate the previous map's sketch.
  useEffect(() => {
    return () => resetDraw();
  }, [mapId]);
  const { sketches, reload: reloadSketches } = useMapSketches(mapId);
  useEffect(() => {
    void reloadSketches();
  }, [reloadSketches, reloadKey]);

  const byLayer = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sketches) if (s.layerId) map.set(s.layerId, s.table);
    return map;
  }, [sketches]);
  const byLayerRef = useRef(byLayer);
  useEffect(() => {
    byLayerRef.current = byLayer;
  }, [byLayer]);
  const cardLines = useMemo(() => {
    const lines = new Map<string, { sentence: string; table: string }>();
    for (const s of sketches)
      if (s.layerId)
        lines.set(s.layerId, { sentence: sketchSentence(s), table: s.table });
    return lines;
  }, [sketches]);

  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);
  const refreshTable = useCallback(
    async (table: string) => {
      // Word-boundary match, the table-deps rule: every layer whose SQL
      // reads the table refreshes, duplicates included.
      const pattern = new RegExp(`\\b${table}\\b`, "i");
      await Promise.all(
        layersRef.current
          .filter((l) => pattern.test(l.sql))
          .map((l) => refreshLayer(l.id)),
      );
    },
    [refreshLayer],
  );

  const session = useDrawSession({
    request: opts.request,
    mapId,
    onLayerMinted: (layerId) => {
      reload();
      selectLayer(layerId);
    },
    refreshTable,
    reloadSketches,
    announce,
    onSelectionGone: () => setDrawSelection(null),
  });

  // The selected feature's ground-truth geometry, for its selection
  // mark and the vertex handles — read from the sketch
  // features API, not the render, for every kind: fetching it only for
  // polygon and freehand was why a selected point, line, rectangle or
  // circle showed nothing on the map.
  const [ringEpoch, setRingEpoch] = useState(0);
  const [selectedRing, setSelectedRing] =
    useState<SelectedSketchGeometry | null>(null);
  // Reset during render when the selection changes (the documented
  // pattern); the effect below only ever sets state asynchronously.
  const [ringFor, setRingFor] = useState<DrawSelection | null>(null);
  if (ringFor !== mode.selected) {
    setRingFor(mode.selected);
    setSelectedRing(null);
  }
  useEffect(() => {
    const sel = mode.selected;
    if (!sel) return;
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/sketches/${sel.table}/features`);
        if (!r.ok) return;
        const body = (await r.json()) as {
          features: { id: string; geometry: SketchGeometry }[];
        };
        const feature = body.features.find((f) => f.id === sel.featureId);
        if (alive && feature)
          setSelectedRing({ selection: sel, geometry: feature.geometry });
      } catch {
        // The mark and handles stay absent; selection and delete still work.
      }
    })();
    return () => {
      alive = false;
    };
  }, [mode.selected, ringEpoch]);

  const moveVertex = useCallback(
    async (
      selection: DrawSelection,
      index: number,
      position: [number, number],
    ) => {
      await session.moveVertex(selection, index, position);
      setRingEpoch((n) => n + 1);
    },
    [session],
  );

  // Delete/Backspace removes the selected drawn shape —
  // outside text editing, and never while a shape tool draws.
  useEffect(() => {
    const sel = mode.selected;
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable ||
          t instanceof HTMLTextAreaElement ||
          t instanceof HTMLInputElement)
      )
        return;
      e.preventDefault();
      void session.deleteFeature(sel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode.selected, session]);

  // The pick seam (behaviors 5 and 12): an armed picker answers first;
  // then a sketch feature's click selects it, when no shape tool owns
  // the map.
  const onCanvasFeaturePick = useCallback(
    (layerId: string, feature: PickedFeature) => {
      if (offerPickedLayer(layerId)) return true;
      const table = byLayerRef.current.get(layerId);
      const st = drawState();
      if (
        table &&
        feature.featureId &&
        feature.kind &&
        (st.tool === null || st.tool === "select")
      ) {
        setDrawSelection({
          layerId,
          table,
          featureId: feature.featureId,
          kind: feature.kind,
        });
        return true;
      }
      return false;
    },
    [offerPickedLayer],
  );

  return {
    mode,
    session,
    cardLines,
    sketchTableFor: (layerId: string) => byLayerRef.current.get(layerId),
    reloadSketches,
    selectedRing,
    moveVertex,
    onCanvasFeaturePick,
  };
}
