import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { isPublicationScope, requirePublicationScope, type PublicationScope } from "@/lib/publish/publication-scope";
import { metadataDb } from "@/lib/metadata/db";
import { tableFromRow, type TableRow, type DataTable } from "@/lib/metadata/tables";
import { authorityOf, type EvaluationContext } from "./context";
export { mapEvaluation } from "./context";

/** Engine authority is either private account access or a live publication,
 * optionally carried in an evaluation context that names the SQL home. A
 * publication never becomes an account scope, even for an active owner. */
export type DatasetScope = AccountScope | PublicationScope | EvaluationContext;
/** The authority's account (a publication's owner), rechecked. */
export function requireDatasetScope(scope: DatasetScope, db: Database = metadataDb()): string | null {
  const authority = authorityOf(scope);
  return isPublicationScope(authority) ? requirePublicationScope(authority, db) : requireAccountScope(authority, db);
}
/** The authority's own datasets. */
export function scopedDatasets(scope: DatasetScope, db: Database = metadataDb()): DataTable[] {
  const owner = requireDatasetScope(scope, db);
  return (db.prepare("SELECT * FROM data_tables WHERE owner_id IS ? ORDER BY created_at DESC, name").all(owner) as TableRow[]).map(tableFromRow);
}
