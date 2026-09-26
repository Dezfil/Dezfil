import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { deriveTableName } from "@/lib/ingest/naming";
import { listSteps, type RecipeStep } from "@/lib/metadata/recipes";
import { listTables } from "@/lib/metadata/tables";
import { findOperation } from "./catalog";

/**
 * A declared output's name, at add and at edit.
 *
 * The rule the drawer's form applies on screen, held by the API so an agent
 * and the canvas get the same answer: the registered form is what is
 * stored and promised; a blank or letterless name is refused in its own
 * words; a name a registered table carries, or another node of the **same
 * recipe** declares or holds, is refused naming the holder; a produced
 * output's name is frozen (the phase's ruling). Another workflow's unrun
 * declaration is not a reservation anywhere else, so it is not one here;
 * the registry's refusal at run time stays the backstop.
 */

/** The name the registry will use for what was typed. */
export function registeredOutputName(typed: string): string {
  return deriveTableName(typed.trim(), new Set());
}

const declared = (params: Record<string, unknown> | null): string | null =>
  params && typeof params.name === "string" && params.name.trim() !== ""
    ? registeredOutputName(params.name)
    : null;

/** Every name a step of the recipe declares or holds, other than `stepId`'s. */
export function siblingNames(
  recipeId: string,
  stepId: string | null,
  db: Database,
): Map<string, RecipeStep> {
  const held = new Map<string, RecipeStep>();
  for (const s of listSteps(recipeId, db)) {
    if (s.id === stepId) continue;
    for (const n of [declared(s.parameters), declared(s.proposedParameters), s.outputTableName?.toLowerCase() ?? null]) {
      if (n && !held.has(n)) held.set(n, s);
    }
  }
  return held;
}

/**
 * The refusal a typed name earns, or null when it is accepted. Absent is
 * not refused here: a node may be added before it is named, and the run
 * refuses a nameless one.
 */
export function outputNameRefusal(args: {
  db: Database;
  recipeId: string;
  /** The step being edited; null for one being added. */
  stepId: string | null;
  /** The dataset the step has produced, when it has. */
  produced: string | null;
  typed: unknown;
}): ApiError | null {
  const { db, recipeId, stepId, produced, typed } = args;
  // An edit replaces the whole definition: leaving the name out of a
  // produced step's definition would drop its frozen name.
  if (typed === undefined) {
    return produced === null
      ? null
      : new ApiError(
          "invalid_request",
          `The dataset "${produced}" keeps its name after its first run.`,
          400,
        );
  }
  if (typeof typed !== "string") {
    return new ApiError("invalid_request", "The result's name must be a string.", 400);
  }
  const trimmed = typed.trim();
  if (trimmed === "") {
    return new ApiError("invalid_request", "The result needs a name.", 400);
  }
  if (!/[a-z0-9]/i.test(trimmed.normalize("NFKD"))) {
    return new ApiError("invalid_request", "That name has no letters or digits in it.", 400);
  }
  const registered = registeredOutputName(trimmed);
  if (produced !== null) {
    if (registered !== produced.toLowerCase()) {
      return new ApiError(
        "invalid_request",
        `The dataset "${produced}" keeps its name after its first run.`,
        400,
      );
    }
    return null;
  }
  const table = listTables(db).find((t) => t.name.toLowerCase() === registered);
  if (table) {
    return new ApiError(
      "name_taken",
      `A table named "${registered}" already exists. An operation never replaces or ` +
        `renames around an existing table. Choose another name.`,
      400,
    );
  }
  const sibling = siblingNames(recipeId, stepId, db).get(registered);
  if (sibling) {
    return new ApiError(
      "name_taken",
      `Another node of this workflow (${findOperation(sibling.operation).label}) already ` +
        `declares "${registered}". Choose another name.`,
      400,
    );
  }
  return null;
}
