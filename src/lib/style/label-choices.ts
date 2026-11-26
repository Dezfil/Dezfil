import type { LabelStyle, RgbaColor } from "./style";

/**
 * A label's two choices: its text, and its halo (width and colour
 * together), each "automatic", following the tone of the basemap drawn
 * under the label, or "own", the label's own colours. Only types come from
 * the style module, so it may import this one back.
 */

export const LABEL_PAINT_CHOICES = ["automatic", "own"] as const;
export type LabelPaintChoice = (typeof LABEL_PAINT_CHOICES)[number];

/** The historical halo color — what `halo: true` always painted; the
 * one-time read migration pins legacy maps to it exactly. It is also the
 * halo colour of the old starting paint every earlier label began with. */
export const LEGACY_HALO_COLOR: RgbaColor = { r: 12, g: 16, b: 24, a: 0.8 };

/** The text colour of the old starting paint: white at full opacity. */
const OLD_STARTING_TEXT: RgbaColor = { r: 255, g: 255, b: 255, a: 1 };

const sameColor = (a: RgbaColor | undefined, b: RgbaColor) =>
  a !== undefined && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

/**
 * The choices a write's label resolves to, after every value it sent has
 * passed the label check (which also refuses an incomplete halo). A choice
 * sent is kept; without one, a part follows the map when the write sent
 * none of its values and is the label's own when it sent them. Values an
 * automatic part carries are left for the save to replace with the map's
 * fallbacks. A write is taken as sent: the old starting paint without
 * choices is the label's own.
 */
export function resolveLabelChoices(label: LabelStyle): LabelStyle {
  return {
    ...label,
    textPaint: label.textPaint ?? (label.color !== undefined ? "own" : "automatic"),
    haloPaint:
      label.haloPaint ??
      (label.haloWidth !== undefined && label.haloColor !== undefined ? "own" : "automatic"),
  };
}

/**
 * A label as it is read, wherever a stored one is: a stored map, an undo
 * image, a template's view or its copy. One stored before the choices
 * existed carries neither; it follows the map, text and halo, only when it
 * still holds the whole old starting paint (white opaque text, a halo of
 * width 0 in the old halo colour) and keeps its own paint in every other
 * case. The old boolean halo is read before this, by the caller. A label
 * that carries its choices is read as stored.
 */
export function labelChoicesOnRead(label: LabelStyle): LabelStyle {
  if (label.textPaint !== undefined || label.haloPaint !== undefined) return resolveLabelChoices(label);
  const started =
    sameColor(label.color, OLD_STARTING_TEXT) &&
    label.haloWidth === 0 &&
    sameColor(label.haloColor, LEGACY_HALO_COLOR);
  const choice: LabelPaintChoice = started ? "automatic" : "own";
  return { ...label, textPaint: choice, haloPaint: choice };
}
