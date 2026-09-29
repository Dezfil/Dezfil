import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { namedSql } from "@/lib/query/named-sql";
import { sqlError } from "@/lib/query/engine-message";
import { boundedEvaluation, isOutOfMemory } from "@/lib/query/bounded";
import {
  effectiveSql,
  filteredSql,
  odExportSql,
  wrappable,
} from "@/lib/query/compile";
import { isAggregated, isOdViz } from "@/lib/viz";
import type { Layer } from "@/lib/metadata/maps";
import { ensureTileDirs, tileScratchDir } from "@/lib/tiles/paths";

/**
 * Layer data export: the layer's effective result — SQL, then stored
 * filters, then OD/aggregation, the same compilation every render uses —
 * written to a downloadable file. There is no second query path that
 * could forget the filters; live widget selections and preview transients
 * never enter (stored state only).
 *
 * The write rides the tile build's precedent: user SQL passes the
 * read-only guard, the evaluation runs on the hardened instance through
 * the bounded lane — the interactive timeout, the memory budget, and the
 * caller's departure all interrupt it — and the COPY
 * lands inside the scratch directory, the fence's one writable spot, so
 * this trusted wrapper cannot be steered anywhere else. Cleanup is the
 * caller's on success (stream close) and ours on failure; the boot sweep
 * that clears the scratch covers process loss.
 *
 * Geometry rule: the effective result's first geometry
 * column is the feature geometry — the same first-geometry rule the
 * render path applies — and every other geometry column is serialized to
 * WKT, uniformly across formats, so no supported layer silently loses a
 * column. Rows whose feature geometry is NULL are dropped, matching the
 * inline render and tile paths.
 */

export const LAYER_EXPORT_FORMATS = ["geoparquet", "geojson", "csv"] as const;
export type LayerExportFormat = (typeof LAYER_EXPORT_FORMATS)[number];

export function isLayerExportFormat(
  value: unknown,
): value is LayerExportFormat {
  return LAYER_EXPORT_FORMATS.includes(value as LayerExportFormat);
}

export interface LayerExportFile {
  path: string;
  filename: string;
  contentType: string;
  cleanup: () => Promise<void>;
}

