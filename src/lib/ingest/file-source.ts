import type { TableFormat } from "@/lib/metadata/tables";
import type { GeometryCandidate, GeometryRecord } from "@/lib/geometry-evidence";
import { planCsvSource } from "./csv-source";
import { ident, lit } from "./sql";

export interface SourcePlan {
  geometryRecord?: GeometryRecord | null;
  geometryCandidates?: GeometryCandidate[];
  select: string;
  crsAssumed: boolean;
  /** The suspect-header signals — only the CSV road can
   * raise it; advisory, independent of recognition. */
  headerSuspect: boolean;
}

export async function geometryColumnOfSelect(
  conn: import("@duckdb/node-api").DuckDBConnection,
  select: string,
): Promise<string | null> {
  const described = await conn.runAndReadAll(`DESCRIBE ${select}`);
  const columns = described.getRowObjects() as unknown as {
    column_name: string;
    column_type: string;
  }[];
  return (
    columns.find((column) =>
      String(column.column_type).startsWith("GEOMETRY"),
    )?.column_name ?? null
  );
}

/** Extract the CRS parameter from a GEOMETRY('<crs>') column type. */
function crsFromType(columnType: string): string | null {
  const match = columnType.match(/^GEOMETRY\('(.+)'\)$/);
  return match ? match[1] : null;
}

function isWgs84(crs: string): boolean {
  const c = crs.toUpperCase();
  return c === "OGC:CRS84" || c === "EPSG:4326";
}

/** Blob columns by these names are probed as WKB geometry. */
const WKB_BLOB_NAMES = ["geometry", "geom", "wkb_geometry"];

export async function planSource(
  conn: import("@duckdb/node-api").DuckDBConnection,
  format: TableFormat,
  sourcePath: string,
): Promise<SourcePlan> {
  switch (format) {
    case "geoparquet": {
      const from = `read_parquet(${lit(sourcePath)})`;
      const described = await conn.runAndReadAll(
        `DESCRIBE SELECT * FROM ${from}`,
      );
      const columns = (
        described.getRowObjects() as unknown as {
          column_name: string;
          column_type: string;
        }[]
      ).map((c) => ({ name: c.column_name, type: c.column_type }));

      const geom = columns.find((c) => c.type.startsWith("GEOMETRY"));
      if (geom) {
        const crs = crsFromType(geom.type);
        if (crs && !isWgs84(crs)) {
          // Declared non-WGS84 CRS: normalize so it renders in place.
          return {
            select: `SELECT * EXCLUDE (${ident(geom.name)}), ST_Transform(${ident(geom.name)}, ${lit(crs)}, 'EPSG:4326', always_xy := true) AS ${ident(geom.name)} FROM ${from}`,
            crsAssumed: false,
            headerSuspect: false,
          };
        }
        // WGS84, or no crs field (GeoParquet defines that as CRS84).
        return {
          select: `SELECT * FROM ${from}`,
          crsAssumed: false,
          headerSuspect: false,
        };
      }

      // No GeoParquet metadata: probe documented blob column names as WKB,
      // under the stated WGS84 assumption (spec: no declared CRS).
      const blob = columns.find(
        (c) =>
          c.type === "BLOB" && WKB_BLOB_NAMES.includes(c.name.toLowerCase()),
      );
      if (blob) {
        try {
          await conn.runAndReadAll(
            `SELECT ST_GeomFromWKB(${ident(blob.name)}) FROM ${from} LIMIT 100`,
          );
          return {
            select: `SELECT * EXCLUDE (${ident(blob.name)}), ST_GeomFromWKB(${ident(blob.name)}) AS ${ident(blob.name)} FROM ${from}`,
            crsAssumed: true,
            headerSuspect: false,
          };
        } catch {
          // Not WKB after all — import as a plain column.
        }
      }
      return {
        select: `SELECT * FROM ${from}`,
        crsAssumed: false,
        headerSuspect: false,
      };
    }
    case "geojson":
      // GeoJSON is WGS84 by specification — declared, not assumed.
      return {
        select: `SELECT * FROM ST_Read(${lit(sourcePath)})`,
        crsAssumed: false,
        headerSuspect: false,
      };
    case "shapefile":
    case "geopackage":
    case "kml":
      // Container formats fan out per layer and take the spatial ingest
      // road (gdal-formats.ts); reaching this switch with one is a bug.
      throw new Error(`format "${format}" takes the spatial ingest road`);
    case "csv":
      return planCsvSource(conn, sourcePath);
  }
}

