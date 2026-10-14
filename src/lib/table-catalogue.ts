import { withTrustedOperation } from "@/lib/trusted-operation";
import type { AccountScope } from "@/lib/auth/scope";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { dataDir } from "@/lib/config";
import { withConnection } from "@/lib/duckdb";
import { catalogueRecords, type CatalogueQuery } from "@/lib/metadata/table-catalogue";
import { reachedTableProjectIds } from "@/lib/metadata/owned-tables";
import { trackInflight } from "@/lib/query/inflight";

export const CATALOGUE_MAX_BYTES = 96 * 1024;
export interface CatalogueTable {
  id: string; name: string;
  /** The name the caller would type: plain for their own, `<sql name>.<name>` for someone else's. */
  qualifiedName: string;
  owner: { name: string; sqlName: string };
  /** The projects through which the caller reaches the dataset: those it is
   * filed in that the caller owns or belongs to. Identities only. */
  projectIds: string[];
  rowCount: number;
  geometryColumn: string | null; geometryType: string | null; crsAssumed: boolean;
  columns: { name: string; type: string }[]; columnCount: number; nextColumnOffset: number | null;
}
export interface TableCatalogue { tables: CatalogueTable[]; total: number; nextAfter: string | null }

export function parseCatalogueQuery(url: URL): CatalogueQuery {
  const params = url.searchParams;
  const allowed = new Set(["after", "names", "project", "limit", "columns", "columnOffset"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new ApiError("invalid_request", "Unknown or repeated catalogue parameter.", 400);
  }
  function number(key: string, fallback: number, min: number, max: number) {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new ApiError("invalid_request", `Invalid catalogue ${key}.`, 400);
    }
    return Number(value);
  }
  const names = params.has("names") ? params.get("names")!.split(",") : undefined;
  if (names && (names.length > 32 || names.some((name) => !name.trim()) || new Set(names).size !== names.length)) {
    throw new ApiError("invalid_request", "Provide 1 to 32 distinct table names.", 400);
  }
  const project = params.get("project") ?? undefined;
  if (project !== undefined && !project.trim()) throw new ApiError("invalid_request", "Provide a project identity or none.", 400);
  return { after: params.get("after") ?? undefined, names, project, limit: number("limit", 32, 1, 32), columns: number("columns", 64, 0, 64), columnOffset: number("columnOffset", 0, 0, Number.MAX_SAFE_INTEGER) };
}

/** Only Parquet footer/schema metadata is evaluated. In particular this does
 * not use artifactRelation's row probe or inspection's preview/healing path.
 */
export async function readTableCatalogue(scope: AccountScope, query: CatalogueQuery, signal?: AbortSignal): Promise<TableCatalogue> {
  return withTrustedOperation({ kind: "interactive-read", name: "Dataset catalogue", signal }, async operation => {
    const { records, total, more } = catalogueRecords(scope, query);
    const memberships = reachedTableProjectIds(scope);
    return trackInflight(withConnection(async (conn) => {
      const tables: CatalogueTable[] = [];
      for (const record of records) {
        operation.assertCanCommit();
        const artifact = path.join(dataDir(), record.file).replace(/'/g, "''");
        await conn.run(`CREATE OR REPLACE TEMP VIEW catalogue_schema AS SELECT * FROM read_parquet('${artifact}')`);
        const count = await conn.runAndReadAll("SELECT COUNT(*) AS count FROM pragma_table_info('catalogue_schema')");
        const columnCount = Number(count.getRowObjects()[0].count);
        const described = await conn.runAndReadAll(`SELECT name, type FROM pragma_table_info('catalogue_schema') ORDER BY cid LIMIT ${query.columns} OFFSET ${query.columnOffset}`);
        const columns = described.getRowObjects() as unknown as { name: string; type: string }[];
        tables.push({
          id: record.id, name: record.name, qualifiedName: record.qualified,
          owner: { name: record.owner_name, sqlName: record.owner_sql_name },
          projectIds: [...(memberships.get(record.id) ?? [])].sort(), rowCount: record.row_count,
          geometryColumn: record.geometry_column, geometryType: record.geometry_type, crsAssumed: Boolean(record.crs_assumed),
          columns, columnCount, nextColumnOffset: query.columnOffset + columns.length < columnCount ? query.columnOffset + columns.length : null,
        });
        if (Buffer.byteLength(JSON.stringify(tables)) > CATALOGUE_MAX_BYTES) throw new ApiError("catalogue_too_large", "The schema page exceeds 96 KiB. Request fewer tables or columns.", 422);
      }
      const result = { tables, total, nextAfter: more ? tables.at(-1)!.qualifiedName : null };
      if (Buffer.byteLength(JSON.stringify(result)) > CATALOGUE_MAX_BYTES) throw new ApiError("catalogue_too_large", "The schema page exceeds 96 KiB. Request fewer tables or columns.", 422);
      return result;
    }));
  });
}
