import type { DatasetScope } from "./query/access";
import { namedSql } from "./query/named-sql";
import { boundedEvaluation } from "./query/bounded";
import { effectiveSql, filteredSql } from "./query/compile";
import { inspectLayerGeometry } from "./layer-geometry";
import { baseFields } from "./layer-fields";
import { isAggregated } from "./viz";
import { limits } from "./limits";
import type { Layer } from "./metadata/maps";
import type { SliderPreviewData } from "./slider-preview";
import { layerEvaluation } from "./query/context";
import { buildInlineAnswer } from "./query/render-features";
import { ApiError } from "./api/errors";
import { sliderPreviewBytesRefusal } from "./layer-render-copy";

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** The layer's effective query — SQL, then filters, then aggregation — for
 * consumers outside the render path (classification, previews). */
export async function layerEffectiveSql(
  scope: DatasetScope,
  layer: Layer,
  signal?: AbortSignal,
): Promise<string> {
  scope = layerEvaluation(scope, layer);
  if (!isAggregated(layer.viz)) {
    return effectiveSql(
      { sql: layer.sql, filters: layer.filters, viz: layer.viz },
      null,
    );
  }
  const { geometryColumn } = await inspectLayerGeometry(scope, layer.sql, signal);
  return effectiveSql(
    { sql: layer.sql, filters: layer.filters, viz: layer.viz },
    geometryColumn,
  );
}

/** Base-result attributes the canvas may need while durable layer state stays
 * unchanged. Automatic tooltips are deliberately absent during a preview. */
function sliderPreviewFieldNames(layer: Layer): Set<string> {
  const names = new Set<string>();
  for (const filter of layer.filters) {
    if (filter.kind === "range" || filter.kind === "timerange") {
      names.add(filter.field);
    }
  }
  if (isAggregated(layer.viz) && layer.viz.aggregate.fn !== "count") {
    names.add(layer.viz.aggregate.attribute);
  }
  // Extruded cells re-aggregate their height locally too.
  const elevation = isAggregated(layer.viz) ? layer.viz.elevation : undefined;
  if (elevation && elevation.aggregate.fn !== "count") {
    names.add(elevation.aggregate.attribute);
  }
  if (layer.viz.type === "heatmap" && layer.viz.weight) {
    names.add(layer.viz.weight);
  }
  const paints = [layer.style.fill, layer.style.strokeBy];
  for (const paint of paints) {
    if (paint && paint.type !== "constant") names.add(paint.attribute);
  }
  if (layer.style.pointRadiusBy) names.add(layer.style.pointRadiusBy.attribute);
  if (layer.style.strokeWidthBy) names.add(layer.style.strokeWidthBy.attribute);
  if (layer.style.label?.attribute) names.add(layer.style.label.attribute);
  return names;
}

/**
 * Geometry input used while a human manipulates a query-shaping slider.
 * Range/time filters are intentionally omitted so a local preview can widen as
 * well as narrow; discrete filters remain server-applied. Above the dedicated
 * input budget, a hash-ordered subset stays stable across requests. The
 * answer is built under Bytes drawn per layer as it is read; over it, the
 * preview is refused whole (422 render_bytes_exceeded), and the layer's own
 * render, evaluated when the slider settles, is unaffected.
 */
export async function sliderPreviewData(
  scope: DatasetScope,
  layer: Layer,
  signal?: AbortSignal,
): Promise<SliderPreviewData> {
  scope = layerEvaluation(scope, layer);
  const inspection = await inspectLayerGeometry(scope, layer.sql, signal);
  const base = await baseFields(scope, layer, signal);
  const wanted = sliderPreviewFieldNames(layer);
  const fields = base
    .filter((field) => wanted.has(field.name))
    .map(({ name, kind }) => ({ name, kind }));
  const filters = layer.filters.filter((filter) => filter.kind === "values");
  const geom = ident(inspection.geometryColumn);
  // Aggregation and heatmaps are point visualizations. Plain layers keep
  // their original geometry so range/time fallback previews also work for
  // lines and polygons that cannot use the canvas's point-oriented fast path.
  const geometryPredicate =
    layer.viz.type === "points"
      ? `${geom} IS NOT NULL`
      : `${geom} IS NOT NULL AND ST_GeometryType(${geom}) = 'POINT'`;
  const budget = limits.sliderPreviewRows;
  const bytes = limits.renderCapBytes;

  return boundedEvaluation(async (conn, bounds) => {
    const source = `(${filteredSql(await namedSql(conn, layer.sql), filters)}) AS q`;
    const counted = await conn.runAndReadAll(
      `SELECT count(*) AS n FROM ${source} WHERE ${geometryPredicate}`,
    );
    const sourceCount = Number(counted.getRowObjects()[0]?.n ?? 0);
    const exact = sourceCount <= budget;
    const hashArgs = [
      `ST_AsWKB(${geom})`,
      ...fields.map((field) => ident(field.name)),
    ].join(", ");
    const sampled = `(SELECT ${[geom, ...fields.map((field) => ident(field.name))].join(", ")}
       FROM ${source} WHERE ${geometryPredicate}
       ${exact ? "" : `ORDER BY hash(${hashArgs})`}
       LIMIT ${budget}) AS q`;
    try {
      return await buildInlineAnswer(
        conn,
        { from: sampled, geometry: geom, properties: fields.map((field) => field.name), anchors: false },
        (features, count) => ({
          layerId: layer.id,
          exact,
          sourceCount,
          sampledCount: count,
          budget,
          fields,
          geojson: { type: "FeatureCollection", features },
        }),
        bytes,
        bounds.interrupted,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "render_bytes_exceeded") {
        throw new ApiError("render_bytes_exceeded", sliderPreviewBytesRefusal(bytes), 422);
      }
      throw error;
    }
  }, { scope, signal });
}
