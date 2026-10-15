import { withTrustedMutation } from "@/lib/trusted-mutation";
import { currentTrustedOperation, isTrustedOperationRefusal } from "@/lib/trusted-operation";
import { captureIngestBudget, type IngestBudget } from "./budget";
import { registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";
import { ownedTableNames, listOwnedTables } from "@/lib/metadata/owned-tables";
import { requireFilingDestination } from "@/lib/auth/reach";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { replayGeometryRelation, type GeometryReplay } from "@/lib/geometry/replay";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { withConnection } from "@/lib/duckdb";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { fileOwnedTable } from "@/lib/metadata/owned-tables";
import {
  insertTable,
  type DataTable,
  type TableFormat,
} from "@/lib/metadata/tables";
import { deriveTableName } from "./naming";
import {
  detectFormat,
  ident,
  ingestFile,
  lit,
  measureArtifact,
  requireLinkImportRule,
  type IngestProvenance,
} from "./ingest";
import { extractArchive } from "./container";
import { ingestScratchDir } from "./scratch";

/**
 * The spatial ingest road: Shapefile zips, GeoPackage, and KML/KMZ, read
 * through DuckDB spatial's GDAL reader. Unlike the one-file one-table
 * formats, these can hold several layers — each spatial layer lands as its
 * own table, the group shares provenance, and the whole import is atomic:
 * any layer failing removes everything the import built.
 */

export type GdalFormat = "shapefile" | "geopackage" | "kml";

export function isGdalFormat(format: TableFormat): format is GdalFormat {
  return format === "shapefile" || format === "geopackage" || format === "kml";
}

/** The GDAL driver each format must resolve to — a mislabeled file that
 * would sniff as some other driver is refused, not silently imported. */
const DRIVER: Record<GdalFormat, string> = {
  shapefile: "ESRI Shapefile",
  geopackage: "GPKG",
  kml: "KML",
};

function malformed(format: GdalFormat, detail: string): ApiError {
  return new ApiError(
    "malformed_file",
    `The file could not be read as ${format}: ${detail}`,
    422,
  );
}

/** A member of the import answer that did not become a table. */
export interface SkippedLayer {
  layer: string;
  reason: string;
}

/** What an import created — one table for the single-file formats, one
 * per spatial layer for the container formats. */
export interface IngestResult {
  tables: DataTable[];
  skipped: SkippedLayer[];
}

export interface SpatialLayer {
  /** Layer name — the table-name suffix and the stored refresh recipe. */
  name: string;
  datasetPath: string;
  /** Passed to the reader; null for single-layer datasets (.shp). */
  readerLayer: string | null;
  driver: string;
  spatial: boolean;
}

export interface PreparedSource {
  datasets: string[];
  /** Extraction directory to remove when the import settles, if any. */
  scratchDir: string | null;
}

/** Expand a container into the ingest scratch area when the format needs
 * it; single-file formats pass through. */
export async function prepareSource(
  format: GdalFormat,
  sourcePath: string,
  filename: string,
  accountId?: string,
  budget: IngestBudget = captureIngestBudget(),
): Promise<PreparedSource> {
  const ext = path.extname(filename).toLowerCase();
  if (format === "geopackage" || (format === "kml" && ext === ".kml")) {
    return { datasets: [sourcePath], scratchDir: null };
  }

  const scratchDir = path.join(ingestScratchDir(), randomUUID());
  if (accountId) registerAccountFile(accountId, scratchDir, true);
  await mkdir(scratchDir, { recursive: true });
  currentTrustedOperation()?.defer(() => removeAccountFile(scratchDir, { recursive: true, force: true }));
  try {
    const { files } = await extractArchive(sourcePath, scratchDir, filename, budget.uploadMaxBytes);

    if (format === "shapefile") {
      const shp = files.filter((f) => f.toLowerCase().endsWith(".shp"));
      if (shp.length === 0) {
        throw malformed(
          "shapefile",
          `the zip contains no shapefile (.shp), ${files.length} other member(s)`,
        );
      }
      return { datasets: shp.map((f) => path.join(scratchDir, f)), scratchDir };
    }

    // .kmz: by convention the document is doc.kml at the root; failing that, the first .kml member.
    const kml =
      files.find((f) => f.toLowerCase() === "doc.kml") ??
      files.find((f) => f.toLowerCase().endsWith(".kml"));
    if (!kml) {
      throw malformed("kml", "the .kmz contains no KML document");
    }
    return { datasets: [path.join(scratchDir, kml)], scratchDir };
  } catch (error) {
    // A refusal before the source is handed over cleans its own scratch.
    await removeAccountFile(scratchDir, { recursive: true, force: true });
    throw error;
  }
}

/** Unwrap @duckdb/node-api LIST/STRUCT values into plain arrays/objects. */
function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const items = (value as { items?: unknown[] } | null)?.items;
  return Array.isArray(items) ? items : [];
}
function asStruct(value: unknown): Record<string, unknown> {
  const entries = (value as { entries?: Record<string, unknown> } | null)
    ?.entries;
  return entries && typeof entries === "object"
    ? entries
    : ((value ?? {}) as Record<string, unknown>);
}

