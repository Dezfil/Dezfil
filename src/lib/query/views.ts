import { accountMaterialAvailable, type AccountWorkLease } from "@/lib/auth/account-deletion-admission";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { registerQueryStore } from "@/lib/query/retained";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { dataDir } from "@/lib/config";
import { catalogGenerationOf } from "@/lib/duckdb";
import type { DataTable } from "@/lib/metadata/tables";
import { artifactRelations, invalidateArtifactRelations } from "./catalog-state";
import { artifactRelation, type ArtifactRelation } from "./artifact-relation";
import { requireDatasetScope, type DatasetScope } from "./access";
import { registryTable, type ReachableDataset } from "./bindings";
import { contextOf } from "./context";
import { namespaceFor, publicationNamespace } from "./namespace";
import { isPublicationScope } from "@/lib/publish/publication-scope";
import { planMounts, setMountPlan, type Mount } from "./mount-plan";

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** A dataset as this evaluation's registration bound it, under its view. */
export interface RegisteredMount extends DataTable {
  /** The view it answers under; absent for a synthetic binding. */
  view: string | null;
}

/** The artifact relation's cache identity: the dataset's owner and name,
 * its identity, its artifact and its geometry column. */
function relationKey(dataset: ReachableDataset): string {
  return JSON.stringify([dataset.ownerId, dataset.name, dataset.id, dataset.file, dataset.geometryColumn]);
}

/** Names and views belong to this connection alone. The weak map only supports
 * reconciliation when an internal caller explicitly reuses its connection. */
let mounted = new WeakMap<DuckDBConnection, Set<string>>();

/**
 * Mount one evaluation's namespace on its own connection: a view per dataset
 * the evaluation can see, under the name its context gives it (see
 * `mount-plan.ts`), reconciled against whatever an earlier registration on
 * the same connection left, and the plan the compiler and the guard read.
 */
export async function registerTableViews(
  scope: DatasetScope,
  conn: DuckDBConnection,
  abandoned?: () => boolean,
  afterRegistration?: (registered: readonly RegisteredMount[]) => Promise<void>,
  admission?: AccountWorkLease,
): Promise<void> {
  const caller = requireDatasetScope(scope);
  const context = contextOf(scope);
  // A publication mounts only the datasets its map's SQL names.
  const publication = isPublicationScope(context.authority) ? await publicationNamespace(conn, context.authority) : null;
  if (publication && abandoned?.()) return;
  const plan = planMounts(publication?.namespace ?? namespaceFor(scope), context.purpose, caller === context.home);
  // Resolution can await compilation. Admit discovered owners before any
  // artifact relation is consumed, even when a namespace came from a cache.
  const owners = plan.namespace.datasets.map(dataset => dataset.ownerId);
  if (admission) admission.bind(owners);
  else if (owners.some(owner => !accountMaterialAvailable(owner))) throw resourceAbsent();
  if (publication) plan.withheld = publication.withheld;
  const relations = artifactRelations(catalogGenerationOf(conn));
  const previous = mounted.get(conn) ?? new Set<string>();
  mounted.set(conn, previous);
  for (const name of previous) {
    if (abandoned?.()) return;
    if (!plan.views.has(name.toLowerCase()) || plan.views.get(name.toLowerCase())!.view !== name) {
      await conn.run(`DROP VIEW IF EXISTS temp.main.${ident(name)}`);
      previous.delete(name);
    }
  }
  const relationOf = async (dataset: ReachableDataset): Promise<ArtifactRelation> => {
    const key = relationKey(dataset);
    for (const other of relations.keys()) {
      const [owner, name] = JSON.parse(other);
      if (owner === dataset.ownerId && name === dataset.name && other !== key) relations.delete(other);
    }
    return relations.get(key) ?? await artifactRelation(conn, path.join(dataDir(), dataset.file), dataset.geometryColumn);
  };
  const registered: RegisteredMount[] = [];
  for (const { view, dataset } of plan.views.values() as Iterable<Mount>) {
    if (abandoned?.()) return;
    const key = relationKey(dataset);
    const relation = await relationOf(dataset);
    if (abandoned?.()) return;
    try {
      await conn.run(`CREATE OR REPLACE TEMP VIEW ${ident(view)} AS SELECT * FROM ${relation.from}`);
      previous.add(view);
      registered.push({ ...registryTable(dataset), view });
      if (relation.probed) relations.set(key, relation);
    } catch (error) {
      if (abandoned?.()) return;
      await conn.run(`DROP VIEW IF EXISTS temp.main.${ident(view)}`).catch(() => {});
      previous.delete(view);
      relations.delete(key);
      console.warn(`table view "${view}" not registered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const binding of plan.qualified.values()) {
    if (!("synthetic" in binding) || plan.synthetic.has(binding.synthetic.id)) continue;
    if (abandoned?.()) return;
    const relation = await relationOf(binding.synthetic);
    if (abandoned?.()) return;
    plan.synthetic.set(binding.synthetic.id, relation.from);
    registered.push({ ...registryTable(binding.synthetic), view: null });
    if (relation.probed) relations.set(relationKey(binding.synthetic), relation);
  }
  setMountPlan(conn, plan);
  requireDatasetScope(scope, undefined, admission);
  if (!abandoned?.()) await afterRegistration?.(registered);
}

/** Deleted names disappear at the next admission. Existing evaluations retain
 * their own view and artifact until their reader lease ends. */
export async function dropTableView(scope: DatasetScope, name: string): Promise<void> {
  invalidateArtifactRelations(requireDatasetScope(scope), name);
}

registerQueryStore({ drain: async () => {}, busy: () => false, clear: () => { mounted = new WeakMap<DuckDBConnection, Set<string>>(); } });
export function mountedViewsForTests(conn: DuckDBConnection): string[] { return [...(mounted.get(conn) ?? [])]; }
