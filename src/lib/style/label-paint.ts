import { LABEL_RECIPES, type LabelTone } from "./label-recipe";
import type { LabelStyle, RgbaColor } from "./style";

/**
 * What a label is drawn with over a basemap of a given tone: its text
 * colour, halo width and halo colour, each part from the tone's recipe
 * where it follows the map and from the label where it is the label's own.
 * One resolution for every reader of it, so the map and the Label section
 * show the same paint.
 *
 * An own colour keeps its authored alpha; the recipes are opaque. The
 * layer's opacity is not applied here: the text layer applies it once, on
 * top, through its own gamma curve, and a tile's labels inherit the tiled
 * layer's.
 */

export interface LabelPaint {
  color: RgbaColor;
  /** On the Label section's 0 to 3 scale. */
  haloWidth: number;
  haloColor: RgbaColor;
}

type Paintable = Pick<LabelStyle, "textPaint" | "color" | "haloPaint" | "haloWidth" | "haloColor">;

/** A label's paint over a basemap of this tone. A part that carries no
 * choice (a label not yet saved) is drawn as given. */
export function labelPaint(label: Paintable, tone: LabelTone): LabelPaint {
  const recipe = LABEL_RECIPES[tone];
  const text = label.textPaint === "automatic";
  const halo = label.haloPaint === "automatic";
  return {
    color: text ? recipe.color : label.color,
    haloWidth: halo ? recipe.haloWidth : label.haloWidth,
    haloColor: halo ? recipe.haloColor : label.haloColor,
  };
}

/** The label as the renderer draws it over this tone: its paint resolved,
 * every other setting as it is. The label given when nothing follows the
 * map, so a label of its own reaches the renderer unchanged. */
export function paintedLabel(label: LabelStyle, tone: LabelTone): LabelStyle {
  if (label.textPaint !== "automatic" && label.haloPaint !== "automatic") return label;
  return { ...label, ...labelPaint(label, tone) };
}
