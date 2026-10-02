import { recordDocumentCreation } from "./revisions";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { metadataDb } from "./db";
import { touchProjectsOf } from "./projects";
import { ApiError } from "@/lib/api/errors";

export { recordOutput, stepOwnsOutput } from "./recipe-outputs";

/**
 * Recipes and their steps.
 *
 * A recipe is an **ordered list whose dependencies may only point backwards**.
 * That is a directed acyclic graph and necessarily so — two steps may both read
 * step one — but the ordering is what keeps it authorable as a list and lets a
 * backward-only rule be checked by position rather than by walking the graph at
 * run time.
 *
 * Three things here are deliberate and easy to undo by accident.
 *
 * **A step's proposed parameters are not its active ones.** Editing a step that
 * has already produced an output does not change what that output means; the
 * proposal becomes active only when a run of it succeeds (G3). Collapsing the
 * two would leave a step whose definition and output disagree with no way to say
 * so.
 *
 * **A step owns its output as a stored fact**, recorded here rather than taken
 * from anything a caller sends. That ownership is what admits a re-run to reuse
 * an existing table name, so reading it from request input would let any client
 * overwrite any table.
 *
 * **Ordinals are dense and rewritten on every move.** A sparse or duplicated
 * ordinal makes "earlier than" ambiguous, and "earlier than" is the whole
 * validity rule.
 */

/** Which surface made a recipe: the workflows page lists
 * `workflow`; the builder's one-step Tools make `builder`. Fixed at creation. */
export type RecipeOrigin = "workflow" | "builder";

