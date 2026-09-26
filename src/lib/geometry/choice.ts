import { ApiError } from "@/lib/api/errors";
import { isNumericCsvType } from "@/lib/ingest/csv-geometry";
import type { GeometryChoice } from "./types";

export function parseGeometryChoice(value: unknown): GeometryChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("invalid_request", "A geometry choice is required.", 400);
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some(k => !["format", "columns", "epsg"].includes(k)) ||
      !["wkt", "wkb", "geojson", "h3", "pair"].includes(String(c.format)) ||
      !Array.isArray(c.columns) || c.columns.length !== (c.format === "pair" ? 2 : 1) ||
      !c.columns.every(v => typeof v === "string" && v.length > 0) || new Set(c.columns).size !== c.columns.length ||
      (c.epsg !== undefined && (typeof c.epsg !== "number" || !Number.isSafeInteger(c.epsg) || c.epsg <= 0))) {
    throw new ApiError("invalid_request", "Choose a format, its source columns and an optional positive EPSG code.", 400);
  }
  if ((c.format === "h3" || c.format === "geojson") && c.epsg !== undefined) {
    throw new ApiError("invalid_request", "H3 and GeoJSON use WGS 84 and take no projection.", 400);
  }
  return { format: c.format as GeometryChoice["format"], columns: [...c.columns] as string[], ...(c.epsg !== undefined ? { epsg: c.epsg as number } : {}) };
}
export function validateGeometryColumns(choice: GeometryChoice, columns: { name: string; type: string }[], native = false) {
  for (const name of choice.columns) {
    const col = columns.find(c => c.name === name);
    if (!col) throw new ApiError("column_unavailable", `Column "${name}" is no longer available.`, 400);
    if (native && col.type.startsWith("GEOMETRY")) continue;
    if (!col.type.startsWith("VARCHAR") && !(choice.format === "pair" && isNumericCsvType(col.type))) {
      throw new ApiError("invalid_request", `Column "${name}" cannot be read as ${choice.format}.`, 400);
    }
  }
}
