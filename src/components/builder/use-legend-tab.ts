"use client";

import { useCallback, useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { Corner } from "@/lib/corners";
import type { LegendAttrs } from "@/lib/viz";

/**
 * The Legend tab's write wiring, out of `MapBuilder.tsx` (at-touch
 * decomposition slice): the per-layer legend edits the builder always
 * made, joined by the manual order's two writes. A reorder applies
 * optimistically — the dropped row must hold its slot this frame, not
 * after the round-trip — so it takes the mutation lane's edit ticket
 * exactly as the layer order does.
 */
export function useLegendTab({
  patchMap,
  patchLayer,
  setMap,
  truthSeqRef,
  mapFieldEditedAtRef,
}: {
  patchMap: (
    request: Record<string, unknown>,
    opts?: { changeGroup?: string },
  ) => Promise<boolean>;
  patchLayer: (
    layerId: string,
    body: Record<string, unknown>,
  ) => Promise<unknown>;
  setMap: Dispatch<SetStateAction<MapWithLayers | null>>;
  truthSeqRef: RefObject<number>;
  mapFieldEditedAtRef: RefObject<
    Partial<Record<"widgets" | "layerOrder" | "legendOrder", number>>
  >;
}) {
  const writeOrder = useCallback(
    (arrangement: string[] | null) => {
      truthSeqRef.current += 1;
      mapFieldEditedAtRef.current.legendOrder = truthSeqRef.current;
      setMap((m) => (m ? { ...m, legendOrder: arrangement } : m));
      // Each drop and each reset is its own history gesture:
      // ungrouped, a move and a quick reset would coalesce into one
      // null→null step and undo to nothing.
      void patchMap(
        { legendOrder: arrangement },
        { changeGroup: crypto.randomUUID() },
      );
    },
    [patchMap, setMap, truthSeqRef, mapFieldEditedAtRef],
  );

  return useMemo(
    () => ({
      onCorner: (legendCorner: Corner) => void patchMap({ legendCorner }),
      onToggle: (id: string, inLegend: boolean) =>
        void patchLayer(id, { inLegend }),
      // The text saves hand their answer back: the legend editor tells
      // its own refused text from another surface's change by it.
      onTitle: (id: string, legendTitle: string | null) =>
        patchLayer(id, { legendTitle }),
      onLabels: (id: string, legendLabels: (string | null)[] | null) =>
        patchLayer(id, { legendLabels }),
      onAttrs: (id: string, legendAttrs: LegendAttrs | null) =>
        patchLayer(id, { legendAttrs }),
      /** The arrangement, top first — the tab's display order. */
      onReorder: (topFirstIds: string[]) => writeOrder(topFirstIds),
      onResetOrder: () => writeOrder(null),
    }),
    [patchMap, patchLayer, writeOrder],
  );
}
