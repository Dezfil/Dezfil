import { tiledRender, errored } from "./tiles/render";
import type { TileAccess } from "./tiles/access";
import type { DatasetScope } from "./query/access";
import { limits } from "./limits";
import { ApiError } from "./api/errors";
import { stripStatementQuote } from "./query/engine-message";
import { boundedEvaluation, EvaluationCancelled } from "./query/bounded";
import { effectiveSql, wrappable, OD_GEOMETRY } from "./query/compile";
import type { Layer } from "./metadata/maps";
import { AGG_ELEV, isAggregated, isOdViz, type LayerFilter } from "./viz";
import { publishedFieldsFor, type PublishedMapContext } from "./publish/published-fields";
import { renderCapRefusal } from "./layer-render-copy";
import { renderFilters } from "./layer-render-filters";

function ident(s: string): string { return `"${s.replace(/"/g, '""')}"`; }

/** How a tiled layer stands: preparing in the background, ready
 * with a tile URL template, or — as an errored layer — failed. */
export interface LayerTiles {
  state: "building" | "ready";
  /** Present when ready: a template with {z}/{x}/{y} placeholders. */
  url?: string;
  /** Present when ready: [west, south, east, north] of the tiled data. */
  bounds?: [number, number, number, number];
  minZoom?: number;
  maxZoom?: number;
  builtAt?: string;
}

/** Canonical geometry family of one successful render result. Multi-geometry
 * variants collapse into their simple family; empty or unsupported results
 * are unknown rather than guessed from the column's generic DuckDB type. */
export type LayerRenderGeometryType =
  | "POINT"
  | "LINESTRING"
  | "POLYGON"
  | "MIXED"
  | null;

export interface LayerRenderData {
  layerId: string;
  ok: boolean;
  /** Inline carries the GeoJSON itself; tiled points at served tiles. */
  mode?: "inline" | "tiled";
  /** Present when ok and inline: a GeoJSON FeatureCollection of the result. */
  geojson?: unknown;
  featureCount?: number;
  /** Canonical family of the effective result, independent of render mode. */
  geometryType?: LayerRenderGeometryType;
  /** Present when ok and tiled. */
  tiles?: LayerTiles;
  /** True when the data ships without the layer's live filters
   * — the client enforces them on the GPU. Absent = every filter is
   * already applied in the SQL. */
  liveFiltered?: boolean;
  /** Present on published-audience renders: the effective
   * published field set the properties carry — what the assembly filters
   * the interaction lists through, so the response never names a field
   * the wire lacks. */
  publishedFields?: string[];
  /** Present when not ok: why the layer cannot render right now. */
  error?: { code: string; message: string };
}

function renderGeometryType(types: string[]): LayerRenderGeometryType {
  if (types.length === 0) return null;
  const families = types.map((type) => {
    if (type === "POINT" || type === "MULTIPOINT") return "POINT" as const;
    if (type === "LINESTRING" || type === "MULTILINESTRING") {
      return "LINESTRING" as const;
    }
    if (type === "POLYGON" || type === "MULTIPOLYGON") {
      return "POLYGON" as const;
    }
    return null;
  });
  if (families.some((family) => family === null)) return null;
  return families.every((family) => family === families[0])
    ? families[0]
    : "MIXED";
}

/** Options for a published-audience render: with the map's
 * context supplied, feature properties carry exactly the layer's effective
 * published field set. Absent — every builder lane — properties carry every
 * non-geometry column, as always. */
export interface RenderLayerOpts {
  scope?: DatasetScope;
  published?: PublishedMapContext;
  tileAccess?: TileAccess;
}

/**
 * Render data for one layer. Failures are returned, not thrown: a layer whose
 * table was deleted (or whose result exceeds the render cap) enters a visible
 * errored state while the rest of the map keeps working (spec: Layers).
 */
