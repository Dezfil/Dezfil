import { getMap, type Layer } from "@/lib/metadata/maps";
import { privateLayerFields, type PrivateMapContext } from "@/lib/field-dependencies";
import { isTemplateDocumentId } from "@/lib/templates/ids";
import { templateMapContext } from "@/lib/templates/map-read";

/** The map-level state a layer's private render reads: a template's from
 * its folder, any other from the store. */
function privateContextOf(mapId: string): PrivateMapContext {
  const map = isTemplateDocumentId(mapId) ? templateMapContext(mapId) : getMap(mapId);
  return { timeline: map?.timeline ?? null, widgets: map?.widgets ?? [] };
}

/** The properties a layer's private (builder) render carries: what the
 * layer and its map read, by the private policy, in result order. */
export function privateRenderFields(layer: Layer, columns: string[]): string[] {
  return privateLayerFields(layer, privateContextOf(layer.mapId), columns);
}
