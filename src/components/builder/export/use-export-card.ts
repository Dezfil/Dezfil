"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { EXPORT_WIDTH_PRESETS, type SizeStep } from "@/lib/export/image-definition";
import { openingMapStep } from "@/lib/export/space";
import { useScreenDefaults } from "../../screen-defaults";
import type { Viewport } from "../../map/MapCanvas";
import type { CameraHandle } from "../../map/camera-handle";
import { ASPECT_PRESETS } from "./aspect";

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
   * and shape as the Export menu's read answered them, or the page's
   * snapshot until it did. */
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

/** A starting width and shape, as the instance's settings name them. */
interface StartingSize {
  width: string;
  shape: string;
}

const WIDTHS: readonly string[] = EXPORT_WIDTH_PRESETS.map(String);
const SHAPES: readonly string[] = ASPECT_PRESETS.map((preset) => preset.label);

/** The instance's starting width and shape as the runtime read answers
 * them now, or null when it cannot say: a refused or failed read, or an
 * answer naming a width or shape the card does not offer. */
async function readStartingSize(fetcher: typeof fetch = fetch): Promise<StartingSize | null> {
  try {
    const response = await fetcher("/api/config");
    if (!response.ok) return null;
    const { defaults } = (await response.json()) as { defaults?: Record<string, unknown> };
    const width = defaults?.["imageExport.width"];
    const shape = defaults?.["imageExport.shape"];
    return typeof width === "string" && WIDTHS.includes(width) && typeof shape === "string" && SHAPES.includes(shape)
      ? { width, shape }
      : null;
  } catch {
    return null;
  }
}

/**
 * The export card's open state: the camera and the builder canvas's
 * size are read once, at open — seed state, never render-time ref
 * reads — and so are the instance's starting width and shape, so an
 * open card keeps what it opened on. Lives with the card, not in
 * MapBuilder (the monster-file habit: new logic starts in new modules).
 *
 * A builder can stay open while an admin changes the starting width and
 * shape, so each opening of the Export menu reads them again, once: the
 * answer decides whether Image is offered and what a card opened from
 * that menu starts at. Until it is in, or when the read fails, the
 * page's snapshot stands. Nothing is read while a card is open.
 */
export function useExportCard(
  cameraRef: RefObject<CameraHandle | null>,
  viewportRef: RefObject<Viewport | null>,
  mapLayerRef: RefObject<HTMLDivElement | null>,
  fallbackCamera: Viewport,
): {
  seed: ExportSeed | null;
  available: (onAnswer?: (available: boolean) => void) => boolean;
  open: () => boolean;
  close: () => void;
} {
  const [seed, setSeed] = useState<ExportSeed | null>(null);
  const defaults = useScreenDefaults();
  const snapshotWidth = defaults["imageExport.width"];
  const snapshotShape = defaults["imageExport.shape"];
  // Which opening of the menu is current, and the read's answer for an
  // opening once it is in: an answer stands for its own opening alone.
  const openings = useRef(0);
  const answered = useRef<{ opening: number; size: StartingSize } | null>(null);

  /** Read one coherent, live snapshot. This is used once when the menu
   * opens to describe availability, then independently when Image is
   * activated so a stale enabled row can never create an illegal card.
   * The opening step is judged at the shape the card would open at. */
  const legalSeed = useCallback((start: StartingSize): ExportSeed | null => {
    const el = mapLayerRef.current;
    const canvasWidth = el && el.clientWidth > 0 ? el.clientWidth : 0;
    if (canvasWidth === 0) return null;
    const camera = exportCameraSnapshot(
      cameraRef.current,
      viewportRef.current,
      fallbackCamera,
    );
    const size = openingSize(start.width, start.shape);
    const mapStep = openingMapStep(camera.zoom, canvasWidth, size);
    if (mapStep === null) return null;
    return { camera, canvasWidth, mapStep, size };
  }, [cameraRef, viewportRef, mapLayerRef, fallbackCamera]);

  /** What a card opened now starts at: this menu opening's answer once it
   * is in, the page's snapshot until then. */
  const starting = useCallback((): StartingSize => {
    const answer = answered.current;
    return answer && answer.opening === openings.current
      ? answer.size
      : { width: snapshotWidth, shape: snapshotShape };
  }, [snapshotWidth, snapshotShape]);

  /** The read for one opening of the menu; its answer stands for that
   * opening alone. */
  const askAgain = useCallback((opening: number, onAnswer?: (available: boolean) => void) => {
    void readStartingSize().then((size) => {
      if (size === null || opening !== openings.current) return;
      answered.current = { opening, size };
      onAnswer?.(legalSeed(size) !== null);
    });
  }, [legalSeed]);

  /** Called as the Export menu opens: whether Image can open now, and,
   * once the instance's latest defaults are read, again by `onAnswer`. */
  const available = useCallback((onAnswer?: (available: boolean) => void) => {
    const opening = openings.current + 1;
    openings.current = opening;
    if (seed === null) askAgain(opening, onAnswer);
    return legalSeed(starting()) !== null;
  }, [seed, askAgain, legalSeed, starting]);
  const open = useCallback(() => {
    const next = legalSeed(starting());
    if (next === null) return false;
    setSeed(next);
    return true;
  }, [legalSeed, starting]);
  const close = useCallback(() => setSeed(null), []);
  return { seed, available, open, close };
}
