import { withTrustedMutation } from "@/lib/trusted-mutation";
import { isTrustedOperationRefusal } from "@/lib/trusted-operation";
import { trustedNativeConnection, endTrustedConnectionWork, trustedEngineError } from "@/lib/trusted-connection";
import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { withConnection } from "@/lib/duckdb";
import { resolveAllowed } from "@/lib/net/egress";
import { PgSourceOwner, previewSourceError } from "./source-owner";
import type { PgConnection } from "@/lib/metadata/connections";

/**
 * PostGIS access layer — everything goes through DuckDB's postgres
 * extension on the trusted instance: a READ_ONLY attach plus pass-through
 * queries executed on the source. The hardened instance never touches the
 * network; imports materialize like every other source.
 */

export interface ConnectionTarget
  extends Pick<
    PgConnection,
    "host" | "port" | "database" | "username" | "ssl"
  > {
  password: string;
}

function libpqEscape(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function attachString(
  target: ConnectionTarget,
  hostaddr?: string,
  sourceIdentity?: string,
): string {
  return [
    `host=${libpqEscape(target.host)}`,
    // The vetted address from the egress policy: libpq connects to
    // hostaddr while host keeps naming the server for auth/TLS, so the
    // approved address is the connected address.
    ...(hostaddr ? [`hostaddr=${libpqEscape(hostaddr)}`] : []),
    `port=${target.port}`,
    `dbname=${libpqEscape(target.database)}`,
    `user=${libpqEscape(target.username)}`,
    `password=${libpqEscape(target.password)}`,
    `sslmode=${target.ssl ? "require" : "prefer"}`,
    // Fail fast instead of hanging on unreachable hosts.
    `connect_timeout=10`,
    // Source startup options are inherited by every connection the attachment
    // opens, including extension work connections.
    ...(sourceIdentity ? [`application_name=${libpqEscape(sourceIdentity)}`] : []),
    `options=${libpqEscape("-c statement_timeout=30000")}`,
  ].join(" ");
}

function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Quote a Postgres identifier for pass-through SQL. */
export function pgIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function mapAttachError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const friendly = /password authentication|authentication failed/i.test(
    message,
  )
    ? "Authentication failed. Check the username and password."
    : /database .* does not exist/i.test(message)
      ? "The database does not exist on that server."
      : /timeout|timed out|could not connect|connection refused|no route|could not translate/i.test(
            message,
          )
        ? "The server is unreachable. Check host, port, and network."
        : "The connection failed while accessing the source.";
  throw new ApiError("connection_failed", friendly, 502);
}

/** Attach read-only, run work, always detach. */
export async function withPg<T>(
  target: ConnectionTarget,
  fn: (
    conn: import("@duckdb/node-api").DuckDBConnection,
    passthrough: (sql: string) => string,
  ) => Promise<T>,
  options: { signal?: AbortSignal; preview?: boolean } = {},
): Promise<T> {
  return withTrustedMutation({ kind: "interactive-read", name: "PostGIS source", signal: options.signal }, async operation => {
    const owner = new PgSourceOwner(operation.signal);
    owner.check();
    // Egress policy first: a blocked destination is rejected before
    // anything is loaded or contacted, with the one uniform error — this
    // endpoint must not act as an internal port scanner.
    let hostaddr: string;
    try {
      [hostaddr] = await resolveAllowed(target.host);
    } catch (error) {
      owner.check();
      if (isTrustedOperationRefusal(error)) throw error;
      throw new ApiError(
        "connection_failed",
        "The server is unreachable. Check host, port, and network.",
        502,
      );
    }
    owner.check();
    const identity = randomUUID().replace(/-/g, "");
    const alias = `pg_${identity}`;
    return withConnection(async (conn) => {
      owner.check();
      const native = trustedNativeConnection(conn);
      const guarded = owner.bind(native);
      let attached = false;
      try {
        try {
          await guarded.run("INSTALL postgres; LOAD postgres;");
        } catch (error) {
          owner.check();
          const classified = trustedEngineError(error);
          if (isTrustedOperationRefusal(classified)) throw classified;
          throw new ApiError(
            "connection_failed",
            `The DuckDB postgres extension could not be loaded${
              error instanceof Error ? `: ${error.message}` : ""
            }`,
            502,
          );
        }
        owner.check();
        try {
          // Mark a successful native ATTACH before testing departure: a late
          // success still owns a catalogue that must be detached.
          await native.run(
            `ATTACH ${sqlLit(attachString(target, hostaddr, options.preview ? `dezfil_preview_${identity}` : `dezfil_source_${identity}`))} AS ${alias} (TYPE postgres, READ_ONLY)`,
          );
          attached = true;
        } catch (error) {
          owner.check();
          const classified = previewSourceError(trustedEngineError(error));
          if (isTrustedOperationRefusal(classified)) throw classified;
          mapAttachError(classified);
        }
        owner.check();
        const passthrough = (sql: string) =>
          `postgres_query(${sqlLit(alias)}, ${sqlLit(sql)})`;
        const result = await fn(guarded, passthrough);
        owner.check();
        return result;
      } finally {
        owner.drainComplete();
        const cleanup = endTrustedConnectionWork(conn);
        if (attached) await cleanup.run(`DETACH ${alias}`);
      }
    });
  });
}

