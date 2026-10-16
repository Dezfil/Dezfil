import { isAggregated, type LayerFilter, type LayerViz } from "@/lib/viz";
import type { LayerStyle } from "@/lib/style/style";
import type { MapTimeline } from "@/lib/timeline";
import type { MapWidget } from "@/lib/widgets";
import {
  publishedFunctionalCore,
  publishedLayerFields,
  publishedSignature,
  type FieldLayerConfig,
  type PublishedMapContext,
} from "@/lib/field-dependencies";

/**
 * The effective published field set. "Publish this map" means "publish what
 * the reader can see": every published response that carries feature data
 * carries exactly this set as properties, nothing more. The derivation is
 * the published policy of the field-dependency module, which the inline
 * render, the tile build, the published boundary's selection check and the
 * publish surface's statement all read, so they cannot drift from one
 * another. This module phrases it for the publication's call sites.
 */

export {
  AUTO_TOOLTIP_FIELDS,
  autoInteractionFields,
  type PublishedMapContext,
} from "@/lib/field-dependencies";

export interface PublishedProjectionInput {
  layerId: string;
  style: LayerStyle;
  viz: LayerViz;
  filters: LayerFilter[];
  /** Hover fields; null = automatic. */
  tooltip: string[] | null;
  /** Click fields; null = automatic. */
  popup: string[] | null;
  /** The author's explicit published-field list; null = derived default. */
  publishedFields: string[] | null;
  /** The map's docked timeline, whichever layer it targets. */
  timeline: MapTimeline | null;
  /** The map's widgets, whichever layers they read. */
  widgets: MapWidget[];
  /** Whether widgets ship with the published view at all. */
  widgetsPublished: boolean;
  /** Non-geometry result columns of the layer's SQL, in result order. */
  columns: string[];
}

/** The layer configuration the projection reads. `Layer` satisfies it. */
export type PublishedLayerConfig = FieldLayerConfig;

/** The derivation, phrased for call sites that hold a layer and its map. */
export function publishedFieldsFor(
  layer: PublishedLayerConfig,
  map: PublishedMapContext,
  columns: string[],
): string[] {
  return publishedLayerFields(layer, map, columns);
}

/** The derivation over one flat input. */
export function effectivePublishedFields(
  input: PublishedProjectionInput,
): string[] {
  return publishedLayerFields(
    {
      id: input.layerId,
      style: input.style,
      viz: input.viz,
      filters: input.filters,
      tooltip: input.tooltip,
      popup: input.popup,
      publishedFields: input.publishedFields,
    },
    input,
    input.columns,
  );
}

/** What the publish surface states, per layer: the effective
 * set with the fields the published map cannot render without marked, the
 * mode, and what an explicit list could add. The UI merely renders this;
 * the statement is the API's. */
export interface PublishedFieldsStatement {
  mode: "derived" | "list";
  fields: { name: string; required: boolean }[];
  /** Every field an explicit list could name — the result's non-geometry
   * columns. Empty on aggregated layers: their computed columns are the
   * whole wire, and there is nothing to add. */
  available: string[];
  /** The author's raw explicit list, verbatim (null = derived). Editors
   * write against this, never against the effective set — a listed field
   * that is currently also required must survive unrelated edits (review
   * round one). */
  list: string[] | null;
}

export function publishedFieldsStatement(
  layer: PublishedLayerConfig,
  map: PublishedMapContext,
  columns: string[],
): PublishedFieldsStatement {
  const effective = publishedFieldsFor(layer, map, columns);
  if (isAggregated(layer.viz)) {
    return {
      mode: "derived",
      fields: effective.map((name) => ({ name, required: true })),
      available: [],
      list: layer.publishedFields,
    };
  }
  const core = publishedFunctionalCore(layer, map);
  return {
    mode: layer.publishedFields === null ? "derived" : "list",
    fields: effective.map((name) => ({ name, required: core.has(name) })),
    available: columns,
    list: layer.publishedFields,
  };
}

/**
 * Canonical signature of every projection input except the result
 * columns. The tile fingerprint folds this string, and the published tile
 * authorization recomputes it synchronously from the same inputs: one
 * function, two call sites, no drift.
 */
export function publishedFieldsSignature(
  layer: PublishedLayerConfig,
  map: PublishedMapContext,
): string {
  return publishedSignature(layer, map);
}
