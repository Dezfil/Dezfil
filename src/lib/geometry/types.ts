import type { GeometryFormat } from "@/lib/geometry-evidence";

export interface GeometryChoice {
  format: GeometryFormat;
  /** Pair columns are ordered x, y; other formats name one column. */
  columns: string[];
  epsg?: number;
}
export type GeometryMode = "unmodified" | "set" | "cleared";
export type GeometryExtent = [number, number, number, number] | null;

export interface GeometryIssue {
  code: "projection_required" | "unsupported_projection" | "h3_unavailable" | "unknown_crs" | "conflicting_crs" | "source_unavailable";
  message: string;
}
export interface GeometryPreview {
  tableId: string;
  revision: string;
  choice: GeometryChoice;
  canApply: boolean;
  issues: GeometryIssue[];
  /** Counts, class, extent and degree verdict cover only the first 50 rows. */
  rowCount: number;
  unreadableCount: number;
  geometryType: string | null;
  extent: GeometryExtent;
  degreeCompatible: boolean | null;
  sample: {
    rows: { index: number; values: Record<string, unknown>; status: "readable" | "missing" | "unreadable" | "projection-required" }[];
    features: { type: "FeatureCollection"; features: { type: "Feature"; id: number; geometry: unknown; properties: Record<string, never> }[] };
  };
}
