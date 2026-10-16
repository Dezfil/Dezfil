import type { DuckDBConnection, DuckDBListValue, DuckDBStructVector, DuckDBVector } from "@duckdb/node-api";
import { EvaluationCancelled } from "@/lib/api/errors";
import { decodeGeoJSON, geojsonProjection } from "./budget-geojson";
import { quoteIdent } from "./budget-projection";
import { RenderBudget } from "./render-budget";
import { decodeRenderValue, renderValueProjection, type RenderValue } from "./render-values";
import { jsonBytes, type ByteBudget } from "./result-budget";
import { setOwn } from "./set-own";

/** One feature as a layer answer carries it. */
export interface InlineFeature {
  type: "Feature";
  geometry: unknown;
  properties: Record<string, unknown>;
}

/** Where an inline answer's rows come from. */
export interface InlineRows {
  /** A FROM clause yielding the rows, e.g. `(<sql>) AS q`. */
  from: string;
  /** The quoted geometry column of `from`. Rows without one are not drawn. */
  geometry: string;
  /** The property columns in answer order. */
  properties: readonly string[];
  /** Whether each non-point feature carries its label anchor. Layer
   * renders do, by default; other answers pass `false`. */
  anchors?: boolean;
}

/**
 * One row while its feature is built. Each part is charged to the answer's
 * budget as it is read, before the value it measures is converted; the
 * feature's own members around them are the builder's to charge.
 */
export interface InlineRow {
  /** The feature's position in the answer, from zero. */
  readonly index: number;
  readonly budget: ByteBudget;
  /** The row's geometry as GeoJSON, charged. */
  geometry(): unknown;
  /** A non-point geometry's label anchor, not charged: whoever carries it
   * charges it. Undefined for a point, or without anchors. */
  anchor(): unknown;
  /** The value of property column `c`, by its position, charged. */
  value(c: number): unknown;
}

/** Builds one feature of an answer from its row. */
export type FeatureBuilder<F> = (row: InlineRow) => F;

/** The reserved property that carries a non-point feature's label anchor. */
const ANCHOR = "__anchor";
/** `{"type":"Feature","geometry":…,"properties":…}` without its two values. */
const FEATURE_BYTES = jsonBytes({ type: "Feature", geometry: null, properties: null }) - 8;
/** A free budget for the label anchor, a single point charged once read. */
const UNCOUNTED: ByteBudget = { take() {} };

/**
 * A layer's feature: its geometry and the property columns, with the label
 * anchor of a non-point feature under the reserved name unless a column of
 * that name holds its place.
 */
export function layerFeature(rows: InlineRows): FeatureBuilder<InlineFeature> {
  const anchorAt = rows.properties.indexOf(ANCHOR);
  return (row) => {
    const { budget } = row;
    budget.take(FEATURE_BYTES);
    const geometry = row.geometry();
    // Labels anchor non-point features on an interior point computed in
    // the engine; a client centroid lands outside concave shapes. A column
    // of the same name gives its place to the anchor.
    const anchor = row.anchor();
    const entries = rows.properties.length + (anchor !== undefined && anchorAt < 0 ? 1 : 0);
    budget.take(2 + Math.max(0, entries - 1));
    const properties: Record<string, unknown> = {};
    for (let c = 0; c < rows.properties.length; c++) {
      const name = rows.properties[c];
      budget.take(jsonBytes(name) + 1);
      if (c === anchorAt && anchor !== undefined) {
        budget.take(jsonBytes(anchor));
        setOwn(properties, name, anchor);
      } else {
        setOwn(properties, name, row.value(c));
      }
    }
    if (anchor !== undefined && anchorAt < 0) {
      budget.take(jsonBytes(ANCHOR) + 1 + jsonBytes(anchor));
      setOwn(properties, ANCHOR, anchor);
    }
    return { type: "Feature", geometry, properties };
  };
}

/**
 * Reads an answer's features while it is built, admitting every byte of
 * the eventual JSON against the budget before the value it measures is
 * converted. Rows stream from the engine one chunk at a time, so an answer
 * over the limit stops within the chunk that crosses it, and one oversized
 * value is refused while it is still native. Nothing is returned until
 * every feature is admitted. With `take`, at most that many features are
 * read, and `more` says whether the rows held another.
 */
