import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { canReach, REACHED_PROJECTS, requirePermitted, requireReachable } from "@/lib/auth/reach";
import { metadataDb } from "./db";
import * as recipes from "./recipes";
export { fileRecipe } from "./owned-projects";
export { createRecipe } from "./recipes";
export type { Recipe, RecipeStep, NewStep, RecipeOrigin } from "./recipes";

/**
 * Workflow reads: a workflow is reached by its owner and by the owner and
 * people of the project it is filed in, and its steps follow it. Anyone else
 * gets the absent refusal.
 */
export function getRecipe(scope: AccountScope, id: string, db: Database = metadataDb()) {
  if (!canReach(scope, "workflow", id, db)) return null;
  return recipes.getRecipe(id, db);
}
export function requireRecipe(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const recipe = getRecipe(scope, id, db);
  if (!recipe) throw resourceAbsent();
  return recipe;
}
/** The workflows an account reaches, most recent first: its own, and every
 * workflow filed in a project it owns or belongs to. `project` narrows to one
 * reached project's workflows, whoever owns them; `none` to the account's own
 * workflows filed nowhere. One still filed in a project its owner no longer
 * reaches is filed, not none: its owner can see and withdraw that filing. */
export function listRecipes(scope: AccountScope, db: Database = metadataDb(), filter: { origin?: recipes.RecipeOrigin; project?: string | "none" } = {}) {
  const me = requireAccountScope(scope, db);
  const where = [`(owner_id = @me OR project_id IN (${REACHED_PROJECTS}))`];
  const args: Record<string, string> = { me };
  if (filter.origin) { where.push("origin = @origin"); args.origin = filter.origin; }
  if (filter.project === "none") where.push("owner_id = @me AND project_id IS NULL");
  else if (filter.project) {
    requireReachable(scope, "project", filter.project, db);
    where.push("project_id = @project"); args.project = filter.project;
  }
  const rows = db.prepare(`SELECT id FROM recipes WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`).all(args) as { id: string }[];
  return rows.map(row => recipes.getRecipe(row.id, db)!);
}
export function getStep(scope: AccountScope, id: string, db: Database = metadataDb()) {
  if (!canReach(scope, "step", id, db)) return null;
  return recipes.getStep(id, db);
}
export function requireStep(scope: AccountScope, recipeId: string, id: string, db: Database = metadataDb()) {
  requireReachable(scope, "workflow", recipeId, db);
  const step = getStep(scope, id, db);
  if (!step || step.recipeId !== recipeId) throw resourceAbsent();
  return step;
}
export function listSteps(scope: AccountScope, recipeId: string, db: Database = metadataDb()) {
  requireReachable(scope, "workflow", recipeId, db);
  return recipes.listSteps(recipeId, db);
}

/** Who owns a workflow, whose space its SQL binds in, and where it is filed. */
export function recipeStanding(id: string, db: Database = metadataDb()): { ownerId: string; homeId: string | null; projectId: string | null } | null {
  const row = db.prepare("SELECT owner_id, home_account_id, project_id FROM recipes WHERE id = ?").get(id) as
    { owner_id: string; home_account_id: string | null; project_id: string | null } | undefined;
  return row ? { ownerId: row.owner_id, homeId: row.home_account_id, projectId: row.project_id } : null;
}

/**
 * The owner's own reads, for what stays the owner's: the names a duplicate
 * may not take.
 */
export function listOwnRecipes(scope: AccountScope, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  const rows = db.prepare("SELECT id FROM recipes WHERE owner_id = ? ORDER BY created_at DESC, id DESC").all(owner) as { id: string }[];
  return rows.map(row => recipes.getRecipe(row.id, db)!);
}
export function listOwnSteps(scope: AccountScope, recipeId: string, db: Database = metadataDb()) {
  requireOwnedResource(scope, "workflow", recipeId, db);
  return recipes.listSteps(recipeId, db);
}
/** A captured layer's origin names a map and layer the capturer reaches. */
function checkOrigin(scope: AccountScope, origin: Record<string, unknown> | null | undefined, db: Database) {
  if (typeof origin?.mapId === "string") requireReachable(scope, "map", origin.mapId, db);
  if (typeof origin?.layerId === "string") {
    requireReachable(scope, "layer", origin.layerId, db);
    if (typeof origin.mapId === "string" && !db.prepare("SELECT id FROM layers WHERE id = ? AND map_id = ?").get(origin.layerId, origin.mapId)) throw resourceAbsent();
  }
}
export function addStep(scope: AccountScope, recipeId: string, step: recipes.NewStep, db: Database = metadataDb()) {
  return db.transaction(() => {
    requirePermitted(scope, "workflow", recipeId, "edit", db); checkOrigin(scope, step.origin, db);
    return recipes.addStep(recipeId, step, db);
  })();
}
export function editStep(scope: AccountScope, id: string, parameters: Record<string, unknown>, db: Database = metadataDb(), origin?: Record<string, unknown> | null) {
  return db.transaction(() => {
    requirePermitted(scope, "step", id, "edit", db); checkOrigin(scope, origin, db);
    return recipes.editStep(id, parameters, db, origin);
  })();
}
export function touchRecipe(scope: AccountScope, id: string, db: Database = metadataDb()) {
  return db.transaction(() => { requirePermitted(scope, "workflow", id, "edit", db); return recipes.touchRecipe(id, db); })();
}
export function renameRecipe(scope: AccountScope, id: string, name: string, db: Database = metadataDb()) {
  return db.transaction(() => { requirePermitted(scope, "workflow", id, "edit", db); return recipes.renameRecipe(id, name, db); })();
}
export function deleteRecipe(scope: AccountScope, id: string, db: Database = metadataDb()) {
  return db.transaction(() => { requirePermitted(scope, "workflow", id, "delete", db); return recipes.deleteRecipe(id, db); })();
}
export function discardProposal(scope: AccountScope, id: string, db: Database = metadataDb()) {
  return db.transaction(() => { requirePermitted(scope, "step", id, "edit", db); return recipes.discardProposal(id, db); })();
}
export function removeStep(scope: AccountScope, id: string, db: Database = metadataDb(), options: { edited?: boolean } = {}) {
  return db.transaction(() => { requirePermitted(scope, "step", id, "edit", db); return recipes.removeStep(id, db, options); })();
}
export function reorderSteps(scope: AccountScope, recipeId: string, ids: string[], db: Database = metadataDb()) {
  return db.transaction(() => {
    requirePermitted(scope, "workflow", recipeId, "edit", db);
    for (const id of ids) if (recipes.getStep(id, db)?.recipeId !== recipeId) throw resourceAbsent();
    return recipes.reorderSteps(recipeId, ids, db);
  })();
}
export function moveStep(scope: AccountScope, id: string, ordinal: number, db: Database = metadataDb()) {
  return db.transaction(() => { requirePermitted(scope, "step", id, "edit", db); return recipes.moveStep(id, ordinal, db); })();
}
/** A copied definition keeps the owned source step's historical origin.
 * Captured SQL remains a snapshot after the original layer is deleted. */
export function copyStep(scope: AccountScope, sourceId: string, targetRecipeId: string, parameters: Record<string, unknown>, db: Database = metadataDb()) {
  return db.transaction(() => {
    requirePermitted(scope, "workflow", targetRecipeId, "edit", db);
    // A step is copied from any workflow its copier reaches.
    const source = getStep(scope, sourceId, db);
    if (!source) throw resourceAbsent();
    return recipes.addStep(targetRecipeId, { operation: source.operation, parameters, origin: source.origin }, db);
  })();
}
