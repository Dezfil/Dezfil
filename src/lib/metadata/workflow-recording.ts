import type { Database } from "better-sqlite3";
import type { AccountScope } from "@/lib/auth/scope";
import { stableJson } from "./history";
import { getRecipe, getStep, listSteps } from "./recipes";
import { recordDocumentChanges } from "./revisions";

/** Executable meaning excludes names, layout and run/output bookkeeping. */
function executable(id: string, db: Database) {
  return stableJson(listSteps(id, db).map(step => ({
    id: step.id, ordinal: step.ordinal, operation: step.operation,
    parameters: step.parameters, proposedParameters: step.proposedParameters,
    origin: step.origin, proposedOrigin: step.proposedOrigin,
  })));
}

/** Compare the accepted definition inside its write transaction. Repository
 * clocks and run output associations are deliberately not edit evidence. */
export function recordWorkflowEdit<T>(scope: AccountScope, id: string, apply: () => T, db: Database): T {
  return db.transaction(() => {
    const before = getRecipe(id, db), definition = executable(id, db);
    const value = apply();
    const after = getRecipe(id, db), definitionChanged = definition !== executable(id, db);
    if (before && after && (before.name !== after.name || definitionChanged)) {
      recordDocumentChanges(scope, [{ kind: "workflow", id, executable: definitionChanged }], db);
    }
    return value;
  })();
}
export function recordStepEdit<T>(scope: AccountScope, id: string, apply: () => T, db: Database): T {
  const step = getStep(id, db);
  return step ? recordWorkflowEdit(scope, step.recipeId, apply, db) : apply();
}
