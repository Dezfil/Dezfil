import type { Layer } from "@/lib/metadata/maps";
import { stableJson } from "@/lib/metadata/history";
import type { FillPaint } from "@/lib/style/style";
import { isAggregated, type LayerViz } from "@/lib/viz";
import type { UpdateLayerFields } from "./layer-admission";

/**
 * The lifetime of a classed paint's whole-number fact across a layer
 * write. Computing classes sets the fact from the result it classified; a
 * paint the caller sends is the caller's statement, its fact included; and
 * a paint the server recomputes in the write carries its own fresh fact.
 * What remains are the stored paints the write keeps as they were: when
 * the write changes the SQL or the aggregation, the result those paints
 * classified may no longer be the one they describe, so their fact is
 * cleared and their legend falls back to the boundary form until their
 * classes are next computed.
 */

/** A paint without its whole-number fact; the same paint when it has none. */
export function withoutWholeNumbers(paint: FillPaint): FillPaint {
  if (paint.type !== "quantile" || paint.wholeNumbers === undefined) return paint;
  const rest = { ...paint };
  delete rest.wholeNumbers;
  return rest;
}

/** What decides an aggregate value's type: whether the layer aggregates,
 * and with which function over which attribute. */
function aggregation(viz: LayerViz): string {
  return isAggregated(viz) ? stableJson(viz.aggregate) : "none";
}

/**
 * The fields that clear the fact from the stored paints a write keeps,
 * to fold into the write; empty when the write changes neither the SQL nor
 * the aggregation, or keeps no paint with a fact. `fields` is the write as
 * derived, the server's recomputed aggregate fill included; `sent` says
 * which members the caller sent, before any derivation.
 */
export function clearedPaintFacts(
  layer: Layer,
  fields: UpdateLayerFields,
  sent: { style: boolean; viz: boolean },
): UpdateLayerFields {
  const sqlChanged = fields.sql !== undefined && fields.sql !== layer.sql;
  const aggregationChanged =
    aggregation(fields.viz ?? layer.viz) !== aggregation(layer.viz);
  if (!sqlChanged && !aggregationChanged) return {};
  const out: UpdateLayerFields = {};

  // The fill and the outline, active or dormant under an aggregation.
  if (!sent.style) {
    const style = fields.style ?? layer.style;
    const fill = withoutWholeNumbers(style.fill);
    const strokeBy = style.strokeBy && withoutWholeNumbers(style.strokeBy);
    if (fill !== style.fill || strokeBy !== style.strokeBy) {
      out.style = { ...style, fill, ...(strokeBy ? { strokeBy } : {}) };
    }
  }

  // The cells' fill: a viz in the write was either sent or derived with a
  // fresh classification, so only a stored one kept whole can go stale.
  if (fields.viz === undefined && !sent.viz && isAggregated(layer.viz) && layer.viz.fill) {
    const fill = withoutWholeNumbers(layer.viz.fill);
    if (fill !== layer.viz.fill) out.viz = { ...layer.viz, fill };
  }
  return out;
}
