import { admitAccountWork } from "@/lib/auth/account-deletion-admission";
import { metadataDb } from "@/lib/metadata/db";
import { contextOf } from "./context";
import { requireDatasetScope, type DatasetScope } from "./access";

/** The SQL home is attribution, not ownership. A surviving definition can
 * keep a deleted SQL home; only its actual owner fences its work. */
export function admitEvaluationWork(scope: DatasetScope) {
  const actor = requireDatasetScope(scope), context = contextOf(scope);
  const resource = context.resource;
  const owner = resource ? metadataDb().prepare(`SELECT owner_id FROM ${resource.kind} WHERE id = ?`).get(resource.id) as { owner_id: string } | undefined : undefined;
  return admitAccountWork([actor, ...(owner ? [owner.owner_id] : [])]);
}
