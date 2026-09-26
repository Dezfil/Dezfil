import type { HeatmapViz } from "./viz";

/** Adaptive aggregation quality for builder heatmaps. */
export const HEATMAP_PREVIEW_TEXTURE_SIZE = 256;
export const HEATMAP_SETTLED_TEXTURE_SIZE = 2048;

export function heatmapTextureSize(interacting: boolean): number {
  return interacting
    ? HEATMAP_PREVIEW_TEXTURE_SIZE
    : HEATMAP_SETTLED_TEXTURE_SIZE;
}

/** Deck.gl initializes heatmap textures once per layer identity. Preview and
 * settled modes therefore need distinct ids for their sizes to take effect. */
export function heatmapLayerId(
  layerId: string,
  interacting: boolean,
): string {
  return `${layerId}:heatmap:${interacting ? "preview" : "settled"}`;
}

export function isHeatmapLayerId(id: string, layerId: string): boolean {
  return id.startsWith(`${layerId}:heatmap:`);
}

export type HeatmapControlField = "radiusPx" | "intensity";

/** Apply one control's draft without replacing a concurrent control edit. */
export function mergeHeatmapControl(
  base: HeatmapViz,
  candidate: HeatmapViz,
  field: HeatmapControlField,
): HeatmapViz {
  return { ...base, [field]: candidate[field] };
}
