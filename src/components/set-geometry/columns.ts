import type { GeometryFormat } from "@/lib/geometry-evidence";

/** The engine's numeric families, as the CSV road names them. */
const NUMERIC = /^(DOUBLE|FLOAT|REAL|DECIMAL|(U?(TINY|SMALL|BIG|HUGE)?INT))/;

export interface ColumnEntry {
  name: string;
  type: string;
}

/** The columns a format's field offers: what the API accepts for it,
 * so a pick never answers with a type refusal. A pair takes numeric
 * and text-typed columns; a single-column format takes text. The stored
 * geometry column is never offered as a source, except on the
 * native path where it is the only column the choice may name. */
export function acceptedColumns(
  format: GeometryFormat,
  columns: readonly ColumnEntry[],
  geometryColumn: string | null,
  native = false,
): ColumnEntry[] {
  return columns.filter((c) => {
    if (c.name === geometryColumn) return native && c.type.startsWith("GEOMETRY");
    if (c.type.startsWith("VARCHAR")) return true;
    return format === "pair" && NUMERIC.test(c.type);
  });
}
