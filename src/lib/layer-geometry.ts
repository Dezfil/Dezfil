import type { DatasetScope } from "@/lib/query/access";
import { ApiError } from "@/lib/api/errors";
import { NOT_MAPPABLE_COPY } from "@/lib/layer-copy";
import { assertReadOnlySelect } from "@/lib/query/guard";
import { stripStatementQuote } from "@/lib/query/engine-message";
import {
  boundedEvaluation,
  isOutOfMemory,
} from "@/lib/query/bounded";
import { wrappable } from "@/lib/query/compile";

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

interface GeometryInspection {
  geometryColumn: string;
  geometryType: string | null;
}

/**
 * A layer requires a result with a geometry column; the first one is the
 * layer's primary geometry (additional geometry columns are allowed so
 * origin→destination results work; simple rendering draws the first). Zero
 * geometry columns, or unsupported geometry types, fail with a clear
 * message. Returns the primary geometry column and its dominant type.
 */
export async function inspectLayerGeometry(
  sql: string,
  signal?: AbortSignal,
  scope?: DatasetScope,
): Promise<GeometryInspection> {
  return boundedEvaluation(async (conn) => {
    await assertReadOnlySelect(conn, sql);

    const sub = `(${wrappable(sql)}) AS q`;
    let columns: { name: string; type: string }[];
    try {
      const described = await conn.runAndReadAll(
        `DESCRIBE SELECT * FROM ${sub}`,
      );
      columns = (
        described.getRowObjects() as unknown as {
          column_name: string;
          column_type: string;
        }[]
      ).map((c) => ({ name: c.column_name, type: c.column_type }));
    } catch (error) {
      // The memory budget is the boundary's outcome, not a SQL problem —
      // even a DESCRIBE can trip it while binding.
      if (isOutOfMemory(error)) throw error;
      throw new ApiError(
        "sql_error",
        error instanceof Error
          ? stripStatementQuote(error.message)
          : "The query could not run.",
        400,
      );
    }

    const geometryColumns = columns.filter((c) =>
      c.type.startsWith("GEOMETRY"),
    );
    if (geometryColumns.length === 0) {
      throw new ApiError(
        "invalid_request",
        NOT_MAPPABLE_COPY,
        400,
      );
    }

    const geometryColumn = geometryColumns[0].name;
    const typed = await conn.runAndReadAll(
      `SELECT DISTINCT ST_GeometryType(${ident(geometryColumn)}) AS t
       FROM ${sub} WHERE ${ident(geometryColumn)} IS NOT NULL LIMIT 6`,
    );
    const types = typed
      .getRowObjects()
      .map((r) => String(r.t))
      .filter(Boolean);

    const supported = types.filter((t) =>
      /POINT|LINESTRING|POLYGON/.test(t),
    );
    const unsupported = types.filter((t) => !/POINT|LINESTRING|POLYGON/.test(t));
    if (unsupported.length > 0 && supported.length === 0) {
      throw new ApiError(
        "invalid_request",
        `Unsupported geometry type ${unsupported[0]}. Points, lines, and polygons are supported.`,
        400,
      );
    }

    const geometryType =
      types.length === 0 ? null : supported.length === 1 ? supported[0] : "MIXED";
    return { geometryColumn, geometryType };
  }, { signal, scope });
}
