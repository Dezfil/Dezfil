import { namedSql } from "@/lib/query/named-sql";
import type { DatasetScope } from "@/lib/query/access";
import { ApiError } from "@/lib/api/errors";
import { boundedEvaluation, EvaluationCancelled } from "@/lib/query/bounded";
import { effectiveSql, wrappable } from "@/lib/query/compile";
import { inspectLayerGeometry } from "@/lib/layer-geometry";
import type { Layer } from "@/lib/metadata/maps";
import { isAggregated, AGG_VALUE, AGG_COUNT, type LayerViz } from "@/lib/viz";
import { layerEvaluation } from "@/lib/query/context";
import { cappedText, cappedValue } from "@/lib/query/value-ceiling";

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** The three field families: they decide the filter control and
 * the picker badge. Time covers date/timestamp column types. */
export type FieldKind = "numeric" | "time" | "text";

export interface LayerField {
  name: string;
  type: string;
  /** Numeric fields can be quantile-classified; all fields can be categorical. */
  numeric: boolean;
  kind: FieldKind;
}

const NUMERIC_TYPE = /^(DOUBLE|FLOAT|REAL|DECIMAL|(U?(TINY|SMALL|BIG|HUGE)?INT))/;
const TIME_TYPE = /^(DATE|TIMESTAMP)/;

export function fieldKind(columnType: string): FieldKind {
  if (NUMERIC_TYPE.test(columnType)) return "numeric";
  if (TIME_TYPE.test(columnType)) return "time";
  return "text";
}

export interface LayerFieldsResult {
  /** Columns of the effective result — what fills and tooltips can use. An
   * aggregated layer exposes exactly its aggregate value and count. */
  styling: LayerField[];
  /** Columns of the layer's own SQL result — what filters apply to. */
  filterable: LayerField[];
  /** Geometry columns of the layer's own SQL result, in SELECT order —
   * what origin→destination endpoints can map to. */
  geometryColumns: string[];
}

export async function layerFields(
  scope: DatasetScope,
  layer: Layer,
  signal?: AbortSignal,
): Promise<LayerFieldsResult> {
  const described = await describeBase(scope, layer, signal);
  return withStyling(described, layer.viz);
}

function withStyling(
  described: { fields: LayerField[]; geometryColumns: string[] },
  viz: LayerViz,
): LayerFieldsResult {
  const filterable = described.fields;
  const styling = isAggregated(viz)
    ? [
        { name: "value", type: "DOUBLE", numeric: true, kind: "numeric" as const },
        { name: "count", type: "BIGINT", numeric: true, kind: "numeric" as const },
      ]
    : filterable;
  return { styling, filterable, geometryColumns: described.geometryColumns };
}

/**
 * The schema a write validates against — the result as the request would
 * leave it. When it cannot be resolved (the table is gone, the SQL
 * errors), a write introducing references is refused with the state
 * named rather than validated blind; bounded outcomes (timeout, memory,
 * cancellation) stay themselves.
 */
export async function fieldsForWrite(
  scope: DatasetScope,
  sql: string,
  viz: LayerViz,
  signal?: AbortSignal,
): Promise<LayerFieldsResult> {
  try {
    return withStyling(await describeBase(scope, { sql } as Layer, signal), viz);
  } catch (error) {
    if (error instanceof EvaluationCancelled || (error instanceof ApiError && error.code !== "sql_error")) {
      throw error;
    }
    throw new ApiError(
      "column_unavailable",
      "The layer's result schema could not be resolved, so the column references this write introduces cannot be validated. Repair the layer's SQL (or its table) first.",
      400,
    );
  }
}

/** Non-geometry columns of the layer's own SQL result — what filters apply to. */
export async function baseFields(
  scope: DatasetScope,
  layer: Layer,
  signal?: AbortSignal,
): Promise<LayerField[]> {
  return (await describeBase(scope, layer, signal)).fields;
}

