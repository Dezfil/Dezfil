import { engineRefusal } from "@/lib/query/engine-message";
import { namedSql } from "@/lib/query/named-sql";
import type { DatasetScope } from "@/lib/query/access";
import { ApiError } from "@/lib/api/errors";
import { boundedEvaluation, isOutOfMemory } from "@/lib/query/bounded";
import { wrappable } from "@/lib/query/compile";
import { naturalBreakValues } from "./natural-breaks";
import { niceBreaks } from "./nice-breaks";

// Re-exported so break consumers (and tests) keep one import site.
export { niceBreaks } from "./nice-breaks";
import type { ContinuousFill, FillPaint, RgbaColor, SizeScale } from "./style";
import {
  sequentialColors,
  categoricalColors,
  paletteByName,
  continuousStops,
  rampStopColor,
  rampColors,
  DEFAULT_SEQUENTIAL,
  DEFAULT_CATEGORICAL,
} from "./palettes";
import { getCustomPalette } from "@/lib/metadata/palettes";

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Distinct categories to color individually before falling back to "other". */
const MAX_CATEGORIES = 10;
/** Default classes in a numeric ramp: five, so existing behavior is
 * unchanged unless a class count is asked for. */
const DEFAULT_CLASSES = 5;
const MIN_CLASSES = 2;
const MAX_CLASSES = 12;
/** Natural breaks cluster a bounded, seeded sample so cost stays flat at any
 * table size; quantile and equal intervals stay exact (plan: decision 2). */
const NATURAL_SAMPLE_ROWS = 2000;

export type ClassifyMethod =
  | "quantile"
  | "equal"
  | "natural"
  | "categorical"
  | "continuous";

/** Column facts nice rounding needs: integer-typed, and the data extent. */
async function columnMeta(
  conn: Conn,
  sub: string,
  col: string,
): Promise<{ integer: boolean; lo: number; hi: number }> {
  const described = await conn.runAndReadAll(
    `DESCRIBE SELECT ${col} AS v FROM ${sub}`,
  );
  const type = String(described.getRowObjects()[0]?.column_type ?? "");
  const integer = /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT)$/i.test(
    type,
  );
  const extent = await conn.runAndReadAll(
    `SELECT min(${col}::DOUBLE) AS lo, max(${col}::DOUBLE) AS hi
     FROM ${sub} WHERE ${col} IS NOT NULL`,
  );
  const row = extent.getRowObjects()[0] as { lo: unknown; hi: unknown };
  return {
    integer,
    lo: row?.lo == null ? NaN : Number(row.lo),
    hi: row?.hi == null ? NaN : Number(row.hi),
  };
}

export interface ClassifyOptions {
  /** Palette name from the catalogue; kind must match the method. */
  palette?: string;
  /** Number of classes for numeric ramps (clamped to a sane range). */
  classes?: number;
  /** Apply the palette back-to-front. */
  reversed?: boolean;
  /** A numeric ramp's colors in place of its palette's, order and any
   * reversal already applied: a layer's own stored colors, classified with
   * when the palette it names no longer exists. The fill keeps the name. */
  colors?: { stops: RgbaColor[]; positions?: number[] };
}

/** Whether a palette of this kind can be resolved now: the curated
 * catalogue, or (for numeric ramps) a saved custom palette. */
export function paletteAvailable(name: string, kind: "sequential" | "categorical"): boolean {
  if (paletteByName(name, kind)) return true;
  return kind === "sequential" && getCustomPalette(name) !== null;
}

function resolvePalette(
  name: string | undefined,
  kind: "sequential" | "categorical",
): string {
  const fallback = kind === "sequential" ? DEFAULT_SEQUENTIAL : DEFAULT_CATEGORICAL;
  if (name === undefined) return fallback;
  if (!paletteByName(name, kind)) {
    throw new ApiError(
      "invalid_request",
      `Unknown ${kind} palette "${name}".`,
      400,
    );
  }
  return name;
}