/** The slice of a layer the export consumes — stored state only. */
export type ExportableLayer = Pick<Layer, "name" | "sql" | "filters" | "viz">;

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** A content-disposition-safe download name from a free-text layer name. */
function safeFilename(name: string, ext: string): string {
  const base = name
    .replace(/[^A-Za-z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${base || "layer"}.${ext}`;
}

const EXT: Record<LayerExportFormat, string> = {
  geoparquet: "parquet",
  geojson: "geojson",
  csv: "csv",
};

const CONTENT_TYPE: Record<LayerExportFormat, string> = {
  geoparquet: "application/vnd.apache.parquet",
  geojson: "application/geo+json",
  csv: "text/csv; charset=utf-8",
};

/**
 * Export the layer's effective result into the scratch directory and hand
 * back the file. One bounded evaluation covers the whole thing — guard,
 * geometry resolution, description, and the COPY — so the universal
 * budget is a single wall-clock bound, not a sum of separate ones.
 */
export async function exportLayerResult(
  scope: AccountScope,
  layer: ExportableLayer,
  format: LayerExportFormat,
  signal?: AbortSignal,
): Promise<LayerExportFile> {
  requireAccountScope(scope);
  ensureTileDirs();
  const outFile = path.join(
    tileScratchDir(),
    `export-${randomUUID()}.${EXT[format]}`,
  );

  try {
    await boundedEvaluation(
      async (conn) => {
        requireAccountScope(scope);
        const compiledSql = await namedSql(conn, layer.sql);

        // Aggregation bins over the base result's geometry; resolve it the
        // way the render path does — the first geometry column.
        let baseGeometry: string | null = null;
        if (isAggregated(layer.viz)) {
          const described = await describe(conn, wrappable(compiledSql));
          baseGeometry =
            described.find((c) => c.type.startsWith("GEOMETRY"))?.name ?? null;
          if (!baseGeometry) {
            throw new ApiError(
              "invalid_request",
              "A layer needs a geometry column. This result has none.",
              400,
            );
          }
        }

        // O→D layers take the export variant of the compilation: the
        // render path deliberately drops mapped endpoint columns (one
        // geometry for downstream), but a data export must not lose
        // them — they travel as WKT under the multi-geometry rule
        // (the "no supported layer silently loses a column" rule).
        const sql = isOdViz(layer.viz)
          ? odExportSql(filteredSql(compiledSql, layer.filters), layer.viz)
          : effectiveSql(
              { sql: compiledSql, filters: layer.filters, viz: layer.viz },
              baseGeometry,
            );

        // The effective result's own shape decides the projection: first
        // geometry column is the feature geometry, the rest become WKT.
        const columns = await describe(conn, sql);
        const geometryColumns = columns
          .filter((c) => c.type.startsWith("GEOMETRY"))
          .map((c) => c.name);
        if (geometryColumns.length === 0) {
          throw new ApiError(
            "invalid_request",
            "This layer's result has no geometry column to export.",
            400,
          );
        }
        const primary = geometryColumns[0];
        const asWkt = new Set(
          format === "csv" ? geometryColumns : geometryColumns.slice(1),
        );
        const selectList = columns
          .map((c) =>
            asWkt.has(c.name)
              ? `ST_AsText(${ident(c.name)}) AS ${ident(c.name)}`
              : ident(c.name),
          )
          .join(", ");

        const target = outFile.replace(/'/g, "''");
        const options =
          format === "geojson"
            ? "FORMAT gdal, DRIVER 'GeoJSON'"
            : format === "csv"
              ? "FORMAT csv, HEADER"
              : "FORMAT parquet";
        try {
          await conn.run(
            `COPY (SELECT ${selectList} FROM (${sql}) AS q
                   WHERE ${ident(primary)} IS NOT NULL)
             TO '${target}' WITH (${options})`,
          );
        } catch (error) {
          if (error instanceof ApiError) throw error;
          if (isOutOfMemory(error)) throw error;
          throw sqlError(error);
        }
      },
      { scope, signal },
    );
    requireAccountScope(scope);
  } catch (error) {
    await rm(outFile, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    path: outFile,
    filename: safeFilename(layer.name, EXT[format]),
    contentType: CONTENT_TYPE[format],
    cleanup: () => rm(outFile, { force: true }),
  };
}

/**
 * A query result as a file: every row the SQL produces — not the capped
 * preview — under the same guard, lane and scratch fence as the layer
 * export, and with its geometry rule: the first geometry column is the
 * feature geometry, every other geometry column travels as WKT. Unlike a
 * layer, a result may carry no geometry at all: CSV and parquet then
 * export the plain rows, and GeoJSON — which has nowhere to put a
 * geometry-less row — is refused with a coded reason. Rows are never
 * dropped for a NULL feature geometry: a download means every row.
 */
export async function exportQueryResult(
  scope: AccountScope,
  sql: string,
  format: LayerExportFormat,
  signal?: AbortSignal,
  name = "query_result",
): Promise<LayerExportFile> {
  requireAccountScope(scope);
  ensureTileDirs();
  const outFile = path.join(
    tileScratchDir(),
    `export-${randomUUID()}.${EXT[format]}`,
  );

  try {
    await boundedEvaluation(
      async (conn) => {
        requireAccountScope(scope);
        sql = await namedSql(conn, sql);
        const body = wrappable(sql);
        const columns = await describe(conn, body);
        const geometryColumns = columns
          .filter((c) => c.type.startsWith("GEOMETRY"))
          .map((c) => c.name);
        if (format === "geojson" && geometryColumns.length === 0) {
          throw new ApiError(
            "invalid_request",
            "GeoJSON needs a geometry column, and this result has none. " +
              "Download CSV or Parquet instead.",
            400,
          );
        }
        const asWkt = new Set(
          format === "csv" ? geometryColumns : geometryColumns.slice(1),
        );
        const selectList = columns
          .map((c) =>
            asWkt.has(c.name)
              ? `ST_AsText(${ident(c.name)}) AS ${ident(c.name)}`
              : ident(c.name),
          )
          .join(", ");
        const target = outFile.replace(/'/g, "''");
        const options =
          format === "geojson"
            ? "FORMAT gdal, DRIVER 'GeoJSON'"
            : format === "csv"
              ? "FORMAT csv, HEADER"
              : "FORMAT parquet";
        try {
          await conn.run(
            `COPY (SELECT ${selectList} FROM (${body}) AS q)
             TO '${target}' WITH (${options})`,
          );
        } catch (error) {
          if (error instanceof ApiError) throw error;
          if (isOutOfMemory(error)) throw error;
          throw sqlError(error);
        }
      },
      { scope, signal },
    );
    requireAccountScope(scope);
  } catch (error) {
    await rm(outFile, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    path: outFile,
    filename: safeFilename(name, EXT[format]),
    contentType: CONTENT_TYPE[format],
    cleanup: () => rm(outFile, { force: true }),
  };
}

async function describe(
  conn: DuckDBConnection,
  sql: string,
): Promise<{ name: string; type: string }[]> {
  try {
    const described = await conn.runAndReadAll(
      `DESCRIBE SELECT * FROM (${sql}) AS q`,
    );
    return (
      described.getRowObjects() as unknown as {
        column_name: string;
        column_type: string;
      }[]
    ).map((c) => ({ name: c.column_name, type: c.column_type }));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isOutOfMemory(error)) throw error;
    throw sqlError(error);
  }
}
