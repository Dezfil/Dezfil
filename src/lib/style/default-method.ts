import { AGG_COUNT, AGG_VALUE, isAggregated, type LayerViz } from "@/lib/viz";

/**
 * The method a new classed colour starts on, shared by the Style panel and
 * the server's own fill for cells. Pure: it reads the visualization and
 * the field's type, nothing else.
 */

/** The engine's whole-number types: the integers, signed or not. */
export const WHOLE_NUMBER_TYPE = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT)$/i;

/**
 * Whether the values a colour over this field classifies are whole
 * numbers. On cells the count always is, and the value is when the cells
 * count; a sum, average, minimum or maximum is cast to a double and is
 * not, whatever the field list calls it. Any other field is whole when
 * its column type is an integer type.
 */
export function wholeNumberField(viz: LayerViz, field: { name: string; type?: string }): boolean {
  if (isAggregated(viz) && (field.name === AGG_VALUE || field.name === AGG_COUNT)) {
    return field.name === AGG_COUNT || viz.aggregate.fn === "count";
  }
  return WHOLE_NUMBER_TYPE.test(field.type ?? "");
}

/** Natural breaks for whole numbers, whose counts pile up on a few small
 * values that equal-count classes cannot tell apart; Quantile for any
 * other number. */
export function automaticMethod(wholeNumbers: boolean): "natural" | "quantile" {
  return wholeNumbers ? "natural" : "quantile";
}
