import { namedSql } from "@/lib/query/named-sql";
import type { DatasetScope } from "@/lib/query/access";
import { boundedEvaluation } from "@/lib/query/bounded";
import { effectiveSql } from "@/lib/query/compile";
import { inspectLayerGeometry } from "@/lib/layer-geometry";
import { isAggregated, isOdViz, type LayerFilter } from "@/lib/viz";
import { isLiveKind } from "@/lib/live-filters";
import type { Layer } from "@/lib/metadata/maps";
import { layerEvaluation } from "@/lib/query/context";


/**
 * A layer's current data extent, computed where the data lives.
 *
 * The browser can answer this for itself whenever it holds the layer's
 * features whole. It cannot for a tiled layer: those features never reach
 * it entire — only the tiles the viewport happens to have loaded — so an
 * extent taken from them would depend on where the user was looking. That
 * is the case this exists for.
 *
 * The query is the layer's own, refined by every constraint in force, the
 * same composition the render and the widget values use. Empty is a
 * distinct outcome from a failure: filtering everything away is a normal
 * thing to do, and it must not read as a broken extent.
 */

/** Quote an identifier for DuckDB — each query module keeps its own, the
 * established shape in this tree. */
function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** [west, south, east, north] — the shape tiled bounds already use. */
export type ExtentBox = [number, number, number, number];

export type LayerExtent =
  | { kind: "extent"; box: ExtentBox }
  | { kind: "empty" };

/**
 * The layer's stored filters, with any range or time filter the caller has
 * restated REPLACED by the caller's version.
 *
 * This is the load-bearing part. A delegated filter's stored bounds are
 * the settled ones; the canvas is enforcing the *current* ones, and the
 * caller passes those. Appending instead of replacing would AND the two —
 * a timeline moved from January to February would query January AND
 * February, find nothing, and report empty while February is on screen.
 *
 * Only range and time are replaced, and only by their own kind on their
 * own field: a category selection is a genuinely additional constraint,
 * not a new value for an existing one.
 */
function composeFilters(
  stored: LayerFilter[],
  extra: LayerFilter[],
): LayerFilter[] {
  const restated = new Set(
    extra.filter(isLiveKind).map((f) => `${f.kind}:${f.field}`),
  );
  const keep = stored.filter(
    (f) => !(isLiveKind(f) && restated.has(`${f.kind}:${f.field}`)),
  );
  return [...keep, ...extra];
}

export async function layerExtent(
  scope: DatasetScope,
  layer: Layer,
  /** Constraints the canvas is enforcing — a reader's timeline window,
   * widget selections, the current bounds of a delegated filter. A range
   * or time entry REPLACES the layer's stored filter on that field. */
  extra: LayerFilter[] = [],
  signal?: AbortSignal,
): Promise<LayerExtent> {
  scope = layerEvaluation(scope, layer);
  const inspection = await inspectLayerGeometry(scope, layer.sql, signal);
  // Which column holds the geometry that is actually drawn: an aggregation
  // computes its own cells, an origin→destination viz builds its line, and
  // everything else draws the base result's geometry. The same choice the
  // render path makes, for the same reason — measuring the base column
  // under an aggregation would measure the wrong shapes.
  const aggregated = isAggregated(layer.viz);
  const geomName = aggregated
    ? "geometry"
    : isOdViz(layer.viz)
      ? "__od"
      : inspection.geometryColumn;
  if (!geomName) return { kind: "empty" };
  const geom = ident(geomName);

  return boundedEvaluation(async (conn) => {
    const sub = `(${effectiveSql(
      {
        sql: await namedSql(conn, layer.sql),
        filters: composeFilters(layer.filters, extra),
        viz: layer.viz,
      },
      inspection.geometryColumn,
    )}) AS q`;
    // ST_Extent is the SCALAR box of one geometry; ST_Extent_Agg is the
    // aggregate over many. Using the scalar here returns the first row's
    // own box — a wrong answer that looks like a right one, which is
    // exactly what the unconstrained case caught.
    const reader = await conn.runAndReadAll(
      `SELECT ST_XMin(e) AS w, ST_YMin(e) AS s, ST_XMax(e) AS e2, ST_YMax(e) AS n
       FROM (SELECT ST_Extent_Agg(${geom}) AS e FROM ${sub}
             WHERE ${geom} IS NOT NULL)`,
    );
    const row = reader.getRowObjects()[0] as {
      w: unknown;
      s: unknown;
      e2: unknown;
      n: unknown;
    };
    // No rows survived the constraints: the aggregate over nothing is
    // NULL, and so is every bound read off it. The null check has to come
    // BEFORE the numeric one — Number(null) is 0, a perfectly finite
    // number, so an empty result would otherwise report a real extent at
    // the origin.
    const raw = [row?.w, row?.s, row?.e2, row?.n];
    if (raw.some((v) => v === null || v === undefined)) {
      return { kind: "empty" };
    }
    const box = raw.map(Number) as ExtentBox;
    if (!box.every((n) => Number.isFinite(n))) return { kind: "empty" };
    return { kind: "extent", box };
  }, { signal, scope });
}
