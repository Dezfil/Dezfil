import type { TableListing } from "../../api";
import type { RecipeSummary } from "./recipe-model";

/**
 * Derived-table grouping.
 *
 * **A catalog this size floods every table picker.** Every verb mints a durable
 * global dataset and a twelve-step recipe mints twelve; without grouping, the
 * workspace fills with names nobody can attribute.
 *
 * **It is a property of the table list wherever it appears**, not of the
 * drawer. That is why this is a pure function over a listing rather than a
 * component: the drawer's own pickers and the add-layer catalog's table browser
 * both call it, and the grouping rule stands on the second — a grouping that
 * lived only inside the drawer could not satisfy a criterion about inspecting
 * an output *without opening the drawer*.
 */

/** The step that wrote a derived table, as a row says it. */
export interface StepReference {
  recipeId: string;
  recipeName: string;
  stepId: string;
  /** One-based, as the chain numbers its steps. */
  ordinal: number;
  operation: string;
}

export interface GroupedTable {
  table: TableListing;
  /** Present for a recipe output; absent for an imported table. */
  step?: StepReference;
}

export interface TableGroup {
  key: "sketches" | "outputs" | "workspace";
  /** The eyebrow above the group. */
  label: string;
  tables: GroupedTable[];
}

export const SKETCHES_LABEL = "Drawn on this map";
export const OUTPUTS_LABEL = "Tool outputs";
export const WORKSPACE_LABEL = "Workspace tables";

/** Which step wrote which table, by output id. */
export function stepsByOutput(
  recipes: RecipeSummary[],
): Map<string, StepReference> {
  const byOutput = new Map<string, StepReference>();
  for (const recipe of recipes) {
    for (const step of recipe.steps) {
      if (!step.output) continue;
      byOutput.set(step.output.id, {
        recipeId: recipe.id,
        recipeName: recipe.name,
        stepId: step.id,
        ordinal: step.ordinal + 1,
        operation: step.operation,
      });
    }
  }
  return byOutput;
}

/**
 * The groups, **Drawn on this map above Tool outputs above Workspace
 * tables**, each with its own eyebrow, and an empty group omitted rather
 * than shown empty.
 *
 * A table produced by an operation whose step has since been removed is still
 * an operation's output — it just has no step to point back at. It stays in
 * the workspace group rather than under an eyebrow that promises a
 * back-reference it cannot make.
 *
 * The sketches group exists only where a current map gives it meaning: the
 * Tools picker passes its map, the add-layer browser passes nothing and keeps
 * its context-free grouping. Another map's sketch is an ordinary workspace
 * table here.
 */
export function groupTables(
  tables: TableListing[],
  recipes: RecipeSummary[],
  sketchContext?: { mapId: string } | null,
): TableGroup[] {
  const byOutput = stepsByOutput(recipes);
  const sketches: GroupedTable[] = [];
  const outputs: GroupedTable[] = [];
  const workspace: GroupedTable[] = [];
  for (const table of tables) {
    const step = byOutput.get(table.id);
    if (
      sketchContext &&
      table.source === "sketch" &&
      table.sourceParams?.mapId === sketchContext.mapId
    ) {
      sketches.push({ table });
      continue;
    }
    // **The table's own source decides the group**: an
    // operation output whose owning step — or whole recipe — is gone is
    // still a tool's output, and filing it under Workspace tables would
    // make it the one dataset nobody can attribute. The step, when one
    // still owns it, only sharpens the attribution.
    if (step || table.source === "operation") outputs.push({ table, step });
    else workspace.push({ table });
  }
  return [
    { key: "sketches", label: SKETCHES_LABEL, tables: sketches },
    { key: "outputs", label: OUTPUTS_LABEL, tables: outputs },
    { key: "workspace", label: WORKSPACE_LABEL, tables: workspace },
  ].filter((group) => group.tables.length > 0) as TableGroup[];
}

/** What a row says a table holds: the two facts that decide whether an
 * operation is legal, visible **before** the picker opens. */
export function geometryClass(table: TableListing): string {
  if (table.geometryColumn === null) return "no geometry";
  const type = table.geometryType;
  if (!type) return "geometry of unknown class";
  return type.toLowerCase().replace(/^multi/, "multi ");
}

/**
 * Which class of geometry a table holds, in the catalog's own vocabulary.
 *
 * The registry stores what the engine reported — `POINT`, `MULTIPOLYGON`,
 * `GEOMETRY` — and the catalog speaks of point, line and polygon. A table whose
 * type is the unspecific `GEOMETRY` could hold any of them, so it is **not**
 * classified: refusing to guess is what keeps a picker from disabling a table
 * that would have worked.
 */
export function geometryClassOf(
  table: TableListing,
): "point" | "line" | "polygon" | null {
  const recordedType = table.geometryType;
  const type = (recordedType ?? "").toUpperCase();
  if (type.includes("POINT")) return "point";
  if (type.includes("LINE")) return "line";
  if (type.includes("POLYGON")) return "polygon";
  return null;
}

/** Whether an input that accepts these classes can take this table. */
export function acceptsTable(
  accepts: readonly string[],
  table: TableListing,
): boolean {
  if (accepts.includes("any")) return true;
  // **`none` is `any`'s opposite and takes only a table without geometry**: a
  // verb that writes a geometry column onto rows that came without one cannot
  // take a table that already has one, because a dataset has exactly one active
  // geometry column.
  //
  // Asked of the **column**, which is what admission refuses on — not of the
  // type, which is null for a table that has a geometry column and nothing
  // classifiable in it (an empty table, or a geocode result where nothing
  // matched). Reading the type here offered exactly those rows and let the run
  // refuse them. Found at the cross-model review.
  if (accepts.includes("none")) return !table.geometryColumn;
  // `any` is the only other acceptance that includes a table with no geometry:
  // a verb naming classes wants geometry, and saying so here is what stops the
  // picker offering a table the run would refuse.
  if (table.geometryColumn === null) return false;
  const held = geometryClassOf(table);
  return held === null || accepts.includes(held);
}

/** Why a table is not offered for this input, in the input's own terms. Said
 * where the row is, so a disabled row is never a mystery. */
export function refusalFor(
  accepts: readonly string[],
  table: TableListing,
): string {
  if (accepts.includes("none")) {
    return (
      `This step writes geometry onto every row, so it takes a table without ` +
      `any: “${table.name}” holds ${geometryClass(table)}.`
    );
  }
  return `This step needs ${accepts.join(", ")} geometry; “${table.name}” holds ${geometryClass(table)}.`;
}