export interface ConnectionHealth {
  serverVersion: string;
  postgisVersion: string | null;
}

export async function readConnectionHealth(
  conn: import("@duckdb/node-api").DuckDBConnection,
  passthrough: (sql: string) => string,
): Promise<ConnectionHealth> {
  const version = await conn.runAndReadAll(
    `SELECT * FROM ${passthrough("SELECT version() AS v")}`,
  );
  const serverVersion = String(version.getRowObjects()[0]?.v ?? "unknown");
  const ext = await conn.runAndReadAll(
    `SELECT * FROM ${passthrough(
      "SELECT extversion AS v FROM pg_extension WHERE extname = 'postgis'",
    )}`,
  );
  const postgisVersion = ext.getRowObjects()[0]?.v
    ? String(ext.getRowObjects()[0].v)
    : null;
  return { serverVersion, postgisVersion };
}

/** Test a connection: reachability, auth, and PostGIS presence. */
export async function testConnection(
  target: ConnectionTarget,
  signal?: AbortSignal,
): Promise<ConnectionHealth> {
  return withPg(target, readConnectionHealth, { signal });
}

export interface RemoteTable {
  schema: string;
  table: string;
  kind: "table" | "view" | "materialized_view";
  /** True only when pg_depend records membership in the PostGIS extension. */
  system: boolean;
  /** Null for attribute-only tables. */
  geometryColumn: string | null;
  geometryType: string | null;
  srid: number | null;
  spatialKind: "geometry" | "geography" | null;
  /**
   * Planner estimate: omitted for ordinary views, null when a table or
   * materialized view has never been analyzed, and numeric otherwise.
   * Zero is a known estimate and must not collapse into the unknown state.
   */
  approxRows?: number | null;
}

/** List the database's tables: spatial first (from the geometry catalogue),
 * then attribute-only — both importable (joins are the point). */
export async function browseRemoteTables(
  target: ConnectionTarget,
  signal?: AbortSignal,
): Promise<{ tables: RemoteTable[]; health: ConnectionHealth }> {
  return withPg(target, async (conn, passthrough) => {
    const health = await readConnectionHealth(conn, passthrough);
    // geometry_columns only exists with PostGIS installed; without it the
    // catalogue still lists attribute tables instead of erroring.
    const hasPostgis = health.postgisVersion !== null;
    const spatialJoin = hasPostgis
      ? `LEFT JOIN (
          SELECT DISTINCT ON (table_schema, table_name)
                 table_schema, table_name, spatial_column, spatial_type, srid, spatial_kind
          FROM (
            SELECT g.f_table_schema AS table_schema,
                   g.f_table_name AS table_name,
                   g.f_geometry_column AS spatial_column,
                   g.type AS spatial_type,
                   g.srid AS srid,
                   'geometry'::text AS spatial_kind
            FROM geometry_columns g
            UNION ALL
            SELECT g.f_table_schema AS table_schema,
                   g.f_table_name AS table_name,
                   g.f_geography_column AS spatial_column,
                   g.type AS spatial_type,
                   g.srid AS srid,
                   'geography'::text AS spatial_kind
            FROM geography_columns g
          ) spatial_columns
          ORDER BY table_schema, table_name, spatial_kind, spatial_column
        ) spatial
          ON spatial.table_schema = n.nspname
         AND spatial.table_name = c.relname`
      : `LEFT JOIN LATERAL (
          SELECT NULL::text AS spatial_column, NULL::text AS spatial_type,
                 NULL::int AS srid, NULL::text AS spatial_kind
          WHERE FALSE
        ) spatial ON TRUE`;
    const sql = `
      SELECT n.nspname AS schema_name,
             c.relname AS table_name,
             CASE c.relkind
               WHEN 'v' THEN 'view'
               WHEN 'm' THEN 'materialized_view'
               ELSE 'table'
             END AS relation_kind,
             (postgis_membership.objid IS NOT NULL) AS is_system,
             spatial.spatial_column AS geometry_column,
             spatial.spatial_type AS geometry_type,
             spatial.srid AS srid,
             spatial.spatial_kind AS spatial_kind,
             c.reltuples::bigint AS approx_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      ${spatialJoin}
      LEFT JOIN (
        SELECT DISTINCT dependency.objid
        FROM pg_depend dependency
        JOIN pg_extension extension
          ON extension.oid = dependency.refobjid
        WHERE dependency.classid = 'pg_class'::regclass
          AND dependency.refclassid = 'pg_extension'::regclass
          AND dependency.deptype = 'e'
          AND extension.extname = 'postgis'
      ) postgis_membership ON postgis_membership.objid = c.oid
      WHERE c.relkind IN ('r', 'p', 'm', 'v')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'tiger', 'tiger_data', 'topology')
      ORDER BY (spatial.spatial_column IS NULL), n.nspname, c.relname`;
    const read = await conn.runAndReadAll(
      `SELECT * FROM ${passthrough(sql.replace(/\s+/g, " ").trim())}`,
    );
    const tables = (read.getRowObjects() as unknown as Record<string, unknown>[]).map(
      (r) => {
        const kind = String(r.relation_kind) as RemoteTable["kind"];
        return {
          schema: String(r.schema_name),
          table: String(r.table_name),
          kind,
          system: Boolean(r.is_system),
          geometryColumn: r.geometry_column ? String(r.geometry_column) : null,
          geometryType: r.geometry_type ? String(r.geometry_type) : null,
          srid: r.srid === null || r.srid === undefined ? null : Number(r.srid),
          spatialKind: r.spatial_kind
            ? (String(r.spatial_kind) as RemoteTable["spatialKind"])
            : null,
          ...(kind === "view"
            ? {}
            : {
                approxRows:
                  r.approx_rows === null ||
                  r.approx_rows === undefined ||
                  Number(r.approx_rows) < 0
                    ? null
                    : Number(r.approx_rows),
              }),
        };
      },
    );
    return { tables, health };
  }, { signal });
}

