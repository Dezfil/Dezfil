import { withTrustedOperation } from "@/lib/trusted-operation";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { GEOMETRY_PROJECTION_NAMES } from "@/lib/geometry-evidence";
import { withConnection } from "@/lib/duckdb";
import { lit } from "@/lib/ingest/sql";

const CURATED = [4326, 3857, 25832, 25833, 3035, 27700, 4269];
function entry(epsg: number) {
  return {
    epsg, name: GEOMETRY_PROJECTION_NAMES[epsg] ?? `EPSG:${epsg}`,
    unit: CURATED.includes(epsg) ? ([4326, 4269].includes(epsg) ? "degrees" : "metres") : null,
  };
}
export async function projectionSupported(conn: DuckDBConnection, epsg: number): Promise<boolean> {
  // Validate even when the table has no readable coordinates. This checks the
  // engine's projection catalogue, never a curated-list allowlist.
  try {
    await conn.runAndReadAll(`SELECT ST_Transform(ST_Point(0, 0), ${lit(`EPSG:${epsg}`)}, 'EPSG:4326', always_xy := true)`);
    return true;
  } catch (error) {
    // Row tolerance is not permission to hide engine/storage failures.
    if (error instanceof Error && /Could not create projection|Unknown CRS|proj_create/i.test(error.message)) return false;
    throw error;
  }
}
export async function listProjections(query?: string, signal?: AbortSignal) {
  return withTrustedOperation({ kind: "interactive-read", name: "Projection lookup", signal }, async () => {
    let resolved: ReturnType<typeof entry> | null = null;
    if (query !== undefined) {
      if (!/^(?:EPSG:)?[0-9]+$/i.test(query)) throw new ApiError("invalid_request", "Enter a numeric EPSG code.", 400);
      const epsg = Number(query.replace(/^EPSG:/i, ""));
      if (!Number.isSafeInteger(epsg) || epsg <= 0) throw new ApiError("invalid_request", "Enter a positive EPSG code.", 400);
      if (!await withConnection(conn => projectionSupported(conn, epsg))) {
        throw new ApiError("geometry_choice_invalid", `EPSG:${epsg} cannot be transformed to WGS 84.`, 422);
      }
      resolved = entry(epsg);
    }
    return { projections: CURATED.map(entry), resolved };
  });
}
