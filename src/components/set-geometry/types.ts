import type { GeometryCandidate, GeometryFormat, GeometryRecord } from "@/lib/geometry-evidence";
import type { GeometryChoice, GeometryExtent, GeometryMode, GeometryPreview } from "@/lib/geometry/types";
import type { TableListing } from "../api";

export type { GeometryChoice, GeometryPreview };

/** The published read of a dataset's geometry: columns, record,
 * the replayable current choice, and candidates in the API's order. */
export interface GeometryInspection {
  tableId: string;
  revision: string;
  columns: { name: string; type: string }[];
  geometryColumn: string | null;
  geometryRecord: GeometryRecord | null;
  currentChoice: GeometryChoice | null;
  mode: GeometryMode;
  candidates: GeometryCandidate[];
}

/** The committed envelope of a set: the Table shape, never a later
 * inspection that could describe another mutation. */
export interface GeometrySetResult {
  table: TableListing;
  revision: string;
  currentChoice: GeometryChoice | null;
  mode: GeometryMode;
  extent: GeometryExtent;
}

export interface ProjectionEntry {
  epsg: number;
  name: string;
  unit: "degrees" | "metres" | null;
}

export interface ProjectionList {
  projections: ProjectionEntry[];
  resolved: ProjectionEntry | null;
}

/** The projection the panel's choice carries.
 *
 * `implicit`: untouched and carrying no code, so the API's own CRS rules
 * apply and an assumed dataset stays assumed. `explicit`: a code
 * the person picked, or the code the current choice already carried when
 * the panel opened on it. `other`: Other EPSG code is selected, its code
 * the field's resolved integer or null while the field is empty or not a
 * number. `unset`: the native first-projection-change path, where the
 * field is marked and holds no code until the person chooses one. */
export interface PanelProjection {
  kind: "implicit" | "explicit" | "other" | "unset";
  code: number | null;
  text: string;
}

export interface PanelChoice {
  format: GeometryFormat;
  /** One column, or two in x/y order for a pair. */
  columns: string[];
  projection: PanelProjection;
}

/** A pair the proposal strip hands the panel to open on. */
export interface SeedChoice {
  format: "pair";
  columns: [string, string];
}
