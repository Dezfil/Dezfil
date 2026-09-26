/**
 * Cell formatting for the console's result table. The query operation
 * answers geometry as GeoJSON objects (so the map can draw them); a grid
 * cell wants a short, readable label instead — WKT-shaped for a point, the
 * kind and size for anything larger. Pure.
 */
export interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
}

export function isGeometryObject(value: unknown): value is GeoJsonGeometry {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    ("coordinates" in (value as object) || "geometries" in (value as object))
  );
}

function countPositions(coords: unknown): number {
  if (!Array.isArray(coords)) return 0;
  if (typeof coords[0] === "number") return 1;
  let n = 0;
  for (const c of coords) n += countPositions(c);
  return n;
}

function fmtNum(n: unknown): string {
  return typeof n === "number" ? String(+n.toFixed(5)) : String(n);
}

/** A short label for a geometry object. */
export function geometryLabel(g: GeoJsonGeometry): string {
  if (g.type === "Point" && Array.isArray(g.coordinates)) {
    const [x, y] = g.coordinates as unknown[];
    return `POINT (${fmtNum(x)} ${fmtNum(y)})`;
  }
  if (g.type === "GeometryCollection") {
    return `GEOMETRYCOLLECTION (${g.geometries?.length ?? 0} parts)`;
  }
  const n = countPositions(g.coordinates);
  return `${g.type.toUpperCase()} (${n} point${n === 1 ? "" : "s"})`;
}

/** The text a cell shows, and whether it is null / numeric / geometry. */
export function formatCell(value: unknown): {
  text: string;
  kind: "null" | "number" | "geometry" | "text";
} {
  if (value === null || value === undefined) return { text: "NULL", kind: "null" };
  if (typeof value === "number") {
    return {
      text: Number.isInteger(value) ? value.toLocaleString("en-US") : String(value),
      kind: "number",
    };
  }
  if (typeof value === "bigint") return { text: value.toString(), kind: "number" };
  if (typeof value === "boolean") return { text: String(value), kind: "text" };
  if (isGeometryObject(value)) return { text: geometryLabel(value), kind: "geometry" };
  if (typeof value === "string") {
    return {
      text: value,
      kind: /^(SRID=\d+;)?(POINT|LINESTRING|POLYGON|MULTI|GEOMETRYCOLLECTION)/i.test(value)
        ? "geometry"
        : "text",
    };
  }
  try {
    return { text: JSON.stringify(value), kind: "text" };
  } catch {
    return { text: String(value), kind: "text" };
  }
}

/** The whole value for the cell peek: geometry objects as pretty JSON. */
export function fullValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
