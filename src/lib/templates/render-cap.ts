import { liveFilters } from "@/lib/live-filters";
import type { DatasetScope } from "@/lib/query/access";
import { boundedEvaluation } from "@/lib/query/bounded";
import { effectiveSql, OD_GEOMETRY, wrappable } from "@/lib/query/compile";
import { namedSql } from "@/lib/query/named-sql";
import { NUMERIC_SETTINGS } from "@/lib/settings/numeric";
import { isAggregated, isOdViz, type LayerFilter, type LayerViz } from "@/lib/viz";

/**
 * A template's layers and the render cap.
 *
 * A template's layer has no tile road, so its read-only view draws it
 * inline or answers the cap refusal. Every layer of a template is held at
 * admission to the render cap's default, not to this instance's value:
 * the rule is the same for every instance, a template admitted anywhere
 * draws inline wherever the cap is left at its default, and an admin who
 * sets a lower cap sees the view's refusal for a larger layer rather than
 * the template refused. Large data goes in as an aggregation or a slice.
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
