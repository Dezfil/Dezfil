import { namedSql } from "@/lib/query/named-sql";
import { recordedInputs } from "@/lib/query/evaluation-inputs";
import { tiledRender, errored } from "./tiles/render";
import type { TileAccess } from "./tiles/access";
import type { DatasetScope } from "./query/access";
import { limits } from "./limits";
import { ApiError } from "./api/errors";
import { DatasetUnavailable, safeEngineMessage } from "./query/engine-message";
import { boundedEvaluation, EvaluationCancelled } from "./query/bounded";
import { effectiveSql, wrappable, OD_GEOMETRY } from "./query/compile";
import type { Layer } from "./metadata/maps";
import { AGG_ELEV, isAggregated, isOdViz, type LayerFilter } from "./viz";
import { publishedFieldsFor, type PublishedMapContext } from "./publish/published-fields";
import { renderCapRefusal, templateRenderBytesRefusal, templateRenderCapRefusal } from "./layer-render-copy";
import { isTemplateDocumentId } from "./templates/ids";
import { renderFilters } from "./layer-render-filters";
import { privateRenderFields } from "./layer-render-fields";
import { layerEvaluation } from "./query/context";
import { buildInlineAnswer } from "./query/render-features";
import { renderBytesExceeded } from "./query/render-budget";

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
 * published field set. Absent (every builder lane), properties carry what
 * the layer and its map read, by the private field policy. */
export interface RenderLayerOpts {
  published?: PublishedMapContext;
  tileAccess?: TileAccess;
}

/**
 * Render data for one layer. Failures are returned, not thrown: a layer whose
 * table was deleted (or whose result exceeds the render cap or the byte limit
 * where no other road carries it) enters a visible errored state while the
 * rest of the map keeps working.
 */
export async function renderLayer(
  scope: DatasetScope,
  layer: Layer,
  signal?: AbortSignal,
  opts: RenderLayerOpts = {},
): Promise<LayerRenderData> {
  scope = layerEvaluation(scope, layer);
  try {
    return await boundedEvaluation(async (conn, bounds) => {
      const compiledSql = await namedSql(conn, layer.sql);
      const aggregated = isAggregated(layer.viz);
      const rawSub = `(${wrappable(compiledSql)}) AS q`;
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
      // Properties carry the non-geometry columns the audience reads —
      // additional geometry columns (O→D endpoints and beyond) stay out of
      // tooltips. A builder render carries what the layer and its map use
      // (the private policy); a published-audience render carries the
      // effective published field set. Aggregated results are exactly
      // their computed columns on every audience.
      const nonGeometry = columns.filter(
        (c) => !c.type.startsWith("GEOMETRY"),
      );
      const names = nonGeometry.map((c) => c.name);
      const carried = new Set(
        opts.published
          ? publishedFieldsFor(layer, opts.published, names)
          : privateRenderFields(layer, names),
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
        : nonGeometry.filter((c) => carried.has(c.name));
      const publishedFields = opts.published
        ? { publishedFields: propsCols.map((c) => c.name) }
        : null;
      const subFor = (fs: LayerFilter[]) =>
        `(${effectiveSql(
          { sql: compiledSql, filters: fs, viz: layer.viz },
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
      let { featureCount, geometryType } = await summarize(sub);
      // A template's layer has no tile road: it draws within the limits or
      // answers their refusal, and its copy tiles as any map does.
      const template = isTemplateDocumentId(layer.id);
      const tileable = layer.viz.type === "points" && !template;
      // Simple features over a limit switch to tiles — live filtering rides
      // the tiles. `overBytes` names the byte limit when the count fits.
      const tiles = (overBytes?: number) =>
        tiledRender(
          layer,
          filters,
          rawGeomCol,
          names,
          featureCount,
          geometryType,
          {
            liveFiltered,
            published: opts.published !== undefined,
            tileAccess: opts.tileAccess,
            inputs: recordedInputs(conn),
            ...(overBytes === undefined ? null : { overBytes }),
          },
        );
      // A layer whose undelegated result cannot ship falls back to every
      // filter in SQL: correct results, settled on release, just not live.
      const applyEveryFilter = async () => {
        filters = layer.filters;
        liveFiltered = false;
        sub = subFor(filters);
        ({ featureCount, geometryType } = await summarize(sub));
      };
      if (featureCount > limits.renderCapFeatures) {
        if (tileable) return tiles();
        if (liveFiltered) await applyEveryFilter();
      }
      if (featureCount > limits.renderCapFeatures) {
        // The cap error remains for what still cannot render: an over-cap
        // aggregation, the heatmap, which draws raw points by design, and
        // the O→D types, which apply to the standard rendering path only.
        return errored(
          layer.id,
          "render_cap_exceeded",
          template && layer.viz.type === "points"
            ? templateRenderCapRefusal(featureCount, limits.renderCapFeatures)
            : renderCapRefusal(
                { aggregated, od, vizType: layer.viz.type },
                featureCount,
                limits.renderCapFeatures,
              ),
        );
      }

      // The answer is built while it is read, under Bytes drawn per layer:
      // an answer over the limit is refused before it is complete, never
      // after (see query/render-features). Null is that refusal.
      const inline = async () => {
        try {
          return await buildInlineAnswer(
            conn,
            { from: sub, geometry: geom, properties: propsCols.map((c) => c.name) },
            (features, count) => ({
              layerId: layer.id,
              ok: true,
              mode: "inline" as const,
              geojson: { type: "FeatureCollection", features },
              featureCount: count,
              geometryType,
              ...(liveFiltered ? { liveFiltered } : null),
              ...publishedFields,
            }),
            limits.renderCapBytes,
            bounds.interrupted,
          );
        } catch (error) {
          if (error instanceof ApiError && error.code === "render_bytes_exceeded") return null;
          throw error;
        }
      };
      const drawn = await inline();
      if (drawn) return drawn;
      // Over the byte limit with the count within its cap, a layer takes
      // the road it takes over the cap.
      if (tileable) return tiles(limits.renderCapBytes);
      if (liveFiltered) {
        await applyEveryFilter();
        const settled = await inline();
        if (settled) return settled;
      }
      return errored(
        layer.id,
        "render_bytes_exceeded",
        template && layer.viz.type === "points"
          ? templateRenderBytesRefusal(limits.renderCapBytes)
          : renderBytesExceeded(limits.renderCapBytes).message,
      );
    }, { signal, scope });
  } catch (error) {
    // A departed caller gets nothing, not an errored layer: the envelope
    // is for states a viewer will look at, and nobody is looking.
    if (error instanceof EvaluationCancelled) throw error;
    return errored(
      layer.id,
      error instanceof ApiError ? error.code : "sql_error",
      error instanceof Error
        ? error instanceof DatasetUnavailable ? error.message : safeEngineMessage(error.message)
        : "The layer could not render.",
    );
  }
}
