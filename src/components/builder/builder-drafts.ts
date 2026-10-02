import type { Layer, MapWithLayers } from "@/lib/metadata/maps";

/** Field intents survive refusal; accepting one removes only that intent. */
export class BuilderDrafts {
  private next = 0;
  private edits = new Map<number, { layerId?: string; apply: (map: MapWithLayers) => MapWithLayers }>();
  layer(id: string, compose: (layer: Layer) => Record<string, unknown>) {
    const ticket = ++this.next;
    this.edits.set(ticket, { layerId: id, apply: map => ({ ...map, layers: map.layers.map(layer => layer.id === id ? { ...layer, ...compose(layer) } : layer) }) });
    return ticket;
  }
  map(compose: (map: MapWithLayers | null) => Record<string, unknown>) {
    const ticket = ++this.next;
    this.edits.set(ticket, { apply: map => ({ ...map, ...compose(map) }) });
    return ticket;
  }
  accepted(ticket: number) { this.edits.delete(ticket); }
  hasLayer(id: string) { return [...this.edits.values()].some(edit => edit.layerId === id); }
  apply = (map: MapWithLayers): MapWithLayers => [...this.edits.values()].reduce((value, edit) => edit.apply(value), map);
}
