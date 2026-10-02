import type { AccountScope } from "@/lib/auth/scope";
import { canReach, reachableDatasetIds } from "@/lib/auth/reach";
import type { AccountLabel } from "@/lib/metadata/accounts";
import type { DataTable } from "@/lib/metadata/tables";
import type { ReachedTable } from "@/lib/metadata/owned-tables";

/**
 * What every dataset listing and read carries beyond the stored record: its
 * owner, and the name its reader would type for it. The reader's own dataset
 * is typed by its plain name; another person's by their SQL name and the
 * dataset's, `<sql name>.<name>`, which is what tells two same-named datasets
 * apart. One's own datasets carry the same fields, so a client never
 * special-cases them.
 */
export interface DatasetPresence {
  owner: AccountLabel;
  qualifiedName: string;
}

export function datasetPresence(scope: AccountScope, reached: ReachedTable): DatasetPresence {
  return {
    owner: reached.owner,
    qualifiedName: reached.ownerId === scope.accountId ? reached.table.name : `${reached.owner.sqlName}.${reached.table.name}`,
  };
}

/**
 * A dataset's origin as its reader may see it. Its owner sees the record as
 * stored. Anyone else sees nothing the record says about what they cannot
 * reach: a PostGIS snapshot shows its origin kind and nothing about the
 * connection, a sketch whose map they do not reach names no map, and a
 * derived dataset's recorded inputs list only those the reader reaches, by
 * the identity each was recorded under, as the inspection's resolved inputs
 * do. The SQL and parameters that ran are the document itself and stay.
 * `reach` is the reader's reachable dataset identities, when a listing has
 * already read them.
 */
export function datasetOrigin(scope: AccountScope, reached: ReachedTable, reach?: ReadonlySet<string>): DataTable["sourceParams"] {
  const { table } = reached;
  if (reached.ownerId === scope.accountId) return table.sourceParams;
  if (table.source === "postgis") return null;
  const mapId = table.sourceParams?.mapId;
  if (table.source === "sketch" && (typeof mapId !== "string" || !canReach(scope, "map", mapId))) return null;
  const inputs = table.sourceParams?.inputs;
  if (table.source === "operation" && Array.isArray(inputs)) {
    const reachable = reach ?? reachableDatasetIds(scope);
    return { ...table.sourceParams, inputs: inputs.filter((entry: unknown) => {
      const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
      return typeof id === "string" && reachable.has(id);
    }) };
  }
  return table.sourceParams;
}

/** The file or remote table a dataset came from, as its reader may see it:
 * a PostGIS snapshot's remote schema and table live in its owner's
 * connection, so only the owner sees them. */
export function datasetSourceName(scope: AccountScope, reached: ReachedTable): DataTable["sourceFilename"] {
  return reached.ownerId !== scope.accountId && reached.table.source === "postgis" ? null : reached.table.sourceFilename;
}

/** A reached dataset as its reader sees it: the record with its origin
 * bounded, its owner and the name the reader would type. */
export function presentDataset(scope: AccountScope, reached: ReachedTable, reach?: ReadonlySet<string>): DataTable & DatasetPresence {
  return {
    ...reached.table,
    sourceFilename: datasetSourceName(scope, reached),
    sourceParams: datasetOrigin(scope, reached, reach),
    ...datasetPresence(scope, reached),
  };
}
