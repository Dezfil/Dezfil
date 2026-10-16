import { liveFilters } from "@/lib/live-filters";
import type { DatasetScope } from "@/lib/query/access";
import { boundedEvaluation } from "@/lib/query/bounded";
import { effectiveSql, OD_GEOMETRY, wrappable } from "@/lib/query/compile";
import { namedSql } from "@/lib/query/named-sql";
import { NUMERIC_SETTINGS } from "@/lib/settings/numeric";
import { isAggregated, isOdViz, type LayerFilter, type LayerViz } from "@/lib/viz";
import type { PrivateMapContext } from "@/lib/field-dependencies";
import { layerAnswer, type LayerRenderData } from "@/lib/layer-render";
import type { Layer } from "@/lib/metadata/maps";

/**
 * A template's layers and the render limits.
 *
 * A template's layer has no tile road, so its read-only view draws it
 * inline or answers the limit's refusal. Every layer of a template is held
 * at admission to the defaults of the render cap and of Bytes drawn per
 * layer, not to this instance's values: the rule is the same for every
 * instance, a template admitted anywhere draws inline wherever the limits
 * are left at their defaults, and a lower limit set on an instance shows as
 * the view's refusal for a larger layer rather than the template refused.
 * A version installed before stays as it is: it opens and copies, and any
 * excess shows in its layer's render. Large data goes in as an aggregation
 * or a slice.
 *
 * The count is the render's: the layer's SQL refined by the filters the
 * render applies on the server, aggregated by its look, counting the rows
 * with a geometry; when that is over the cap and some filters were left to
 * the canvas, counted again with every filter applied, as the render falls
 * back to.
 */

/** The render cap's default, in features. */
export function templateRenderCap(): number {
  return NUMERIC_SETTINGS.find((setting) => setting.key === "renderCapFeatures")!.defaultValue;
}

/** Bytes drawn per layer's default. */
export function templateRenderBytes(): number {
  return NUMERIC_SETTINGS.find((setting) => setting.key === "renderCapBytes")!.defaultValue;
}

/**
 * The layer's render as its view will answer it, under the defaults of the
 * render cap and Bytes drawn per layer rather than this instance's values:
 * the same result, properties and filter fallback, with the map's timeline
 * and widgets given, since the version being admitted has no map to read
 * yet. Its answer is built under the byte limit and let go; what matters is
 * whether it drew. A refusal of the evaluation itself is thrown.
 */
export function templateLayerRender(
  scope: DatasetScope,
  layer: Layer,
  context: PrivateMapContext,
  signal?: AbortSignal,
): Promise<LayerRenderData> {
  return layerAnswer(scope, layer, signal, { context, limits: { features: templateRenderCap(), bytes: templateRenderBytes() } });
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The features the layer's inline render draws, as the render counts
 * them; `dockedField` is the field of the map's timeline when docked on
 * this layer. */
export async function drawnFeatures(
  scope: DatasetScope,
  layer: { sql: string; viz: LayerViz; filters: LayerFilter[] },
  dockedField: string | null,
  cap: number,
  signal?: AbortSignal,
): Promise<number> {
  return boundedEvaluation(async (conn) => {
    const sql = await namedSql(conn, layer.sql);
    const described = await conn.runAndReadAll(`DESCRIBE SELECT * FROM (${wrappable(sql)}) AS q`);
    const geometry = (described.getRowObjects() as unknown as { column_name: string; column_type: string }[])
      .find((column) => column.column_type.startsWith("GEOMETRY"));
    // A result without a geometry was refused before it was counted.
    if (!geometry) return 0;
    const drawn = ident(isAggregated(layer.viz) ? "geometry" : isOdViz(layer.viz) ? OD_GEOMETRY : geometry.column_name);
    const count = async (filters: LayerFilter[]) => {
      const counted = await conn.runAndReadAll(
        `SELECT count(*) AS n FROM (${effectiveSql({ sql, filters, viz: layer.viz }, geometry.column_name)}) AS q WHERE ${drawn} IS NOT NULL`,
      );
      return Number((counted.getRowObjects()[0] as { n: bigint | number }).n);
    };
    const live = new Set<LayerFilter>(liveFilters(layer.viz, layer.filters, dockedField));
    const first = await count(layer.filters.filter((filter) => !live.has(filter)));
    return first > cap && live.size > 0 ? count(layer.filters) : first;
  }, { signal, scope });
}
