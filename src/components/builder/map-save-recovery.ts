import type { MapWithLayers } from "@/lib/metadata/maps";

const facts = new Set(["editRevision", "lastChangedAt", "lastChangedBy", "updatedAt"]);
const without = (value: object, ignored: Set<string>) => Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)));
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const contents = (map: MapWithLayers) => ({
  ...without(map, new Set([...facts, "viewport", "history"])),
  layers: map.layers.map(layer => without(layer, facts)),
});

/** A lost response can be confirmed by the complete expected document.
 * A matching edited field alone cannot rebase work over another edit.
 * Camera and response bookkeeping do not belong to the edit boundary. */
export function confirmsMapPatch(before: MapWithLayers | null, patch: Record<string, unknown>, read: MapWithLayers): boolean {
  if (!before) return false;
  const { layerOrder, ...fields } = patch;
  let layers = before.layers;
  if (Array.isArray(layerOrder)) {
    const byId = new Map(layers.map(layer => [layer.id, layer]));
    if (layerOrder.length !== layers.length || layerOrder.some(id => !byId.has(id))) return false;
    layers = layerOrder.map((id, ordinal) => ({ ...byId.get(id)!, ordinal }));
  }
  return stable(contents({ ...before, ...fields, layers })) === stable(contents(read));
}

/** Layer saves share the map's revision, so recovery must also rule out
 * unrelated changes elsewhere in the document. */
export function confirmsLayerPatch(before: MapWithLayers | null, layerId: string, patch: Record<string, unknown>, read: MapWithLayers): boolean {
  if (!before?.layers.some(layer => layer.id === layerId)) return false;
  return confirmsMapPatch({ ...before, layers: before.layers.map(layer =>
    layer.id === layerId ? { ...layer, ...patch } : layer) }, {}, read);
}
