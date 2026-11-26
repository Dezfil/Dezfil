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

/**
 * A geometry kind as a plain word, wherever a kind is shown as a fact:
 * Points, Lines or Polygons, single and multi alike; Mixed for a mix of
 * kinds (`POINT+POLYGON`, a legacy `MIXED`) or a collection; Geometry for
 * geometry of a kind that isn't known; No geometry when there is none.
 * `spatial` says whether there is geometry at all; a type alone does not.
 * A raw database column type (`geography`) is not a kind and keeps its
 * own spelling where the schema is shown.
 */
export function geometryKindWord(
  geometryType: string | null | undefined,
  spatial = true,
): string {
  if (!spatial) return "No geometry";
  const type = (geometryType ?? "").toUpperCase();
  if (type.includes("+") || type.includes("MIXED") || type.includes("COLLECTION")) {
    return "Mixed";
  }
  if (type.includes("POINT")) return "Points";
  if (type.includes("LINE")) return "Lines";
  if (type.includes("POLYGON")) return "Polygons";
  return "Geometry";
}

/**
 * The kind of a table a tool or a workflow step makes, or would make, from
 * its three answers: no geometry column, a column with no geometry to
 * classify (it reads Geometry, with why), or a classified kind (its kind
 * word, Geometry when no type is recorded). A preview of a table without
 * geometry also says it will not be a layer.
 */
export function resultKindWord(
  geometry: "none" | "undetermined" | "classified",
  geometryType: string | null | undefined,
  options: { preview?: boolean } = {},
): string {
  if (geometry === "none") return options.preview ? "No geometry: a table, not a layer" : "No geometry";
  if (geometry === "undetermined") return "Geometry: no geometries to classify";
  return geometryKindWord(geometryType);
}
