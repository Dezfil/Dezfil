import type { MapWithLayers } from "@/lib/metadata/maps";

/**
 * What the builder draws once the server refuses a write. A refusal stores
 * nothing, so the refused gesture leaves the screen: each field the write
 * drew shows the server's stored map with the intent still pending over it
 * (`truth`), and every other field stays as drawn. A pending change built on
 * the refused one leaves with it, because pending intent is replayed over
 * the stored map, where what it was built on does not exist.
 */
export function withoutRefusedMapWrite(
  shown: MapWithLayers,
  truth: MapWithLayers,
  fields: string[],
): MapWithLayers {
  const next = { ...shown } as MapWithLayers & Record<string, unknown>;
  const stored = truth as MapWithLayers & Record<string, unknown>;
  for (const field of fields) {
    if (field === "layerOrder") {
      // The map draws its order as the order of its layers; a reorder still
      // pending names its own.
      const order = Array.isArray(stored.layerOrder)
        ? (stored.layerOrder as string[])
        : truth.layers.map((layer) => layer.id);
      const position = new Map(order.map((id, index) => [id, index]));
      next.layers = [...shown.layers].sort(
        (a, b) =>
          (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
    }
    next[field] = stored[field];
  }
  return next;
}

/** The same for a refused layer write: only that layer is drawn again. */
export function withoutRefusedLayerWrite(
  shown: MapWithLayers,
  truth: MapWithLayers,
  layerId: string,
): MapWithLayers {
  const stored = truth.layers.find((layer) => layer.id === layerId);
  if (!stored) return shown;
  return {
    ...shown,
    layers: shown.layers.map((layer) => (layer.id === layerId ? stored : layer)),
  };
}