/**
 * Enumerate a dataset's layers from the reader's metadata. Every layer a
 * later read names MUST come from here: the reader crashes the process on
 * a layer name the dataset does not hold, so enumeration-first is a hard
 * rule, not a nicety.
 */
async function enumerateDataset(
  conn: import("@duckdb/node-api").DuckDBConnection,
  format: GdalFormat,
  datasetPath: string,
  datasetName?: string,
): Promise<SpatialLayer[]> {
  let rows: Record<string, unknown>[];
  try {
    const read = await conn.runAndReadAll(
      `SELECT * FROM ST_Read_Meta(${lit(datasetPath)})`,
    );
    rows = read.getRowObjects() as Record<string, unknown>[];
  } catch (error) {
    if (isTrustedOperationRefusal(error)) throw error;
    throw malformed(
      format,
      error instanceof Error ? error.message : "unreadable file",
    );
  }
  if (rows.length === 0) {
    throw malformed(format, "the file is not readable as a spatial dataset");
  }
  const driver = String(rows[0].driver_short_name ?? "");
  if (driver !== DRIVER[format]) {
    throw malformed(
      format,
      `the content reads as "${driver || "unknown"}", not ${DRIVER[format]}`,
    );
  }

  const stem =
    datasetName ?? path.basename(datasetPath, path.extname(datasetPath));
  return asList(rows[0].layers).map((raw) => {
    const layer = asStruct(raw);
    const geometryFields = asList(layer.geometry_fields);
    const name = String(layer.name ?? stem);
    return {
      // A.shp dataset is one layer named after its archive-relative path (two same-stem shapefiles
      // in different folders must keep distinct identities, or a refresh resolves both to the
      // first). The layer list inside a .shp is not addressable separately.
      name: format === "shapefile" ? stem : name,
      datasetPath,
      readerLayer: format === "shapefile" ? null : name,
      driver,
      spatial: geometryFields.length > 0,
    };
  });
}

/** Enumerate all spatial+skipped layers of a prepared source, in dataset
 * order. Exported for the refresh road, which must re-validate a stored
 * layer name before reading it. */
export async function enumerateLayers(
  conn: import("@duckdb/node-api").DuckDBConnection,
  format: GdalFormat,
  prepared: PreparedSource,
): Promise<{ spatial: SpatialLayer[]; skipped: SkippedLayer[] }> {
  const spatial: SpatialLayer[] = [];
  const skipped: SkippedLayer[] = [];
  for (const datasetPath of prepared.datasets) {
    // Shapefile identity is the archive-relative path, extension stripped
    // and slashes normalized — stable across import and refresh.
    const datasetName =
      format === "shapefile" && prepared.scratchDir
        ? path
            .relative(prepared.scratchDir, datasetPath)
            .replace(/\\/g, "/")
            .replace(/\.[^.]*$/, "")
        : undefined;
    for (const layer of await enumerateDataset(
      conn,
      format,
      datasetPath,
      datasetName,
    )) {
      if (layer.spatial) spatial.push(layer);
      else
        skipped.push({
          layer: layer.name,
          reason: "no geometry: attribute-only content is not imported",
        });
    }
  }
  return { spatial, skipped };
}

