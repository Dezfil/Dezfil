import { requireOwnedResource } from "@/lib/auth/owned-resource";
import type { AccountScope } from "@/lib/auth/scope";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
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
  requireOwnedResource(scope, "dataset", table.id);
  if (table.source !== "operation") return null;
  const raw = table.sourceParams?.inputs;
  if (!Array.isArray(raw)) return null;

  const all = listOwnedTables(scope);
  const byId = new Map(all.map((t) => [t.id, t]));
  const byName = new Map(all.map((t) => [t.name.toLowerCase(), t]));

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
    // The id is gone. If its old name now belongs to something else, say so
    // rather than let a reader assume the input is simply renamed.
    const usurper = byName.get(name.toLowerCase());
    return [{ id, name, missing: true, nameReclaimed: usurper !== undefined }];
  });
}
