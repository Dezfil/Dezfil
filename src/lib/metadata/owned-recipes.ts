import type { Database } from "better-sqlite3";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { metadataDb } from "./db";
import * as recipes from "./recipes";
export { fileRecipe } from "./owned-projects";
export { createRecipe } from "./recipes";
export type { Recipe, RecipeStep, NewStep, RecipeOrigin } from "./recipes";

export function getRecipe(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  if (!db.prepare("SELECT id FROM recipes WHERE id = ? AND owner_id = ?").get(id, owner)) return null;
  return recipes.getRecipe(id, db);
}
export function requireRecipe(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const recipe = getRecipe(scope, id, db);
  if (!recipe) throw resourceAbsent();
  return recipe;
}
export function listRecipes(scope: AccountScope, db: Database = metadataDb(), filter: { origin?: recipes.RecipeOrigin; project?: string | "none" } = {}) {
  const owner = requireAccountScope(scope, db);
  const where = ["owner_id = ?"], args = [owner];
  if (filter.origin) { where.push("origin = ?"); args.push(filter.origin); }
  if (filter.project === "none") where.push("project_id IS NULL");
  else if (filter.project) {
    requireOwnedResource(scope, "project", filter.project, db);
    where.push("project_id = ?"); args.push(filter.project);
  }
  const rows = db.prepare(`SELECT id FROM recipes WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`).all(...args) as { id: string }[];
  return rows.map(row => recipes.getRecipe(row.id, db)!);
}
export function getStep(scope: AccountScope, id: string, db: Database = metadataDb()) {
  const owner = requireAccountScope(scope, db);
  if (!db.prepare("SELECT s.id FROM recipe_steps s JOIN recipes r ON r.id = s.recipe_id WHERE s.id = ? AND r.owner_id = ?").get(id, owner)) return null;
  return recipes.getStep(id, db);
}
export function requireStep(scope: AccountScope, recipeId: string, id: string, db: Database = metadataDb()) {
  requireOwnedResource(scope, "workflow", recipeId, db);
  const step = getStep(scope, id, db);
  if (!step || step.recipeId !== recipeId) throw resourceAbsent();
  return step;
}
export function listSteps(scope: AccountScope, recipeId: string, db: Database = metadataDb()) {
  requireOwnedResource(scope, "workflow", recipeId, db);
  return recipes.listSteps(recipeId, db);
}
function checkOrigin(scope: AccountScope, origin: Record<string, unknown> | null | undefined, db: Database) {
  if (typeof origin?.mapId === "string") requireOwnedResource(scope, "map", origin.mapId, db);
  if (typeof origin?.layerId === "string") {
    requireOwnedResource(scope, "layer", origin.layerId, db);
    if (typeof origin.mapId === "string" && !db.prepare("SELECT id FROM layers WHERE id = ? AND map_id = ?").get(origin.layerId, origin.mapId)) throw resourceAbsent();
  }
}
export function addStep(scope: AccountScope, recipeId: string, step: recipes.NewStep, db: Database = metadataDb()) {
  return db.transaction(() => {
    requireOwnedResource(scope, "workflow", recipeId, db); checkOrigin(scope, step.origin, db);
    return recipes.addStep(recipeId, step, db);
  })();
}
export function editStep(scope: AccountScope, id: string, parameters: Record<string, unknown>, db: Database = metadataDb(), origin?: Record<string, unknown> | null) {
  return db.transaction(() => {
    requireOwnedResource(scope, "step", id, db); checkOrigin(scope, origin, db);
    return recipes.editStep(id, parameters, db, origin);
  })();
}
export function touchRecipe(scope: AccountScope, id: string, db: Database = metadataDb()) {
  return db.transaction(() => { requireOwnedResource(scope, "workflow", id, db); return recipes.touchRecipe(id, db); })();
}
export function renameRecipe(scope: AccountScope, id: string, name: string, db: Database = metadataDb()) {
  return db.transaction(() => { requireOwnedResource(scope, "workflow", id, db); return recipes.renameRecipe(id, name, db); })();
}
export function deleteRecipe(scope: AccountScope, id: string, db: Database = metadataDb()) {
  return db.transaction(() => { requireOwnedResource(scope, "workflow", id, db); return recipes.deleteRecipe(id, db); })();
}
export function discardProposal(scope: AccountScope, id: string, db: Database = metadataDb()) {
  return db.transaction(() => { requireOwnedResource(scope, "step", id, db); return recipes.discardProposal(id, db); })();
}
export function removeStep(scope: AccountScope, id: string, db: Database = metadataDb(), options: { edited?: boolean } = {}) {
  return db.transaction(() => { requireOwnedResource(scope, "step", id, db); return recipes.removeStep(id, db, options); })();
}
export function reorderSteps(scope: AccountScope, recipeId: string, ids: string[], db: Database = metadataDb()) {
  return db.transaction(() => {
    requireOwnedResource(scope, "workflow", recipeId, db);
    for (const id of ids) requireStep(scope, recipeId, id, db);
    return recipes.reorderSteps(recipeId, ids, db);
  })();
}
export function moveStep(scope: AccountScope, id: string, ordinal: number, db: Database = metadataDb()) {
  return db.transaction(() => { requireOwnedResource(scope, "step", id, db); return recipes.moveStep(id, ordinal, db); })();
}
/** A copied definition keeps the owned source step's historical origin.
 * Captured SQL remains a snapshot after the original layer is deleted. */
export function copyStep(scope: AccountScope, sourceId: string, targetRecipeId: string, parameters: Record<string, unknown>, db: Database = metadataDb()) {
  return db.transaction(() => {
    requireOwnedResource(scope, "workflow", targetRecipeId, db);
    const source = getStep(scope, sourceId, db);
    if (!source) throw resourceAbsent();
    return recipes.addStep(targetRecipeId, { operation: source.operation, parameters, origin: source.origin }, db);
  })();
}
