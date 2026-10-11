import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";
import { deriveTableName } from "@/lib/ingest/naming";
import { geometryEvidence, type GeometryEvidence } from "@/lib/geometry-evidence";
import { serializeGeometryStorage, type GeometryStorage } from "@/lib/geometry/state";
import { listOwnedTables, ownedTableNames } from "./owned-tables";
import { ApiError } from "@/lib/api/errors";
import { withRecordedOrigin } from "@/lib/settings/disclosure";

export type TableFormat =
  | "geoparquet"
  | "geojson"
  | "csv"
  | "shapefile"
  | "geopackage"
  | "kml";

/**
 * Where a table came from; an operation's output; a drawn sketch — its
 * sourceParams record the owning map and the session-minted owning
 * layer; a template's dataset copied into its copier's project — its
 * sourceParams name the template and the version it came from.
 */
export type TableSource =
  | "upload"
  | "url"
  | "overture"
  | "osm"
  | "postgis"
  | "operation"
  | "sketch"
  | "template";

export interface DataTable extends GeometryEvidence {
  id: string;
  /** SQL identifier the user queries; unique within its owner. */
  name: string;
  /** The file this arrived as. Null for a derived table: an
   * operation's output never was a file, and filler here would state
   * something untrue about how the dataset came to exist. */
  sourceFilename: string | null;
  format: TableFormat;
  /** Path of the GeoParquet artifact, relative to the data directory. */
  file: string;
  /** Null for non-spatial tables. */
  geometryColumn: string | null;
  geometryType: string | null;
  /** True when the file declared no CRS and WGS84 was assumed. */
  crsAssumed: boolean;
  /** True when a CSV's detected column names betrayed a broken read
   * an unsplit header or a consumed one. Advisory only; always false
   * off the CSV road. */
  headerSuspect: boolean;
  rowCount: number;
  createdAt: string;
  /** Provenance: which source created this table. */
  source: TableSource;
  /** Parameters that re-run the import (e.g. { url }); null for
   * single-file uploads. Container-format tables also carry { layer,
   * group? } — for uploads that is provenance only, never a refresh
   * recipe. */
  sourceParams: Record<string, unknown> | null;
  /** When this table's data was last produced — the import's last run, or
   * for a derived table the run that wrote it. Null for a table that has
   * neither. The detail surface and the recently-updated ordering both read
   * it, so a derived table reports its age where an import does. */
  importedAt: string | null;
}

export interface TableRow {
  id: string;
  name: string;
  source_filename: string | null;
  format: TableFormat;
  file: string;
  geometry_column: string | null;
  geometry_recognition: string | null;
  geometry_type: string | null;
  crs_assumed: 0 | 1;
  header_suspect: 0 | 1;
  row_count: number;
  created_at: string;
  source: TableSource;
  source_params: string | null;
  imported_at: string | null;
}

/** The record as every read gives it: the service a provider run or an
 * OpenStreetMap import reached reads as scheme and host, whenever it was
 * recorded. The stored row is never rewritten for it. */
function recordedSourceParams(source: string, params: Record<string, unknown>): Record<string, unknown> {
  if (source === "osm") return withRecordedOrigin(params);
  const disclosure = params.disclosure;
  if (source === "operation" && typeof disclosure === "object" && disclosure !== null && !Array.isArray(disclosure)) {
    return { ...params, disclosure: withRecordedOrigin(disclosure as Record<string, unknown>) };
  }
  return params;
}

export function tableFromRow(r: TableRow): DataTable {
  return {
    ...(r.geometry_recognition ? geometryEvidence(JSON.parse(r.geometry_recognition) as GeometryEvidence) : {}),
    id: r.id,
    name: r.name,
    sourceFilename: r.source_filename,
    format: r.format,
    file: r.file,
    geometryColumn: r.geometry_column,
    geometryType: r.geometry_type,
    crsAssumed: r.crs_assumed === 1,
    headerSuspect: r.header_suspect === 1,
    rowCount: r.row_count,
    createdAt: r.created_at,
    source: r.source,
    sourceParams: r.source_params
      ? recordedSourceParams(r.source, JSON.parse(r.source_params) as Record<string, unknown>)
      : null,
    importedAt: r.imported_at,
  };
}

/**
 * Derive-and-register in one synchronous step: the taken set is consulted
 * at insert time — never from a snapshot held across asynchronous work —
 * so overlapping imports land with distinct names. The bounded retry turns
 * the residual race into a coded conflict instead of an uncoded 500 on the
 * UNIQUE constraint.
 */
export function registerTable(
  scope: AccountScope,
  record: Omit<DataTable, "name">,
  desiredName: string,
  db: Database = metadataDb(),
): DataTable {
  requireAccountScope(scope, db);
  for (let attempt = 0; ; attempt++) {
    const named: DataTable = {
      ...record,
      name: deriveTableName(desiredName, ownedTableNames(scope, db)),
    };
    try {
      insertTable(scope, named, db);
      return named;
    } catch (error) {
      const unique =
        error instanceof Error && /UNIQUE constraint/i.test(error.message);
      if (unique && attempt < 2) continue;
      if (unique) {
        throw new ApiError(
          "invalid_request",
          `The table name "${named.name}" was claimed by a concurrent import. Retry the import.`,
          409,
        );
      }
      throw error;
    }
  }
}

