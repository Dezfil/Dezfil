import { getMap, type Layer } from "@/lib/metadata/maps";
import { isTemplateDocumentId } from "@/lib/templates/ids";
import { templateMapTimeline } from "@/lib/templates/map-read";
import type { LayerFilter } from "@/lib/viz";
import { liveFilters, type LiveFilter } from "@/lib/live-filters";

/** The docked timeline of the layer's map: a template's from its folder,
 * any other from the store. */
function timelineOf(mapId: string) {
  return isTemplateDocumentId(mapId) ? templateMapTimeline(mapId) : getMap(mapId)?.timeline;
}

/**
 * The filters this layer's render delegates to the client: the shared rule,
 * resolved against the map's docked timeline. Every other surface (previews,
 * classification, aggregated stats) keeps applying all filters.
 */
export function liveRenderFilters(
  layer: Layer,
  timeline = timelineOf(layer.mapId),
): LiveFilter[] {
  const dockedField =
    timeline && timeline.layerId === layer.id ? timeline.field : null;
  return liveFilters(layer.viz, layer.filters, dockedField);
}

/**
 * Filters as the render path enforces them (generalized): live filters are
 * delegated to the canvas — the data ships without them, so slider drags
 * and playback never wait on the server.
 */
export function renderFilters(
  layer: Layer,
  timeline = timelineOf(layer.mapId),
): LayerFilter[] {
  const live = new Set<LayerFilter>(liveRenderFilters(layer, timeline));
  if (live.size === 0) return layer.filters;
  return layer.filters.filter((f) => !live.has(f));
}
