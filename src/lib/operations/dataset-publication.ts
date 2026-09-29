import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { getTableByName, insertTable, updateTableData, type DataTable } from "@/lib/metadata/tables";
import type { BoundInput, MaterializeRequest } from "./materialize";

/** Thrown when `authorize` refused: the run lost its claim while it worked. */
export class LostAuthority extends Error {
  constructor() {
    super("This run is no longer the live attempt, so it did not publish.");
  }
}

/** Publish the registry row and its caller's authority in one transaction.
 * The returned previous artifact is retired only after this commits. */
export function publishDataset(
  scope: AccountScope,
  table: DataTable,
  bound: BoundInput[],
  request: Pick<MaterializeRequest, "authorize" | "replaceTable" | "onPublished">,
): string | null {
  const { authorize, replaceTable } = request;
  const now = table.createdAt;
  const name = table.name;
  // One transaction: the run's claim to publish and the dataset row commit
  // together, or neither does. A cancel that lands mid-run is decided here,
  // once, by the database — not by a read taken a moment earlier.
  const db = metadataDb();
  // Kept so the replaced generation can be retired after the commit. Read
  // before the swap, because after it the row names the new file.
  const replaced = replaceTable
    ? (getTableByName(replaceTable.name)?.file ?? null)
    : null;
  try {
    db.transaction(() => {
      requireAccountScope(scope, db);
      if (authorize && !authorize(table, db, bound)) throw new LostAuthority();
      if (replaceTable) {
        // Keyed on name AND id: a re-run racing a delete, or a name
        // reclaimed by a newer table, matches nothing and says so rather
        // than writing into a stranger.
        const swapped = updateTableData(
          { name: replaceTable.name, id: replaceTable.id },
          {
            file: table.file,
            geometryColumn: table.geometryColumn,
            geometryType: table.geometryType,
            crsAssumed: table.crsAssumed,
            headerSuspect: false,
            rowCount: table.rowCount,
            importedAt: table.importedAt ?? now,
            sourceParams: table.sourceParams ?? undefined,
          },
          db,
        );
        if (!swapped) throw outputGone(replaceTable.name);
      } else {
        insertTable(scope, table, db);
        request.onPublished?.(table, db);
      }
    })();
  } catch (error) {
    if (error instanceof LostAuthority) throw error;
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) {
      throw nameTaken(name);
    }
    throw error;
  }
  return replaced;
}

/** A replacement whose target vanished — deleted, or its name reclaimed by a
 * different table — while the run was working. */
function outputGone(name: string): ApiError {
  return new ApiError(
    "not_found",
    `The dataset "${name}" this run was replacing no longer exists, or its ` +
      `name now belongs to a different table. Nothing was written.`,
    404,
  );
}

export function nameTaken(name: string): ApiError {
  return new ApiError(
    "name_taken",
    `A table named "${name}" already exists. An operation never replaces or ` +
      `renames around an existing table. Choose another name.`,
    409,
  );
}
