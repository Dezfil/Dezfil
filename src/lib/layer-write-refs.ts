import { ApiError } from "@/lib/api/errors";
import { changedRefs, refProblem, type ColumnRef } from "@/lib/column-validation";
import { fieldsForWrite } from "./layer-fields";
import type { LayerViz } from "@/lib/viz";

/** Refuse the references this write introduces or changes that the
 * post-request schema cannot honor; an empty diff resolves nothing and
 * costs nothing. */
export async function assertWritableRefs(
  incoming: ColumnRef[],
  stored: ColumnRef[],
  sql: string,
  viz: LayerViz,
  signal?: AbortSignal,
): Promise<void> {
  const refs = changedRefs(incoming, stored);
  if (refs.length === 0) return;
  const problem = refProblem(refs, await fieldsForWrite(sql, viz, signal));
  if (problem) throw new ApiError("column_unavailable", problem, 400);
}