interface ResolvedRamp {
  palette: string;
  stops: RgbaColor[];
  positions?: number[];
}

/**
 * A ramp for a numeric fill: the curated catalogue first, then the saved
 * custom palettes — unknown names stay rejected. Reversal is applied
 * here so every consumer bakes identical colors.
 */
function resolveRamp(
  name: string | undefined,
  reversed: boolean,
  colors?: ClassifyOptions["colors"],
): ResolvedRamp {
  if (colors) {
    return { palette: name ?? DEFAULT_SEQUENTIAL, stops: colors.stops, positions: colors.positions };
  }
  if (name !== undefined && !paletteByName(name, "sequential")) {
    const custom = getCustomPalette(name);
    if (!custom) {
      throw new ApiError(
        "invalid_request",
        `Unknown sequential palette "${name}".`,
        400,
      );
    }
    const ordered = reversed ? [...custom.stops].reverse() : custom.stops;
    return {
      palette: name,
      stops: ordered.map((s) => rampStopColor(s.color)),
      positions: ordered.map((s) =>
        reversed ? 1 - s.position : s.position,
      ),
    };
  }
  const palette = resolvePalette(name, "sequential");
  return { palette, stops: continuousStops(palette, reversed) };
}

/**
 * Class colors for a classed ramp: curated palettes keep their published
 * per-count sets (upstream-exact — no regression); custom palettes
 * sample their gradient evenly.
 */
function classRampColors(
  name: string | undefined,
  count: number,
  reversed: boolean,
  colors?: ClassifyOptions["colors"],
): { palette: string; colors: RgbaColor[] } {
  if (colors || (name !== undefined && !paletteByName(name, "sequential"))) {
    const { palette, stops, positions } = resolveRamp(name, reversed, colors);
    return { palette, colors: rampColors(stops, positions, count) };
  }
  const palette = resolvePalette(name, "sequential");
  return { palette, colors: sequentialColors(count, palette, reversed) };
}

function classCount(classes: number | undefined): number {
  if (classes === undefined) return DEFAULT_CLASSES;
  const n = Math.round(classes);
  if (!Number.isFinite(n) || n < MIN_CLASSES || n > MAX_CLASSES) {
    throw new ApiError(
      "invalid_request",
      `classes must be between ${MIN_CLASSES} and ${MAX_CLASSES}.`,
      400,
    );
  }
  return n;
}

/**
 * Compute a data-driven fill for a layer's attribute (spec: data-driven fill).
 * Numeric → quantile or equal-interval breaks (skewed data must not collapse
 * into one class); categorical → distinct-value colors from the curated
 * palette. Runs on the hardened query engine.
 */
