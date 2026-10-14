import { isTrustedOperationRefusal } from "@/lib/trusted-operation";
import { ApiError } from "@/lib/api/errors";
import { OVERTURE_BUCKET, OVERTURE_REGION } from "./bucket";

/**
 * Shared plumbing for every Overture S3 read (import, divisions metadata):
 * anonymous scoped access and honest error mapping.
 */

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export async function ensureOvertureSupport(
  conn: import("@duckdb/node-api").DuckDBConnection,
): Promise<void> {
  try {
    await conn.run(`INSTALL httpfs; LOAD httpfs;`);
    // Anonymous, region-pinned, and scoped to the Overture bucket so
    // administrator AWS credentials never sign these requests.
    // DEZFIL_OVERTURE_S3_ENDPOINT (test seam, the Overpass-URL analog)
    // points the same scoped secret at a local S3-compatible fixture —
    // path-style, plain http — so the whole read road stays real.
    const seam = process.env.DEZFIL_OVERTURE_S3_ENDPOINT;
    const seamOpts = seam
      ? `, ENDPOINT ${lit(seam)}, URL_STYLE 'path', USE_SSL false`
      : "";
    await conn.run(
      `CREATE SECRET IF NOT EXISTS overture_public (
         TYPE s3, REGION ${lit(OVERTURE_REGION)}, SCOPE ${lit(`s3://${OVERTURE_BUCKET}`)}${seamOpts})`,
    );
  } catch (error) {
    if (isTrustedOperationRefusal(error)) throw error;
    throw new ApiError(
      "remote_fetch_failed",
      `Overture reads need the DuckDB httpfs extension, which could not be loaded${
        error instanceof Error ? `: ${error.message}` : ""
      }`,
      502,
    );
  }
}

export function mapOvertureError(error: unknown): never {
  if (isTrustedOperationRefusal(error)) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /HTTP|40[0-9]|50[0-9]|Connection|resolve|timed? ?out|No files found|Unable to connect/i.test(
      message,
    )
  ) {
    throw new ApiError(
      "remote_fetch_failed",
      `Could not read Overture data from S3: ${message}`,
      502,
    );
  }
  throw error;
}
