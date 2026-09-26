/**
 * The export card's shapes. "Current view" is gone: it was never a
 * shape the author picked, it was the browser window's shape resolved
 * at the moment the card opened — which is why it read as an odd member
 * of a list of ratios. The corner drag does that job properly, and
 * names what it produced.
 */

export const ASPECT_PRESETS = [
  { key: "wide", label: "16:9", ratio: 16 / 9 },
  { key: "classic", label: "4:3", ratio: 4 / 3 },
  { key: "square", label: "1:1", ratio: 1 },
] as const;

export type AspectKey = (typeof ASPECT_PRESETS)[number]["key"];

/** How far from a preset a drag may sit and still be called that preset.
 * A fraction of the ratio, so it feels the same at every shape. */
const SNAP = 0.04;

/** The range a drag may reach — portrait to landscape, bounded so a
 * sliver cannot be produced. */
export const ASPECT_MIN = 1 / 2;
export const ASPECT_MAX = 3;

export function clampAspect(ratio: number): number {
  return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, ratio));
}

/** The preset a ratio counts as, or null for a genuinely custom shape.
 * Snapping is this function: a drag passing near a preset becomes it. */
export function snapAspect(ratio: number): AspectKey | null {
  for (const preset of ASPECT_PRESETS) {
    if (Math.abs(ratio - preset.ratio) <= preset.ratio * SNAP) {
      return preset.key;
    }
  }
  return null;
}

export function aspectRatio(key: AspectKey): number {
  return ASPECT_PRESETS.find((p) => p.key === key)!.ratio;
}

/** The shape control's mode (field round, directive 2):
 * Custom is a choice beside the presets, not an accident of dragging —
 * selecting it is sticky, so the card stays on Custom while the author
 * works the handle, and a drag that lands on a preset hands the
 * selection to that preset's card, which is what snapping means. */
export type ShapeMode = "preset" | "custom";

/** What to call the current shape: a preset's own name, or the ratio the
 * drag produced, reduced to one decimal so it reads as a shape rather
 * than as a measurement. */
export function aspectName(ratio: number): string {
  const preset = snapAspect(ratio);
  if (preset) return ASPECT_PRESETS.find((p) => p.key === preset)!.label;
  return ratio >= 1
    ? `Custom · ${ratio.toFixed(2)} : 1`
    : `Custom · 1 : ${(1 / ratio).toFixed(2)}`;
}
