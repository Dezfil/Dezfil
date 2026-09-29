import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { ApiError } from "@/lib/api/errors";
import { registerTable, type DataTable } from "@/lib/metadata/tables";
import { metadataDb } from "@/lib/metadata/db";
import { fileTable } from "@/lib/metadata/projects";
import { importProjectId } from "@/lib/project-scope";
import {
  getConnection,
  connectionPassword,
  type PgConnection,
} from "@/lib/metadata/connections";
import { measureArtifact, type ArtifactMeta } from "@/lib/ingest/ingest";
import {
  withPg,
  fetchColumns,
  composeImportSelect,
  readConnectionHealth,
  type ConnectionHealth,
  type ConnectionTarget,
} from "./access";
import {
  isConnectionLevelFailure,
  recordConnectionFailure,
  recordConnectionHealth,
} from "./status";

/**
 * PostGIS snapshot import: one pass-through SELECT on the source,
 * materialized as a GeoParquet artifact — never live federation.
 */

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function requireTarget(connectionId: string): {
  connection: PgConnection;
  target: ConnectionTarget;
} {
  const connection = getConnection(connectionId);
  const password = connectionPassword(connectionId);
  if (!connection || password === null) {
    throw new ApiError(
      "not_found",
      `No PostGIS connection with id "${connectionId}".`,
      404,
    );
  }
  return { connection, target: { ...connection, password } };
}

export interface PostgisRecipe {
  connectionId: string;
  schema: string;
  table: string;
  filter?: string;
  limit?: number;
}

export interface PostgisArtifactMeta extends ArtifactMeta {
  connectionHealth: ConnectionHealth;
}

/** Produce and measure the artifact for a recipe — shared by first import
 * and refresh. Geometry columns arrive as WKB and are rebuilt as geometry
 * before the artifact is written. */
export async function buildPostgisArtifact(
  target: ConnectionTarget,
  recipe: PostgisRecipe,
  artifact: string,
  observeHealth?: (health: ConnectionHealth) => void,
): Promise<PostgisArtifactMeta> {
  await mkdir(path.dirname(artifact), { recursive: true });
  return withPg(target, async (conn, passthrough) => {
    const connectionHealth = await readConnectionHealth(conn, passthrough);
    observeHealth?.(connectionHealth);
    const columns = await fetchColumns(
      conn,
      passthrough,
      recipe.schema,
      recipe.table,
    );
    const select = composeImportSelect(
      recipe.schema,
      recipe.table,
      columns,
      recipe.filter,
      recipe.limit,
    );
    const geometryColumns = columns.filter(
      (c) => c.udt === "geometry" || c.udt === "geography",
    );
    const replace =
      geometryColumns.length > 0
        ? ` REPLACE (${geometryColumns
            .map((c) => `ST_GeomFromWKB(${ident(c.name)}) AS ${ident(c.name)}`)
            .join(", ")})`
        : "";
    try {
      await conn.run(
        `COPY (SELECT *${replace} FROM ${passthrough(select)}) TO ${lit(artifact)} (FORMAT PARQUET)`,
      );
    } catch (error) {
      throw new ApiError(
        "malformed_file",
        `The table could not be read from PostGIS: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        422,
      );
    }
    return {
      ...(await measureArtifact(conn, artifact, geometryColumns[0]?.name ?? null)),
      connectionHealth,
    };
  });
}

export interface PostgisImportRequest {
  connectionId: unknown;
  schema: unknown;
  table: unknown;
  name?: unknown;
  filter?: unknown;
  limit?: unknown;
  /** The project the snapshot joins; optional. */
  projectId?: unknown;
}

export function resolvePostgisRequest(request: PostgisImportRequest): {
  recipe: PostgisRecipe;
  requestedName?: string;
} {
  if (typeof request.connectionId !== "string" || !request.connectionId) {
    throw new ApiError("invalid_request", "connectionId is required.", 400);
  }
  if (typeof request.schema !== "string" || !request.schema) {
    throw new ApiError("invalid_request", "schema is required.", 400);
  }
  if (typeof request.table !== "string" || !request.table) {
    throw new ApiError("invalid_request", "table is required.", 400);
  }
  if (request.name !== undefined && typeof request.name !== "string") {
    throw new ApiError("invalid_request", "The name must be a string.", 400);
  }
  if (request.filter !== undefined && typeof request.filter !== "string") {
    throw new ApiError("invalid_request", "The filter must be a string.", 400);
  }
  let limit: number | undefined;
  if (request.limit !== undefined) {
    limit = Number(request.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ApiError(
        "invalid_request",
        "The row limit must be a positive integer.",
        400,
      );
    }
  }
  return {
    recipe: {
      connectionId: request.connectionId,
      schema: request.schema,
      table: request.table,
      ...(request.filter && request.filter.trim()
        ? { filter: request.filter.trim() }
        : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    ...(request.name && request.name.trim()
      ? { requestedName: request.name.trim() }
      : {}),
  };
}

/** Import a PostGIS table as a snapshot. */
export async function importPostgis(
  scope: AccountScope,
  request: PostgisImportRequest,
  build: typeof buildPostgisArtifact = buildPostgisArtifact,
): Promise<DataTable> {
  requireAccountScope(scope);
  const { recipe, requestedName } = resolvePostgisRequest(request);
  const { connection, target } = requireTarget(recipe.connectionId);

  const id = randomUUID();
  const relFile = path.join("tables", `${id}.parquet`);
  const artifact = path.join(dataDir(), relFile);
  let meta: PostgisArtifactMeta;
  let observedHealth: ConnectionHealth | null = null;
  try {
    meta = await build(target, recipe, artifact, (health) => {
      observedHealth = health;
    });
  } catch (error) {
    if (isConnectionLevelFailure(error)) {
      recordConnectionFailure(recipe.connectionId, error);
    } else if (observedHealth) {
      recordConnectionHealth(recipe.connectionId, observedHealth);
    }
    await rm(artifact, { force: true });
    throw error;
  }
  recordConnectionHealth(recipe.connectionId, meta.connectionHealth);
  try {
    const record: Omit<DataTable, "name"> = {
      id,
      sourceFilename: `${recipe.schema}.${recipe.table}`,
      format: "geoparquet",
      file: relFile,
      geometryColumn: meta.geometryColumn,
      geometryType: meta.geometryType,
      crsAssumed: false,
      headerSuspect: false,
      rowCount: meta.rowCount,
      createdAt: new Date().toISOString(),
      source: "postgis",
      sourceParams: {
        connectionId: recipe.connectionId,
        connectionName: connection.name,
        schema: recipe.schema,
        table: recipe.table,
        ...(recipe.filter ? { filter: recipe.filter } : {}),
        ...(recipe.limit !== undefined ? { limit: recipe.limit } : {}),
      },
      importedAt: new Date().toISOString(),
    };
    // Derive-and-register in one synchronous step; the project
    // membership commits with it.
    const db = metadataDb();
    const projectId = importProjectId(request.projectId);
    return db.transaction(() => {
      const table = registerTable(scope, record, requestedName ?? recipe.table, db);
      if (projectId) fileTable(table.id, projectId, db);
      return table;
    })();
  } catch (error) {
    await rm(artifact, { force: true });
    throw error;
  }
}
