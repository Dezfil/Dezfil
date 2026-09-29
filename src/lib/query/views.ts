import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { dataDir } from "@/lib/config";
import { catalogGenerationOf } from "@/lib/duckdb";
import type { DataTable } from "@/lib/metadata/tables";
import { artifactRelations, invalidateArtifactRelations } from "./catalog-state";
import { artifactRelation } from "./artifact-relation";
import { scopedDatasets, requireDatasetScope, type DatasetScope } from "./access";

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Names and views belong to this connection alone. The weak map only supports
 * reconciliation when an internal caller explicitly reuses its connection. */
const mounted = new WeakMap<DuckDBConnection, Set<string>>();
export async function registerTableViews(
  scope: DatasetScope,
  conn: DuckDBConnection,
  abandoned?: () => boolean,
  afterRegistration?: (registered: readonly DataTable[]) => Promise<void>,
): Promise<void> {
  const owner = requireDatasetScope(scope);
  const tables = scopedDatasets(scope);
  const relations = artifactRelations(catalogGenerationOf(conn));
  const previous = mounted.get(conn) ?? new Set<string>();
  mounted.set(conn, previous);
  const current = new Set(tables.map(t => t.name));
  for (const name of previous) {
    if (abandoned?.()) return;
    if (!current.has(name)) {
      await conn.run(`DROP VIEW IF EXISTS temp.main.${ident(name)}`);
      previous.delete(name);
    }
  }
  const keys = new Set(tables.map(table => JSON.stringify([owner, table.name, table.id, table.file, table.geometryColumn])));
  for (const key of relations.keys()) {
    if (JSON.parse(key)[0] === owner && !keys.has(key)) relations.delete(key);
  }
  const registered: DataTable[] = [];
  for (const table of tables) {
    if (abandoned?.()) return;
    const key = JSON.stringify([owner, table.name, table.id, table.file, table.geometryColumn]);
    const relation = relations.get(key) ?? await artifactRelation(conn, path.join(dataDir(), table.file), table.geometryColumn);
    if (abandoned?.()) return;
    try {
      await conn.run(`CREATE OR REPLACE TEMP VIEW ${ident(table.name)} AS SELECT * FROM ${relation.from}`);
      previous.add(table.name);
      registered.push(table);
      if (relation.probed) relations.set(key, relation);
    } catch (error) {
      if (abandoned?.()) return;
      await conn.run(`DROP VIEW IF EXISTS temp.main.${ident(table.name)}`).catch(() => {});
      previous.delete(table.name);
      relations.delete(key);
      console.warn(`table view "${table.name}" not registered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  requireDatasetScope(scope);
  if (!abandoned?.()) await afterRegistration?.(registered);
}

/** Deleted names disappear at the next admission. Existing evaluations retain
 * their own view and artifact until their reader lease ends. */
export async function dropTableView(scope: DatasetScope, name: string): Promise<void> {
  invalidateArtifactRelations(requireDatasetScope(scope), name);
}
