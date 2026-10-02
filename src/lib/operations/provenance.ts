import { reachableDatasetIds, requireReachable } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
import { reachableDatasets } from "@/lib/query/bindings";
import type { DataTable } from "@/lib/metadata/tables";

/**
 * Resolve a derived table's recorded inputs at read time.
 *
 * The record stores each input by id as well as by name, precisely because a
 * name can be reclaimed by a different table. Storing the id is only half the
 * promise though: the read has to *use* it, or the record still reads as
 * though the run had used whatever now holds that name. So each input is
 * resolved by its recorded id and reported missing when nothing carries it —
 * the derived table's provenance never silently re-points at a stranger.
 *
 * Within the reader's reach: an input the reader reaches resolves to what it
 * is now. The derived dataset's owner reads every other input as missing,
 * the same for one deleted and one no longer theirs to reach; anyone else
 * reads only the inputs they reach, the rest left out rather than named.
 */

export interface ResolvedInput {
  id: string;
  /** The name recorded at run time. */
  name: string;
  /** The name that id carries now, when it still exists. */
  currentName?: string;
  /** True when no table carries that id any more. */
  missing: boolean;
  /** True when the recorded name now belongs to a different table. */
  nameReclaimed?: boolean;
}

export function resolveInputs(scope: AccountScope, table: DataTable): ResolvedInput[] | null {
  const author = requireReachable(scope, "dataset", table.id).relation === "owner";
  if (table.source !== "operation") return null;
  const raw = table.sourceParams?.inputs;
  if (!Array.isArray(raw)) return null;

  const byId = new Map(reachableDatasets(reachableDatasetIds(scope)).map((t) => [t.id, t]));
  const byName = new Map(listOwnedTables(scope).map((t) => [t.name.toLowerCase(), t]));

  return raw.flatMap((entry): ResolvedInput[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || typeof name !== "string") return [];
    const live = byId.get(id);
    if (live) {
      return [
        {
          id,
          name,
          currentName: live.name,
          missing: false,
        },
      ];
    }
    if (!author) return [];
    // The id is gone, or out of reach. If its old name now belongs to
    // something else, say so rather than let a reader assume the input is
    // simply renamed.
    const usurper = byName.get(name.toLowerCase());
    return [{ id, name, missing: true, nameReclaimed: usurper !== undefined }];
  });
}
