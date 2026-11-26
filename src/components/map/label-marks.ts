import type { Layer as DeckLayer } from "@deck.gl/core";
import type { LabeledFeature } from "@/lib/style/deck-style";
import { layerOpacity } from "@/lib/style/deck-style";
import { paintedLabel } from "@/lib/style/label-paint";
import type { LabelTone } from "@/lib/style/label-recipe";
import type { LabelStyle, LayerStyle } from "@/lib/style/style";
import type { LabelStack } from "./label-collision";
import { textSublayer, type LiveWindowing } from "./text-sublayer";

/**
 * A layer's marks with its labels drawn above them, out of the canvas under
 * the decomposition rule: the one place a feature layer's labels are given
 * their face and their paint for the tone of the map under them, and laid
 * over their marks. Tiled layers attach theirs per tile, in the tiled layer,
 * from the same paint.
 */

interface Labelled {
  id: string;
  style: Pick<LayerStyle, "label" | "opacity">;
}

/** How a canvas build labels its layers. */
export interface LabelLook {
  markScale: number;
  /** The surface's label face once it has loaded; no labels before it. */
  labelFont: string | null;
  /** The tone of the basemap the canvas drew, which automatic paint follows. */
  tone: LabelTone;
}

export function withLabelLayer(
  layer: Labelled,
  marks: DeckLayer,
  labeled: LabeledFeature[],
  at: LabelLook & {
    /** An aggregated cell's ground size, which its labels scale with. */
    cellMeters: number | null | undefined;
    windowing: LiveWindowing | null;
    /** The marks' id suffix, which the labels' id follows. */
    suffix: string;
    stack: LabelStack | undefined;
  },
): DeckLayer | DeckLayer[] {
  const label = layer.style.label;
  if (!label || labeled.length === 0 || !at.labelFont) return marks;
  // The layer's opacity rides the text layer's own, once; the paint keeps
  // the label's alpha.
  const text = textSublayer(`${layer.id}:labels${at.suffix}`, labeled, paintedLabel(label, at.tone), at.cellMeters,
    at.windowing, layerOpacity(layer.style.opacity), at.markScale, at.labelFont, at.stack);
  return [marks, text as unknown as DeckLayer];
}

/** One build's label attachment: each layer's marks with its prepared
 * labels over them, ranked in the build's one overlap test. */
export function labelAttachment<L extends Labelled>(build: LabelLook & {
  prepare: (layer: L, label: LabelStyle, windowing: LiveWindowing | null) => LabeledFeature[];
  stacks: Map<string, LabelStack>;
}) {
  return (layer: L, marks: unknown, cellMeters: number | null | undefined, windowing: LiveWindowing | null,
    suffix: string) => withLabelLayer(layer, marks as DeckLayer,
    layer.style.label ? build.prepare(layer, layer.style.label, windowing) : [],
    { ...build, cellMeters, windowing, suffix, stack: build.stacks.get(layer.id) });
}
