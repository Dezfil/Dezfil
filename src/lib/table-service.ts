import { copyFileWork, bindDeletionInputs } from "@/lib/auth/account-deletion-work";
import { registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";
import { readBudgetedRows } from "@/lib/query/budget-reader";
import { ResultBudget, jsonBytes } from "@/lib/query/result-budget";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { reachableDatasetIds, requireReachable } from "@/lib/auth/reach";
import { getOwnedTableByName, listReachableTables, deleteOwnedTable, reachedTableProjectIds,
  ownedDependentLayerIds, updateOwnedTableGeometryType, type ReachedTable } from "@/lib/metadata/owned-tables";
import { presentDataset, type DatasetPresence } from "@/lib/dataset-presence";
import { addressDataset, requireOwnDataset } from "@/lib/dataset-address";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { limits } from "@/lib/limits";
import { withConnection } from "@/lib/duckdb";
import { ApiError } from "@/lib/api/errors";
import { resolveInputs, type ResolvedInput } from "@/lib/operations/provenance";
import {
  type DataTable,
} from "@/lib/metadata/tables";
import { collapseGeometryTypes } from "@/lib/ingest/ingest";
import {
  touchProjectsOf,
} from "@/lib/metadata/projects";
import { retireArtifact } from "@/lib/ingest/retire";
import { trackInflight } from "@/lib/query/inflight";
import { dropTableView } from "@/lib/query/views";
import { artifactRelation } from "@/lib/query/artifact-relation";
import { removeTileArtifacts } from "@/lib/tiles/build";

import { INSPECT_PREVIEW_ROWS } from "./table-preview-limit";

export interface TableInspection extends DataTable, DatasetPresence {
  columns: { name: string; type: string }[];
  preview: Record<string, unknown>[];
  sizeBytes: number | null;
  /** The projects this dataset is in; every Table-shaped
   * response carries it, detail reads included. */
  projectIds: string[];
  /** For a derived table: its recorded inputs, resolved by the id each
   * was recorded under, so a deleted input reads as missing rather than as
   * whatever now carries its name. Null for an imported table. */
  inputs: ResolvedInput[] | null;
}

/** A listed table plus its artifact's size on disk, the projects it
 * belongs to that the reader reaches (and for the reader's own, every one),
 * its owner and the name its reader would type. */
export type TableListing = DataTable & DatasetPresence & {
  sizeBytes: number | null;
  projectIds: string[];
};

async function artifactSize(table: DataTable): Promise<number | null> {
  try {
    return (await stat(path.join(dataDir(), table.file))).size;
  } catch {
    return null;
  }
}

/**
 * The datasets the acting account reaches: its own and every dataset filed
 * in a project it owns or belongs to, each with its owner and the name its
 * reader would type, so two same-named datasets both appear, once each.
 * `project` narrows to one reached project's datasets, whoever owns them;
 * `none` to the account's own datasets filed in no project at all: its own
 * memberships name even a project it no longer reaches.
 */
export function listTablesWithSize(
  scope: AccountScope,
  project?: string | "none",
): Promise<TableListing[]> {
  // An unknown or unreached project refuses, never an empty list.
  requireAccountScope(scope);
  if (project && project !== "none") requireReachable(scope, "project", project);
  return withSizes(scope, listReachableTables(scope), project);
}

function withSizes(scope: AccountScope, reached: ReachedTable[], project?: string | "none"): Promise<TableListing[]> {
  const memberships = reachedTableProjectIds(scope);
  const reach = reachableDatasetIds(scope);
  return Promise.all(
    reached
      .map((t) => ({ reached: t, projectIds: memberships.get(t.table.id) ?? [] }))
      .filter((t) =>
        project === undefined
          ? true
          : project === "none"
            ? t.projectIds.length === 0 && t.reached.ownerId === scope.accountId
            : t.projectIds.includes(project),
      )
      .map(async (t) => ({
        ...presentDataset(scope, t.reached, reach),
        projectIds: t.projectIds,
        sizeBytes: await artifactSize(t.reached.table),
      })),
  );
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function requireTable(scope: AccountScope, name: string): DataTable {
  const table = getOwnedTableByName(scope, name);
  if (!table) {
    throw resourceAbsent();
  }
  return table;
}

/** Schema plus a row preview (spec: Upload — schema, row count, preview),
 * for the caller's own dataset by its bare name, or any dataset they reach by
 * its qualified name or identifier. */
export async function inspectTable(scope: AccountScope, name: string): Promise<TableInspection> {
  return inspectDataset(scope, addressDataset(scope, name));
}

/** A reached dataset's inspection, as its reader may see it: its origin
 * bounded, its recorded inputs resolved within the reader's reach, its
 * memberships in the projects the reader reaches. */
export async function inspectDataset(scope: AccountScope, reached: ReachedTable): Promise<TableInspection> {
  const table = reached.table;
  const inputs = resolveInputs(scope, table);
  const artifact = path.join(dataDir(), table.file);

  // A tracked artifact reader: retirement waits for this pass.
  return trackInflight(
    withConnection(async (conn) => {
      const { from } = await artifactRelation(
        conn,
        artifact,
        table.geometryColumn,
      );
      // Legacy MIXED rows predate the family-collapse rules: a table of
      // POLYGON + MULTIPOLYGON is polygons. Determine the final envelope
      // before decoding preview values; persist the repair after admission.
      let geometryType = table.geometryType;
      if (geometryType === "MIXED" && table.geometryColumn) {
        const typed = await conn.runAndReadAll(
          `SELECT DISTINCT ST_GeometryType(${ident(table.geometryColumn)}) AS t
         FROM ${from} LIMIT 5`,
        );
        geometryType = collapseGeometryTypes(
          typed.getRowObjects().map((r) => String(r.t)),
        );
      }
      const envelope = {
        ...presentDataset(scope, reached),
        geometryType,
        columns: [], preview: [],
        sizeBytes: await artifactSize(table),
        projectIds: reachedTableProjectIds(scope).get(table.id) ?? [],
        inputs,
      };
      const budget = new ResultBudget();
      budget.take(jsonBytes(envelope));
      // Schema entries count toward the answer, not as preview cells.
      const columns = await readBudgetedRows(conn,
        `SELECT column_name AS name, column_type AS type FROM (DESCRIBE SELECT * FROM ${from})`,
        budget, new Set(["name", "type"]),
      ) as { name: string; type: string }[];

      // Geometry previews as WKT, not raw WKB bytes.
      const replace = table.geometryColumn
        ? ` REPLACE (ST_AsText(${ident(table.geometryColumn)}) AS ${ident(table.geometryColumn)})`
        : "";
      const nativeGeometry = new Set(columns.filter(c => c.name === table.geometryColumn &&
        (c.type === "GEOMETRY" || c.type.startsWith("GEOMETRY("))).map(c => c.name));
      const preview = await readBudgetedRows(conn,
        `SELECT *${replace} FROM ${from} LIMIT ${INSPECT_PREVIEW_ROWS}`, budget, nativeGeometry);

      if (geometryType !== table.geometryType) {
        updateOwnedTableGeometryType(scope, table, geometryType);
      }
      return { ...envelope, geometryType, columns, preview };
    }),
  );
}

export interface TableFeaturesResult {
  ok: boolean;
  name: string;
  geometryType: string | null;
  featureCount?: number;
  /** GeoJSON FeatureCollection when ok; features carry a stable row id. */
  geojson?: unknown;
  /** True when a capped subset was drawn; totalCount holds the
   * table's real row count so readouts stay truthful. */
  sampled?: boolean;
  totalCount?: number;
  /** When not ok: why this table cannot draw, in plain language. */
  reason?: string;
}

/** A table's features as GeoJSON for the dialog map — the
 * layer legend and Select from Layer read this. No geometry or over the
 * render cap returns ok:false with a reason, not an HTTP error, so the
 * legend can say so and the rest keeps working. With `sample`, an over-cap
 * table draws its first cap-many features instead of refusing (the dataset
 * detail's map preview). */
export async function tableFeatures(
  scope: AccountScope,
  name: string,
  opts: { sample?: boolean } = {},
): Promise<TableFeaturesResult> {
  const table = addressDataset(scope, name).table;
  if (!table.geometryColumn) {
    return {
      ok: false,
      name,
      geometryType: null,
      reason: "This table has no geometry column.",
    };
  }
  const overCap = table.rowCount > limits.renderCapFeatures;
  if (overCap && !opts.sample) {
    return {
      ok: false,
      name,
      geometryType: table.geometryType,
      reason: `${table.rowCount.toLocaleString()} features is over the render cap of ${limits.renderCapFeatures.toLocaleString()}, too many to draw here.`,
    };
  }
  const artifact = path.join(dataDir(), table.file);
  const geom = ident(table.geometryColumn);
  // A tracked artifact reader: retirement waits for this pass.
  return trackInflight(
    withConnection(async (conn) => {
      const { from } = await artifactRelation(
        conn,
        artifact,
        table.geometryColumn,
      );
      const rows = await conn.runAndReadAll(
        `SELECT ST_AsGeoJSON(${geom}) AS geometry
       FROM ${from} WHERE ${geom} IS NOT NULL
       ${overCap ? `LIMIT ${limits.renderCapFeatures}` : ""}`,
      );
      const features = rows.getRowObjects().map((r, i) => ({
        type: "Feature",
        id: i,
        geometry: JSON.parse(String(r.geometry)) as unknown,
        properties: { __table: name, __fid: i },
      }));
      return {
        ok: true,
        name,
        geometryType: table.geometryType,
        featureCount: features.length,
        ...(overCap ? { sampled: true, totalCount: table.rowCount } : {}),
        geojson: { type: "FeatureCollection", features },
      };
    }),
  );
}

export const EXPORT_FORMATS = ["geoparquet", "geojson", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return EXPORT_FORMATS.some((f) => f === value);
}

export interface TableExport {
  /** Absolute path of the file to stream. */
  path: string;
  filename: string;
  contentType: string;
  /** Removes a temp conversion after streaming; no-op for the artifact. */
  cleanup: () => Promise<void>;
}

/** A table as a downloadable file. GeoParquet is the stored
 * artifact byte-for-byte; GeoJSON and CSV are written by DuckDB into the
 * data dir's tmp corner for the route to stream and clean up. Runs on the
 * main instance — the hardened fence guards user SQL, not our exports. */
async function exportTableWork(
  scope: AccountScope,
  name: string,
  format: ExportFormat,
): Promise<TableExport> {
  const reached = addressDataset(scope, name);
  bindDeletionInputs([reached.ownerId]);
  const table = reached.table;
  const artifact = path.join(dataDir(), table.file);
  if (format === "geoparquet") {
    return {
      path: artifact,
      filename: `${name}.parquet`,
      contentType: "application/vnd.apache.parquet",
      cleanup: async () => {},
    };
  }
  if (format === "geojson" && !table.geometryColumn) {
    throw new ApiError(
      "invalid_request",
      "This table has no geometry column. Export CSV or GeoParquet instead.",
      400,
    );
  }
  const ext = format === "csv" ? "csv" : "geojson";
  const tmp = path.join(dataDir(), "tmp", `export-${randomUUID()}.${ext}`);
  registerAccountFile(scope.accountId, tmp);
  await mkdir(path.dirname(tmp), { recursive: true });
  // A tracked artifact reader: retirement waits for the conversion. A
  // conversion that fails after opening its target (a full disk, a late
  // write error) must not leave the partial file behind (review): the
  // caller never receives a cleanup for a rejected conversion, so the
  // writer removes its own target on the way out.
  try {
    await trackInflight(
      withConnection(async (conn) => {
        const { from } = await artifactRelation(
          conn,
          artifact,
          table.geometryColumn,
        );
        if (format === "geojson") {
          await conn.run(
            `COPY (SELECT * FROM ${from})
         TO ${lit(tmp)} WITH (FORMAT gdal, DRIVER 'GeoJSON')`,
          );
        } else {
          // CSV keeps every column; geometry reads as WKT text.
          const replace = table.geometryColumn
            ? ` REPLACE (ST_AsText(${ident(table.geometryColumn)}) AS ${ident(table.geometryColumn)})`
            : "";
          await conn.run(
            `COPY (SELECT *${replace} FROM ${from})
         TO ${lit(tmp)} WITH (FORMAT csv, HEADER)`,
          );
        }
      }),
    );
  } catch (e) {
    await removeAccountFile(tmp, { force: true });
    throw e;
  }
  return {
    path: tmp,
    filename: `${name}.${ext}`,
    contentType:
      format === "csv" ? "text/csv; charset=utf-8" : "application/geo+json",
    cleanup: () => removeAccountFile(tmp, { force: true }),
  };
}

/** Delete registry entry and artifact. Dependent layers keep their SQL and
 * enter an errored state when rendered (spec: Layers). The row read and the
 * row delete are one synchronous step — no await between them — so the
 * artifact retired is the one the registry referenced at the moment of
 * deletion: a concurrent refresh either swapped before (and its new
 * artifact is the one retired here, its old one by the refresh itself) or
 * finds the row gone and aborts without residue.
 *
 * Deletion is complete: dependent layers stop serving tiles built from the
 * deleted data and their archives are reclaimed; the shared catalog drops
 * the table's view, so SQL naming it answers unknown-table instead of an
 * engine file error; the artifact retires behind any in-flight readers. The
 * completeness tail is best-effort — the row removal above is the deletion
 * the caller reads. */
export async function removeTable(scope: AccountScope, address: string): Promise<void> {
  // Deletion is the owner's: another person's dataset is refused by the
  // permission shape, whichever address names it.
  const table = requireOwnDataset(scope, address).table;
  const name = table.name;
  const dependents = ownedDependentLayerIds(scope, name);
  // Every set it was in advances its clock before the cascade removes
  // the membership rows.
  touchProjectsOf({ tableId: table.id });
  deleteOwnedTable(scope, table);
  // Each cleanup step fails independently: a tile
  // reclamation error must not suppress the view drop, or SQL naming the
  // deleted table regains the artifact-path error this removes.
  const outcomes = await Promise.allSettled([
    ...dependents.map((lid) => removeTileArtifacts(lid)),
    dropTableView(scope, name),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      console.warn(
        `post-delete cleanup failed for "${name}": ${
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason)
        }`,
      );
    }
  }
  registerAccountFile(scope.accountId, table.file);
  retireArtifact(path.join(dataDir(), table.file));
}

export function exportTable(scope: AccountScope, name: string, format: ExportFormat): Promise<TableExport> { return copyFileWork(scope, [{ table: "data_tables", id: addressDataset(scope, name).table.id }], () => exportTableWork(scope, name, format)); }