async function describeBase(
  scope: DatasetScope,
  layer: Layer,
  signal?: AbortSignal,
): Promise<{ fields: LayerField[]; geometryColumns: string[] }> {
  scope = layerEvaluation(scope, layer);
  return boundedEvaluation(async (conn) => {
    const sub = `(${wrappable(await namedSql(conn, layer.sql))}) AS q`;
    const described = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${sub}`);
    const columns = (
      described.getRowObjects() as unknown as {
        column_name: string;
        column_type: string;
      }[]
    ).map((c) => ({ name: c.column_name, type: c.column_type }));
    return {
      fields: columns
        .filter((c) => !c.type.startsWith("GEOMETRY"))
        .map((c) => ({
          name: c.name,
          type: c.type,
          numeric: NUMERIC_TYPE.test(c.type),
          kind: fieldKind(c.type),
        })),
      geometryColumns: columns
        .filter((c) => c.type.startsWith("GEOMETRY"))
        .map((c) => c.name),
    };
  }, { signal, scope });
}

/** Distinct values shown when seeding a value-set filter. */
const MAX_STAT_VALUES = 50;

/** Bars in a filter's distribution histogram. */
export const DISTRIBUTION_BINS = 40;

export type FieldStats =
  | {
      field: string;
      kind: "numeric";
      numeric: true;
      min: number | null;
      max: number | null;
      /** Arithmetic mean over non-null values (spec the ramp's
       * distribution header). */
      mean: number | null;
      /** Row counts over equal bins across [min, max]; empty when the
       * extent is missing or a single value. */
      bins: number[];
    }
  | {
      field: string;
      kind: "time";
      numeric: false;
      /** ISO-8601 without timezone — the values as stored. */
      min: string | null;
      max: string | null;
      bins: number[];
    }
  | {
      field: string;
      kind: "text";
      numeric: false;
      values: string[];
      truncated: boolean;
    };

type QueryConnection = Parameters<Parameters<typeof boundedEvaluation>[0]>[0];

/** Numeric field stats — extent, mean, distribution — over a subquery. */
async function numericFieldStats(
  conn: QueryConnection,
  sub: string,
  field: string,
): Promise<FieldStats> {
  const col = ident(field);
  const expr = `${col}::DOUBLE`;
  const reader = await conn.runAndReadAll(
    `SELECT min(${expr}) AS lo, max(${expr}) AS hi, avg(${expr}) AS mean
     FROM ${sub} WHERE ${col} IS NOT NULL`,
  );
  const row = reader.getRowObjects()[0] as {
    lo: unknown;
    hi: unknown;
    mean: unknown;
  };
  const lo = Number(row?.lo);
  const hi = Number(row?.hi);
  const avg = Number(row?.mean);
  const min = Number.isFinite(lo) ? lo : null;
  const max = Number.isFinite(hi) ? hi : null;
  return {
    field,
    kind: "numeric" as const,
    numeric: true as const,
    min,
    max,
    mean: Number.isFinite(avg) ? avg : null,
    bins: await distribution(conn, sub, expr, min, max),
  };
}

/** Row counts over equal bins of a numeric expression's [lo, hi]. */
async function distribution(
  conn: QueryConnection,
  sub: string,
  expr: string,
  lo: number | null,
  hi: number | null,
): Promise<number[]> {
  if (lo === null || hi === null || !(hi > lo)) return [];
  const step = (hi - lo) / DISTRIBUTION_BINS;
  const reader = await conn.runAndReadAll(
    `SELECT least(floor((${expr} - (${lo})) / (${step})), ${DISTRIBUTION_BINS - 1})::INT AS b,
            count(*) AS n
     FROM ${sub} WHERE ${expr} IS NOT NULL
     GROUP BY b`,
  );
  const bins = new Array<number>(DISTRIBUTION_BINS).fill(0);
  for (const row of reader.getRowObjects() as { b: unknown; n: unknown }[]) {
    const i = Number(row.b);
    if (Number.isInteger(i) && i >= 0 && i < DISTRIBUTION_BINS) {
      bins[i] = Number(row.n);
    }
  }
  return bins;
}

/**
 * Seed data for a filter control: extent and distribution for numeric and
 * time fields, distinct values (bounded, by frequency) for text. Computed on
 * the layer's own result — the unfiltered extent — so controls always show
 * the full range (filters; kinds, distributions).
 */
export async function layerFieldStats(
  scope: DatasetScope,
  layer: Layer,
  field: string,
  signal?: AbortSignal,
): Promise<FieldStats> {
  scope = layerEvaluation(scope, layer);
  // An aggregated layer styles value/count — computed by the aggregation,
  // absent from the base result. Their distribution comes from the
  // effective query, the same values classification sees.
  if (
    isAggregated(layer.viz) &&
    (field === AGG_VALUE || field === AGG_COUNT)
  ) {
    const inspection = await inspectLayerGeometry(scope, layer.sql, signal);
    return boundedEvaluation(async (conn) => {
      const sub = `(${effectiveSql(
        { sql: await namedSql(conn, layer.sql), filters: layer.filters, viz: layer.viz },
        inspection.geometryColumn,
      )}) AS q`;
      return numericFieldStats(conn, sub, field);
    }, { signal, scope });
  }
  const fields = await baseFields(scope, layer, signal);
  const target = fields.find((f) => f.name === field);
  if (!target) {
    throw new ApiError(
      "invalid_request",
      `The layer's result has no field "${field}".`,
      400,
    );
  }
  return boundedEvaluation(async (conn) => {
    const sub = `(${wrappable(await namedSql(conn, layer.sql))}) AS q`;
    const col = ident(field);
    if (target.kind === "numeric") {
      return numericFieldStats(conn, sub, field);
    }
    if (target.kind === "time") {
      // Extent as ISO for the control, as epoch seconds for the bins —
      // one convention (naive/as-stored) at both ends, so nothing shifts.
      const ts = `CAST(${col} AS TIMESTAMP)`;
      const reader = await conn.runAndReadAll(
        `SELECT strftime(min(${ts}), '%Y-%m-%dT%H:%M:%S') AS lo_iso,
                strftime(max(${ts}), '%Y-%m-%dT%H:%M:%S') AS hi_iso,
                epoch(min(${ts})) AS lo, epoch(max(${ts})) AS hi
         FROM ${sub} WHERE ${col} IS NOT NULL`,
      );
      const row = reader.getRowObjects()[0] as {
        lo_iso: unknown;
        hi_iso: unknown;
        lo: unknown;
        hi: unknown;
      };
      const lo = Number(row?.lo);
      const hi = Number(row?.hi);
      return {
        field,
        kind: "time" as const,
        numeric: false as const,
        min: row?.lo_iso == null ? null : String(row.lo_iso),
        max: row?.hi_iso == null ? null : String(row.hi_iso),
        bins: await distribution(
          conn,
          sub,
          `epoch(${ts})`,
          Number.isFinite(lo) ? lo : null,
          Number.isFinite(hi) ? hi : null,
        ),
      };
    }
    // Each value returned is held to the per-value ceiling; the one read
    // past them only says the list is truncated.
    const text = `${col}::VARCHAR`;
    const reader = await conn.runAndReadAll(
      `SELECT ${cappedText(text, "v")}, count(*) AS n FROM ${sub}
       WHERE ${col} IS NOT NULL
       GROUP BY ${text} ORDER BY n DESC, ${text} LIMIT ${MAX_STAT_VALUES + 1}`,
    );
    const rows = reader.getRowObjects();
    return {
      field,
      kind: "text" as const,
      numeric: false as const,
      values: rows.slice(0, MAX_STAT_VALUES).map((r) => cappedValue(r, "v")),
      truncated: rows.length > MAX_STAT_VALUES,
    };
  }, { signal, scope });
}
