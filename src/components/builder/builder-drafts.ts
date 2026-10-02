import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { patchIntent } from "../document-sequence";

type Draft = { layerId?: string; patch: (map: MapWithLayers) => Record<string, unknown> };
const target = (edit: Draft, map: MapWithLayers): Record<string, unknown> | null =>
  (edit.layerId ? map.layers.find(layer => layer.id === edit.layerId) ?? null : map) as Record<string, unknown> | null;
const apply = (map: MapWithLayers, edit: Draft): MapWithLayers => {
  const patch = edit.patch(map);
  return edit.layerId ? { ...map, layers: map.layers.map(layer => layer.id === edit.layerId ? { ...layer, ...patch } : layer) } : { ...map, ...patch };
};

/** Accepted fields retire earlier intent on those fields, preserving later drafts. */
export class BuilderDrafts {
  private next = 0;
  private edits = new Map<number, Draft>();
  layer(id: string, compose: (layer: Layer) => Record<string, unknown>) {
    const ticket = ++this.next;
    this.edits.set(ticket, { layerId: id, patch: map => {
      const layer = map.layers.find(layer => layer.id === id);
      return layer ? compose(layer) : {};
    } });
    return ticket;
  }
  map(compose: (map: MapWithLayers | null) => Record<string, unknown>) {
    const ticket = ++this.next;
    this.edits.set(ticket, { patch: compose });
    return ticket;
  }
  accepted(ticket: number, map: MapWithLayers | null) {
    const accepted = this.edits.get(ticket);
    if (!accepted) return;
    this.edits.delete(ticket);
    if (!map) return;
    const before = target(accepted, apply(map, accepted));
    for (const [older, edit] of this.edits) {
      if (older > ticket || edit.layerId !== accepted.layerId) continue;
      // Apply the accepted intent to both sides of the older draft. Only
      // unresolved differences remain, including nested fields and list IDs.
      const after = target(edit, apply(apply(map, edit), accepted));
      const remaining = Object.fromEntries(Object.keys(edit.patch(map))
        .filter(field => JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field]))
        .map(field => [field, after?.[field]]));
      if (Object.keys(remaining).length === 0) this.edits.delete(older);
      else {
        const compose = patchIntent(before, remaining);
        edit.patch = current => compose(target(edit, current));
      }
    }
  }
  hasLayer(id: string) { return [...this.edits.values()].some(edit => edit.layerId === id); }
  apply = (map: MapWithLayers): MapWithLayers => [...this.edits.values()].reduce(apply, map);
}
