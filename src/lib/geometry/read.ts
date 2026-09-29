import type { AccountScope } from "@/lib/auth/scope";
import { createHash } from "node:crypto";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { dataDir } from "@/lib/config";
import { withConnection } from "@/lib/duckdb";
import { ApiError } from "@/lib/api/errors";
import { requireTable } from "@/lib/table-service";
import type { DataTable } from "@/lib/metadata/tables";
import { artifactRelation } from "@/lib/query/artifact-relation";
import { trackInflight } from "@/lib/query/inflight";
import type { GeometryChoice } from "./types";

export const GEOMETRY_SOURCE_REFUSAL = "Set geometry is available for file uploads and URL imports. SQL and workflow datasets take geometry from their SQL; PostGIS tables bring their own.";
export function geometryRevision(table: DataTable): string {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return `${hash(table.id)}.${hash(table.file)}`;
}
export function requireGeometryTable(scope: AccountScope, name: string, expectedRevision?: string): DataTable {
  const table = requireTable(scope, name);
  if (table.source !== "upload" && table.source !== "url") {
    throw new ApiError("geometry_not_supported", GEOMETRY_SOURCE_REFUSAL, 409);
  }
  const revision = geometryRevision(table);
  if (expectedRevision !== undefined && /^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(expectedRevision) && expectedRevision.split(".")[0] !== revision.split(".")[0]) {
    throw new ApiError("not_found", "That dataset was deleted. Its name now belongs to another dataset.", 404);
  }
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new ApiError("input_changed", "The dataset changed. Inspect its geometry again before continuing.", 409);
  }
  return table;
}
export function readGeometry<T>(table: DataTable, read: (conn: DuckDBConnection, from: string) => Promise<T>): Promise<T> {
  return trackInflight(withConnection(async conn => {
    const { from } = await artifactRelation(conn, path.join(dataDir(), table.file), table.geometryColumn);
    return read(conn, from);
  }));
}
export async function geometryColumns(conn: DuckDBConnection, from: string) {
  const described = (await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${from}`)).getRowObjects();
  return described.map(c => ({ name: String(c.column_name), type: String(c.column_type) }));
}
export function retainedChoice(table: DataTable, columns: { name: string }[]): GeometryChoice | null {
  const r = table.geometryRecord;
  return r && r.columns.every(name => name !== table.geometryColumn && columns.some(c => c.name === name))
    ? { format: r.format, columns: r.columns } : null;
}
