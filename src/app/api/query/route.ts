import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { executeQuery, isGeometryEncoding } from "@/lib/query/execute";
import { parseWrittenIn, writtenInContext } from "@/lib/query/written-in";

/** Run read-only SQL against the uploaded tables (spec: Query). */
export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    let sql: unknown;
    let geometry: unknown;
    let writtenIn: unknown;
    try {
      ({ sql, geometry, writtenIn } = (await request.json()) as {
        sql?: unknown;
        geometry?: unknown;
        writtenIn?: unknown;
      });
    } catch {
      throw new ApiError(
        "invalid_request",
        'Expected a JSON body like {"sql": "SELECT …"}.',
        400,
      );
    }
    if (typeof sql !== "string" || sql.trim() === "") {
      throw new ApiError(
        "invalid_request",
        'The "sql" field must be a non-empty string.',
        400,
      );
    }
    if (geometry !== undefined && !isGeometryEncoding(geometry)) {
      throw new ApiError(
        "invalid_request",
        'The "geometry" field must be "wkt" or "geojson".',
        400,
      );
    }
    // Evaluated where it was written: a map's home, a workflow's context,
    // or the caller's own console.
    const written = parseWrittenIn(writtenIn, ["console", "map", "workflow"]);
    return NextResponse.json(
      await executeQuery(written ? writtenInContext(scope, written) : scope, sql, {
        signal: request.signal,
        geometry: isGeometryEncoding(geometry) ? geometry : undefined,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
