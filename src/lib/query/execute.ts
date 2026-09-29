import type { DatasetScope } from "@/lib/query/access";
import { limits } from "@/lib/limits";
import { ApiError } from "@/lib/api/errors";
import { namedSql } from "./named-sql";
import { wrappable } from "./compile";
import { enginePosition, stripStatementQuote } from "./engine-message";
import {
  boundedEvaluation,
  isOutOfMemory,
  type EvaluationOptions,
} from "./bounded";

export interface QueryResult {
  columns: { name: string; type: string }[];
  /** Exact total row count of the full result (spec: Query). */
  rowCount: number;
  /** First rows, capped at the documented preview limit. Geometry cells
   * are WKT text by default, or GeoJSON geometry objects when the caller
   * asked for `geometry: "geojson"`. */
  preview: Record<string, unknown>[];
  previewTruncated: boolean;
  runtimeMs: number;
}

/** How geometry columns travel in the preview: WKT text, the
 * historical default every caller already reads, or parsed GeoJSON
 * geometry objects for a caller that wants to draw the rows. */
export type GeometryEncoding = "wkt" | "geojson";
export const GEOMETRY_ENCODINGS: readonly GeometryEncoding[] = [
  "wkt",
  "geojson",
];
export function isGeometryEncoding(value: unknown): value is GeometryEncoding {
  return (GEOMETRY_ENCODINGS as readonly unknown[]).includes(value);
}

export interface QueryOptions extends Omit<EvaluationOptions, "scope"> {
  geometry?: GeometryEncoding;
}

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export async function executeQuery(
  scope: DatasetScope,
  sql: string,
  options: QueryOptions = {},
): Promise<QueryResult> {
  const submittedSql = sql;
  const encoding: GeometryEncoding = options.geometry ?? "wkt";
  return boundedEvaluation(async (conn) => {
    sql = await namedSql(conn, sql);

    const started = Date.now();
    // Wrap as a subquery to count and preview uniformly; a trailing
    // semicolon (accepted as one statement by the guard) would break that.
    const sub = `(${wrappable(sql)}) AS q`;
    // The probe's opening text — what the engine quotes ahead of the user's
    // SQL on line one, and what a reported caret is mapped through.
    const probePrefix = "DESCRIBE SELECT * FROM (";
    try {
      const described = await conn.runAndReadAll(
        `${probePrefix.slice(0, -1)}${sub}`,
      );
      const columns = (
        described.getRowObjects() as unknown as {
          column_name: string;
          column_type: string;
        }[]
      ).map((c) => ({ name: c.column_name, type: c.column_type }));

      // Preview geometry as text, not raw bytes: WKT by default, GeoJSON
      // when asked — parsed below so the wire carries objects. The
      // engine's own type name: a geometry is GEOMETRY, or GEOMETRY with
      // its CRS in parentheses. GEOMETRY_TYPE is a different type — the
      // enum a geometry's kind is reported in, a text value the text
      // functions do not take — and the former prefix match wrapped it
      // into a binder error.
      const geometryColumns = columns
        .filter((c) => c.type === "GEOMETRY" || c.type.startsWith("GEOMETRY("))
        .map((c) => c.name);
      const textOf = encoding === "geojson" ? "ST_AsGeoJSON" : "ST_AsText";
      const replace = geometryColumns.length
        ? ` REPLACE (${geometryColumns
            .map((g) => `${textOf}(${ident(g)}) AS ${ident(g)}`)
            .join(", ")})`
        : "";

      const counted = await conn.runAndReadAll(
        `SELECT count(*) AS n FROM ${sub}`,
      );
      const rowCount = Number(counted.getRowObjects()[0].n);

      const previewed = await conn.runAndReadAll(
        `SELECT *${replace} FROM ${sub} LIMIT ${limits.previewRows}`,
      );
      const preview = previewed.getRowObjectsJson() as Record<
        string,
        unknown
      >[];
      if (encoding === "geojson" && geometryColumns.length) {
        for (const row of preview) {
          for (const g of geometryColumns) {
            const cell = row[g];
            row[g] = typeof cell === "string" ? JSON.parse(cell) : null;
          }
        }
      }

      return {
        columns,
        rowCount,
        preview,
        previewTruncated: rowCount > preview.length,
        runtimeMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Binder/runtime problems — the engine's own message, per spec.
      // The bound's concerns — interruption, the memory budget — are the
      // boundary's to map, not ours.
      if (isOutOfMemory(error)) throw error;
      const message =
        error instanceof Error
          ? stripStatementQuote(error.message)
          : "Query execution failed";
      // Where the engine says the problem is, in the user's coordinates —
      // additional to the message, absent when it cannot be mapped.
      const position =
        error instanceof Error && sql === submittedSql
          ? enginePosition(error.message, probePrefix)
          : null;
      throw new ApiError(
        "sql_error",
        message,
        400,
        position ? { position } : {},
      );
    }
  }, { ...options, scope });
}
