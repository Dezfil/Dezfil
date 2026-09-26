import { metadataDb } from "@/lib/metadata/db";
import { listTables } from "@/lib/metadata/tables";

/**
 * Which tables a piece of layer SQL depends on. Shared by refresh
 * invalidation, delete reclamation, and the tile fingerprint — one matcher,
 * so "depends on" means the same thing everywhere.
 */

/**
 * Does this SQL reference the table as a whole identifier? Bounded by
 * non-identifier characters, case-insensitive as the engine binds names
 * — so `main_roads` and `roads_2` are not references to `roads`, and `_`
 * never acts as a wildcard. Deliberately conservative beyond that: an
 * occurrence inside a quoted identifier, alias or string literal still
 * counts, because the cost of over-match is one serialized rebuild while
 * under-match serves stale tiles.
 */
export function sqlReferencesTable(sql: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, "i").test(
    sql,
  );
}

/** The layers whose SQL references this table — refresh invalidates their
 * tile records; delete reclaims their archives. */
export function dependentLayerIds(name: string): string[] {
  const layers = metadataDb().prepare(`SELECT id, sql FROM layers`).all() as {
    id: string;
    sql: string;
  }[];
  return layers
    .filter((layer) => sqlReferencesTable(layer.sql, name))
    .map((layer) => layer.id);
}

/** The artifact files behind the tables this SQL references, in a stable
 * order — the data identity a tile fingerprint folds in: a refresh mints
 * a new artifact file, so a fingerprint that carries these can never
 * accept pre-refresh tiles as fresh, even when an explicit invalidation
 * was lost. */
export function referencedTableArtifacts(sql: string): string[] {
  return listTables()
    .filter((t) => sqlReferencesTable(sql, t.name))
    .map((t) => t.file)
    .sort();
}