export async function renderLayer(
  layer: Layer,
  signal?: AbortSignal,
  opts: RenderLayerOpts = {},
): Promise<LayerRenderData> {
  try {
    return await boundedEvaluation(async (conn) => {
      const aggregated = isAggregated(layer.viz);
      const rawSub = `(${wrappable(layer.sql)}) AS q`;
      const described = await conn.runAndReadAll(
        `DESCRIBE SELECT * FROM ${rawSub}`,
      );
      const columns = (
        described.getRowObjects() as unknown as {
          column_name: string;
          column_type: string;
        }[]
      ).map((c) => ({ name: c.column_name, type: c.column_type }));
      const rawGeomCol = columns.find((c) => c.type.startsWith("GEOMETRY"));
      if (!rawGeomCol) {
        return errored(
          layer.id,
          "invalid_request",
          "This layer's query no longer returns a geometry column.",
        );
      }

      // The effective query is the layer's SQL refined by its filters, then
      // aggregated by its viz. Live filters stay out of the query and ship
      // to the client instead — the cap applies to what is actually drawn,
      // which for a live-filtered layer is the undelegated result (the dock
      // decision, generalized).
      let filters = renderFilters(layer);
      let liveFiltered = filters.length !== layer.filters.length;
      const od = isOdViz(layer.viz);
      const geomName = aggregated
        ? "geometry"
        : od
          ? OD_GEOMETRY
          : rawGeomCol.name;
      const geom = ident(geomName);
      // Properties carry every non-geometry column — additional geometry
      // columns (O→D endpoints and beyond) stay out of tooltips. A
      // published-audience render narrows to the effective published
      // field set instead; aggregated results are already exactly their
      // computed columns on every audience.
      const nonGeometry = columns.filter(
        (c) => !c.type.startsWith("GEOMETRY"),
      );
      const propsCols = aggregated
        ? [
            { name: "value" },
            { name: "count" },
            // The reserved extrusion value rides along when configured;
            // the canvas keeps it out of tooltips.
            ...(isAggregated(layer.viz) && layer.viz.elevation
              ? [{ name: AGG_ELEV }]
              : []),
          ]
        : opts.published
          ? (() => {
              const effective = new Set(
                publishedFieldsFor(
                  layer,
                  opts.published,
                  nonGeometry.map((c) => c.name),
                ),
              );
              return nonGeometry.filter((c) => effective.has(c.name));
            })()
          : nonGeometry;
      const publishedFields = opts.published
        ? { publishedFields: propsCols.map((c) => c.name) }
        : null;
      const subFor = (fs: LayerFilter[]) =>
        `(${effectiveSql(
          { sql: layer.sql, filters: fs, viz: layer.viz },
          rawGeomCol.name,
        )}) AS q`;
      const summarize = async (s: string) => {
        const counted = await conn.runAndReadAll(
          `SELECT ST_GeometryType(${geom}) AS geometry_type, count(*) AS n
           FROM ${s} WHERE ${geom} IS NOT NULL GROUP BY 1`,
        );
        const rows = counted.getRowObjects() as unknown as {
          geometry_type: string;
          n: bigint | number;
        }[];
        return {
          featureCount: rows.reduce((sum, row) => sum + Number(row.n), 0),
          geometryType: renderGeometryType(
            rows.map((row) => String(row.geometry_type)),
          ),
        };
      };

      let sub = subFor(filters);
      let summary = await summarize(sub);
      let { featureCount, geometryType } = summary;
      if (featureCount > limits.renderCapFeatures) {
        // Simple features over the cap switch to tiles — live filtering
        // rides the tiles.
        if (layer.viz.type === "points") {
          return tiledRender(
            layer,
            filters,
            rawGeomCol,
            nonGeometry.map((c) => c.name),
            featureCount,
            geometryType,
            { liveFiltered, published: opts.published !== undefined, tileAccess: opts.tileAccess },
          );
        }
        // A heatmap whose undelegated result cannot ship falls back to
        // every filter in SQL: correct results, settled on release,
        // just not live.
        if (liveFiltered) {
          filters = layer.filters;
          liveFiltered = false;
          sub = subFor(filters);
          summary = await summarize(sub);
          ({ featureCount, geometryType } = summary);
        }
      }
      if (featureCount > limits.renderCapFeatures) {
        // The cap error remains for what still cannot render: an over-cap
        // aggregation, the heatmap, which draws raw points by design, and
        // the O→D types, which apply to the standard rendering path only.
        return errored(
          layer.id,
          "render_cap_exceeded",
          renderCapRefusal(
            { aggregated, od, vizType: layer.viz.type },
            featureCount,
            limits.renderCapFeatures,
          ),
        );
      }

      const propsStruct = propsCols.length
        ? `to_json({${propsCols
            .map((c) => `'${c.name.replace(/'/g, "''")}': ${ident(c.name)}`)
            .join(", ")}})`
        : `'{}'`;
      // Labels anchor non-point features on a server-computed interior
      // point — a client centroid lands outside concave shapes. Delivered
      // as the reserved __anchor property; the canvas keeps it out of
      // tooltips and pop-ups.
      const anchor = `CASE WHEN ST_GeometryType(${geom}) = 'POINT' THEN NULL
              ELSE ST_AsGeoJSON(ST_PointOnSurface(${geom})) END`;
      const geo = await conn.runAndReadAll(
        `SELECT ST_AsGeoJSON(${geom}) AS geometry, ${propsStruct} AS props,
                ${anchor} AS anchor
         FROM ${sub} WHERE ${geom} IS NOT NULL`,
      );
      const features = geo.getRowObjects().map((r) => {
        const properties = JSON.parse(String(r.props)) as Record<
          string,
          unknown
        >;
        if (r.anchor != null) {
          properties.__anchor = (
            JSON.parse(String(r.anchor)) as { coordinates: [number, number] }
          ).coordinates;
        }
        return {
          type: "Feature",
          geometry: JSON.parse(String(r.geometry)),
          properties,
        };
      });

      return {
        layerId: layer.id,
        ok: true,
        mode: "inline" as const,
        geojson: { type: "FeatureCollection", features },
        featureCount: features.length,
        geometryType,
        ...(liveFiltered ? { liveFiltered } : null),
        ...publishedFields,
      };
    }, { signal, scope: opts.scope });
  } catch (error) {
    // A departed caller gets nothing, not an errored layer: the envelope
    // is for states a viewer will look at, and nobody is looking.
    if (error instanceof EvaluationCancelled) throw error;
    return errored(
      layer.id,
      error instanceof ApiError ? error.code : "sql_error",
      error instanceof Error
        ? stripStatementQuote(error.message)
        : "The layer could not render.",
    );
  }
}
