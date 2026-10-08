"use client";

import { useCallback, useState, type RefObject } from "react";
import type { SizeStep } from "@/lib/export/image-definition";
import { openingMapStep } from "@/lib/export/space";
import { useScreenDefaults } from "../../screen-defaults";
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
  /** The output size the card opens at: the instance's starting width
   * and shape as the page handed them down when it opened. */
  size: { width: number; height: number };
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

/** The output size a starting width and shape give, as the instance's
 * settings name them ("1920", "16:9"): the height is the width carried
 * by the shape, as the card's own shape choice carries it. */
export function openingSize(width: string, shape: string): { width: number; height: number } {
  const [across, down] = shape.split(":").map(Number);
  const pixels = Number(width);
  return { width: pixels, height: Math.round((pixels * down) / across) };
}

/**
 * The export card's open state: the camera and the builder canvas's
 * size are read once, at open — seed state, never render-time ref
 * reads — and so are the instance's starting width and shape, so an
 * open card keeps what it opened on and the next opening takes the
 * page's latest. Lives with the card, not in MapBuilder (the
 * monster-file habit: new logic starts in new modules).
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
  const defaults = useScreenDefaults();
  const width = defaults["imageExport.width"];
  const shape = defaults["imageExport.shape"];

  /** Read one coherent, live snapshot. This is used once when the menu
   * opens to describe availability, then independently when Image is
   * activated so a stale enabled row can never create an illegal card.
   * The opening step is judged at the shape the card would open at. */
  const legalSeed = useCallback((): ExportSeed | null => {
    const el = mapLayerRef.current;
    const canvasWidth = el && el.clientWidth > 0 ? el.clientWidth : 0;
    if (canvasWidth === 0) return null;
    const camera = exportCameraSnapshot(
      cameraRef.current,
      viewportRef.current,
      fallbackCamera,
    );
    const size = openingSize(width, shape);
    const mapStep = openingMapStep(camera.zoom, canvasWidth, size);
    if (mapStep === null) return null;
    return { camera, canvasWidth, mapStep, size };
  }, [cameraRef, viewportRef, mapLayerRef, fallbackCamera, width, shape]);

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
