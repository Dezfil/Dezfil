import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { metadataDb } from "@/lib/metadata/db";
import { ApiError } from "@/lib/api/errors";
import { listLayers } from "@/lib/metadata/maps";
import { requireMap } from "@/lib/map-access";
import { queryInputsStrict } from "@/lib/operations/inputs";
import { boundedEvaluation } from "@/lib/query/bounded";
import { namespaceFor } from "@/lib/query/namespace";
import { resolveReference, type Namespace } from "@/lib/query/bindings";
import { qualifiedNameParts } from "@/lib/query/qualified-name";
import { mapEvaluation } from "@/lib/query/context";
import { listTablesWithSize, type TableListing } from "@/lib/table-service";

/**
 * The datasets a map draws from: the subject of the 14-A checklist, as
 * one documented read. One captured metadata world (the registry,
 * memberships, and workflow-origin output ownership); every saved
 * layer's statement analyzed strictly through the hardened boundary;
 * each reference resolved to a dataset identity in the map's SQL home
 * within the reader's reach, and deduplicated by identity. A reference
 * the reader cannot reach is left out, never named and never guessed at
 * through a same-named dataset of the reader's own. A layer that cannot
 * be analyzed fails the WHOLE read — a partial answer must never present
 * as a complete checklist. Sketch provenance is identity evidence only;
 * the current saved statement decides use.
 */

export interface MapDependency {
  id: string;
  name: string;
  /** The name its reader would type: the plain name for the reader's own,
   * `<sql name>.<name>` for someone else's. */
  qualifiedName: string;
  owner: TableListing["owner"];
  source: TableListing["source"];
  rowCount: number;
  projectIds: string[];
  /** The dataset's spatial identity: the geometry
   * column, null for a non-spatial dataset, and the sampled geometry
   * type, null when there is no column or nothing was sampled — a
   * column with no sampled type is still spatial. */
  geometryColumn: string | null;
  geometryType: string | null;
  /** The workflow that currently produces this dataset; null when it
   * is not a workflow-origin recipe's current output. */
  producer: { id: string; name: string } | null;
}

export type Producer = { id: string; name: string };

/** The workflow-origin producers by their current output identity: one
 * capture, shared by the map's and the workflow's reads. */
export function currentProducers(scope: AccountScope): Map<string, Producer> {
  const owner = requireAccountScope(scope);
  const rows = metadataDb().prepare(`SELECT r.id, r.name, s.output_table_id FROM recipes r
    JOIN recipe_steps s ON s.recipe_id = r.id JOIN data_tables t ON t.id = s.output_table_id
    WHERE r.owner_id = ? AND t.owner_id = ? AND r.origin = 'workflow'
    ORDER BY r.created_at DESC, r.id DESC, s.ordinal`).all(owner, owner) as { id: string; name: string; output_table_id: string }[];
  return new Map(rows.map(row => [row.output_table_id, { id: row.id, name: row.name }]));
}

/** One dependency entry from a captured listing — the facts both
 * filing checklists carry, composed in one place. */
export function dependencyOf(
  table: TableListing,
  producers: Map<string, Producer>,
): MapDependency {
  return {
    id: table.id,
    name: table.name,
    qualifiedName: table.qualifiedName,
    owner: table.owner,
    source: table.source,
    rowCount: table.rowCount,
    projectIds: table.projectIds,
    geometryColumn: table.geometryColumn,
    geometryType: table.geometryType,
    producer: producers.get(table.id) ?? null,
  };
}

/** The dataset identities a statement's analyzed references bind in a
 * namespace: plain names in the home, qualified names as that person's. A
 * reference that binds nothing in reach is left out. */
function boundIdentities(namespace: Namespace, inputs: { tables: string[]; external?: string[] }): string[] {
  const references = [...inputs.tables.map((name) => [name]), ...(inputs.external ?? []).map((written) => qualifiedNameParts(written) ?? [written])];
  return references.flatMap((parts) => {
    const resolution = resolveReference(namespace, parts);
    return resolution.status === "bound" ? [resolution.dataset.id] : [];
  });
}

export async function mapDependencies(
  scope: AccountScope,
  mapId: string,
): Promise<MapDependency[]> {
  requireMap(scope, mapId);
  const layers = listLayers(mapId);

  // One captured world: the registry with memberships, and the
  // workflow-origin producers by their current output identity.
  const tables = await listTablesWithSize(scope);
  const byId = new Map(tables.map((t) => [t.id, t]));
  const producers = currentProducers(scope);
  const evaluation = mapEvaluation(scope, mapId);
  const namespace = namespaceFor(evaluation);

  const found = new Map<string, MapDependency>();
  for (const layer of layers) {
    let ids: string[];
    try {
      ids = boundIdentities(namespace, await boundedEvaluation(async (conn) =>
        queryInputsStrict(conn, layer.sql, () => null), { scope: evaluation },
      ));
    } catch (cause) {
      throw new ApiError(
        "dependencies_unresolved",
        `The layer "${layer.name}" could not be analyzed, so the map's ` +
          `datasets cannot be listed completely. ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
        422,
      );
    }
    for (const id of ids) {
      const table = byId.get(id);
      if (!table || found.has(table.id)) continue;
      found.set(table.id, dependencyOf(table, producers));
    }
  }
  requireMap(scope, mapId);
  return [...found.values()].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
}
