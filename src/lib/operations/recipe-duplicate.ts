import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import { deriveTableName } from "@/lib/ingest/naming";
import { metadataDb } from "@/lib/metadata/db";
import { getLayout, putLayout } from "@/lib/metadata/recipe-layouts";
import { fileRecipe } from "@/lib/metadata/owned-recipes";
import {
  copyStep,
  createRecipe,
  getRecipe,
  requireRecipe,
  listRecipes,
  listSteps,
  type Recipe,
  type RecipeStep,
} from "@/lib/metadata/owned-recipes";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
import type { Database } from "better-sqlite3";
import { findOperation } from "./catalog";
import { rewriteTableReferences } from "./sql-references";
import { stepReads } from "./step-reads";

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
 * owned recipe's nodes declare or hold, active or pending. */
function takenNames(scope: AccountScope, db: Database): Set<string> {
  const taken = new Set<string>(listOwnedTables(scope, db).map((t) => t.name.toLowerCase()));
  for (const recipe of listRecipes(scope, db)) {
    for (const step of listSteps(scope, recipe.id, db)) {
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

export async function duplicateRecipe(scope: AccountScope, sourceId: string): Promise<Recipe> {
  requireAccountScope(scope);
  const db = metadataDb();
  const source = requireRecipe(scope, sourceId, db);
  const steps = listSteps(scope, sourceId, db);
  const before = stamp(steps);

  // 1. Plan: fresh names, redirected reads — from the active definitions.
  const taken = takenNames(scope, db);
  const renamed = new Map<string, string>();
  const planned: PlannedStep[] = steps.map((step) => {
    const parameters: Record<string, unknown> = { ...step.parameters };
    const operation = findOperation(step.operation);
    for (const input of operation.inputs) {
      const value = parameters[input.name];
      if (typeof value !== "string") continue;
      const to = renamed.get(value.toLowerCase());
      if (to) parameters[input.name] = to;
    }
    if (typeof parameters.sql === "string") {
      parameters.sql = rewriteTableReferences(
        parameters.sql,
        (name) => renamed.get(name) ?? null,
      );
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
    const original = await stepReads(scope, {
      operation: steps[i].operation,
      parameters: steps[i].parameters,
      proposedParameters: null,
    }).catch(() => null);
    // SQL the parser cannot read is copied as it is: the copy refuses to run
    // it exactly as the original does, and says why.
    if (original === null) continue;
    const copied = await stepReads(scope, {
      operation: planned[i].operation,
      parameters: planned[i].parameters,
      proposedParameters: null,
    }).catch(() => null);
    const expected = new Set(original.map((n) => renamed.get(n) ?? n));
    const got = new Set(copied ?? []);
    const same =
      copied !== null &&
      expected.size === got.size &&
      [...expected].every((n) => got.has(n));
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
  return db.transaction(() => {
    requireRecipe(scope, sourceId, db);
    if (stamp(listSteps(scope, sourceId, db)) !== before) {
      throw new ApiError(
        "invalid_request",
        "This workflow changed while its copy was being prepared. Try again.",
        409,
      );
    }
    const now = takenNames(scope, db);
    for (const fresh of renamed.values()) {
      if (now.has(fresh)) {
        throw new ApiError(
          "name_taken",
          `The name "${fresh}" was taken while the copy was being prepared. Try again.`,
          409,
        );
      }
    }
    const copy = createRecipe(scope, name, db, "workflow");
    // The copy lands in its source's project — the source re-read
    // INSIDE this transaction, so a move during the asynchronous
    // preparation files the copy where the source is NOW, and a
    // dissolved project reads null (found at review).
    const live = getRecipe(scope, sourceId, db);
    if (live?.projectId) fileRecipe(scope, copy.id, live.projectId, db);
    const copiedIds = new Map<string, string>();
    planned.forEach((p, i) => {
      copiedIds.set(steps[i].id, copyStep(scope, steps[i].id, copy.id, p.parameters, db).id);
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
  })();
}
