import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { REACHED_PROJECTS } from "@/lib/auth/reach";
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
  /** True when the reader owns the dataset: a filing checklist offers
   * only these; another person's is listed as not theirs to add. */
  owned: boolean;
  /** The workflow that produces this dataset (some run of one of its
   * nodes recorded it as its output), when the reader reaches that
   * workflow; null otherwise. */
  producer: Producer | null;
}

/** A producing workflow, and whether the reader owns it (and so may file it). */
export type Producer = { id: string; name: string; owned: boolean };

/** The workflow-origin producers by output identity, among the workflows the
 * reader reaches: every runner's recorded output counts, each dataset being
 * one runner's output of one node. One capture, shared by the map's and the
 * workflow's reads. */
export function currentProducers(scope: AccountScope): Map<string, Producer> {
  const me = requireAccountScope(scope);
  const rows = metadataDb().prepare(`SELECT r.id, r.name, r.owner_id, o.output_table_id FROM step_runner_outputs o
    JOIN recipe_steps s ON s.id = o.step_id JOIN recipes r ON r.id = s.recipe_id
    WHERE r.origin = 'workflow' AND (r.owner_id = @me OR r.project_id IN (${REACHED_PROJECTS}))
    ORDER BY r.created_at DESC, r.id DESC, s.ordinal`).all({ me }) as { id: string; name: string; owner_id: string; output_table_id: string }[];
  const producers = new Map<string, Producer>();
  for (const row of rows) {
    if (!producers.has(row.output_table_id)) producers.set(row.output_table_id, { id: row.id, name: row.name, owned: row.owner_id === me });
  }
  return producers;
}

/** The reader's own SQL name, which marks the datasets they own. */
export function readerSqlName(scope: AccountScope): string | null {
  const me = requireAccountScope(scope);
  const row = metadataDb().prepare("SELECT sql_name FROM accounts WHERE id = ?").get(me) as { sql_name: string | null } | undefined;
  return row?.sql_name ?? null;
}

/** One dependency entry from a captured listing — the facts both
 * filing checklists carry, composed in one place. */
export function dependencyOf(
  table: TableListing,
  producers: Map<string, Producer>,
  reader: string | null,
): MapDependency {
  return {
    id: table.id,
    name: table.name,
    qualifiedName: table.qualifiedName,
    owner: table.owner,
    owned: table.owner.sqlName === reader,
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
  const reader = readerSqlName(scope);
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
      found.set(table.id, dependencyOf(table, producers, reader));
    }
  }
  requireMap(scope, mapId);
  return [...found.values()].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
}
