import type { TableSource } from "@/lib/metadata/tables";

/** Where every set-geometry door appears (default 8): the sources
 * the API accepts, on a dataset the reader owns. A dataset changes by its
 * owner alone, so someone else's, typed `<sql name>.<name>`, opens no
 * panel that can only refuse; a dataset that does not say how its reader
 * types it is taken for the reader's own. Elsewhere the surface stays as
 * shipped. One rule for every door. */
export function canSetGeometry(table: { source: TableSource; name?: string; qualifiedName?: string }): boolean {
  const own = table.qualifiedName === undefined || table.qualifiedName === table.name;
  return own && (table.source === "upload" || table.source === "url");
}
