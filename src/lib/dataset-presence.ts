import type { AccountScope } from "@/lib/auth/scope";
import { canReach } from "@/lib/auth/reach";
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
 * connection, and a sketch whose map they do not reach names no map.
 */
export function datasetOrigin(scope: AccountScope, reached: ReachedTable): DataTable["sourceParams"] {
  const { table } = reached;
  if (reached.ownerId === scope.accountId) return table.sourceParams;
  if (table.source === "postgis") return null;
  const mapId = table.sourceParams?.mapId;
  if (table.source === "sketch" && (typeof mapId !== "string" || !canReach(scope, "map", mapId))) return null;
  return table.sourceParams;
}

/** A reached dataset as its reader sees it: the record with its origin
 * bounded, its owner and the name the reader would type. */
export function presentDataset(scope: AccountScope, reached: ReachedTable): DataTable & DatasetPresence {
  return { ...reached.table, sourceParams: datasetOrigin(scope, reached), ...datasetPresence(scope, reached) };
}