export async function classifyFill(
  scope: DatasetScope,
  sql: string,
  attribute: string,
  method: ClassifyMethod,
  options: ClassifyOptions = {},
  signal?: AbortSignal,
): Promise<FillPaint> {
  return boundedEvaluation(async (conn) => {
    const sub = `(${wrappable(await namedSql(conn, sql))}) AS q`;
    const col = ident(attribute);
    const reversed = options.reversed === true;

    if (method === "continuous") {
      const { palette, stops, positions } = resolveRamp(
        options.palette,
        reversed,
        options.colors,
      );
      let lo: number;
      let hi: number;
      let mean: number;
      try {
        const reader = await conn.runAndReadAll(
          `SELECT min(${col}::DOUBLE) AS lo, max(${col}::DOUBLE) AS hi,
                  avg(${col}::DOUBLE) AS mean
           FROM ${sub} WHERE ${col} IS NOT NULL`,
        );
        const row = reader.getRowObjects()[0] as {
          lo: unknown;
          hi: unknown;
          mean: unknown;
        };
        lo = row?.lo == null ? NaN : Number(row.lo);
        hi = row?.hi == null ? NaN : Number(row.hi);
        mean = row?.mean == null ? NaN : Number(row.mean);
      } catch (error) {
        const refusal = engineRefusal(error);
        if (refusal) throw refusal;
        if (error instanceof ApiError) throw error;
        // The memory budget is the boundary's outcome, not a type problem.
        if (isOutOfMemory(error)) throw error;
        throw new ApiError(
          "invalid_request",
          `Column "${attribute}" is not numeric; use categorical coloring instead.`,
          400,
        );
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        throw new ApiError(
          "invalid_request",
          `Column "${attribute}" has no numeric values to color by.`,
          400,
        );
      }
      const paint: ContinuousFill = {
        type: "continuous",
        attribute,
        palette,
        ...(reversed ? { reversed } : {}),
        domain: [lo, hi],
        stops,
        ...(positions ? { positions } : {}),
      };
      // Diverging palettes start centered on the field's mean; the builder
      // reveals the center control for exactly these.
      if (
        paletteByName(palette, "sequential")?.group === "diverging" &&
        Number.isFinite(mean)
      ) {
        paint.center = Math.min(hi, Math.max(lo, mean));
      }
      return paint;
    }

    if (method === "quantile" || method === "equal" || method === "natural") {
      const classes = classCount(options.classes);
      let breaks: number[];
      try {
        breaks =
          method === "quantile"
            ? await quantileBreaks(conn, sub, col, classes)
            : method === "equal"
              ? await equalBreaks(conn, sub, col, classes)
              : await naturalBreaks(conn, sub, col, classes);
      } catch (error) {
        const refusal = engineRefusal(error);
        if (refusal) throw refusal;
        if (error instanceof ApiError) throw error;
        if (isOutOfMemory(error)) throw error;
        throw new ApiError(
          "invalid_request",
          `Column "${attribute}" is not numeric; use categorical coloring instead.`,
          400,
        );
      }
      if (breaks.length === 0) {
        throw new ApiError(
          "invalid_request",
          `Column "${attribute}" has no numeric values to classify.`,
          400,
        );
      }
      // Dedup breaks so low-cardinality data yields distinct classes only,
      // then round to nice values — the stored break IS the shown break.
      const unique = [...new Set(breaks)].sort((a, b) => a - b);
      const nice = niceBreaks(unique, await columnMeta(conn, sub, col));
      const { palette, colors } = classRampColors(
        options.palette,
        nice.length + 1,
        reversed,
        options.colors,
      );
      return {
        type: "quantile" as const,
        attribute,
        palette,
        ...(nice.length + 1 === classes ? {} : { classes }),
        method,
        ...(reversed ? { reversed } : {}),
        breaks: nice,
        colors,
      };
    }

    // categorical
    const palette = resolvePalette(options.palette, "categorical");
    const reader = await conn.runAndReadAll(
      `SELECT ${col}::VARCHAR AS v, count(*) AS n FROM ${sub}
       WHERE ${col} IS NOT NULL
       GROUP BY 1 ORDER BY n DESC LIMIT ${MAX_CATEGORIES}`,
    );
    const values = reader.getRowObjects().map((r) => String(r.v));
    if (values.length === 0) {
      throw new ApiError(
        "invalid_request",
        `Column "${attribute}" has no values to color by.`,
        400,
      );
    }
    const colors = categoricalColors(values.length, palette, reversed);
    const other = { r: 120, g: 130, b: 150, a: 0.55 };
    return {
      type: "categorical" as const,
      attribute,
      palette,
      ...(reversed ? { reversed } : {}),
      map: values.map((value, i) => ({ value, color: colors[i] })),
      other,
    };
  }, { scope, signal });
}

/**
 * Resolve a size scale for a layer's attribute: the attribute's value range
 * over the effective result — the same source of truth fill classification
 * uses, so filters are respected — mapped onto the requested pixel range.
 * Runs on the hardened query engine.
 */
