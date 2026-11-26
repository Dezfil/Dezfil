import type { Layer as DeckLayer } from "@deck.gl/core";
import type { LabeledFeature } from "@/lib/style/deck-style";
import { layerOpacity } from "@/lib/style/deck-style";
import type { LayerStyle } from "@/lib/style/style";
import type { LabelStack } from "./label-collision";
import { textSublayer, type LiveWindowing } from "./text-sublayer";

/**
 * A layer's marks with its labels drawn above them, out of the canvas under
 * the decomposition rule: the one place a feature layer's labels are given
 * their face and laid over their marks. Tiled layers attach theirs per tile,
 * in the tiled layer.
 */
export function withLabelLayer(
  layer: { id: string; style: Pick<LayerStyle, "label" | "opacity"> },
  marks: DeckLayer,
  labeled: LabeledFeature[],
  at: {
    /** An aggregated cell's ground size, which its labels scale with. */
    cellMeters: number | null | undefined;
    windowing: LiveWindowing | null;
    /** The marks' id suffix, which the labels' id follows. */
    suffix: string;
    markScale: number;
    /** The surface's label face once it has loaded; no labels before it. */
    labelFont: string | null;
    stack: LabelStack | undefined;
  },
): DeckLayer | DeckLayer[] {
  const label = layer.style.label;
  if (!label || labeled.length === 0 || !at.labelFont) return marks;
  const text = textSublayer(`${layer.id}:labels${at.suffix}`, labeled, label, at.cellMeters, at.windowing,
    layerOpacity(layer.style.opacity), at.markScale, at.labelFont, at.stack);
  return [marks, text as unknown as DeckLayer];
}
