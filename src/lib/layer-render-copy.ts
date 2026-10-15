/**
 * The render-refusal sentences (extracted from layer-service): what a
 * layer says when it cannot draw — over the cap in a shape the tile
 * path cannot carry, or over the cap with no tile builder on the
 * instance. Over Bytes drawn per layer with the feature count within its
 * cap, the same sentences name the byte limit instead. Copy only; the
 * decisions stay with the caller.
 */

/** The byte limit as the sentences name it. */
function overByteLimit(limit: number): string {
  return `This layer's answer is larger than ${limit.toLocaleString("en-US")} bytes, the limit for one layer drawn in the map`;
}

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

/** A template's layer over the cap: it has no tiles of its own, and a copy
 * is a map of the person's, which tiles. */
export function templateRenderCapRefusal(featureCount: number, capFeatures: number): string {
  return `This layer has ${featureCount.toLocaleString()} features, over the render cap of ${capFeatures.toLocaleString()}. A template draws within the cap; make a copy to draw all of it.`;
}

/** A template's layer over the byte limit: as over the cap, a copy tiles. */
export function templateRenderBytesRefusal(limit: number): string {
  return `${overByteLimit(limit)}. A template draws within the limit; make a copy to draw all of it.`;
}

/** No tile builder for a layer over the cap, or, when `overBytes` names
 * the byte limit, over that limit with its count within the cap. */
export function tilerUnavailable(featureCount: number, overBytes?: number): string {
  const over = overBytes === undefined
    ? `This layer has ${featureCount.toLocaleString()} features, over the render cap`
    : overByteLimit(overBytes);
  return `${over}, and rendering it needs the tile builder (tippecanoe), which this instance could not find. Install it, or filter/aggregate the layer.`;
}
