import {
  effectiveBasemap,
  type EffectiveBasemap,
} from "@/lib/basemap-effective";
import type { AttributionLine, BasemapStyle } from "@/lib/basemap";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { Theme } from "@/components/theme";

/**
 * The builder's effective basemap, out of the builder module: one shared
 * derivation where a custom style wins outright, then the explicit
 * choice, then Auto following the theme unless the deployment override
 * pins it. Kind gates the content-group toggles; the credit follows the
 * style, which for a custom one is its save-time snapshot and for an
 * override is the credit the instance configured.
 */
export function builderBasemap(
  map: MapWithLayers,
  deployment: {
    theme: Theme;
    basemapUrl: string;
    basemapOverrideUrl: string | null;
    basemapOverrideAttribution: AttributionLine[];
    basemaps: BasemapStyle[];
  },
): EffectiveBasemap {
  return effectiveBasemap({
    key: map.basemap,
    custom: map.customBasemap,
    theme: deployment.theme,
    overrideUrl: deployment.basemapOverrideUrl,
    defaultUrl: deployment.basemapUrl,
    basemaps: deployment.basemaps,
    overrideAttribution: deployment.basemapOverrideAttribution,
  });
}
