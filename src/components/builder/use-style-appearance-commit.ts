"use client";
import { useCallback, type RefObject } from "react";
import type { Layer } from "@/lib/metadata/maps";
import type { LayerStyle } from "@/lib/style/style";
import type { DocumentSequence } from "../document-sequence";
import type { useBuilderMutations } from "./use-builder-mutations";

export function useStyleAppearanceCommit({ sequence, authoritativeLayersRef, appearancePreviewVersionRef, clearAppearanceDraft, patchLayer }: {
  sequence: DocumentSequence;
  authoritativeLayersRef: RefObject<Record<string, Layer>>;
  appearancePreviewVersionRef: RefObject<Record<string, number>>;
  clearAppearanceDraft: (id: string) => void;
  patchLayer: ReturnType<typeof useBuilderMutations>["patchLayer"];
}) {
  return useCallback(async (layerId: string, partial: Partial<LayerStyle>): Promise<boolean> => {
    const version = appearancePreviewVersionRef.current[layerId] ?? 0;
    const current = authoritativeLayersRef.current[layerId];
    if (!current) return false;
    const updated = await patchLayer(layerId,
      accepted => ({ style: { ...accepted.style, ...partial } }), { separateHistoryStep: true, skipUnchanged: true });
    if (sequence.stale) return false;
    if (appearancePreviewVersionRef.current[layerId] === version) clearAppearanceDraft(layerId);
    return updated !== null;
  }, [sequence, authoritativeLayersRef, appearancePreviewVersionRef, clearAppearanceDraft, patchLayer]);
}
