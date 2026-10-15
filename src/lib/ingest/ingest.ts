import { withTrustedMutation } from "@/lib/trusted-mutation";
import { isTrustedOperationRefusal } from "@/lib/trusted-operation";
import { admitAccountWork } from "@/lib/auth/account-deletion-admission";
import { registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";
import { requireFilingDestination } from "@/lib/auth/reach";
import { requireRule } from "@/lib/auth/instance-rules";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { withConnection } from "@/lib/duckdb";
import { ApiError } from "@/lib/api/errors";
import {
  registerTable,
  type DataTable,
  type TableFormat,
  type TableSource,
} from "@/lib/metadata/tables";
import { metadataDb } from "@/lib/metadata/db";
import { fileOwnedTable } from "@/lib/metadata/owned-tables";
import { geometryColumnOfSelect, planSource } from "./file-source";
import { requireCsvContent } from "./csv-content";
import { replayFileGeometry, type GeometryReplay } from "@/lib/geometry/replay";
import type { GeometryStorage } from "@/lib/geometry/state";
import { ident, lit } from "./sql";
import { geometryEvidence, type GeometryCandidate, type GeometryRecord } from "@/lib/geometry-evidence";
export { ident, lit } from "./sql";
export { withBlankCoordinateFacts } from "./csv-source";

/** The one sentence every surface that lists accepted formats derives from
 * (the refusal names the whole truth, everywhere the same). */
export const SUPPORTED_FORMATS_SENTENCE =
  "Supported formats: GeoParquet (.parquet, .geoparquet), GeoJSON (.geojson, .json), CSV (.csv), Shapefile (.zip), GeoPackage (.gpkg), KML (.kml, .kmz).";

export function detectFormat(filename: string): TableFormat {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".parquet" || ext === ".geoparquet") return "geoparquet";
  if (ext === ".geojson" || ext === ".json") return "geojson";
  if (ext === ".csv") return "csv";
  if (ext === ".zip") return "shapefile";
  if (ext === ".gpkg") return "geopackage";
  if (ext === ".kml" || ext === ".kmz") return "kml";
  throw new ApiError(
    "unsupported_format",
    `Unsupported file type "${ext || filename}". ${SUPPORTED_FORMATS_SENTENCE}`,
    415,
  );
}

/** What a conversion measured about the artifact it produced. */
export interface ArtifactMeta extends GeometryStorage {
  geometryRecord?: GeometryRecord | null;
  geometryCandidates?: GeometryCandidate[];
  geometryColumn: string | null;
  geometryType: string | null;
  rowCount: number;
  crsAssumed: boolean;
  /** The CSV road's suspect-header verdict; false elsewhere. */
  headerSuspect: boolean;
}

/**
 * Convert a source file into a GeoParquet artifact at the given path and
 * measure it. Shared by first imports and refresh re-imports; the caller
 * owns cleanup of the artifact on any subsequent failure.
 */
export async function buildArtifact(
  sourcePath: string,
  filenameForFormat: string,
  artifact: string,
  replay?: GeometryReplay,
): Promise<ArtifactMeta> {
  const format = detectFormat(filenameForFormat);
  if (format === "csv") await requireCsvContent(sourcePath);
  await mkdir(path.dirname(artifact), { recursive: true });

  return withConnection(async (conn) => {
    if (replay) return replayFileGeometry(conn, format, sourcePath, artifact, replay);
    let plan: Awaited<ReturnType<typeof planSource>>;
    let geometryColumn: string | null;
    try {
      plan = await planSource(conn, format, sourcePath);
      geometryColumn = await geometryColumnOfSelect(conn, plan.select);
      await conn.run(
        `COPY (${plan.select}) TO ${lit(artifact)} (FORMAT PARQUET)`,
      );
    } catch (error) {
      if (isTrustedOperationRefusal(error)) throw error;
      throw new ApiError(
        "malformed_file",
        `The file could not be read as ${format}: ${
          error instanceof Error ? error.message : "unknown parse error"
        }`,
        422,
      );
    }

    const measured = await measureArtifact(conn, artifact, geometryColumn);
    return {
      ...measured,
      crsAssumed: plan.crsAssumed && measured.geometryColumn !== null,
      headerSuspect: plan.headerSuspect,
      ...(plan.geometryCandidates ? {
        geometryRecord: plan.geometryRecord ?? null,
        geometryCandidates: plan.geometryCandidates,
      } : {}),
    };
  });
}

const GEOMETRY_FAMILIES = ["POINT", "LINESTRING", "POLYGON"] as const;

/** One honest label for a table's geometries: a single type stands as-is;
 * single- and multi- of one family collapse to the MULTI type (POLYGON +
 * MULTIPOLYGON is still a table of polygons); a real mix of families is
 * recorded as the families joined ("POINT+POLYGON"), so the UI can draw
 * the actual mix. Anything outside the three families stays MIXED. */
export function collapseGeometryTypes(types: string[]): string | null {
  if (types.length === 0) return null;
  if (types.length === 1) return types[0];
  const familyOf = (t: string) =>
    GEOMETRY_FAMILIES.find((f) => t.toUpperCase().endsWith(f)) ?? null;
  const families = new Set(types.map(familyOf));
  if (families.has(null)) return "MIXED";
  if (families.size === 1) return `MULTI${[...families][0]}`;
  return GEOMETRY_FAMILIES.filter((f) => families.has(f)).join("+");
}

/** Measure a finished GeoParquet artifact: geometry column/type, row count.
 * Shared by every source that writes artifacts (files, + imports). */
