import { labelBasemapTone } from "@/lib/basemap-effective";
import type { BasemapKey } from "@/lib/basemap";
import { resolveLabelChoices } from "./label-choices";
import type { LabelStyle, LayerStyle, RgbaColor } from "./style";

/**
 * The paint an automatic label takes, by the tone of the basemap under it,
 * and the fixed fallbacks the server stores and answers with: every label
 * that leaves the server carries a concrete text colour, halo width and
 * halo colour beside its two choices, so a client that draws a label as
 * given (an older release among them) still draws something readable.
 */

export type LabelTone = "light" | "dark";

export interface LabelRecipe {
  color: RgbaColor;
  /** On the Label section's 0 to 3 scale. */
  haloWidth: number;
  haloColor: RgbaColor;
}

/** Fixed and opaque, the same on every surface, whatever the person's
 * look; a layer's opacity applies on top as it always has. */
export const LABEL_RECIPES: Record<LabelTone, LabelRecipe> = {
  // #243230 on a white halo.
  light: { color: { r: 36, g: 50, b: 48, a: 1 }, haloWidth: 1.5, haloColor: { r: 255, g: 255, b: 255, a: 1 } },
  // #e9ecf3 on a #0b0e14 halo.
  dark: { color: { r: 233, g: 236, b: 243, a: 1 }, haloWidth: 1.5, haloColor: { r: 11, g: 14, b: 20, a: 1 } },
};

/**
 * How labels are drawn, as a map's card pictures record it: the paint
 * above, and the face and weights every surface draws labels in. Raise it
 * whenever any of them changes, so the pictures of every map whose visible
 * layers carry labels are made once more, and those of every other map are
 * kept. A picture made before pictures recorded it was drawn by none (0).
 */
export const LABEL_RECIPE_VERSION = 1;

/** What of a map decides its fallbacks: the basemap as saved. */
export interface SavedBasemap {
  basemap: BasemapKey | null;
  customBasemap: unknown;
}

/**
 * The tone a map's fallbacks take: the light appearance of its basemap as
 * saved. Dark and Satellite are dark (imagery has no names of its own, and
 * light text on a dark rim is what reads over it); Light, Streets and Auto
 * in the light appearance are light; a custom style, whose tone is not
 * known, takes the light recipe. The map has no theme of its own on the
 * server, so this is a fallback, not a claim about what anyone saw.
 */
export function fallbackLabelTone(map: SavedBasemap): LabelTone {
  const custom = map.customBasemap !== null && map.customBasemap !== undefined;
  return labelBasemapTone({ key: map.basemap, custom, theme: "light" });
}

/** The style with each automatic part of its label carrying the tone's
 * recipe; an own part is kept exactly. A new object when anything is
 * filled; the style given is never changed. */
export function withLabelFallbacks(style: LayerStyle, tone: LabelTone): LayerStyle {
  const label = style.label;
  if (!label || (label.textPaint !== "automatic" && label.haloPaint !== "automatic")) return style;
  const recipe = LABEL_RECIPES[tone];
  const filled: LabelStyle = { ...label };
  if (label.textPaint === "automatic") filled.color = { ...recipe.color };
  if (label.haloPaint === "automatic") {
    filled.haloWidth = recipe.haloWidth;
    filled.haloColor = { ...recipe.haloColor };
  }
  return { ...style, label: filled };
}

/** A written style as it is stored: its label's choices resolved as the
 * write sent them, then each automatic part given the map's fallbacks, so
 * an explicit "automatic" overrides the values sent beside it and the
 * stored label is always complete. Runs before the normaliser, which then
 * has nothing to infer. */
export function labelStyleForWrite(style: LayerStyle, map: SavedBasemap): LayerStyle {
  if (!style.label) return style;
  return withLabelFallbacks({ ...style, label: resolveLabelChoices(style.label) }, fallbackLabelTone(map));
}

/** Layers as they leave the server: each style with its map's fallbacks,
 * read for the basemap the map has saved now. It writes nothing, so it
 * stays out of the store, of history and of every revision: apply it to an
 * answer, never to a layer about to be written or compared. */
export function layersWithLabelFallbacks<T extends { style: LayerStyle }>(map: SavedBasemap, layers: T[]): T[] {
  const tone = fallbackLabelTone(map);
  return layers.map((layer) => {
    const style = withLabelFallbacks(layer.style, tone);
    return style === layer.style ? layer : { ...layer, style };
  });
}
