import type { Layer, MapWithLayers } from "@/lib/metadata/maps";

type Draft = { layerId?: string; patch: (map: MapWithLayers) => Record<string, unknown>; retired: Set<string> };
const remaining = (edit: Draft, map: MapWithLayers) => Object.fromEntries(Object.entries(edit.patch(map)).filter(([field]) => !edit.retired.has(field)));

/** Accepted fields retire earlier intent on those fields, preserving later drafts. */
export class BuilderDrafts {
  private next = 0;
  private edits = new Map<number, Draft>();
  layer(id: string, compose: (layer: Layer) => Record<string, unknown>) {
    const ticket = ++this.next;
    this.edits.set(ticket, { layerId: id, retired: new Set(), patch: map => {
      const layer = map.layers.find(layer => layer.id === id);
      return layer ? compose(layer) : {};
    } });
    return ticket;
  }
  map(compose: (map: MapWithLayers | null) => Record<string, unknown>) {
    const ticket = ++this.next;
    this.edits.set(ticket, { retired: new Set(), patch: compose });
    return ticket;
  }
  accepted(ticket: number, fields: string[], map: MapWithLayers | null) {
    const accepted = this.edits.get(ticket);
    if (!accepted) return;
    this.edits.delete(ticket);
    for (const [older, edit] of this.edits) {
      if (older > ticket || edit.layerId !== accepted.layerId) continue;
      for (const field of fields) edit.retired.add(field);
      if (map && Object.keys(remaining(edit, map)).length === 0) this.edits.delete(older);
    }
  }
  hasLayer(id: string) { return [...this.edits.values()].some(edit => edit.layerId === id); }
  apply = (map: MapWithLayers): MapWithLayers => [...this.edits.values()].reduce((value, edit) => {
    const patch = remaining(edit, value);
    return edit.layerId ? { ...value, layers: value.layers.map(layer => layer.id === edit.layerId ? { ...layer, ...patch } : layer) } : { ...value, ...patch };
  }, map);
}
