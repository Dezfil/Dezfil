import type { FeaturePickResult, PickedFeature } from "../../map/canvas-pointer";
import { drawState, setDrawSelection } from "./draw-mode";

/**
 * The builder's answer to a click on a map feature, before the canvas's
 * own cluster zoom and pop-up: an armed Tools picker takes the feature's
 * layer first; else a drawn shape's click selects that shape, when no
 * shape tool owns the map. Selecting a shape closes a pinned pop-up; a
 * picker's pick leaves it standing.
 */
export function builderCanvasPick(
  layerId: string,
  feature: PickedFeature,
  offerPickedLayer: (layerId: string) => boolean,
  sketchTableFor: (layerId: string) => string | undefined,
): FeaturePickResult {
  if (offerPickedLayer(layerId)) return true;
  const table = sketchTableFor(layerId);
  const tool = drawState().tool;
  if (table && feature.featureId && feature.kind && (tool === null || tool === "select")) {
    setDrawSelection({ layerId, table, featureId: feature.featureId, kind: feature.kind });
    return "selected";
  }
  return false;
}
