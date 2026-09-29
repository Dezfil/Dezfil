import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { executeQuery, isGeometryEncoding } from "@/lib/query/execute";

/** Run read-only SQL against the uploaded tables (spec: Query). */
export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    let sql: unknown;
    let geometry: unknown;
    try {
      ({ sql, geometry } = (await request.json()) as {
        sql?: unknown;
        geometry?: unknown;
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
    return NextResponse.json(
      await executeQuery(scope, sql, {
        signal: request.signal,
        geometry: isGeometryEncoding(geometry) ? geometry : undefined,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
