import { createHash } from "node:crypto";
import type { MapWithLayers } from "@/lib/metadata/maps";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Only drawn content participates. Sketch artifacts are supplied by the
 * stored bindings; ordinary dataset replacements advance the generation. */
export function drawingDigest(map: MapWithLayers, effectiveStyles: readonly string[], sketchArtifacts: readonly string[] = []): string {
  const drawing = {
    viewport: { ...map.viewport, pitch: map.viewport.pitch ?? 0, bearing: map.viewport.bearing ?? 0 },
    basemap: map.basemap,
    customStyle: map.customBasemap?.url ?? null,
    effectiveStyles,
    basemapLayers: map.basemapLayers,
    timeline: map.timeline,
    sketches: [...sketchArtifacts].sort(),
    layers: map.layers.filter(layer => layer.visible).map(({ id, sql, style, viz, filters }) => ({ id, sql, style, viz, filters })),
  };
  return createHash("sha256").update(JSON.stringify(canonical(drawing))).digest("hex");
}

export interface DrawingFreshness {
  digest: string;
  requestedGeneration: number;
  publishedGeneration: number;
  drawingChangedAt: number;
}

/** Excluded edits leave both the quiet clock and queue ordering alone. */
export function requestDrawing(previous: DrawingFreshness | null, digest: string, now: number, force = false): DrawingFreshness {
  if (previous?.digest === digest && !force) return previous;
  return {
    digest,
    requestedGeneration: (previous?.requestedGeneration ?? 0) + 1,
    publishedGeneration: previous?.publishedGeneration ?? 0,
    drawingChangedAt: previous?.digest === digest ? previous.drawingChangedAt : now,
  };
}
