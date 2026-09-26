"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The map-scoped sketch read: provenance and per-family summaries from
 * the server — what drives the card's mixed counts, the owner-specific
 * cascade confirmation, and selection mapping — without assuming an
 * inline render.
 */
export interface MapSketchSummary {
  table: string;
  tableId: string;
  mapId: string;
  layerId: string | null;
  rowCount: number;
  counts: Partial<
    Record<
      "point" | "line" | "polygon" | "rectangle" | "circle" | "freehand",
      number
    >
  >;
}

/** The card's honest content line: per-family
 * counts — polygon-family kinds fold together the way the data stores
 * them. */
export function sketchSentence(summary: MapSketchSummary): string {
  const points = summary.counts.point ?? 0;
  const lines = summary.counts.line ?? 0;
  const polygons =
    (summary.counts.polygon ?? 0) +
    (summary.counts.rectangle ?? 0) +
    (summary.counts.circle ?? 0) +
    (summary.counts.freehand ?? 0);
  const parts: string[] = [];
  if (points) parts.push(`${points} ${points === 1 ? "point" : "points"}`);
  if (lines) parts.push(`${lines} ${lines === 1 ? "line" : "lines"}`);
  if (polygons)
    parts.push(`${polygons} ${polygons === 1 ? "polygon" : "polygons"}`);
  return parts.join(" · ") || "0 features";
}

export function useMapSketches(mapId: string): {
  sketches: MapSketchSummary[];
  reload: () => Promise<void>;
} {
  const [sketches, setSketches] = useState<MapSketchSummary[]>([]);
  const reload = useCallback(
    () =>
      fetch(`/api/maps/${mapId}/sketches`)
        .then(async (r) => {
          if (r.ok) setSketches((await r.json()) as MapSketchSummary[]);
        })
        .catch(() => {
          // Best-effort: the summaries resync on the next mutation or
          // reload.
        }),
    [mapId],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { sketches, reload };
}