export async function measureArtifact(
  conn: import("@duckdb/node-api").DuckDBConnection,
  artifact: string,
  establishedGeometryColumn: string | null = null,
): Promise<Omit<ArtifactMeta, "crsAssumed"> & { crsAssumed: false }> {
  const from = `read_parquet(${lit(artifact)})`;
  const described = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${from}`);
  const columns = described.getRowObjects() as unknown as {
    column_name: string;
    column_type: string;
  }[];
  // Geometry columns read as GEOMETRY or GEOMETRY('<crs>').
  const typedGeometryColumn =
    columns.find((c) => c.column_type.startsWith("GEOMETRY"))?.column_name ??
    null;
  const retainedGeometryColumn = establishedGeometryColumn
    ? columns.find(
        (column) =>
          column.column_name === establishedGeometryColumn &&
          column.column_type.trim().toUpperCase() === "BLOB",
      )?.column_name ?? null
    : null;
  const geometryColumn = typedGeometryColumn ?? retainedGeometryColumn;

  const counted = await conn.runAndReadAll(
    `SELECT count(*) AS n FROM ${from}`,
  );
  const rowCount = Number(counted.getRowObjects()[0].n);

  let geometryType: string | null = null;
  if (typedGeometryColumn && rowCount > 0) {
    const typed = await conn.runAndReadAll(
      // No cap: this classification is authoritative for the registry and, for
      // the dry run that must agree with it. A sampled probe can omit a
      // surviving class, which is a wrong answer presented as fact. The column
      // name comes from the artifact, and an artifact can be written from an
      // arbitrary user SELECT whose geometry alias the user chose. An
      // unescaped identifier there closes this one and the engine accepts
      // whatever follows — a read-only path executing DDL.
      //
      // **Rows without geometry are not a geometry class.** A NULL comes back
      // from `DISTINCT` as its own group, and reading it as a type name made a
      // table of points with one unmatched row classify as MIXED — which is
      // not what it holds, and costs it the point treatment on the map. Found
      // building, whose whole output shape is points plus rows that did not
      // resolve.
      `SELECT DISTINCT ST_GeometryType(${ident(typedGeometryColumn)}) AS t FROM ${from}
       WHERE ${ident(typedGeometryColumn)} IS NOT NULL`,
    );
    const types = typed.getRowObjects().map((r) => String(r.t));
    geometryType = collapseGeometryTypes(types);
  }

  return {
    geometryColumn,
    geometryType,
    rowCount,
    crsAssumed: false,
    headerSuspect: false,
  };
}

/** Provenance carried by an import. Uploads are the default. Since
 * it also carries the project the created tables join — the one context
 * field that must commit with the registration, atomically. */
export interface IngestProvenance {
  source: TableSource;
  sourceParams: Record<string, unknown> | null;
  projectId?: string | null;
}

/**
 * A new import from a link is admitted again by who may import from links
 * inside the transaction that registers it: the download and the build take
 * time, and a rule an admin narrowed meanwhile is the one that decides, with
 * nothing registered. Uploads and the other sources pass; refreshing a link
 * dataset replaces its file and never registers, so it is never asked.
 */
export function requireLinkImportRule(scope: AccountScope, provenance: IngestProvenance | undefined, db: Database): void {
  if (provenance?.source === "url") requireRule(scope.accountId, "imports.links", db);
}

/**
 * Turn a source file into a GeoParquet artifact plus a registry entry.
 * The whole ingest is atomic from the outside: any failure removes the
 * artifact and registers nothing (spec: no partial table is ever created).
 */
export async function ingestFile(
  scope: AccountScope,
  sourcePath: string,
  originalFilename: string,
  provenance: IngestProvenance = { source: "upload", sourceParams: null },
  requestedName?: string,
  signal?: AbortSignal,
): Promise<DataTable> {
  return withTrustedMutation({ kind: "import", name: "File import", signal }, async operation => {
    const deletionWork = admitAccountWork([requireAccountScope(scope)]);
    try {
    requireAccountScope(scope);
    if (provenance?.projectId) requireFilingDestination(scope, provenance.projectId);
    const format = detectFormat(originalFilename);
    const id = randomUUID();
    const relFile = path.join("tables", `${id}.parquet`);
    const artifact = path.join(dataDir(), relFile);
      registerAccountFile(scope.accountId, artifact);

    try {
      const meta = await buildArtifact(sourcePath, originalFilename, artifact);

      // Derive-and-register is one synchronous step; the project
      // membership commits in the same transaction, so a membership
      // failure leaves no registered table behind.
      const db = metadataDb();
      return db.transaction(() => {
        requireLinkImportRule(scope, provenance, db);
        operation.assertCanCommit();
        const table = registerTable(
          scope,
          {
            id,
            sourceFilename: originalFilename,
            format,
            file: relFile,
            geometryColumn: meta.geometryColumn,
            geometryType: meta.geometryType,
            crsAssumed: meta.crsAssumed,
            headerSuspect: meta.headerSuspect,
            ...geometryEvidence(meta),
            rowCount: meta.rowCount,
            createdAt: new Date().toISOString(),
            source: provenance.source,
            sourceParams: provenance.sourceParams,
            importedAt: new Date().toISOString(),
          },
          requestedName ?? originalFilename,
          db,
        );
        if (provenance.projectId) fileOwnedTable(scope, table.id, provenance.projectId, db);
        return table;
      })();
    } catch (error) {
      operation.refuseIfFinal(error);
      await removeAccountFile(artifact, { force: true });
      throw error;
    }

    } finally { deletionWork.release(); }
  });
}
