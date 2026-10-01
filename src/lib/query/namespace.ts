import type { Database } from "better-sqlite3";
import type { DuckDBConnection } from "@duckdb/node-api";
import { datasetReachOf, reachableDatasetIds } from "@/lib/auth/reach";
import { requireAccountScope } from "@/lib/auth/scope";
import { metadataDb } from "@/lib/metadata/db";
import { isPublicationScope, requirePublicationScope } from "@/lib/publish/publication-scope";
import type { DatasetScope } from "./access";
import { ownerlessDatasets, reachableDatasets, type Namespace } from "./bindings";

function sqlNameOf(account: string | null, db: Database): string | null {
  if (account === null) return null;
  const row = db.prepare("SELECT sql_name FROM accounts WHERE id = ?").get(account) as { sql_name: string | null } | undefined;
  return row?.sql_name ?? null;
}

/**
 * The namespace an evaluation binds names in. A signed-in caller's SQL has
 * the caller as its home and the caller's reach; a publication has its
 * owner's. The reach comes from the reach kernel and nowhere else.
 */
export function namespaceFor(scope: DatasetScope, db: Database = metadataDb()): Namespace {
  if (isPublicationScope(scope)) {
    const owner = requirePublicationScope(scope, db);
    const datasets = owner === null ? ownerlessDatasets(db) : reachableDatasets(datasetReachOf(owner, db), db);
    return { home: { id: owner, sqlName: sqlNameOf(owner, db) }, datasets, outputs: new Map() };
  }
  const me = requireAccountScope(scope, db);
  return { home: { id: me, sqlName: sqlNameOf(me, db) }, datasets: reachableDatasets(reachableDatasetIds(scope, db), db), outputs: new Map() };
}

/** The namespace an evaluation's connection binds in. */
export function bindingNamespace(_conn: DuckDBConnection, scope: DatasetScope): Namespace {
  return namespaceFor(scope);
}
