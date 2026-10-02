import type { Database } from "better-sqlite3";
import type { DuckDBConnection } from "@duckdb/node-api";
import { datasetReachOf, reachableDatasetIds } from "@/lib/auth/reach";
import { requireAccountScope } from "@/lib/auth/scope";
import { deriveTableName } from "@/lib/ingest/naming";
import { metadataDb } from "@/lib/metadata/db";
import { isPublicationScope, requirePublicationScope, type PublicationScope } from "@/lib/publish/publication-scope";
import type { DatasetScope } from "./access";
import { ownerlessDatasets, reachableDatasets, type Namespace } from "./bindings";
import { contextOf } from "./context";
import { mountPlanOf } from "./mount-plan";
import { publicationKey, rememberedPublication, resolvePublication, type PublicationReach } from "./publication-namespace";

function sqlNameOf(account: string | null, db: Database): string | null {
  if (account === null) return null;
  const row = db.prepare("SELECT sql_name FROM accounts WHERE id = ?").get(account) as { sql_name: string | null } | undefined;
  return row?.sql_name ?? null;
}

type StepRow = { parameters: string; proposed_parameters: string | null; output_table_name: string | null;
  runner_output: string | null; runner_name: string | null };

/**
 * A workflow's declared outputs as one runner reads them. Every name a step
 * owns is reserved: the name its parameters declare, the name a pending
 * proposal declares, and the name its recorded output carries, each through
 * the sanitizer the registry applies. A name binds the dataset this runner's
 * latest successful run of that step produced, while it still exists; no
 * other runner's output and no same-named home dataset ever stands in.
 * A later step's claim on a name wins, as it does for workflow ordering.
 */
export function declaredOutputs(recipeId: string, runner: string | null, db: Database = metadataDb()): Map<string, string | null> {
  const steps = db.prepare(`SELECT s.parameters, s.proposed_parameters, s.output_table_name,
      o.output_table_id AS runner_output, o.output_table_name AS runner_name
    FROM recipe_steps s
    LEFT JOIN step_runner_outputs o ON o.step_id = s.id AND o.runner_id IS ?
      AND EXISTS (SELECT 1 FROM data_tables t WHERE t.id = o.output_table_id)
    WHERE s.recipe_id = ? ORDER BY s.ordinal`).all(runner, recipeId) as StepRow[];
  const declared = (json: string | null): string | null => {
    const params = json ? JSON.parse(json) as Record<string, unknown> : null;
    return params && typeof params.name === "string" && params.name !== "" ? deriveTableName(params.name, new Set()) : null;
  };
  const outputs = new Map<string, string | null>();
  for (const step of steps) {
    const produced = step.runner_name?.toLowerCase() ?? null;
    for (const name of [declared(step.parameters), declared(step.proposed_parameters), step.output_table_name, step.runner_name]) {
      if (!name) continue;
      const key = name.toLowerCase();
      outputs.set(key, key === produced ? step.runner_output : null);
    }
  }
  return outputs;
}

/**
 * The namespace an evaluation binds names in: its context's home, the
 * authority's reach and, for a workflow, the declared outputs. A signed-in
 * caller's reach comes from the reach kernel and nowhere else. A
 * publication has its owner's reach restricted to the datasets the map's
 * own SQL names (publication-namespace.ts), resolved by its evaluation's
 * registration; until that has happened it binds nothing.
 */
export function namespaceFor(scope: DatasetScope, db: Database = metadataDb()): Namespace {
  const full = unrestrictedNamespace(scope, db);
  const authority = contextOf(scope, db).authority;
  if (!isPublicationScope(authority)) return full;
  return rememberedPublication(authority.mapId, full, db)?.namespace ?? { ...full, datasets: [] };
}

/** A publication's namespace for an evaluation on this connection, its
 * restriction resolved here before anything is mounted. */
export async function publicationNamespace(conn: DuckDBConnection, scope: PublicationScope,
  db: Database = metadataDb()): Promise<PublicationReach> {
  return resolvePublication(conn, scope.mapId, unrestrictedNamespace(scope, db), db);
}

/** What a publication's mounts are resolved from (its map's layers' SQL and
 * its owner's reach in the map's home): when this moves, so may the
 * identities the link evaluates, and nothing assembled before may serve. */
export function publicationRevision(scope: PublicationScope, db: Database = metadataDb()): string {
  return publicationKey(scope.mapId, unrestrictedNamespace(scope, db), db);
}

/** The home and the authority's whole reach, before a publication's
 * restriction. */
function unrestrictedNamespace(scope: DatasetScope, db: Database): Namespace {
  const context = contextOf(scope, db);
  const authority = context.authority;
  let datasets, runner: string | null;
  if (isPublicationScope(authority)) {
    runner = requirePublicationScope(authority, db);
    datasets = runner === null ? ownerlessDatasets(db) : reachableDatasets(datasetReachOf(runner, db), db);
  } else {
    runner = requireAccountScope(authority, db);
    datasets = reachableDatasets(reachableDatasetIds(authority, db), db);
  }
  const outputs = context.workflow ? declaredOutputs(context.workflow, runner, db) : new Map<string, string | null>();
  return { home: { id: context.home, sqlName: sqlNameOf(context.home, db) }, datasets, outputs };
}

/** The namespace an evaluation's connection mounted, else the scope's own. */
export function bindingNamespace(conn: DuckDBConnection, scope: DatasetScope): Namespace {
  return mountPlanOf(conn)?.namespace ?? namespaceFor(scope);
}
