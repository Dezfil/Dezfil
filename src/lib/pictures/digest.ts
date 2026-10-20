import { createHash } from "node:crypto";
import type { MapWithLayers } from "@/lib/metadata/maps";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** The formula a digest is written by. A stored digest without it is the
 * first formula's, which still counted the saved centre and zoom. */
const FORMULA = "v2:";

function hashed(drawing: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(drawing))).digest("hex");
}

function drawn(map: MapWithLayers, effectiveStyles: readonly string[], sketchArtifacts: readonly string[]) {
  return {
    basemap: map.basemap,
    customStyle: map.customBasemap?.url ?? null,
    effectiveStyles,
    basemapLayers: map.basemapLayers,
    timeline: map.timeline,
    sketches: [...sketchArtifacts].sort(),
    layers: map.layers.filter(layer => layer.visible).map(({ id, sql, style, viz, filters }) => ({ id, sql, style, viz, filters })),
  };
}

/** Only drawn content participates. The picture frames the drawn data, so
 * of the saved camera only its tilt and rotation count. Sketch artifacts are
 * supplied by the stored bindings; ordinary dataset replacements advance
 * the generation. */
export function drawingDigest(map: MapWithLayers, effectiveStyles: readonly string[], sketchArtifacts: readonly string[] = []): string {
  const camera = { pitch: map.viewport.pitch ?? 0, bearing: map.viewport.bearing ?? 0 };
  return FORMULA + hashed({ ...drawn(map, effectiveStyles, sketchArtifacts), camera });
}

/** The first formula, kept only to recognise a stored digest written by it. */
export function firstFormulaDigest(map: MapWithLayers, effectiveStyles: readonly string[], sketchArtifacts: readonly string[] = []): string {
  const viewport = { ...map.viewport, pitch: map.viewport.pitch ?? 0, bearing: map.viewport.bearing ?? 0 };
  return hashed({ viewport, ...drawn(map, effectiveStyles, sketchArtifacts) });
}

export function onCurrentFormula(digest: string): boolean {
  return digest.startsWith(FORMULA);
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
