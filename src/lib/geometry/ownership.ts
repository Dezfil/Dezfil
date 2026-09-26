import type { DataTable } from "@/lib/metadata/tables";
import { ApiError } from "@/lib/api/errors";
import { retainedChoice } from "./read";
import type { GeometryChoice } from "./types";
import type { GeometryState } from "./state";

export function sourceUnavailable(message = "The original geometry source is no longer stored. A further change is unavailable."): never {
  throw new ApiError("geometry_choice_invalid", message, 422, { issues: [{ code: "source_unavailable", message }] });
}
export function geometryOwnership(table: DataTable, state: GeometryState | null, columns: { name: string }[]) {
  const retained = retainedChoice(table, columns);
  return { managed: state?.mode === "set" ? state.sourceRetained : retained !== null,
    currentChoice: state ? (state.mode === "set" && state.sourceRetained ? state.choice : null) : retained };
}
export function nativeGeometryChoice(table: DataTable, state: GeometryState | null, columns: { name: string }[], choice: GeometryChoice): boolean {
  const { managed } = geometryOwnership(table, state, columns);
  const selectsOutput = choice.columns.includes(table.geometryColumn ?? "");
  if (table.geometryColumn && !managed) {
    if (!table.crsAssumed && state?.mode !== "set") sourceUnavailable("This dataset's geometry has a declared CRS. It cannot be replaced here.");
    if (!table.crsAssumed || state?.mode === "set" || !selectsOutput || choice.columns.length !== 1 ||
        choice.format !== (table.geometryRecord?.format ?? "wkb") || choice.epsg === undefined) sourceUnavailable();
    return true;
  }
  if (selectsOutput) sourceUnavailable("Choose a retained source column. Generated geometry is not an original input.");
  return false;
}
