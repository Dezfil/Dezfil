import type { MapWidget, WidgetSelection } from "@/lib/widgets";

/**
 * The enforcement-budget half of the dashboard truth states: stored
 * live filters and the timeline take precedence over session selections
 * for a layer's fixed GPU slots. A selection the remaining slots cannot
 * hold is DROPPED — it leaves every surface (canvas, values, chips), so
 * it is never shown active while unapplied, and a notice says so.
 * Dropped, not parked: a filter that silently re-applies when a slot
 * frees later is the same class of surprise this spec exists to remove.
 */

export interface BudgetLayer {
  id: string;
  /** Settle-lane layers take no GPU slots — their selections go to SQL. */
  settles: boolean;
  /** GPU dimensions the layer's stored filters and timeline already use. */
  storedDims: number;
}

export function budgetSelections(
  raw: WidgetSelection[],
  widgets: MapWidget[],
  layers: BudgetLayer[],
  slots: number,
): { selections: WidgetSelection[]; droppedLayers: string[] } {
  const widgetById = new Map(widgets.map((w) => [w.id, w]));
  const layerById = new Map(layers.map((l) => [l.id, l]));
  const used = new Map<string, number>();
  const kept: WidgetSelection[] = [];
  const dropped: string[] = [];
  for (const s of raw) {
    const w = widgetById.get(s.widgetId);
    // A vanished widget's selection falls away by derivation. A HIDDEN
    // widget's does too: before the export card widened the batch, a
    // hidden widget never reached this derivation at all, so its retained
    // selection never filtered — the wider list must not silently
    // re-admit it.
    if (!w || !w.visible) continue;
    const layer = w.layerId ? layerById.get(w.layerId) : undefined;
    if (!layer || layer.settles || w.field === null) {
      kept.push(s);
      continue;
    }
    const base = used.get(layer.id) ?? layer.storedDims;
    if (base + 1 <= slots) {
      used.set(layer.id, base + 1);
      kept.push(s);
    } else {
      dropped.push(layer.id);
    }
  }
  return { selections: kept, droppedLayers: dropped };
}

export const DROPPED_HINT =
  "Live filters and the timeline fill this layer's slots. A selection " +
  "was dropped. Remove one to select again.";
