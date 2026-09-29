import { metadataDb } from "@/lib/metadata/db";
import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";

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
export function dependentLayerIds(scope: AccountScope, name: string, db: Database = metadataDb()): string[] {
  const owner = requireAccountScope(scope, db);
  const layers = db.prepare(`SELECT l.id, l.sql FROM layers l JOIN maps m ON m.id = l.map_id WHERE m.owner_id = ?`).all(owner) as {
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
export function referencedTableArtifacts(sql: string, layerId: string, db: Database = metadataDb()): { id: string; file: string }[] {
  // The durable layer selects the catalogue for both private and published
  // fingerprints. Published links retain their owner's data when that account
  // is inactive; pending-adoption maps retain only the ownerless catalogue.
  // Callers authorize the layer before using this internal cache identity read.
  const map = db.prepare(`SELECT m.owner_id FROM layers l JOIN maps m ON m.id = l.map_id WHERE l.id = ?`)
    .get(layerId) as { owner_id: string | null } | undefined;
  if (!map) throw resourceAbsent();
  const tables = db.prepare("SELECT id, name, file FROM data_tables WHERE owner_id = ? OR (owner_id IS NULL AND ? IS NULL) ORDER BY id")
    .all(map.owner_id, map.owner_id) as { id: string; name: string; file: string }[];
  return tables.filter(t => sqlReferencesTable(sql, t.name)).map(({ id, file }) => ({ id, file }));
}
