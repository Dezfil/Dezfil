import type { BasemapLayers } from "@/lib/basemap-layers";
import { resolveShotBasemapLayers } from "@/lib/export/space";
import type { CompositionMapInputs } from "./ExportComposition";

/**
 * The one map-input assembly both image hosts consume. An explicit null is a
 * resolved answer; only absence inherits stored state.
 */
export function buildCompositionMapInputs(
  input: Omit<CompositionMapInputs, "basemapLayers"> & {
    definitionBasemapLayers: BasemapLayers | null | undefined;
    storedBasemapLayers: BasemapLayers | null;
  },
): CompositionMapInputs {
  const {
    definitionBasemapLayers,
    storedBasemapLayers,
    ...compositionInputs
  } = input;
  return {
    ...compositionInputs,
    basemapLayers: resolveShotBasemapLayers(
      definitionBasemapLayers,
      storedBasemapLayers,
    ),
  };
}
