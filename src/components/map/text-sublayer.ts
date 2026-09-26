import { TextLayer } from "@deck.gl/layers";
import { CollisionFilterExtension } from "@deck.gl/extensions";
import type { LabelStyle } from "@/lib/style/style";
import {
  deckLabelProps,
  deckLabelTriggers,
  labelPosition,
  labelText,
  type LabeledFeature,
} from "@/lib/style/deck-style";

import { collisionSizeScale } from "./label-thinning";

/**
 * The measurement seam, inverted now that automatic collision IS the
 * shipped default: the deciding harness sets this flag to measure the
 * counterfactual arms — "always-draw" disables collision, "cap300"
 * applies the fallback's cap — through the real rendering path. Nothing
 * in the product sets it; the gate's verdict is recorded in the
 * verification.
 */
function spikeMode(): "always-draw" | "cap300" | null {
  if (typeof window === "undefined") return null;
  const flag = (window as { __DEZFIL_LABEL_SPIKE__?: unknown })
    .__DEZFIL_LABEL_SPIKE__;
  return flag === "always-draw" || flag === "cap300" ? flag : null;
}

/**
 * The text sublayer for a labeled layer — extracted from MapCanvas as
 * spec at-touch slice, when export mark-pinning gave it a pixel scale to
 * carry. Ids follow the namespaced-by-type discipline. Aggregated cells
 * label in ground meters so the text keeps its proportion of the cell
 * across zoom (the user's size setting scales that proportion);
 * everything else labels in screen pixels. A pixel cap keeps deep
 * zoom-ins from producing banner text.
 *
 * `pixelScale` reaches only the meters branch's pixel CAP. The pixel
 * text size arrives already pinned in `label.size`; the meters size is
 * ground-anchored and invariant by construction; and the halo rim is
 * relative to the glyph, so it follows the text wherever it goes.
 */

/** GPU windowing props for a live-filtered layer,
 * spread into each of its deck layers; `trigger` keys the accessor's
 * update trigger by the dimension signature, so dims coming and going
 * within the fixed slots recompute the attribute without a new layer
 * id. */
export interface LiveWindowing {
  dims: import("@/lib/live-filters").LiveDim[];
  trigger: string;
  props: Record<string, unknown>;
}

export function textSublayer(
  id: string,
  data: LabeledFeature[],
  label: LabelStyle,
  cellMeters?: number | null,
  windowing?: LiveWindowing | null,
  opacity = 1,
  pixelScale = 1,
) {
  const spike = spikeMode();
  // Automatic collision culling: per-layer isolation via the collision group; survival priority
  // comes from the RANK — the data arrives ranked (priority column descending, else feature order),
  // so the accessor maps the index into deck's supported −1000…1000 domain (raw column values can
  // be non-finite or out of range, which the extension clips out of the collision map entirely).
  // Density maps monotonically to the tested footprint. The cap-300 harness arm runs WITHOUT
  // collision — that is the fallback it measures.
  const collide = spike !== "always-draw" && spike !== "cap300";
  const drawn = spike === "cap300" ? data.slice(0, 300) : data;
  // Live-filter windowing carries its own `extensions`; compose, never let one spread overwrite the
  // other (filtered layers silently stopped culling).
  const windowingProps = { ...(windowing?.props ?? {}) } as Record<
    string,
    unknown
  > & { extensions?: unknown[] };
  const windowingExtensions = windowingProps.extensions ?? [];
  delete windowingProps.extensions;
  return new TextLayer<LabeledFeature>({
    id,
    data: drawn,
    extensions: collide
      ? [...windowingExtensions, new CollisionFilterExtension()]
      : windowingExtensions,
    ...(collide
      ? {
          collisionGroup: id,
          collisionTestProps: {
            sizeScale: collisionSizeScale(label.density),
          },
          getCollisionPriority: (
            _f: LabeledFeature,
            { index }: { index: number },
          ) => 1000 - (index / Math.max(1, drawn.length)) * 2000,
        }
      : null),
    getPosition: (f) => labelPosition(f) as [number, number],
    // Labels ride the layer's opacity — at 0 the layer is *gone*, text
    // included (deck layers default to 1 unless told).
    opacity,
    ...deckLabelProps(label),
    ...(cellMeters
      ? {
          sizeUnits: "meters" as const,
          getSize: cellMeters * (label.size / 12),
          // The cap is the one pixel value here: meter-sized text is
          // ground-anchored and invariant by construction, but its
          // ceiling must hold the same OUTPUT size across spaces, so it
          // alone rides the scale.
          sizeMaxPixels: label.size * 4 * pixelScale,
        }
      : null),
    ...windowingProps,
    updateTriggers: {
      ...deckLabelTriggers(label),
      ...(windowing ? { getFilterValue: windowing.trigger } : null),
    },
  } as ConstructorParameters<typeof TextLayer<LabeledFeature>>[0]);
}

/**
 * The tiled branch's per-tile label sublayers (extracted from MapCanvas
 * as at-touch slice). Tiled labels style like every other branch but
 * are EXEMPT from thinning: each tile sees only itself, so a cap or
 * ranking would be per-tile fictions — the panel says so instead.
 */
export function mvtRenderSubLayers<M>(
  label: LabelStyle,
  makeMarks: (props: Record<string, unknown>) => M,
): (props: {
  id: string;
  data: unknown;
}) => M | (M | TextLayer<LabeledFeature>)[] {
  const textFor = labelText(label);
  return (props) => {
    const marks = makeMarks(props as Record<string, unknown>);
    const features = Array.isArray(props.data)
      ? (props.data as LabeledFeature[]).filter(
          (f) => textFor(f) !== null && labelPosition(f) !== null,
        )
      : [];
    if (features.length === 0) return marks;
    return [
      marks,
      new TextLayer<LabeledFeature>({
        ...(props as Record<string, unknown>),
        id: `${props.id}-labels`,
        data: features,
        getPosition: (f: LabeledFeature) =>
          labelPosition(f) as [number, number],
        ...deckLabelProps(label),
        updateTriggers: deckLabelTriggers(label),
      } as ConstructorParameters<typeof TextLayer<LabeledFeature>>[0]),
    ];
  };
}
