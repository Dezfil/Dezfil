import type { BasemapKey } from "@/lib/basemap";
import { basemapTone } from "@/lib/basemap-effective";
import type { BasemapLayers } from "@/lib/basemap-layers";
import type { Appearance } from "@/lib/export/image-definition";
import { resolveShotBasemapLayers } from "@/lib/export/space";
import type { CompositionMapInputs } from "./ExportComposition";

/**
 * The one map-input assembly both image hosts consume. An explicit null is a
 * resolved answer; only absence inherits stored state. The basemap's tone is
 * decided here from the map's stored key and the image's appearance, so both
 * hosts draw the credit against the same map.
 */
export function buildCompositionMapInputs(
  input: Omit<CompositionMapInputs, "basemapLayers" | "basemapTone"> & {
    definitionBasemapLayers: BasemapLayers | null | undefined;
    storedBasemapLayers: BasemapLayers | null;
    /** The map's stored basemap key; null is Auto. */
    basemapKey: BasemapKey | null;
    /** The image's appearance, which Auto follows. */
    appearance: Appearance;
  },
): CompositionMapInputs {
  const {
    definitionBasemapLayers,
    storedBasemapLayers,
    basemapKey,
    appearance,
    ...compositionInputs
  } = input;
  return {
    ...compositionInputs,
    basemapLayers: resolveShotBasemapLayers(
      definitionBasemapLayers,
      storedBasemapLayers,
    ),
    basemapTone: basemapTone({
      key: basemapKey,
      custom: compositionInputs.customBasemap ?? false,
      theme: appearance,
    }),
  };
}
