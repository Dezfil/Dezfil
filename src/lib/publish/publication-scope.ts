import { accountMaterialAvailable, type AccountWorkLease } from "@/lib/auth/account-deletion-admission";
import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { getPublishedSnapshot } from "@/lib/metadata/maps";

const publicationBrand: unique symbol = Symbol("publication scope");
/** A token grants its current projection in the publisher's dataset space.
 * It is never an AccountScope and cannot authorize private resource access. */
export interface PublicationScope {
  readonly [publicationBrand]: true;
  readonly token: string;
  readonly mapId: string;
  readonly ownerId: string | null;
}
export const publicationAbsent = () => new ApiError("not_found", "This map is not available.", 404);
function identity(token: string, db: Database, admitted?: AccountWorkLease) {
  const row = db.prepare(`SELECT id, owner_id FROM maps WHERE publish_token = ?
    AND (owner_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM accounts))`).get(token) as
    { id: string; owner_id: string | null } | undefined;
  return row && (accountMaterialAvailable(row.owner_id, db) || admitted?.includes(row.owner_id)) ? row : undefined;
}
export function isPublicationScope(scope: unknown): scope is PublicationScope {
  return !!scope && typeof scope === "object" && publicationBrand in scope && scope[publicationBrand] === true;
}
export function requirePublicationScope(scope: PublicationScope, db: Database = metadataDb(), admitted?: AccountWorkLease): string | null {
  if (!isPublicationScope(scope)) throw publicationAbsent();
  const current = identity(scope.token, db, admitted);
  if (!current || current.id !== scope.mapId || current.owner_id !== scope.ownerId) throw publicationAbsent();
  return current.owner_id;
}
/** Snapshot and capability are read in one transaction. First-account adoption
 * changes the owner and revision atomically, retiring pending-adoption scopes. */
export function resolvePublication(token: string, db: Database = metadataDb()) {
  return db.transaction(() => {
    const row = identity(token, db);
    if (!row) return null;
    const snapshot = getPublishedSnapshot(token, db);
    if (!snapshot) return null;
    const scope: PublicationScope = Object.freeze({ [publicationBrand]: true as const, token, mapId: row.id, ownerId: row.owner_id });
    return { ...snapshot, scope, revision: JSON.stringify([snapshot.revision, row.owner_id]) };
  })();
}