export interface Recipe {
  id: string;
  name: string;
  origin: RecipeOrigin;
  /** The project this workflow is in; null = not in one. */
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecipeStep {
  id: string;
  recipeId: string;
  ordinal: number;
  operation: string;
  /** What the step means now — what its output was produced from. */
  parameters: Record<string, unknown>;
  /** An edit awaiting a successful run (G3); null when there is none. */
  proposedParameters: Record<string, unknown> | null;
  /** The dataset this step owns, once it has produced one. */
  outputTableId: string | null;
  outputTableName: string | null;
  /** Where the step's SQL came from, when it was authored from a layer. */
  origin: Record<string, unknown> | null;
  /** The origin a proposal would bring with it, promoted with the definition.
   * Re-authoring a step from a *different* layer changes both, and promoting
   * only the SQL would leave the API describing the step as authored from a
   * layer it no longer reads. */
  proposedOrigin: Record<string, unknown> | null;
  lastSuccessAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RecipeRow {
  id: string;
  name: string;
  origin: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  recipe_id: string;
  ordinal: number;
  operation: string;
  parameters: string;
  proposed_parameters: string | null;
  output_table_id: string | null;
  output_table_name: string | null;
  origin: string | null;
  proposed_origin: string | null;
  last_success_at: string | null;
  created_at: string;
  updated_at: string;
}

const parse = (v: string | null): Record<string, unknown> | null =>
  v ? (JSON.parse(v) as Record<string, unknown>) : null;

function hydrateRecipe(r: RecipeRow): Recipe {
  return {
    id: r.id,
    name: r.name,
    // The migration backfills every older row as the builder's; a row that
    // somehow carries neither word reads as a workflow, the creation default.
    origin: r.origin === "builder" ? "builder" : "workflow",
    projectId: r.project_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hydrateStep(r: StepRow): RecipeStep {
  return {
    id: r.id,
    recipeId: r.recipe_id,
    ordinal: r.ordinal,
    operation: r.operation,
    parameters: parse(r.parameters) ?? {},
    proposedParameters: parse(r.proposed_parameters),
    outputTableId: r.output_table_id,
    outputTableName: r.output_table_name,
    origin: parse(r.origin),
    proposedOrigin: parse(r.proposed_origin),
    lastSuccessAt: r.last_success_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The next last-edited stamp: now, or one millisecond past the previous
 * stamp when the clock has not moved — "advances" has to be strictly true for
 * a sort by it to be stable. */
function nextStamp(previous: string | null): string {
  const now = Date.now();
  const after = previous ? Date.parse(previous) + 1 : now;
  return new Date(Number.isFinite(after) ? Math.max(now, after) : now).toISOString();
}

/** Mark a recipe edited — by an **accepted** change to it or to its nodes
 * A run never calls this, and neither does a refused change: the add route
 * validates first and touches after. Returns the stamp, or null for a recipe
 * that does not exist. */
export function touchRecipe(id: string, db: Database = metadataDb()): string | null {
  const row = db.prepare(`SELECT updated_at FROM recipes WHERE id = ?`).get(id) as
    | { updated_at: string }
    | undefined;
  if (!row) return null;
  const stamp = nextStamp(row.updated_at);
  db.prepare(`UPDATE recipes SET updated_at = ? WHERE id = ?`).run(stamp, id);
  return stamp;
}

// ---- recipes ----

/** Create a recipe owned by the acting account. Its SQL home is the creator's
 * space unless `home` names another: a copy keeps its source's home. */
export function createRecipe(
  scope: AccountScope,
  name: string,
  db: Database = metadataDb(),
  origin: RecipeOrigin = "workflow",
  home?: string,
): Recipe {
  const ownerId = requireAccountScope(scope, db);
  // Creation is always unfiled; filing is fileRecipe's one job, so the
  // project's clock has a single owner.
  const now = new Date().toISOString();
  const recipe: Recipe = {
    id: randomUUID(),
    name,
    origin,
    projectId: null,
    createdAt: now,
    updatedAt: now,
  };
  db.transaction(() => {
  db.prepare(
    `INSERT INTO recipes (owner_id, home_account_id, id, name, origin, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ownerId,
    home ?? ownerId,
    recipe.id,
    recipe.name,
    recipe.origin,
    recipe.projectId,
    recipe.createdAt,
    recipe.updatedAt,
  );
  recordDocumentCreation(scope, { kind: "workflow", id: recipe.id }, db);
  })();
  return recipe;
}

/** The account whose space a workflow's SQL is evaluated in; null only for a
 * workflow that does not exist or awaits first-account adoption. */
export function recipeHome(id: string, db: Database = metadataDb()): string | null {
  const row = db.prepare("SELECT home_account_id FROM recipes WHERE id = ?").get(id) as { home_account_id: string | null } | undefined;
  return row?.home_account_id ?? null;
}

export function getRecipe(id: string, db: Database = metadataDb()): Recipe | null {
  const row = db.prepare(`SELECT * FROM recipes WHERE id = ?`).get(id) as
    | RecipeRow
    | undefined;
  return row ? hydrateRecipe(row) : null;
}

export function listRecipes(
  db: Database = metadataDb(),
  filter: { origin?: RecipeOrigin; project?: string | "none" } = {},
): Recipe[] {
  // The filters compose and the order is the listing's standing
  // contract, unchanged under any filter.
  const where: string[] = [];
  const args: string[] = [];
  if (filter.origin) {
    where.push(`origin = ?`);
    args.push(filter.origin);
  }
  if (filter.project === "none") {
    where.push(`project_id IS NULL`);
  } else if (filter.project) {
    where.push(`project_id = ?`);
    args.push(filter.project);
  }
  const rows = db
    .prepare(
      `SELECT * FROM recipes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC`,
    )
    .all(...args) as RecipeRow[];
  return rows.map(hydrateRecipe);
}

export function renameRecipe(
  id: string,
  name: string,
  db: Database = metadataDb(),
): boolean {
  const row = db.prepare(`SELECT updated_at FROM recipes WHERE id = ?`).get(id) as
    | { updated_at: string }
    | undefined;
  if (!row) return false;
  db.prepare(`UPDATE recipes SET name = ?, updated_at = ? WHERE id = ?`).run(
    name,
    nextStamp(row.updated_at),
    id,
  );
  return true;
}

/** Deleting a recipe removes its steps and their edges. **Its outputs survive**
 * they are ordinary datasets, and a recipe is the record of how they were
 * made, not their owner (E6). Nothing here touches `data_tables`. The
 * project it leaves advances its clock. */
export function deleteRecipe(id: string, db: Database = metadataDb()): boolean {
  return db.transaction(() => {
    touchProjectsOf({ recipeId: id }, db);
    return db.prepare(`DELETE FROM recipes WHERE id = ?`).run(id).changes > 0;
  })();
}

// ---- steps ----

export function listSteps(
  recipeId: string,
  db: Database = metadataDb(),
): RecipeStep[] {
  const rows = db
    .prepare(`SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY ordinal`)
    .all(recipeId) as StepRow[];
  return rows.map(hydrateStep);
}

export function getStep(id: string, db: Database = metadataDb()): RecipeStep | null {
  const row = db.prepare(`SELECT * FROM recipe_steps WHERE id = ?`).get(id) as
    | StepRow
    | undefined;
  return row ? hydrateStep(row) : null;
}

export interface NewStep {
  operation: string;
  parameters: Record<string, unknown>;
  origin?: Record<string, unknown> | null;
}

/** Append a step. Ordinals stay dense, so "earlier than" is unambiguous. */
export function addStep(
  recipeId: string,
  step: NewStep,
  db: Database = metadataDb(),
): RecipeStep {
  const now = new Date().toISOString();
  const next =
    (
      db
        .prepare(
          `SELECT COALESCE(MAX(ordinal), -1) AS m FROM recipe_steps WHERE recipe_id = ?`,
        )
        .get(recipeId) as { m: number }
    ).m + 1;
  const row: RecipeStep = {
    id: randomUUID(),
    recipeId,
    ordinal: next,
    operation: step.operation,
    parameters: step.parameters,
    proposedParameters: null,
    outputTableId: null,
    outputTableName: null,
    origin: step.origin ?? null,
    proposedOrigin: null,
    lastSuccessAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO recipe_steps
       (id, recipe_id, ordinal, operation, parameters, proposed_parameters,
        output_table_id, output_table_name, origin, last_success_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.recipeId,
    row.ordinal,
    row.operation,
    JSON.stringify(row.parameters),
    null,
    null,
    null,
    row.origin ? JSON.stringify(row.origin) : null,
    null,
    now,
    now,
  );
  return row;
}

/**
 * Record an edit.
 *
 * A step that has never produced an output has nothing to protect, so the edit
 * lands on its active parameters. A step that **has** produced one keeps serving
 * what it produced: the edit is stored as a proposal and becomes active only
 * when a run of it succeeds (G3). Returns which of the two happened, because the
 * caller's next move differs.
 */
/** Whether an edit's resolved origin is the one the step carries: an
 * unchanged definition brought by a different layer is still a change. */
function sameOrigin(a: unknown, b: unknown): boolean {
  const key = (v: unknown): string =>
    v && typeof v === "object" && !Array.isArray(v)
      ? JSON.stringify(Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1))))
      : JSON.stringify(v ?? null);
  return key(a) === key(b);
}

export function editStep(
  id: string,
  parameters: Record<string, unknown>,
  db: Database = metadataDb(),
  /** Where the new parameters came from, when they were re-authored from a
   * layer. Undefined leaves whatever the step already records. */
  origin?: Record<string, unknown> | null,
): "active" | "proposed" | null {
  const step = getStep(id, db);
  if (!step) return null;
  const now = new Date().toISOString();
  // **An edit that rewrites the SQL by hand is no longer "captured from layer
  // X".** Carrying the old origin forward would let the API claim a
  // substitution note and a filter count for a query that reads something else
  // entirely. So: a supplied origin replaces it, an unchanged SQL keeps it, and
  // a hand-rewritten SQL clears it.
  const resolved =
    origin !== undefined
      ? origin
      : sameSql(step, parameters)
        ? (step.origin ?? null)
        : null;
  const encoded = resolved ? JSON.stringify(resolved) : null;
  // The recipe is edited with its node, in the same transaction.
  const tx = db.transaction((): "active" | "proposed" => {
    // An edit that puts the active definition back is not a proposal of
    // it: the pending edit, if any, is cleared and the step means what it
    // meant.
    if (
      step.outputTableId !== null &&
      canonical(parameters) === canonical(step.parameters) &&
      sameOrigin(resolved, step.origin ?? null)
    ) {
      db.prepare(
        `UPDATE recipe_steps
         SET proposed_parameters = NULL, proposed_origin = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(now, id);
      touchRecipe(step.recipeId, db);
      return "active";
    }
    if (step.outputTableId === null) {
      db.prepare(
        `UPDATE recipe_steps
         SET parameters = ?, proposed_parameters = NULL, proposed_origin = NULL,
             origin = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(parameters), encoded, now, id);
      touchRecipe(step.recipeId, db);
      return "active";
    }
    db.prepare(
      `UPDATE recipe_steps
       SET proposed_parameters = ?, proposed_origin = ?, updated_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(parameters), encoded, now, id);
    touchRecipe(step.recipeId, db);
    return "proposed";
  });
  return tx();
}

/** Promote a successful proposal to the active definition (G3) — **with the
 * origin it brought**, so a step re-authored from a different layer stops
 * describing itself by the one it used to read. */
export function promoteProposal(id: string, db: Database = metadataDb()): void {
  db.prepare(
    // Assignment, not COALESCE: a proposal that carries no origin means the
    // step no longer has one, and coalescing would keep describing it by a
    // layer whose SQL it no longer runs.
    `UPDATE recipe_steps
     SET parameters = COALESCE(proposed_parameters, parameters),
         origin = CASE WHEN proposed_parameters IS NULL THEN origin ELSE proposed_origin END,
         proposed_parameters = NULL, proposed_origin = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

/** One form for two definitions, so equality is of meaning: keys sorted at
 * every depth, arrays in their order. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(value));
}

/** Whether an edit leaves the step's SQL as it was — the only case in which a
 * captured origin still describes what runs. */
function sameSql(step: RecipeStep, next: Record<string, unknown>): boolean {
  const active = step.parameters.sql;
  return typeof active === "string" && active === next.sql;
}

/** Abandon a proposal without touching what the step currently means. An
 * edit of the recipe all the same: the pending definition changes. */
export function discardProposal(id: string, db: Database = metadataDb()): void {
  const step = getStep(id, db);
  if (!step) return;
  db.transaction(() => {
    db.prepare(
      `UPDATE recipe_steps
       SET proposed_parameters = NULL, proposed_origin = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), id);
    touchRecipe(step.recipeId, db);
  })();
}

/** Detach a step, keeping its output table and its run history (G3). Its
 * lineage edges go with it; the table it produced becomes an ordinary
 * workspace input to whoever still reads it. */
export function removeStep(
  id: string,
  db: Database = metadataDb(),
  /** A removal is an edit of the recipe — except the add route's own cleanup
   * of a step it just refused, which undoes an insert nobody accepted. */
  options: { edited?: boolean } = {},
): boolean {
  const step = getStep(id, db);
  if (!step) return false;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM recipe_steps WHERE id = ?`).run(id);
    // Close the gap so ordinals stay dense.
    db.prepare(
      `UPDATE recipe_steps SET ordinal = ordinal - 1
       WHERE recipe_id = ? AND ordinal > ?`,
    ).run(step.recipeId, step.ordinal);
    if (options.edited !== false) touchRecipe(step.recipeId, db);
  });
  tx();
  return true;
}

/**
 * Move a step to a new position, rewriting the affected ordinals densely.
 *
 * Validation that the move keeps every dependency pointing backwards is the
 * caller's — it needs the lineage the repository does not read — and it must
 * happen in the same transaction, which is why this accepts a database handle.
 */
/** Write a whole order, dense, in one transaction; an edit of the recipe
 * Every step of the recipe must be named once. */
export function reorderSteps(
  recipeId: string,
  orderedIds: string[],
  db: Database = metadataDb(),
): void {
  const steps = listSteps(recipeId, db);
  if (orderedIds.length !== steps.length || new Set(orderedIds).size !== steps.length) {
    throw new ApiError("invalid_request", "The order must name every step of the recipe once.", 400);
  }
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE recipe_steps SET ordinal = ?, updated_at = ? WHERE id = ? AND recipe_id = ?`);
  db.transaction(() => {
    orderedIds.forEach((id, i) => {
      if (stmt.run(i, now, id, recipeId).changes !== 1) {
        throw new ApiError("invalid_request", `No step with id "${id}" in this recipe.`, 400);
      }
    });
    touchRecipe(recipeId, db);
  })();
}

export function moveStep(
  id: string,
  toOrdinal: number,
  db: Database = metadataDb(),
): void {
  const step = getStep(id, db);
  if (!step) throw new ApiError("not_found", `No step with id "${id}".`, 404);
  const steps = listSteps(step.recipeId, db);
  const target = Math.max(0, Math.min(toOrdinal, steps.length - 1));
  const reordered = steps.filter((s) => s.id !== id);
  reordered.splice(target, 0, step);
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE recipe_steps SET ordinal = ?, updated_at = ? WHERE id = ?`,
  );
  reordered.forEach((s, i) => stmt.run(i, now, s.id));
  touchRecipe(step.recipeId, db);
}
