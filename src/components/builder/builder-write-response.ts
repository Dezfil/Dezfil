import type { MapWithLayers, Layer } from "@/lib/metadata/maps";

/** Fold a covered success into accepted state before releasing the queue.
 * Presentation can keep optimistic fields, but never supplies this basis. */
export function acceptedMapWrite(current: MapWithLayers | null, path: string, method: string, value: unknown): MapWithLayers | null {
  if (!current || !value || typeof value !== "object") return current;
  const body = value as Record<string, unknown>;
  const base = typeof body.editRevision === "string" ? { ...current, editRevision: body.editRevision } : current;
  if (Array.isArray(body.layers)) return body as unknown as MapWithLayers;
  if (typeof body.sql === "string" && typeof body.id === "string") {
    const layer = body as unknown as Layer;
    return { ...base, layers: base.layers.some((l) => l.id === layer.id) ? base.layers.map((l) => l.id === layer.id ? layer : l) : [...base.layers, layer] };
  }
  const deleted = method === "DELETE" && /\/layers\/([^/]+)$/.exec(path)?.[1];
  if (deleted) return { ...base, layers: base.layers.filter((l) => l.id !== deleted), widgets: base.widgets.filter((w) => w.layerId !== deleted) };
  return base;
}
