import type { DataTable } from "@/lib/metadata/tables";

/**
 * Which class of geometry a table holds, in the catalog's own vocabulary.
 *
 * **The unspecific `GEOMETRY` is not classified.** A table typed that way could
 * hold points, lines or polygons, and guessing would refuse an input that would
 * have worked — so an unclassifiable table is admitted and the engine answers
 * for it. Refusing what is *known* to be wrong is the point; refusing what is
 * merely unknown is not.
 */
export function geometryClassOf(
  table: DataTable,
): "point" | "line" | "polygon" | null {
  const type = (table.geometryType ?? "").toUpperCase();
  if (type.includes("POINT")) return "point";
  if (type.includes("LINE")) return "line";
  if (type.includes("POLYGON")) return "polygon";
  return null;
}
