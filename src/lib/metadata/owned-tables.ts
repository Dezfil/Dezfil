import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { sqlReferencesTable } from "@/lib/table-deps";
import { metadataDb } from "./db";
import { fileTable } from "./projects";
import { tableFromRow, updateTableData, type TableRow, type DataTable, type TableDataUpdate } from "./tables";

/** Select private rows before decoding provenance or inspecting an artifact. */
export function listOwnedTables(scope: AccountScope, db: Database = metadataDb()): DataTable[] {
  const owner = requireAccountScope(scope, db);
  return (db.prepare("SELECT * FROM data_tables WHERE owner_id = ? ORDER BY created_at DESC, name").all(owner) as TableRow[]).map(tableFromRow);
}
export function getOwnedTableByName(scope: AccountScope, name: string, db: Database = metadataDb()): DataTable | null {
  const owner = requireAccountScope(scope, db);
  const row = db.prepare("SELECT * FROM data_tables WHERE owner_id = ? AND name = ?").get(owner, name) as TableRow | undefined;
  return row ? tableFromRow(row) : null;
}
export function ownedTableNames(scope: AccountScope, db: Database = metadataDb()): Set<string> {
  const owner = requireAccountScope(scope, db);
  return new Set((db.prepare("SELECT name FROM data_tables WHERE owner_id = ?").all(owner) as { name: string }[]).map(r => r.name));
}
export function deleteOwnedTable(scope: AccountScope, table: Pick<DataTable, "id" | "name">, db: Database = metadataDb()): boolean {
  const owner = requireAccountScope(scope, db);
  return db.prepare("DELETE FROM data_tables WHERE owner_id = ? AND id = ? AND name = ?").run(owner, table.id, table.name).changes > 0;
}
export function updateOwnedTableData(scope: AccountScope, ref: { id: string; name: string; file?: string }, update: TableDataUpdate, db: Database = metadataDb()): boolean {
  return db.transaction(() => {
    requireOwnedResource(scope, "dataset", ref.id, db);
    return updateTableData(ref, update, db);
  })();
}
export function ownedTableProjectIds(scope: AccountScope, db: Database = metadataDb()): Map<string, string[]> {
  const owner = requireAccountScope(scope, db);
  const rows = db.prepare(`SELECT pd.table_id, pd.project_id FROM project_datasets pd
    JOIN projects p ON p.id = pd.project_id JOIN data_tables t ON t.id = pd.table_id
    WHERE p.owner_id = ? AND t.owner_id = ? ORDER BY pd.project_id`).all(owner, owner) as { table_id: string; project_id: string }[];
  const memberships = new Map<string, string[]>();
  for (const row of rows) memberships.set(row.table_id, [...(memberships.get(row.table_id) ?? []), row.project_id]);
  return memberships;
}
export function fileOwnedTable(scope: AccountScope, tableId: string, projectId: string, db: Database = metadataDb()): void {
  requireOwnedResource(scope, "dataset", tableId, db);
  requireOwnedResource(scope, "project", projectId, db);
  fileTable(tableId, projectId, db);
}
/** Dataset mutations invalidate only maps in the same account's SQL space. */
export function ownedDependentLayerIds(scope: AccountScope, name: string, db: Database = metadataDb()): string[] {
  const owner = requireAccountScope(scope, db);
  const rows = db.prepare(`SELECT l.id, l.sql FROM layers l JOIN maps m ON m.id = l.map_id WHERE m.owner_id = ?`).all(owner) as { id: string; sql: string }[];
  return rows.filter(row => sqlReferencesTable(row.sql, name)).map(row => row.id);
}
