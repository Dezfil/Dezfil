import { boundsOf, expandBounds, type Bounds } from "./geo-bounds";
import { dimFeatureValue, type LiveDim } from "./live-filters";

/**
 * The current effective data extent — what fit measures.
 *
 * One definition, shared by the builder and the published view, because
 * the two had a copy each and they disagreed: both measured the layer's
 * *canonical* render, which is the data before anything the canvas
 * enforces afterwards. A timeline window, a widget selection, or a
 * range filter the canvas applies would narrow what is drawn without
 * narrowing what fit framed, so the camera pulled back to frame marks
 * that were not on screen.
 *
 * The extent is taken over the geometry a surface actually draws — which
 * for a cell visualization under a widget selection is the re-rendered
 * cells, not the unselected ones — and over only the features that
 * satisfy the constraints in force.
 */

/** One layer, as fitting sees it. */
export interface ExtentLayer {
  id: string;
  /** A hidden layer draws nothing, so it frames nothing. */
  visible: boolean;
  /** The geometry actually drawn: the selection-specific render when one
   * exists, else the canonical one. Null for a tiled layer. */
  geojson: unknown | null;
  /** A ready tiled archive's box, [w,s,e,n]; null when inline, or while
   * the archive is still being built — which contributes no extent. */
  tiles: [number, number, number, number] | null;
  /** The constraints the canvas is enforcing for this layer right now. */
  dims: LiveDim[];
}

export interface EffectiveExtent {
  /** What the browser can answer; null when it can answer nothing. */
  bounds: Bounds | null;
  /**
   * Layers whose extent the browser cannot know: a tiled layer under a
   * constraint the canvas is enforcing. Its features never reach the
   * client whole — only the tiles the viewport happens to have loaded —
   * so an extent taken from them would depend on where the user was
   * looking. These need the server's answer.
   */
  deferred: string[];
}

/** Whether a feature satisfies every constraint in force. The comparison
 * is the inclusive one the canvas makes, over the same numeric domain, so
 * the two cannot disagree about which features are drawn. */
export function featurePasses(feature: unknown, dims: LiveDim[]): boolean {
  if (dims.length === 0) return true;
  const properties = (feature as { properties?: Record<string, unknown> })
    ?.properties;
  for (const dim of dims) {
    const value = dimFeatureValue(dim, properties?.[dim.field]);
    if (value < dim.range[0] || value > dim.range[1]) return false;
  }
  return true;
}

/** The features of one collection that are actually drawn. */
function drawnFeatures(geojson: unknown, dims: LiveDim[]): unknown {
  const features = (geojson as { features?: unknown })?.features;
  if (!Array.isArray(features)) return geojson;
  if (dims.length === 0) return geojson;
  return { features: features.filter((f) => featurePasses(f, dims)) };
}

/**
 * The extent of what the given layers currently draw, plus the ids of any
 * whose answer only the server holds.
 */
export function effectiveExtent(layers: ExtentLayer[]): EffectiveExtent {
  const drawn: unknown[] = [];
  const deferred: string[] = [];
  let bounds: Bounds | null = null;

  for (const layer of layers) {
    if (!layer.visible) continue;
    if (layer.geojson) {
      drawn.push(drawnFeatures(layer.geojson, layer.dims));
      continue;
    }
    if (!layer.tiles) continue; // still preparing: no extent to give
    if (layer.dims.length > 0) {
      deferred.push(layer.id);
      continue;
    }
    bounds = expandBounds(bounds, layer.tiles);
  }

  const inline = boundsOf(drawn);
  if (inline) {
    bounds = bounds
      ? expandBounds(bounds, [
          Math.min(bounds[0][0], inline[0][0]),
          Math.min(bounds[0][1], inline[0][1]),
          Math.max(bounds[1][0], inline[1][0]),
          Math.max(bounds[1][1], inline[1][1]),
        ])
      : inline;
  }
  return { bounds, deferred };
}

/** Merge a server-computed extent into a browser-computed one. */
export function mergeExtent(
  bounds: Bounds | null,
  box: [number, number, number, number] | null,
): Bounds | null {
  return box ? expandBounds(bounds, box) : bounds;
}
