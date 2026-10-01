/**
 * The render-refusal sentences (extracted from layer-service): what a
 * layer says when it cannot draw — over the cap in a shape the tile
 * path cannot carry, or over the cap with no tile builder on the
 * instance. Copy only; the decisions stay with the caller.
 */

export function renderCapRefusal(
  kind: { aggregated: boolean; od: boolean; vizType: string },
  featureCount: number,
  capFeatures: number,
): string {
  const n = featureCount.toLocaleString();
  const cap = capFeatures.toLocaleString();
  if (kind.aggregated) {
    return `This aggregation produces ${n} cells, over the render cap of ${cap}. Choose a coarser cell size.`;
  }
  if (kind.od) {
    return `This layer has ${n} origin→destination rows, over the render cap of ${cap}. ${kind.vizType}s render within the standard path only; filter or aggregate it down in SQL.`;
  }
  if (kind.vizType === "icon" || kind.vizType === "cluster") {
    return `This layer has ${n} points, over the render cap of ${cap}. ${kind.vizType}s render within the standard path only; filter it down, or switch to hex bins or grid.`;
  }
  return `This layer has ${n} points, over the render cap of ${cap}. The heatmap draws raw points; filter it down, or switch to hex bins or grid.`;
}

export function tilerUnavailable(featureCount: number): string {
  return `This layer has ${featureCount.toLocaleString()} features, over the render cap, and rendering it needs the tile builder (tippecanoe), which this instance could not find. Install it, or filter/aggregate the layer.`;
}

/** An over-cap layer read by someone its map is shared with: its tiles are
 * prepared and served for the map's owner alone. */
export function tilesForOwnerOnly(featureCount: number): string {
  return `This layer has ${featureCount.toLocaleString()} features, over the render cap, and its tiles are drawn for the map's owner only.`;
}
