import { resourceAbsent } from "@/lib/auth/owned-resource";
import type { Layer, MapRecord } from "@/lib/metadata/maps";
import { isValidTimeline } from "@/lib/timeline";
import { isValidWidgets } from "@/lib/widgets";

/** Check the whole compound write before evaluating any of its valid references. */
export function assertMapLayerRefs(map: MapRecord, layers: Layer[], fields: {
  widgets?: unknown; timeline?: unknown; layerOrder?: unknown; legendOrder?: unknown;
}): void {
  const ids = new Set(layers.map(layer => layer.id));
  const requireMember = (id: string) => { if (!ids.has(id)) throw resourceAbsent(); };
  for (const order of [fields.layerOrder, fields.legendOrder]) {
    if (Array.isArray(order) && order.every(id => typeof id === "string")) order.forEach(requireMember);
  }
  if (isValidTimeline(fields.timeline)) requireMember(fields.timeline.layerId);
  if (isValidWidgets(fields.widgets)) {
    const stored = new Map(map.widgets.map(widget => [widget.id, widget.layerId]));
    for (const widget of fields.widgets) {
      // Preserve an unchanged orphan already stored by an earlier history image.
      if (widget.layerId !== null && stored.get(widget.id) !== widget.layerId) requireMember(widget.layerId);
    }
  }
}
