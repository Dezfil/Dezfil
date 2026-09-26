import { DEFAULT_STROKE, type LayerStyle } from "./style";
import { layerCycleColor } from "./palettes";

/**
 * Publication-ready default style for a new layer (new layers cycle through
 * kepler.gl's layer colors — the first gets its signature teal; defaults
 * apply on the server so UI-, API-, and assistant-created layers all receive
 * them). Geometry-aware so points, lines, and polygons each read well
 * immediately. Colors are solid; the inherited default translucency lives in
 * the opacity sliders, so 100% honestly means opaque.
 */
export function defaultStyle(
  geometryType: string | null,
  layerIndex = 0,
): LayerStyle {
  const cycle = layerCycleColor(layerIndex);
  const base: LayerStyle = {
    fill: { type: "constant", color: cycle },
    fillOpacity: 0.72,
    stroke: DEFAULT_STROKE,
    strokeOpacity: 0.85,
    // Quiet by default: fills carry the mark, outlines opt in.
    strokeWidth: 0,
    pointRadius: 3,
    opacity: 1,
  };

  if (geometryType?.includes("LINE")) {
    // Lines have no fill area; the visible mark is the stroke.
    return {
      ...base,
      stroke: cycle,
      strokeOpacity: 0.95,
      strokeWidth: 2,
    };
  }
  if (geometryType?.includes("POLYGON")) {
    return { ...base, fillOpacity: 0.5 };
  }
  return base;
}
