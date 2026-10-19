import { registerExistingAccountFile } from "@/lib/ingest/file-ownership";
import { notifyPictureData } from "@/lib/pictures/hooks";
import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { REACHED_PROJECTS, requireReachable } from "@/lib/auth/reach";
import type { AccountLabel } from "./accounts";
import { dependentLayerIds } from "@/lib/table-deps";
import { metadataDb } from "./db";
import { fileTable } from "./owned-projects";
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
/** Every dataset name one account holds, for allocating names that must be
 * free in that account's space. */
export function tableNamesOf(accountId: string, db: Database = metadataDb()): string[] {
  return (db.prepare("SELECT name FROM data_tables WHERE owner_id = ?").all(accountId) as { name: string }[]).map((r) => r.name);
}
/** Whether any of the accounts holds a dataset of this name, case aside: a
 * declared output's name is taken where the output would shadow or land. */
export function tableNameHeld(accountIds: readonly string[], name: string, db: Database = metadataDb()): boolean {
  if (accountIds.length === 0) return false;
  return !!db.prepare(`SELECT 1 FROM data_tables WHERE lower(name) = lower(?)
    AND owner_id IN (${accountIds.map(() => "?").join(", ")}) LIMIT 1`).get(name, ...accountIds);
}
export function ownedTableNames(scope: AccountScope, db: Database = metadataDb()): Set<string> {
  const owner = requireAccountScope(scope, db);
  return new Set((db.prepare("SELECT name FROM data_tables WHERE owner_id = ?").all(owner) as { name: string }[]).map(r => r.name));
}
export function deleteOwnedTable(scope: AccountScope, table: Pick<DataTable, "id" | "name">, db: Database = metadataDb()): boolean {
  const owner = requireAccountScope(scope, db);
  const deleted = db.prepare("DELETE FROM data_tables WHERE owner_id = ? AND id = ? AND name = ?").run(owner, table.id, table.name).changes > 0;
  if (deleted) notifyPictureData(table.id);
  return deleted;
}
export function updateOwnedTableData(scope: AccountScope, ref: { id: string; name: string; file?: string }, update: TableDataUpdate, db: Database = metadataDb()): boolean {
  return db.transaction(() => {
    const owner = requireAccountScope(scope, db);
    // Admission already resolved the owned identity. A deleted member must
    // reach the caller's guarded-swap failure, including group rollback.
    if (!db.prepare("SELECT id FROM data_tables WHERE id = ? AND owner_id = ?").get(ref.id, owner)) return false;
    const previous = db.prepare("SELECT file FROM data_tables WHERE id = ? AND owner_id = ?").get(ref.id, owner) as { file: string };
    registerExistingAccountFile(owner, previous.file);
    registerExistingAccountFile(owner, update.file);
    return updateTableData(ref, update, db);
  })();
}
/** Repair only the admitted owner's measured identity and artifact. A late
 * read may finish after deletion without healing a replacement dataset. */
export function updateOwnedTableGeometryType(scope: AccountScope, ref: Pick<DataTable, "id" | "name" | "file">,
  geometryType: string | null, db: Database = metadataDb()): void {
  const owner = requireAccountScope(scope, db);
  db.prepare("UPDATE data_tables SET geometry_type = ? WHERE owner_id = ? AND id = ? AND name = ? AND file = ?")
    .run(geometryType, owner, ref.id, ref.name, ref.file);
}
/**
 * Every dataset's memberships as the acting account may know them: in the
 * projects it reaches, and for its own datasets in every project they are
 * filed in. A dataset's filing is a fact about the dataset, so its owner is
 * told of a membership in a project they were removed from, by identity,
 * and can withdraw it; anyone else's dataset filed in a project the account
 * does not reach never names that project.
 */
export function reachedTableProjectIds(scope: AccountScope, db: Database = metadataDb()): Map<string, string[]> {
  const me = requireAccountScope(scope, db);
  const rows = db.prepare(`SELECT pd.table_id, pd.project_id FROM project_datasets pd
    WHERE pd.project_id IN (${REACHED_PROJECTS})
      OR pd.table_id IN (SELECT id FROM data_tables WHERE owner_id = @me)
    ORDER BY pd.project_id`).all({ me }) as { table_id: string; project_id: string }[];
  const memberships = new Map<string, string[]>();
  for (const row of rows) memberships.set(row.table_id, [...(memberships.get(row.table_id) ?? []), row.project_id]);
  return memberships;
}

/** A dataset the acting account reaches, with its owner. */
export interface ReachedTable {
  table: DataTable;
  ownerId: string;
  owner: AccountLabel;
}
type ReachedRow = TableRow & { owner_id: string; owner_name: string; owner_sql_name: string };
const reachedOf = (row: ReachedRow): ReachedTable =>
  ({ table: tableFromRow(row), ownerId: row.owner_id, owner: { name: row.owner_name, sqlName: row.owner_sql_name } });
const REACHED_SELECT = `SELECT t.*, a.name AS owner_name, a.sql_name AS owner_sql_name
  FROM data_tables t JOIN accounts a ON a.id = t.owner_id`;

/** The datasets an account reaches, most recent first: its own, and every
 * dataset filed in a project it owns or belongs to. The rows are selected
 * through the reach rule before anything is decoded. */
export function listReachableTables(scope: AccountScope, db: Database = metadataDb()): ReachedTable[] {
  const me = requireAccountScope(scope, db);
  return (db.prepare(`${REACHED_SELECT}
    WHERE a.status NOT IN ('deleting', 'deleted') AND (t.owner_id = @me OR t.id IN (SELECT table_id FROM project_datasets WHERE project_id IN (${REACHED_PROJECTS})))
    ORDER BY t.created_at DESC, t.name`).all({ me }) as ReachedRow[]).map(reachedOf);
}

/** One dataset the acting account reaches, else the absent refusal. */
export function requireReachedTable(scope: AccountScope, id: string, db: Database = metadataDb()): ReachedTable {
  requireReachable(scope, "dataset", id, db);
  return reachedOf(db.prepare(`${REACHED_SELECT} WHERE t.id = ?`).get(id) as ReachedRow);
}
/** File the caller's own new dataset into a project by the filing rule: one
 * the caller owns or edits, whose owner is active. */
export function fileOwnedTable(scope: AccountScope, tableId: string, projectId: string, db: Database = metadataDb()): void {
  requireOwnedResource(scope, "dataset", tableId, db);
  fileTable(scope, tableId, projectId, db);
}
/** The layers whose tiles drew the acting account's dataset of this name, by
 * its identity: whoever's map they sit on, and never a layer that read a
 * same-named dataset of someone else. */
export function ownedDependentLayerIds(scope: AccountScope, name: string, db: Database = metadataDb()): string[] {
  const table = getOwnedTableByName(scope, name, db);
  return table ? dependentLayerIds(table.id, db) : [];
}

/** A replacement names one owned durable identity, never just a SQL name. */
export function requireOwnedTableReference(scope: AccountScope, ref: { id: string; name: string }, db: Database = metadataDb()): void {
  const owner = requireAccountScope(scope, db);
  if (!db.prepare("SELECT id FROM data_tables WHERE id = ? AND name = ? AND owner_id = ?").get(ref.id, ref.name, owner)) throw resourceAbsent();
}
