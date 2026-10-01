import type { AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { deriveTableName } from "@/lib/ingest/naming";
import { requireAccountScope } from "@/lib/auth/scope";
import { requireRecipe, listSteps, recipeStanding, type RecipeStep } from "@/lib/metadata/owned-recipes";
import { tableNameHeld } from "@/lib/metadata/owned-tables";
import { findOperation } from "./catalog";

/**
 * A declared output's name, at add and at edit.
 *
 * The rule the drawer's form applies on screen, held by the API so an agent
 * and the canvas get the same answer: the registered form is what is
 * stored and promised; a blank or letterless name is refused in its own
 * words; a name a registered table carries, or another node of the **same
 * recipe** declares or holds, is refused naming the holder; a produced
 * output's name is frozen. Another workflow's unrun declaration is not a
 * reservation anywhere else, so it is not one here; the registry's refusal
 * at run time stays the backstop.
 *
 * "A registered table" means one in either space the name meets: the
 * workflow's SQL home, where the steps read plain names and a declared
 * output would shadow a home dataset other steps read, and the declaring
 * person's own space, where their run lands the output. For a workflow's
 * owner in their own home the two are one. Someone declaring a name only the
 * home holds is told the name is not available in this workflow, never which
 * table holds it: the home's datasets need not be theirs to see.
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
  scope: AccountScope,
  recipeId: string,
  stepId: string | null,
  db: Database,
): Map<string, RecipeStep> {
  const held = new Map<string, RecipeStep>();
  for (const s of listSteps(scope, recipeId, db)) {
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
  scope: AccountScope;
  db: Database;
  recipeId: string;
  /** The step being edited; null for one being added. */
  stepId: string | null;
  /** The dataset the step has produced, when it has. */
  produced: string | null;
  typed: unknown;
}): ApiError | null {
  const { scope, db, recipeId, stepId, produced, typed } = args;
  requireRecipe(scope, recipeId, db);
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
  const me = requireAccountScope(scope, db);
  const standing = recipeStanding(recipeId, db);
  const home = standing?.homeId ?? standing?.ownerId ?? me;
  if (tableNameHeld([me], registered, db)) {
    return new ApiError(
      "name_taken",
      `A table named "${registered}" already exists. An operation never replaces or ` +
        `renames around an existing table. Choose another name.`,
      400,
    );
  }
  // Held in the home only, by someone else: the home's datasets may be
  // private, so the refusal names no table and says nothing exists.
  if (home !== me && tableNameHeld([home], registered, db)) {
    return new ApiError("name_taken", "That name is not available in this workflow. Choose another name.", 400);
  }
  const sibling = siblingNames(scope, recipeId, stepId, db).get(registered);
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
