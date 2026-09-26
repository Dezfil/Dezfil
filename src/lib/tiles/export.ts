import { limits } from "@/lib/limits";
import { ApiError } from "@/lib/api/errors";
import { assertReadOnlySelect } from "@/lib/query/guard";
import { boundedEvaluation, isOutOfMemory } from "@/lib/query/bounded";
import { filteredSql } from "@/lib/query/compile";
import type { LayerFilter } from "@/lib/viz";

/**
 * Stage one of a tile build: stream the layer's effective simple-features
 * result — SQL refined by filters, the same compilation rule as everywhere
 * else — to newline-delimited GeoJSON that tippecanoe consumes streaming.
 * The write happens on the hardened instance, whose fence allows exactly one
 * writable directory (the tile scratch), so this trusted COPY wrapper cannot
 * be steered anywhere else; the user SQL inside it still passes the
 * read-only guard first.
 *
 * The batch lane keeps its own documented bound: the export rides the shared
 * boundary with the tile-build budget and error, not the interactive query
 * timeout.
 */

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export interface ExportInput {
  sql: string;
  filters: LayerFilter[];
  /** Geometry column of the layer's own result (from inspection). */
  geometryColumn: string;
  /** Non-geometry columns the export carries — the effective published
   * field set. Tippecanoe bakes every input property into the archive, so
   * the projection happens here, at the SELECT. */
  columns: string[];
}

/** Export to `outFile` (inside the scratch directory) and return the number
 * of features written. NULL geometries are dropped, matching the inline
 * render path. */
export async function exportGeoJsonSeq(
  input: ExportInput,
  outFile: string,
): Promise<number> {
  return boundedEvaluation(
    async (conn) => {
      await assertReadOnlySelect(conn, input.sql);

      const source = filteredSql(input.sql, input.filters);
      const geom = ident(input.geometryColumn);
      const target = outFile.replace(/'/g, "''");
      const selectList = [...input.columns.map(ident), geom].join(", ");
      try {
        const reader = await conn.runAndReadAll(
          `COPY (SELECT ${selectList} FROM (${source}) AS q WHERE ${geom} IS NOT NULL)
           TO '${target}' WITH (FORMAT gdal, DRIVER 'GeoJSONSeq')`,
        );
        const row = reader.getRowObjects()[0] as Record<string, unknown>;
        return Number(Object.values(row ?? {})[0] ?? 0);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (isOutOfMemory(error)) throw error;
        const message =
          error instanceof Error ? error.message : "The export could not run.";
        throw new ApiError("sql_error", message, 400);
      }
    },
    {
      budgetMs: limits.tileBuildTimeoutMs,
      timeoutError: () =>
        new ApiError(
          "tile_build_timeout",
          `Exporting the layer's result exceeded the ${Math.round(
            limits.tileBuildTimeoutMs / 1000,
          )}s tile-build timeout. Narrow the layer, or raise DEZFIL_TILE_BUILD_TIMEOUT_S.`,
          408,
        ),
    },
  );
}
