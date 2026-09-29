import type { AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import { listLayers } from "@/lib/metadata/maps";
import { requireMap } from "@/lib/map-access";
import { listRecipes, listSteps } from "@/lib/metadata/recipes";
import { queryInputsStrict } from "@/lib/operations/inputs";
import { boundedEvaluation } from "@/lib/query/bounded";
import { listTablesWithSize, type TableListing } from "@/lib/table-service";

/**
 * The datasets a map draws from: the subject of the 14-A checklist, as
 * one documented read. One captured metadata world (the registry,
 * memberships, and workflow-origin output ownership); every saved
 * layer's statement analyzed strictly through the hardened boundary;
 * analyzed names resolve only to registered datasets and deduplicate by
 * dataset identity. A layer that cannot be analyzed fails the WHOLE
 * read — a partial answer must never present as a complete checklist.
 * Sketch provenance is identity evidence only; the current saved
 * statement decides use.
 */

export interface MapDependency {
  id: string;
  name: string;
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
export function currentProducers(): Map<string, Producer> {
  const producers = new Map<string, Producer>();
  for (const recipe of listRecipes(undefined, { origin: "workflow" })) {
    for (const step of listSteps(recipe.id)) {
      if (step.outputTableId) {
        producers.set(step.outputTableId, { id: recipe.id, name: recipe.name });
      }
    }
  }
  return producers;
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
    source: table.source,
    rowCount: table.rowCount,
    projectIds: table.projectIds,
    geometryColumn: table.geometryColumn,
    geometryType: table.geometryType,
    producer: producers.get(table.id) ?? null,
  };
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
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const producers = currentProducers();

  const found = new Map<string, MapDependency>();
  for (const layer of layers) {
    let names: string[];
    try {
      names = await boundedEvaluation(async (conn) =>
        (await queryInputsStrict(conn, layer.sql, () => null)).tables,
      );
    } catch (cause) {
      throw new ApiError(
        "dependencies_unresolved",
        `The layer "${layer.name}" could not be analyzed, so the map's ` +
          `datasets cannot be listed completely. ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
        422,
      );
    }
    for (const name of names) {
      const table = byName.get(name.toLowerCase());
      if (!table || found.has(table.id)) continue;
      found.set(table.id, dependencyOf(table, producers));
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
