import { getMap, type Layer } from "@/lib/metadata/maps";
import type { LayerFilter } from "@/lib/viz";
import { liveFilters, type LiveFilter } from "@/lib/live-filters";

/**
 * The filters this layer's render delegates to the client: the shared rule,
 * resolved against the map's docked timeline. Every other surface (previews,
 * classification, aggregated stats) keeps applying all filters.
 */
export function liveRenderFilters(
  layer: Layer,
  timeline = getMap(layer.mapId)?.timeline,
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
  timeline = getMap(layer.mapId)?.timeline,
): LayerFilter[] {
  const live = new Set<LayerFilter>(liveRenderFilters(layer, timeline));
  if (live.size === 0) return layer.filters;
  return layer.filters.filter((f) => !live.has(f));
}