export async function listRemoteTables(
  target: ConnectionTarget,
  signal?: AbortSignal,
): Promise<RemoteTable[]> {
  return (await browseRemoteTables(target, signal)).tables;
}

/** Conservative validation for the optional attribute filter — it executes
 * on the source inside one SELECT; statement smuggling is rejected outright
 * (the read-only attach and the recommended read-only role are the other
 * layers). */
export function assertFilterSafe(filter: string): void {
  if (/[;\0]|--|\/\*/.test(filter)) {
    throw new ApiError(
      "invalid_request",
      "The filter must be a single WHERE expression: no statement separators or comments.",
      400,
    );
  }
}

export interface RemoteColumn {
  name: string;
  udt: string;
}

export async function fetchColumns(
  conn: import("@duckdb/node-api").DuckDBConnection,
  passthrough: (sql: string) => string,
  schema: string,
  table: string,
): Promise<RemoteColumn[]> {
  const sql = `SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = ${sqlLit(schema)} AND table_name = ${sqlLit(table)} ORDER BY ordinal_position`;
  const read = await conn.runAndReadAll(
    `SELECT * FROM ${passthrough(sql)}`,
  );
  return (read.getRowObjects() as unknown as Record<string, unknown>[]).map(
    (r) => ({ name: String(r.column_name), udt: String(r.udt_name) }),
  );
}

/**
 * The pass-through SELECT for an import: geometry columns become WKB via
 * the source's own ST_AsBinary(ST_Transform(…, 4326)) — CRS normalization
 * where PostGIS lives; everything else comes as-is.
 */
export function composeImportSelect(
  schema: string,
  table: string,
  columns: RemoteColumn[],
  filter?: string,
  limit?: number,
): string {
  if (columns.length === 0) {
    throw new ApiError(
      "not_found",
      `Table ${schema}.${table} has no columns or does not exist.`,
      404,
    );
  }
  const parts = columns.map((c) =>
    c.udt === "geometry" || c.udt === "geography"
      ? `ST_AsBinary(ST_Transform(${pgIdent(c.name)}::geometry, 4326)) AS ${pgIdent(c.name)}`
      : pgIdent(c.name),
  );
  let sql = `SELECT ${parts.join(", ")} FROM ${pgIdent(schema)}.${pgIdent(table)}`;
  if (filter && filter.trim()) {
    assertFilterSafe(filter);
    sql += ` WHERE ${filter.trim()}`;
  }
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ApiError(
        "invalid_request",
        "The row limit must be a positive integer.",
        400,
      );
    }
    sql += ` LIMIT ${limit}`;
  }
  return sql;
}