export function insertTable(scope: AccountScope, t: DataTable, db: Database = metadataDb()): void {
  const ownerId = requireAccountScope(scope, db);
  db.prepare(
    `INSERT INTO data_tables
       (owner_id, id, name, source_filename, format, file, geometry_column,
        geometry_type, crs_assumed, header_suspect, row_count, created_at,
        source, source_params, imported_at, geometry_recognition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ownerId,
    t.id,
    t.name,
    t.sourceFilename,
    t.format,
    t.file,
    t.geometryColumn,
    t.geometryType,
    t.crsAssumed ? 1 : 0,
    t.headerSuspect ? 1 : 0,
    t.rowCount,
    t.createdAt,
    t.source,
    t.sourceParams ? JSON.stringify(t.sourceParams) : null,
    t.importedAt,
    serializeGeometryStorage(t),
  );
}

/** The measured facts a refresh replaces after an atomic re-import. */
export interface TableDataUpdate extends GeometryStorage {
  file: string;
  geometryColumn: string | null;
  geometryType: string | null;
  crsAssumed: boolean;
  /** The suspect-header state, recomputed by the refresh's own read
   * a refresh may add or clear it. */
  headerSuspect: boolean;
  rowCount: number;
  importedAt: string | null;
  /** When present, the re-run recipe swaps in the same statement: a
   * release move can never be separated from the data it produced. */
  sourceParams?: Record<string, unknown>;
  /** When present, where the replacing data came from: a run replacing a
   * copied template result makes it an operation's output. */
  source?: TableSource;
}

/** Returns whether a row was actually swapped — a refresh racing a delete
 * must be able to read the difference. Keyed on name *and* id: a name
 * reclaimed by a newer import is a different table, and a refresh of the
 * deleted one must never write into it. */
export function updateTableData(
  ref: { name: string; id: string; file?: string },
  u: TableDataUpdate,
  db: Database = metadataDb(),
): boolean {
  const setParams = (u.sourceParams !== undefined ? `, source_params = ?` : "") + (u.source !== undefined ? `, source = ?` : "");
  const values: unknown[] = [
    u.file,
    u.geometryColumn,
    u.geometryType,
    u.crsAssumed ? 1 : 0,
    u.headerSuspect ? 1 : 0,
    u.rowCount,
    u.importedAt,
    serializeGeometryStorage(u),
  ];
  if (u.sourceParams !== undefined) values.push(JSON.stringify(u.sourceParams));
  if (u.source !== undefined) values.push(u.source);
  values.push(ref.name, ref.id);
  if (ref.file !== undefined) values.push(ref.file);
  const info = db
    .prepare(
      `UPDATE data_tables
       SET file = ?, geometry_column = ?, geometry_type = ?, crs_assumed = ?,
           header_suspect = ?, row_count = ?, imported_at = ?, geometry_recognition = ?${setParams}
       WHERE name = ? AND id = ?${ref.file !== undefined ? " AND file = ?" : ""}`,
    )
    .run(...values);
  return info.changes > 0;
}

/** Heal a legacy classification only for the identity and artifact measured
 * A late inspection must not overwrite a refresh or reclaimed name. */
export function updateTableGeometryType(
  ref: Pick<DataTable, "name" | "id" | "file">,
  geometryType: string | null,
  db: Database = metadataDb(),
): void {
  db.prepare(`UPDATE data_tables SET geometry_type = ? WHERE name = ? AND id = ? AND file = ?`).run(
    geometryType,
    ref.name,
    ref.id,
    ref.file,
  );
}

export function listTables(db: Database = metadataDb()): DataTable[] {
  const rows = db
    .prepare(`SELECT * FROM data_tables ORDER BY created_at DESC, name`)
    .all() as TableRow[];
  return rows.map(tableFromRow);
}

/** PostGIS snapshots owned by one durable connection id. The stored display
 * name is provenance text only and never participates in ownership. */
export function listPostgisSnapshots(
  scope: AccountScope,
  connectionId: string,
  db: Database = metadataDb(),
): DataTable[] {
  requireOwnedResource(scope, "connection", connectionId, db);
  return listOwnedTables(scope, db).filter(
    (table) =>
      table.source === "postgis" &&
      table.sourceParams?.connectionId === connectionId,
  );
}

export function getTableByName(
  name: string,
  db: Database = metadataDb(),
): DataTable | null {
  const row = db
    .prepare(`SELECT * FROM data_tables WHERE name = ?`)
    .get(name) as TableRow | undefined;
  return row ? tableFromRow(row) : null;
}

export function tableNames(db: Database = metadataDb()): Set<string> {
  const rows = db.prepare(`SELECT name FROM data_tables`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

export function deleteTable(name: string, db: Database = metadataDb()): boolean {
  const info = db.prepare(`DELETE FROM data_tables WHERE name = ?`).run(name);
  return info.changes > 0;
}