export async function computeSizeScale(
  scope: DatasetScope,
  sql: string,
  attribute: string,
  range: [number, number],
  signal?: AbortSignal,
): Promise<SizeScale> {
  return boundedEvaluation(async (conn) => {
    const sub = `(${wrappable(await namedSql(conn, sql))}) AS q`;
    const col = ident(attribute);
    let lo: number;
    let hi: number;
    try {
      const reader = await conn.runAndReadAll(
        `SELECT min(${col}::DOUBLE) AS lo, max(${col}::DOUBLE) AS hi
         FROM ${sub} WHERE ${col} IS NOT NULL`,
      );
      const row = reader.getRowObjects()[0] as { lo: unknown; hi: unknown };
      // min/max over an empty result are NULL — and Number(null) is 0, so
      // convert nulls to NaN to hit the "no values" rejection below.
      lo = row?.lo == null ? NaN : Number(row.lo);
      hi = row?.hi == null ? NaN : Number(row.hi);
    } catch (error) {
      const refusal = engineRefusal(error);
      if (refusal) throw refusal;
      if (error instanceof ApiError) throw error;
      if (isOutOfMemory(error)) throw error;
      throw new ApiError(
        "invalid_request",
        `Column "${attribute}" is not numeric; sizes need a numeric attribute.`,
        400,
      );
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new ApiError(
        "invalid_request",
        `Column "${attribute}" has no numeric values to size by.`,
        400,
      );
    }
    return { attribute, domain: [lo, hi], range };
  }, { scope, signal });
}

type Conn = import("@duckdb/node-api").DuckDBConnection;

/** Interior quantile cut points → classes - 1 breaks. */
async function quantileBreaks(
  conn: Conn,
  sub: string,
  col: string,
  classes: number,
): Promise<number[]> {
  const qs = Array.from({ length: classes - 1 }, (_, i) => (i + 1) / classes);
  const reader = await conn.runAndReadAll(
    `SELECT quantile_cont(${col}::DOUBLE, [${qs.join(", ")}]) AS q FROM ${sub}
     WHERE ${col} IS NOT NULL`,
  );
  // DuckDB LIST values arrive as { items: [...] }.
  const raw = reader.getRowObjects()[0]?.q as
    | { items?: unknown[] }
    | unknown[]
    | null;
  const list = Array.isArray(raw) ? raw : (raw?.items ?? []);
  return list.map((n) => Number(n)).filter((n) => Number.isFinite(n));
}

/** Natural (Fisher–Jenks) boundaries over a bounded, seeded sample. */
async function naturalBreaks(
  conn: Conn,
  sub: string,
  col: string,
  classes: number,
): Promise<number[]> {
  const reader = await conn.runAndReadAll(
    `SELECT ${col}::DOUBLE AS v FROM ${sub}
     WHERE ${col} IS NOT NULL
     USING SAMPLE reservoir(${NATURAL_SAMPLE_ROWS} ROWS) REPEATABLE (2006)`,
  );
  const values = reader
    .getRowObjects()
    .map((r) => Number(r.v))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  return naturalBreakValues(values, classes);
}

/** Evenly spaced interior boundaries between min and max → classes - 1 breaks. */
async function equalBreaks(
  conn: Conn,
  sub: string,
  col: string,
  classes: number,
): Promise<number[]> {
  const reader = await conn.runAndReadAll(
    `SELECT min(${col}::DOUBLE) AS lo, max(${col}::DOUBLE) AS hi FROM ${sub}
     WHERE ${col} IS NOT NULL`,
  );
  const row = reader.getRowObjects()[0] as { lo: unknown; hi: unknown };
  const lo = Number(row?.lo);
  const hi = Number(row?.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) return [lo];
  return Array.from(
    { length: classes - 1 },
    (_, i) => lo + ((i + 1) * (hi - lo)) / classes,
  );
}
