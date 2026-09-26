import type { GeometryFormat } from "@/lib/geometry-evidence";
import { acceptedColumns } from "./columns";
import { IMPLICIT, UNSET, carriedProjection } from "./projection";
import type { GeometryInspection, PanelChoice, SeedChoice } from "./types";

/** The drawn format order. */
export const FORMAT_ORDER: readonly GeometryFormat[] = ["pair", "wkt", "geojson", "wkb", "h3"];

export interface Opening {
  choice: PanelChoice;
  /** A first apply carries the drawn footer sentence; a change omits it. */
  mode: "first" | "change";
  /** The projection field is marked and holds no code: the native path. */
  marked: boolean;
}

/**
 * What the panel opens on: the API's current choice with the
 * code it carries; else, for a dataset with geometry whose CRS is assumed,
 * the first projection change the API admits (the stored geometry column,
 * the record's format or WKB hex, no code, no preview); else the first
 * candidate in the API's order; else the first format with the first
 * columns it accepts. A seed from the proposal strip opens filled in.
 * Nothing is fabricated for a recordless native dataset.
 */
export function openingChoice({ inspection, table, seed }: {
  inspection: GeometryInspection;
  table: { geometryColumn: string | null; crsAssumed: boolean };
  seed?: SeedChoice | null;
}): Opening {
  const mode = table.geometryColumn !== null ? "change" : "first";
  if (seed) return { choice: { format: "pair", columns: [...seed.columns], projection: IMPLICIT }, mode, marked: false };
  const current = inspection.currentChoice;
  if (current) {
    return { choice: { format: current.format, columns: [...current.columns], projection: carriedProjection(current.epsg) }, mode: "change", marked: false };
  }
  if (table.geometryColumn !== null && table.crsAssumed) {
    return {
      choice: { format: inspection.geometryRecord?.format ?? "wkb", columns: [table.geometryColumn], projection: UNSET },
      mode: "change",
      marked: true,
    };
  }
  const candidate = inspection.candidates.find((c) => c.sourceRetained);
  if (candidate) {
    const first = candidate.orientations?.[0];
    const columns = candidate.format === "pair" && first ? [first.lon, first.lat] : [...candidate.columns];
    return { choice: { format: candidate.format, columns, projection: IMPLICIT }, mode, marked: false };
  }
  for (const format of FORMAT_ORDER) {
    const accepted = acceptedColumns(format, inspection.columns, table.geometryColumn).map((c) => c.name);
    const need = format === "pair" ? 2 : 1;
    if (accepted.length >= need) return { choice: { format, columns: accepted.slice(0, need), projection: IMPLICIT }, mode, marked: false };
  }
  // A dataset with geometry and no retained column left to offer (a
  // consumed source whose CRS is declared, or corrected once): the stored
  // column itself, so the API's own refusal reaches the person
  // rather than a panel with nothing to send.
  if (table.geometryColumn !== null) {
    return { choice: { format: inspection.geometryRecord?.format ?? "wkb", columns: [table.geometryColumn], projection: IMPLICIT }, mode, marked: false };
  }
  return { choice: { format: "pair", columns: [], projection: IMPLICIT }, mode, marked: false };
}