async function readInlineFeatures<F>(
  conn: DuckDBConnection,
  rows: InlineRows,
  budget: RenderBudget,
  interrupted: () => boolean,
  feature: FeatureBuilder<F>,
  take: number,
): Promise<{ features: F[]; more: boolean }> {
  const width = 1 + rows.properties.length;
  const source = `SELECT ${rows.geometry}${rows.properties.map(name => `, ${quoteIdent(name)}`).join("")}
    FROM ${rows.from} WHERE ${rows.geometry} IS NOT NULL`;
  const prepared = await conn.prepare(source);
  let values: RenderValue[];
  try {
    values = rows.properties.map((_, i) => renderValueProjection(quoteIdent(column(i + 1)), prepared.columnType(i + 1)));
  } finally { prepared.destroySync(); }
  const g = quoteIdent(column(0));
  const anchored = rows.anchors !== false
    ? `CASE WHEN ST_GeometryType(${g}) = 'POINT' THEN NULL ELSE ST_PointOnSurface(${g}) END`
    : "CAST(NULL AS GEOMETRY)";
  // Positional names keep generated columns apart from any the layer's SQL
  // returns. The rows are evaluated once; each projection reads them.
  const query = `WITH __dezfil_render_rows(${Array.from({ length: width }, (_, i) => quoteIdent(column(i))).join(", ")}) AS MATERIALIZED (${source})
    SELECT ${point("__dezfil_render_shape")} AS __dezfil_render_point,
      CASE WHEN __dezfil_render_text IS NOT NULL AND NOT regexp_matches(__dezfil_render_text, ${RESPELLED})
        THEN struct_pack(bytes := strlen(__dezfil_render_text), text := __dezfil_render_text) END,
      ${geojsonProjection(`CASE WHEN regexp_matches(__dezfil_render_text, ${RESPELLED}) THEN __dezfil_render_text END`)},
      ${point("__dezfil_render_anchor")} AS __dezfil_render_anchor_point,
      ${geojsonProjection(`CASE WHEN ${plainPoint("__dezfil_render_anchor")} THEN NULL ELSE ST_AsGeoJSON(__dezfil_render_anchor) END`)}
      ${values.map(v => `, ${v.sql}`).join("")}
    FROM (SELECT *,
        ${g} AS __dezfil_render_shape,
        CASE WHEN ${plainPoint(g)} THEN NULL ELSE regexp_replace(CAST(ST_AsGeoJSON(${g}) AS VARCHAR), '\\.0([,\\]])', '\\1', 'g') END AS __dezfil_render_text,
        ${anchored} AS __dezfil_render_anchor
      FROM __dezfil_render_rows)`;
  const features: F[] = [];
  try {
    const result = await conn.stream(query);
    while (true) {
      if (interrupted()) throw new EvaluationCancelled();
      const chunk = await result.fetchChunk();
      if (interrupted()) throw new EvaluationCancelled();
      if (!chunk || chunk.rowCount === 0) break;
      const [points, plain, respelled, anchorPoints, anchors] = Array.from({ length: 5 }, (_, i) => chunk.getColumnVector(i));
      for (let r = 0; r < chunk.rowCount; r++) {
        if (features.length === take) return { features, more: true };
        const index = features.length;
        budget.take(index ? 1 : 0);
        features.push(feature({
          index,
          budget,
          geometry: () => readGeometry(points, plain, respelled, r, budget),
          anchor: () => (readGeometry(anchorPoints, null, anchors, r, UNCOUNTED) as { coordinates: unknown } | null)?.coordinates,
          value: (c) => decodeRenderValue(chunk.getColumnVector(c + 5), r, values[c], budget),
        }));
      }
    }
    return { features, more: false };
  } catch (error) { conn.interrupt(); throw error; }
}

/** A GeoJSON text whose numbers the parser may spell differently: an
 * exponent, or a negative zero. Elsewhere the engine writes each double's
 * shortest exact digits, as JavaScript does, once a whole number's ".0" is
 * dropped, so the text's length is the parsed value's serialized length. */
const RESPELLED = String.raw`'[0-9][eE]|-0[,\]]'`;

/** A two-dimensional, non-empty point with finite coordinates. Conditions
 * nest: the engine evaluates every operand of AND. */
function plainPoint(g: string): string {
  return `CASE WHEN ${g} IS NOT NULL AND ST_GeometryType(${g}) = 'POINT' AND NOT ST_IsEmpty(${g}) AND NOT ST_HasZ(${g}) AND NOT ST_HasM(${g})
    THEN isfinite(ST_X(${g})) AND isfinite(ST_Y(${g})) ELSE false END`;
}

/** Such a point as its two coordinates, which are the numbers its GeoJSON
 * text parses to. */
function point(g: string): string {
  return `CASE WHEN ${plainPoint(g)} THEN [ST_X(${g}), ST_Y(${g})] END`;
}

/** One geometry, from its coordinates, its exact text or its decomposed
 * numbers, whichever the row carries; null without one. */
function readGeometry(points: DuckDBVector, plain: DuckDBVector | null, respelled: DuckDBVector, r: number, budget: ByteBudget): unknown {
  const coordinates = points.getItem(r) as DuckDBListValue | null;
  if (coordinates !== null) {
    const geometry = { type: "Point", coordinates: coordinates.items as number[] };
    budget.take(jsonBytes(geometry));
    return geometry;
  }
  const text = plain as DuckDBStructVector | null;
  if (text?.isItemValid(r)) {
    budget.take(Number(text.entryVectorAt(0).getItem(r)));
    return JSON.parse(text.entryVectorAt(1).getItem(r) as string);
  }
  return decodeGeoJSON(respelled, r, budget);
}

function column(i: number): string {
  return `__dezfil_render_${i}`;
}

/** How an answer's features are built, when not as a layer's. */
export interface InlineShape<F> {
  /** Builds each feature; a layer's feature by default. */
  feature?: FeatureBuilder<F>;
  /** At most this many features; `compose` learns whether the rows held
   * more. Unlimited by default. */
  take?: number;
}

/**
 * Builds a complete inline answer under Bytes drawn per layer. `compose`
 * shapes the answer around its features, their count and whether `take`
 * left rows unread; its smallest envelope is admitted first, at a count of
 * zero, and the rest once the features are known, so the admitted total is
 * exactly the answer's serialized length.
 */
export async function buildInlineAnswer<T, F = InlineFeature>(
  conn: DuckDBConnection,
  rows: InlineRows,
  compose: (features: F[], count: number, more: boolean) => T,
  limit: number,
  interrupted: () => boolean = () => false,
  shape: InlineShape<F> = {},
): Promise<T> {
  const budget = new RenderBudget(limit);
  const envelope = Math.min(jsonBytes(compose([], 0, false)), jsonBytes(compose([], 0, true)));
  budget.take(envelope);
  const feature = shape.feature ?? (layerFeature(rows) as unknown as FeatureBuilder<F>);
  const { features, more } = await readInlineFeatures(conn, rows, budget, interrupted, feature, shape.take ?? Number.POSITIVE_INFINITY);
  budget.take(jsonBytes(compose([], features.length, more)) - envelope);
  return compose(features, features.length, more);
}
