/** The one browser-side vocabulary for a table's spatial identity. */
export type GeometryClass = "point" | "line" | "polygon" | "none" | "unknown";

/** The geometry type a glyph should draw for this table. */
export function geometryGlyphType(
  table:
    | { geometryType: string | null; geometryColumn: string | null }
    | null
    | undefined,
): string | null {
  if (!table) return null;
  return (
    table.geometryType ?? (table.geometryColumn !== null ? "GEOMETRY" : null)
  );
}

/**
 * A column makes a table spatial; its sampled class is a refinement only.
 * The optional column preserves narrow fixtures that carry a known class
 * without constructing a complete table record.
 */
export function classOfTable(table: {
  geometryType: string | null;
  geometryColumn?: string | null;
}): GeometryClass {
  if (
    table.geometryColumn === null ||
    (table.geometryColumn === undefined && !table.geometryType)
  ) {
    return "none";
  }
  const type = (table.geometryType ?? "").toUpperCase();
  if (type.includes("POINT")) return "point";
  if (type.includes("LINE")) return "line";
  if (type.includes("POLYGON")) return "polygon";
  return "unknown";
}
