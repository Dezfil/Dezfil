"use client";

import { useCallback, useState, type RefObject } from "react";
import type { SizeStep } from "@/lib/export/image-definition";
import { openingMapStep } from "@/lib/export/space";
import type { Viewport } from "../../map/MapCanvas";
import type { CameraHandle } from "../../map/camera-handle";

export interface ExportSeed {
  camera: Viewport;
  /** The builder canvas's CSS width at open. The card lays its
   * composition out in a different space, so the same zoom number would
   * frame different ground; this is what lets it open on what the author
   * is actually looking at. */
  canvasWidth: number;
  /** Chosen from the same live camera/canvas snapshot. The card consumes
   * this answer instead of asking the framing calculation again. */
  mapStep: SizeStep;
}

/** The live renderer wins during an ease. The settled ref keeps the
 * existing WebGL-failure road available when MapLibre never produced a
 * handle, and stored map state is the final startup fallback. */
export function exportCameraSnapshot(
  handle: CameraHandle | null,
  settled: Viewport | null,
  fallback: Viewport,
): Viewport {
  return handle?.currentViewport() ?? settled ?? fallback;
}

/**
 * The export card's open state: the camera and the builder canvas's
 * size are read once, at open — seed state, never render-time ref
 * reads. Lives with the card, not in MapBuilder (the monster-file
 * habit: new logic starts in new modules).
 */
export function useExportCard(
  cameraRef: RefObject<CameraHandle | null>,
  viewportRef: RefObject<Viewport | null>,
  mapLayerRef: RefObject<HTMLDivElement | null>,
  fallbackCamera: Viewport,
): {
  seed: ExportSeed | null;
  available: () => boolean;
  open: () => boolean;
  close: () => void;
} {
  const [seed, setSeed] = useState<ExportSeed | null>(null);

  /** Read one coherent, live snapshot. This is used once when the menu
   * opens to describe availability, then independently when Image is
   * activated so a stale enabled row can never create an illegal card. */
  const legalSeed = useCallback((): ExportSeed | null => {
    const el = mapLayerRef.current;
    const canvasWidth = el && el.clientWidth > 0 ? el.clientWidth : 0;
    if (canvasWidth === 0) return null;
    const camera = exportCameraSnapshot(
      cameraRef.current,
      viewportRef.current,
      fallbackCamera,
    );
    const mapStep = openingMapStep(camera.zoom, canvasWidth);
    if (mapStep === null) return null;
    return { camera, canvasWidth, mapStep };
  }, [cameraRef, viewportRef, mapLayerRef, fallbackCamera]);

  const available = useCallback(() => legalSeed() !== null, [legalSeed]);
  const open = useCallback(() => {
    const next = legalSeed();
    if (next === null) return false;
    setSeed(next);
    return true;
  }, [legalSeed]);
  const close = useCallback(() => setSeed(null), []);
  return { seed, available, open, close };
}
