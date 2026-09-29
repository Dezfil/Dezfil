import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { isPublicationScope, requirePublicationScope, type PublicationScope } from "@/lib/publish/publication-scope";
import { metadataDb } from "@/lib/metadata/db";
import { tableFromRow, type TableRow, type DataTable } from "@/lib/metadata/tables";

/** Engine authority is either private account access or a live publication.
 * A publication never becomes an account scope, even for an active owner. */
export type DatasetScope = AccountScope | PublicationScope;
export function requireDatasetScope(scope: DatasetScope, db: Database = metadataDb()): string | null {
  return isPublicationScope(scope) ? requirePublicationScope(scope, db) : requireAccountScope(scope, db);
}
export function scopedDatasets(scope: DatasetScope, db: Database = metadataDb()): DataTable[] {
  const owner = requireDatasetScope(scope, db);
  return (db.prepare("SELECT * FROM data_tables WHERE owner_id IS ? ORDER BY created_at DESC, name").all(owner) as TableRow[]).map(tableFromRow);
}
