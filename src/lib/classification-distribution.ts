import { ApiError } from "@/lib/api/errors";
import { boundedEvaluation, isOutOfMemory } from "@/lib/query/bounded";
import { wrappable } from "@/lib/query/compile";
import type { DatasetScope } from "@/lib/query/access";
import { layerEvaluation } from "@/lib/query/context";
import { engineRefusal } from "@/lib/query/engine-message";
import { namedSql } from "@/lib/query/named-sql";
import type { Layer } from "@/lib/metadata/maps";
import { wholeNumberColumn } from "@/lib/style/classify";
import { layerEffectiveSql } from "./layer-preview";
import { DISTRIBUTION_BINS, type FieldStats } from "./layer-fields";

/**
 * The distribution a classification sees, for the classed histogram: the
 * values of the layer's effective result (filters applied, the aggregate
 * value on cells), counted in bins equal on the axis they are drawn on.
 * Skewed positive values, whose mean lies in the lowest quarter of their
 * extent, are drawn on a logarithmic axis so that small classes stand
 * apart; everything else on a linear one. The answer carries the bin
 * edges, so no reader re-derives them, and the whole-number fact the
 * classifier would find.
 */

export type ClassificationDistribution = Extract<FieldStats, { kind: "numeric" }> & {
  distribution: "classification";
  /** How the bins and the histogram's positions are spaced. */
  axis: "linear" | "log";
  /** Bin boundaries on the value scale, low to high, one more than the
   * bins; a value equal to an inner edge counts in the bin above it, and
   * the maximum in the last bin. Empty when the bins are. */
  edges: number[];
  /** Whether the field is a whole-number type in the effective result. */
  wholeNumbers: boolean;
};

/** The axis rule: logarithmic when every value is positive, the extent is
 * not a single value and the mean lies in its lowest quarter. */
export function distributionAxis(min: number, max: number, mean: number): "linear" | "log" {
  return min > 0 && max > min && mean < min + (max - min) / 4 ? "log" : "linear";
}

/** Bin edges equal on the axis between the extent's ends, which are kept
 * exactly as they are. */
export function distributionEdges(
  min: number,
  max: number,
  axis: "linear" | "log",
  bins = DISTRIBUTION_BINS,
): number[] {
  const to = axis === "log" ? Math.log : (v: number) => v;
  const from = axis === "log" ? Math.exp : (v: number) => v;
  const lo = to(min);
  const step = (to(max) - lo) / bins;
  return Array.from({ length: bins + 1 }, (_, k) =>
    k === 0 ? min : k === bins ? max : from(lo + k * step),
  );
}

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** A number as a literal the engine reads back exactly. */
function literal(n: number): string {
  return `${String(n)}::DOUBLE`;
}

export async function classificationDistribution(
  scope: DatasetScope,
  layer: Layer,
  field: string,
  signal?: AbortSignal,
): Promise<ClassificationDistribution> {
  const sql = await layerEffectiveSql(scope, layer, signal);
  return boundedEvaluation(async (conn) => {
    const sub = `(${wrappable(await namedSql(conn, sql))}) AS q`;
    const col = ident(field);
    const value = `${col}::DOUBLE`;
    let wholeNumbers: boolean;
    let row: { lo: unknown; hi: unknown; mean: unknown };
    try {
      wholeNumbers = await wholeNumberColumn(conn, sub, col);
      const reader = await conn.runAndReadAll(
        `SELECT min(${value}) AS lo, max(${value}) AS hi, avg(${value}) AS mean
         FROM ${sub} WHERE ${col} IS NOT NULL`,
      );
      row = reader.getRowObjects()[0] as typeof row;
    } catch (error) {
      const refusal = engineRefusal(error);
      if (refusal) throw refusal;
      if (error instanceof ApiError) throw error;
      if (isOutOfMemory(error)) throw error;
      throw new ApiError(
        "invalid_request",
        `The classification distribution needs a numeric field of the layer's result; "${field}" is not one.`,
        400,
      );
    }
    const lo = row?.lo == null ? NaN : Number(row.lo);
    const hi = row?.hi == null ? NaN : Number(row.hi);
    const avg = row?.mean == null ? NaN : Number(row.mean);
    const min = Number.isFinite(lo) ? lo : null;
    const max = Number.isFinite(hi) ? hi : null;
    const mean = Number.isFinite(avg) ? avg : null;
    const base = { field, kind: "numeric" as const, numeric: true as const, min, max, mean };
    if (min === null || max === null || mean === null || !(max > min)) {
      return { ...base, bins: [], distribution: "classification", axis: "linear", edges: [], wholeNumbers };
    }
    const axis = distributionAxis(min, max, mean);
    const edges = distributionEdges(min, max, axis);
    // Each value counts in the bin whose edges hold it, compared against
    // the very edges the answer returns.
    const inner = edges.slice(1, -1);
    const bin = `CASE ${inner.map((e, k) => `WHEN ${value} < ${literal(e)} THEN ${k}`).join(" ")} ELSE ${inner.length} END`;
    const reader = await conn.runAndReadAll(
      `SELECT ${bin} AS b, count(*) AS n FROM ${sub} WHERE ${col} IS NOT NULL GROUP BY b`,
    );
    const bins = new Array<number>(edges.length - 1).fill(0);
    for (const r of reader.getRowObjects() as { b: unknown; n: unknown }[]) {
      bins[Number(r.b)] = Number(r.n);
    }
    return { ...base, bins, distribution: "classification", axis, edges, wholeNumbers };
  }, { signal, scope: layerEvaluation(scope, layer) });
}
