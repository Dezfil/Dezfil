import type { AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { mapWithLayers } from "./map-access";
import { computeWidgetValues } from "./widget-service";
import type { MapWidget, WidgetSelection } from "./widgets";

/** Resolve authored widgets through their owned parent; publications use their token projection. */
export async function privateWidgetValues(scope: AccountScope, mapId: string,
  selections: WidgetSelection[], draft?: MapWidget, signal?: AbortSignal) {
  const map = mapWithLayers(scope, mapId);
  if (draft?.layerId != null && !map.layers.some(layer => layer.id === draft.layerId)) throw resourceAbsent();
  return computeWidgetValues(scope, map, map.layers, selections, draft, signal);
}
