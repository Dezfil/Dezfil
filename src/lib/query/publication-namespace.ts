import type { Database } from "better-sqlite3";
import type { DuckDBConnection } from "@duckdb/node-api";
import { metadataDb } from "@/lib/metadata/db";
import { resolveSql, type Namespace } from "./bindings";
import { mountPlanOf, planMounts, setMountPlan } from "./mount-plan";

/**
 * A publication's namespace: the map's SQL home with its current owner's
 * reach, restricted to the dataset identities the map's own SQL resolves to.
 *
 * A published link evaluates its layers and widgets for anonymous readers,
 * so it mounts what the map names and nothing else of the owner's space:
 * catalogue inspection through the link cannot see another name, and a
 * dataset the owner can no longer reach is simply not there. The identities
 * are resolved from every layer's SQL (widgets and filters read the layers),
 * through the same resolver live evaluation uses, in the owner's full reach,
 * and remembered by what they were resolved from: the map, its layers' SQL
 * and that reach. Only the identities are remembered: each reuse takes the
 * datasets' records from the reach as it is read now, so a refresh or a
 * rerun that gives a dataset a new artifact or geometry is drawn at once and
 * a retired artifact is never mounted. `withheld` says the owner's reach
 * holds datasets the map does not name, which catalogue discovery through
 * the link would otherwise have listed.
 */
export interface PublicationReach {
  namespace: Namespace;
  withheld: boolean;
}

const MEMORY = 256;
const remembered = new Map<string, ReadonlySet<string>>();

type LayerSql = { id: string; sql: string };
function layerSql(mapId: string, db: Database): LayerSql[] {
  return db.prepare("SELECT id, sql FROM layers WHERE map_id = ? ORDER BY ordinal, id").all(mapId) as LayerSql[];
}

/** What a publication's identities are resolved from, as one key: the map,
 * its layers' SQL and the owner's reach in its home. */
function keyOf(mapId: string, full: Namespace, layers: LayerSql[]): string {
  return JSON.stringify([mapId, full.home, layers,
    full.datasets.map((dataset) => [dataset.id, dataset.name, dataset.ownerId, dataset.ownerSqlName])]);
}
export function publicationKey(mapId: string, full: Namespace, db: Database = metadataDb()): string {
  return keyOf(mapId, full, layerSql(mapId, db));
}

function restricted(full: Namespace, ids: ReadonlySet<string>): PublicationReach {
  const datasets = full.datasets.filter((dataset) => ids.has(dataset.id));
  return { namespace: { ...full, datasets }, withheld: datasets.length < full.datasets.length };
}

/** The restriction already resolved for this publication as it stands, or
 * null until an evaluation has resolved it. */
export function rememberedPublication(mapId: string, full: Namespace, db: Database = metadataDb()): PublicationReach | null {
  const ids = remembered.get(publicationKey(mapId, full, db));
  return ids ? restricted(full, ids) : null;
}

/**
 * Resolve the restriction on an evaluation's own connection, before anything
 * is mounted on it. A layer whose SQL cannot be read names nothing here; its
 * own evaluation fails as it would anyway.
 */
export async function resolvePublication(conn: DuckDBConnection, mapId: string, full: Namespace,
  db: Database = metadataDb()): Promise<PublicationReach> {
  const layers = layerSql(mapId, db);
  const key = keyOf(mapId, full, layers);
  const known = remembered.get(key);
  if (known) return restricted(full, known);
  // A provisional plan lets the guard recognise the quoted name of another
  // owner's mounted dataset while the references are read; nothing is
  // mounted under it, and the evaluation's own plan replaces it.
  const previous = mountPlanOf(conn);
  setMountPlan(conn, planMounts(full, "resource", false));
  const ids = new Set<string>();
  try {
    for (const { sql } of layers) {
      try {
        for (const dataset of (await resolveSql(conn, sql, full)).datasets) ids.add(dataset.id);
      } catch {
        // Read as nothing: the layer's own evaluation reports why.
      }
    }
  } finally {
    if (previous) setMountPlan(conn, previous);
  }
  remembered.set(key, ids);
  if (remembered.size > MEMORY) remembered.delete(remembered.keys().next().value!);
  return restricted(full, ids);
}

/** Tests reset shared state. */
export function forgetPublications(): void {
  remembered.clear();
}