function readerFrom(layer: SpatialLayer): string {
  const args = [lit(layer.datasetPath)];
  if (layer.readerLayer !== null) args.push(`layer := ${lit(layer.readerLayer)}`);
  args.push(`allowed_drivers := [${lit(layer.driver)}]`);
  return `ST_Read(${args.join(", ")})`;
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

/**
 * Build one layer into a GeoParquet artifact and measure it. CRS follows
 * the file's own declaration: a declared non-WGS84 CRS reprojects; an
 * undeclared one (a.prj-less shapefile) is assumed WGS84 and flagged,
 * the same honest flag CSV carries.
 */
export async function buildLayerArtifact(
  conn: import("@duckdb/node-api").DuckDBConnection,
  format: GdalFormat,
  layer: SpatialLayer,
  artifact: string,
  replay?: GeometryReplay,
): Promise<import("./ingest").ArtifactMeta> {
  await mkdir(path.dirname(artifact), { recursive: true });
  if (replay) return replayGeometryRelation(conn, readerFrom(layer), artifact, replay);
  let crsAssumed = false;
  let geometryColumn: string | null = null;
  try {
    const from = readerFrom(layer);
    const described = await conn.runAndReadAll(
      `DESCRIBE SELECT * FROM ${from}`,
    );
    const columns = described.getRowObjects() as unknown as {
      column_name: string;
      column_type: string;
    }[];
    const geom = columns.find((c) => c.column_type.startsWith("GEOMETRY"));
    geometryColumn = geom?.column_name ?? null;

    let select = `SELECT * FROM ${from}`;
    if (geom) {
      const crs = crsFromType(geom.column_type);
      if (crs === null) {
        // The file declared no CRS — assumed WGS84, honestly flagged.
        crsAssumed = true;
      } else if (!isWgs84(crs)) {
        select = `SELECT * EXCLUDE (${ident(geom.column_name)}), ST_Transform(${ident(
          geom.column_name,
        )}, ${lit(crs)}, 'EPSG:4326', always_xy := true) AS ${ident(geom.column_name)} FROM ${from}`;
      }
    }
    await conn.run(`COPY (${select}) TO ${lit(artifact)} (FORMAT PARQUET)`);
  } catch (error) {
    await removeAccountFile(artifact, { force: true });
    if (isTrustedOperationRefusal(error)) throw error;
    throw malformed(
      format,
      error instanceof Error ? error.message : "unknown parse error",
    );
  }

  try {
    const measured = await measureArtifact(conn, artifact, geometryColumn);
    return {
      ...measured,
      crsAssumed: crsAssumed && measured.geometryColumn !== null,
    };
  } catch (error) {
    // A failure after COPY leaves a written artifact the caller has not
    // yet taken ownership of — no-residue means it goes here (review
    // round one).
    await removeAccountFile(artifact, { force: true });
    throw error;
  }
}

/**
 * Ingest a container-format file: one table per spatial layer, shared
 * group provenance, non-spatial members skipped and named in the answer.
 * Atomic as a group — a failing layer (or the registration) removes every
 * artifact the import built and registers nothing.
 */
export async function ingestSpatialFile(
  scope: AccountScope,
  sourcePath: string,
  originalFilename: string,
  provenance: IngestProvenance = { source: "upload", sourceParams: null },
  requestedName?: string,
  budget: IngestBudget = captureIngestBudget(),
  signal?: AbortSignal,
): Promise<IngestResult> {
  return withTrustedMutation({ kind: "import", name: "Spatial file import", signal }, async operation => {
    requireAccountScope(scope);
    if (provenance?.projectId) requireFilingDestination(scope, provenance.projectId);
    const format = detectFormat(originalFilename) as GdalFormat;
    const prepared = await prepareSource(format, sourcePath, originalFilename, scope.accountId, budget);
    try {
      return await withConnection(async (conn) => {
        const { spatial, skipped } = await enumerateLayers(
          conn,
          format,
          prepared,
        );
        if (spatial.length === 0) {
          const named = skipped.map((s) => `"${s.layer}"`).join(", ");
          throw malformed(
            format,
            `the file contains no spatial layers${named ? ` (skipped: ${named})` : ""}`,
          );
        }

        const base = requestedName?.trim() || originalFilename;
        const group = spatial.length > 1 ? randomUUID() : null;
        const built: {
          layer: SpatialLayer;
          id: string;
          relFile: string;
          artifact: string;
          meta: import("./ingest").ArtifactMeta;
          desired: string;
        }[] = [];
        try {
          for (const layer of spatial) {
            const id = randomUUID();
            const relFile = path.join("tables", `${id}.parquet`);
            const artifact = path.join(dataDir(), relFile);
      registerAccountFile(scope.accountId, artifact);
            const meta = await buildLayerArtifact(conn, format, layer, artifact);
            built.push({
              layer,
              id,
              relFile,
              artifact,
              meta,
              desired: group ? `${base.replace(/\.[^.]*$/, "")}_${layer.name}` : base,
            });
          }

          const db = metadataDb();
          const now = new Date().toISOString();
          const tables = db.transaction(() => {
            requireLinkImportRule(scope, provenance, db);
            operation.assertCanCommit();
            const out: DataTable[] = [];
            for (const b of built) {
              const record: DataTable = {
                id: b.id,
                name: deriveTableName(b.desired, ownedTableNames(scope, db)),
                sourceFilename: originalFilename,
                format,
                file: b.relFile,
                geometryColumn: b.meta.geometryColumn,
                geometryType: b.meta.geometryType,
                crsAssumed: b.meta.crsAssumed,
                // Container formats are never the CSV road.
                headerSuspect: false,
                rowCount: b.meta.rowCount,
                createdAt: now,
                source: provenance.source,
                sourceParams: {
                  ...(provenance.sourceParams ?? {}),
                  layer: b.layer.name,
                  ...(group ? { group } : {}),
                },
                importedAt: now,
              };
              insertTable(scope, record, db);
              // Every table of a container files together — one
              // membership failure rolls the whole group's registration
              // back, the road's own atomicity.
              if (provenance.projectId) fileOwnedTable(scope, record.id, provenance.projectId, db);
              out.push(record);
            }
            return out;
          })();
          operation.markCommitted();
          return { tables, skipped };
        } catch (error) {
          operation.refuseIfFinal(error);
          // No partial state, extended to groups: every artifact this import
          // built goes before the error surfaces.
          for (const b of built) await removeAccountFile(b.artifact, { force: true });
          throw error;
        }
      });
    } finally {
      // Best-effort: by the time this runs the tables may already be
      // committed, and a cleanup stumble must not turn that success into a
      // failure answer. The boot sweep collects strays.
      if (prepared.scratchDir) {
        await removeAccountFile(prepared.scratchDir, { recursive: true, force: true }).catch(
          (error: unknown) =>
            console.warn(
              `ingest scratch cleanup failed for ${prepared.scratchDir}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
        );
      }
    }
  });
}

/**
 * The one ingest entry both roads call (formats behave identically
 * across upload and URL import): container formats fan out, everything
 * else takes the existing single-table road unchanged.
 */
export async function ingestSource(
  scope: AccountScope,
  sourcePath: string,
  originalFilename: string,
  provenance?: IngestProvenance,
  requestedName?: string,
  budget: IngestBudget = captureIngestBudget(),
  signal?: AbortSignal,
): Promise<IngestResult> {
  return withTrustedMutation({ kind: "import", name: "File import", signal, budgetMs: budget.dataProcessingTimeoutMs }, async () => {
    requireAccountScope(scope);
    if (provenance?.projectId) requireFilingDestination(scope, provenance.projectId);
    const format = detectFormat(originalFilename);
    if (isGdalFormat(format)) {
      return ingestSpatialFile(
        scope,
        sourcePath,
        originalFilename,
        provenance,
        requestedName,
        budget,
      );
    }
    const table = await ingestFile(
      scope,
      sourcePath,
      originalFilename,
      provenance,
      requestedName,
    );
    return { tables: [table], skipped: [] };
  });
}

/**
 * The wire shape of an import answer: the single-table formats keep their
 * documented single-object contract; container formats carry the same
 * object for the first table plus the full enumeration — every table
 * created, every member skipped and why.
 */
export function toIngestResponse(
  result: IngestResult,
): DataTable | (DataTable & { tables: DataTable[]; skipped: SkippedLayer[] }) {
  const first = result.tables[0];
  if (!isGdalFormat(first.format)) return first;
  return { ...first, tables: result.tables, skipped: result.skipped };
}

/** Every member of a url-import group, by any member's group id. Mirrors
 * the OSM group helper; the refresh road treats the group as one unit. */
export function urlGroupMembers(scope: AccountScope, group: string): DataTable[] {
  return listOwnedTables(scope).filter(
    (t) => t.source === "url" && t.sourceParams?.group === group,
  );
}
