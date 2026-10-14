import { recordDocumentBatch, readDocumentRevision } from "@/lib/metadata/revisions";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { mayFileInto, requirePermitted } from "@/lib/auth/reach";
import { ApiError } from "@/lib/api/errors";
import { deriveTableName } from "@/lib/ingest/naming";
import { metadataDb } from "@/lib/metadata/db";
import { getLayout, putLayout } from "@/lib/metadata/recipe-layouts";
import { recipeHome } from "@/lib/metadata/recipes";
import { fileRecipe, recipeStanding } from "@/lib/metadata/owned-recipes";
// The source is read as the duplicator reaches it; the names a copy may not
// take are the duplicator's own and the datasets of the home the copy keeps.
import {
  copyStep,
  createRecipe,
  getRecipe,
  requireRecipe,
  listOwnRecipes,
  listOwnSteps,
  listSteps,
  type Recipe,
  type RecipeStep,
} from "@/lib/metadata/owned-recipes";
import { listOwnedTables, tableNamesOf } from "@/lib/metadata/owned-tables";
import type { Database } from "better-sqlite3";
import { findOperation } from "./catalog";
import { copyReadsAgree, readCopySql, rewriteCopySql, wordsOf } from "./copy-references";

/**
 * Duplicating a recipe.
 *
 * A copy that kept its output names could not run — the engine refuses an
 * occupied name — and a copy whose later nodes still read the *original's*
 * outputs would be two recipes sharing data while looking independent. So
 * the copy: takes each node's **active** definition and provenance under a
 * fresh id, in order; renames every declared output to a name that is free
 * — against owned tables and every name an owned recipe declares, active or
 * pending, through the same normalization the engine applies at admission;
 * redirects every read of an original output to the copy's, in named inputs
 * and in SQL table references; carries no output, proposal or history.
 *
 * **Analysis is asynchronous, the write is not.** The SQL parse that checks
 * a rewrite runs first; inside the metadata transaction the source's node
 * stamps and every allocated name are checked again, so a change between
 * the two is a refusal, never a wrong copy.
 */

const COPY_SUFFIX = " copy";
/** Kept in step with the name rule the routes apply. */
const NAME_MAX = 120;

/** A declared output through the registry's own naming, as `ownersByName` does:
 * the name the consumer's SQL will have to write. */
function declaredName(params: Record<string, unknown> | null): string | null {
  return params && typeof params.name === "string" && params.name !== ""
    ? deriveTableName(params.name, new Set())
    : null;
}

/** Every name a new output may not take: registered tables, and what every
 * owned recipe's nodes declare or hold, active or pending; and the datasets
 * of the SQL home the copy keeps, where a declared output would shadow one
 * for every step that reads it by its plain name. The declaration rule
 * refuses both, so a copy allocated against less could not be edited. */
export function takenNames(scope: AccountScope, db: Database, home: string | null): Set<string> {
  const taken = new Set<string>(listOwnedTables(scope, db).map((t) => t.name.toLowerCase()));
  if (home !== null) for (const name of tableNamesOf(home, db)) taken.add(name.toLowerCase());
  for (const recipe of listOwnRecipes(scope, db)) {
    for (const step of listOwnSteps(scope, recipe.id, db)) {
      for (const n of [declaredName(step.parameters), declaredName(step.proposedParameters), step.outputTableName?.toLowerCase() ?? null]) {
        if (n) taken.add(n);
      }
    }
  }
  return taken;
}

function copyName(name: string): string {
  const full = `${name}${COPY_SUFFIX}`;
  if (full.length <= NAME_MAX) return full;
  return `${name.slice(0, NAME_MAX - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`;
}

const stamp = (steps: RecipeStep[]) =>
  steps.map((s) => `${s.id}:${s.ordinal}:${s.updatedAt}`).join("|");

interface PlannedStep {
  operation: string;
  parameters: Record<string, unknown>;
  origin: Record<string, unknown> | null;
}

/**
 * Anyone who reaches a workflow may duplicate it, a frozen one included: the
 * copy is the duplicator's own, keeps the original's SQL home, and lands in
 * the original's project only when the duplicator may file there.
 */
