import type { TableSource } from "@/lib/metadata/tables";

/** Where every set-geometry door appears (default 8): the sources
 * the API accepts. Elsewhere the surface stays as shipped rather than
 * opening a panel that can only refuse. One rule for every door. */
export function canSetGeometry(table: { source: TableSource }): boolean {
  return table.source === "upload" || table.source === "url";
}
