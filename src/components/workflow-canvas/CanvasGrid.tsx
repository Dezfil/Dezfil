"use client";

import { Background, BackgroundVariant, useStore } from "@xyflow/react";

/**
 * The reference's dot grid: a 2px dot in the strong border colour, 24px
 * apart at 100%. The library scales its gap and its dot with the zoom;
 * the gap should scale and the dot should not, so the dot is handed the
 * zoom's inverse and holds 2px at every zoom. Its own component, so the
 * zoom re-renders the grid alone.
 */
export const GRID_GAP = 24;
export const GRID_DOT = 2;

export function CanvasGrid() {
  const zoom = useStore((s) => s.transform[2]);
  return <Background variant={BackgroundVariant.Dots} gap={GRID_GAP} size={GRID_DOT / zoom} color="var(--border-strong)" />;
}
