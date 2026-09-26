import {
  labelPosition,
  labelText,
  type LabeledFeature,
} from "@/lib/style/deck-style";
import type { LabelStyle } from "@/lib/style/style";

/**
 * A labelled layer's text data (extracted from `MapCanvas` by ` `).
 *
 * It lives in its own module for three reasons, all of them load-bearing:
 * the canvas is one of the oversized modules the decomposition rule keeps
 * shrinking; the derivation's invalidation rules need tests, which a
 * module-local function cannot have; and the perf harness had to keep a
 * hand-written replica of it, which could drift from the code it claimed
 * to measure.
 *
 * Note the tiled road filters equivalently but separately, inside its own
 * per-tile callback in `MapCanvas` — it is not on the per-tick path this
 * module exists to make cheap, so deliberately left it alone.
 */

/** Inline features that actually get a label: text and a place to put it. */
export function labelableFeatures(
  geojson: unknown,
  label: LabelStyle,
): LabeledFeature[] {
  const fc = geojson as { features?: LabeledFeature[] };
  const text = labelText(label);
  return (fc?.features ?? []).filter(
    (f) => text(f) !== null && labelPosition(f) !== null,
  );
}

/**
 * Everything about a label style that can change *which* features are kept
 * or *what* they say — the rest of the style must stay out.
 *
 * Only the attribute qualifies: the text of a feature reads that property,
 * or `value` when no attribute is set, and a feature's position never
 * consults the style at all. Size, colour and halo change how a label looks,
 * and they already ride deck's own update triggers — putting them here would
 * rebuild on exactly the ticks this module exists to make cheap, which is
 * the defect (` `) rather than the fix.
 *
 * A missing attribute, an explicitly null one and an empty string all mean
 * "label off `value`" to the text derivation, so all three collapse to the
 * same signature here on purpose.
 */
export function labelShape(label: LabelStyle): string {
  return label.attribute ?? "";
}

/** One layer's derived label set, held with the inputs it came from. */
export interface LabelBase {
  key: unknown;
  shape: string;
  features: LabeledFeature[];
}

/** Per-layer store, keyed by layer id — the shape the canvas's sibling
 * caches (heat, O→D, icon, cluster) already use. */
export type LabelBases = Record<string, LabelBase>;

/** What a layer must offer to be labelled: an identity to key on, and the
 * feature data. Structural on purpose — this module has no business knowing
 * what else a rendered layer carries. */
export interface LabelSubject {
  id: string;
  geojson: unknown;
}

/**
 * The canvas's label store: read a layer's label data, and release what the
 * last build did not ask for.
 *
 * Reclaiming is **observed, not predicted** — `sweep` drops whatever `read`
 * did not touch during the build it follows. Predicting instead (keeping
 * every layer that still has a label and inline features) pins entries the
 * canvas will never read again: a labelled layer switched to a heatmap or a
 * cluster keeps both, and a hidden layer keeps both, yet none of those
 * branches asks for label data. Worse, a predicate would have to restate
 * the canvas's branch conditions and would drift silently the day they
 * change. Whatever the branches do, only what was read survives.
 */
export interface LabelStore {
  read(layer: LabelSubject, label: LabelStyle): LabeledFeature[];
  /** Drop every entry that `read` did not touch since the previous sweep.
   * Called after every full build, never before it. Empty stores do no work. */
  sweep(): void;
}

export function createLabelStore(): LabelStore {
  const bases: LabelBases = {};
  const touched = new Set<string>();
  let hasEntries = false;
  return {
    read: (layer, label) => {
      hasEntries = true;
      touched.add(layer.id);
      return cachedLabelFeatures(bases, layer.id, layer.geojson, label);
    },
    sweep: () => {
      if (!hasEntries) return;
      hasEntries = false;
      for (const id of Object.keys(bases)) {
        if (!touched.has(id)) delete bases[id];
        else hasEntries = true;
      }
      touched.clear();
    },
  };
}

/**
 * The derived set for a layer, reused while the feature data and the
 * labelled attribute are both unchanged.
 *
 * Identity is the point: deck.gl keys a layer's `data` by identity, so
 * handing it an equal-but-fresh array invalidates and re-uploads every glyph
 * attribute. Returning the *same* array across an appearance tick is what
 * makes the drag cheap.
 */
export function cachedLabelFeatures(
  bases: LabelBases,
  layerId: string,
  geojson: unknown,
  label: LabelStyle,
): LabeledFeature[] {
  const shape = labelShape(label);
  const base = bases[layerId];
  if (base?.key !== geojson || base?.shape !== shape) {
    bases[layerId] = {
      key: geojson,
      shape,
      features: labelableFeatures(geojson, label),
    };
  }
  return bases[layerId].features;
}