export async function duplicateRecipe(scope: AccountScope, sourceId: string): Promise<Recipe> {
  requireAccountScope(scope);
  const db = metadataDb();
  requirePermitted(scope, "workflow", sourceId, "duplicate", db);
  const source = requireRecipe(scope, sourceId, db);
  const steps = listSteps(scope, sourceId, db);
  const before = stamp(steps);

  // 1. Plan: fresh names, redirected reads — from the active definitions.
  // An unstamped home is its owner's, as the declaration rule reads it.
  const standing = recipeStanding(sourceId, db);
  const home = standing?.homeId ?? standing?.ownerId ?? null;
  const taken = takenNames(scope, db, home);
  // Fresh outputs must not capture a local SQL name, including a WITH name.
  for (const step of steps) wordsOf(step.parameters, taken);
  const renamed = new Map<string, string>();
  const inputs: Map<string, string>[] = [];
  const planned: PlannedStep[] = steps.map((step) => {
    inputs.push(new Map(renamed));
    const parameters: Record<string, unknown> = { ...step.parameters };
    const operation = findOperation(step.operation);
    for (const input of operation.inputs) {
      const value = parameters[input.name];
      if (typeof value !== "string") continue;
      const to = renamed.get(value.toLowerCase());
      if (to) parameters[input.name] = to;
    }
    if (typeof parameters.sql === "string") {
      parameters.sql = rewriteCopySql(parameters.sql, renamed);
    }
    const declared = declaredName(step.parameters);
    if (declared) {
      const fresh = deriveTableName(`${declared}_copy`, taken);
      taken.add(fresh);
      renamed.set(declared, fresh);
      parameters.name = fresh;
    }
    return { operation: step.operation, parameters, origin: step.origin ?? null };
  });

  // 2. Verify: the engine's parse of each rewritten SQL reads exactly what the
  //    original read, with the copy's names where the original's stood.
  for (let i = 0; i < steps.length; i++) {
    if (typeof planned[i].parameters.sql !== "string") continue;
    const originalSql = String(steps[i].parameters.sql);
    const original = await readCopySql(scope, originalSql);
    // An incomplete definition stays incomplete in the copy.
    if (original === null) { planned[i].parameters.sql = originalSql; continue; }
    const text = String(planned[i].parameters.sql);
    const copied = text === originalSql ? original : await readCopySql(scope, text);
    const same = copyReadsAgree(original, copied, inputs[i]);
    if (!same) {
      throw new ApiError(
        "invalid_request",
        `The copy could not rewrite the SQL of node ${i + 1} to read its own ` +
          `outputs. Edit that node's SQL to name its inputs plainly and try again.`,
        422,
      );
    }
  }

  // 3. Write, after checking that nothing moved under the plan.
  const name = copyName(source.name);
  return recordDocumentBatch(scope, () => {
    requireRecipe(scope, sourceId, db);
    if (stamp(listSteps(scope, sourceId, db)) !== before) {
      throw new ApiError(
        "invalid_request",
        "This workflow changed while its copy was being prepared. Try again.",
        409,
      );
    }
    const now = takenNames(scope, db, home);
    for (const fresh of renamed.values()) {
      if (now.has(fresh)) {
        throw new ApiError(
          "name_taken",
          `The name "${fresh}" was taken while the copy was being prepared. Try again.`,
          409,
        );
      }
    }
    // The copy keeps its source's SQL home, whoever makes it.
    const copy = createRecipe(scope, name, db, "workflow", recipeHome(sourceId, db) ?? undefined);
    // The copy lands in its source's project — the source re-read
    // INSIDE this transaction, so a move during the asynchronous
    // preparation files the copy where the source is NOW, and a
    // dissolved project reads null (found at review).
    const live = getRecipe(scope, sourceId, db);
    if (live?.projectId && mayFileInto(scope, live.projectId, db)) fileRecipe(scope, copy.id, live.projectId, db, { expectedRevision: readDocumentRevision({ kind: "workflow", id: copy.id }, db)!.editRevision });
    const copiedIds = new Map<string, string>();
    planned.forEach((p, i) => {
      copiedIds.set(steps[i].id, copyStep(scope, steps[i].id, copy.id, p.parameters, db, { expectedRevision: readDocumentRevision({ kind: "workflow", id: copy.id }, db)!.editRevision }).id);
    });
    // The layout goes with the copy: each node's position under the copy's
    // identity, sources and notes as they are. A never-written document
    // stays never written.
    const layout = getLayout(sourceId, db);
    if (layout.updatedAt !== null) {
      putLayout(
        copy.id,
        {
          steps: Object.fromEntries(
            Object.entries(layout.document.steps).flatMap(([id, at]) => {
              const to = copiedIds.get(id);
              return to ? [[to, at]] : [];
            }),
          ),
          sources: layout.document.sources,
          notes: layout.document.notes,
        },
        db,
      );
    }
    return copy;
  }, db);
}
