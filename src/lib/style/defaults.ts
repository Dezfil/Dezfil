import { DEFAULT_STROKE, type LayerStyle } from "./style";
import { DEFAULT_CATEGORICAL, layerCycleColor } from "./palettes";

/** What a new layer's default style is drawn with: the categorical palette
 * new layers take their colors from in turn, each geometry family's
 * opacity from 0 to 1, a line's width and a point's radius in pixels. */
export interface NewLayerLook {
  readonly palette: string;
  readonly pointOpacity: number;
  readonly lineOpacity: number;
  readonly areaOpacity: number;
  readonly lineWidth: number;
  readonly pointRadius: number;
}

/** The product's own look, inherited from kepler.gl: what a new layer
 * takes when the instance's defaults are at their product values. */
export const PRODUCT_LAYER_LOOK: NewLayerLook = {
  palette: DEFAULT_CATEGORICAL, pointOpacity: 0.72, lineOpacity: 0.95, areaOpacity: 0.5, lineWidth: 2, pointRadius: 3,
};

/**
 * Publication-ready default style for a new layer (new layers cycle through
 * the look's palette, kepler.gl's layer colors at the product's look — the
 * first gets its signature teal; defaults apply on the server so UI-, API-,
 * and assistant-created layers all receive them). Geometry-aware so points,
 * lines, and polygons each read well immediately. Colors are solid; the
 * inherited default translucency lives in the opacity sliders, so 100%
 * honestly means opaque. Pure: the caller hands it the look, and it reads
 * nothing itself.
 */
export function defaultStyle(
  geometryType: string | null,
  layerIndex = 0,
  look: NewLayerLook = PRODUCT_LAYER_LOOK,
): LayerStyle {
  const cycle = layerCycleColor(layerIndex, look.palette);
  const base: LayerStyle = {
    fill: { type: "constant", color: cycle },
    fillOpacity: look.pointOpacity,
    stroke: DEFAULT_STROKE,
    strokeOpacity: 0.85,
    // Quiet by default: fills carry the mark, outlines opt in.
    strokeWidth: 0,
    pointRadius: look.pointRadius,
    opacity: 1,
  };

  if (geometryType?.includes("LINE")) {
    // Lines have no fill area; the visible mark is the stroke.
    return {
      ...base,
      stroke: cycle,
      strokeOpacity: look.lineOpacity,
      strokeWidth: look.lineWidth,
    };
  }
  if (geometryType?.includes("POLYGON")) {
    return { ...base, fillOpacity: look.areaOpacity };
  }
  return base;
}
