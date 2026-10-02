import type { Database } from "better-sqlite3";
import type { AccountScope } from "@/lib/auth/scope";
import { metadataDb } from "@/lib/metadata/db";
import { isPublicationScope, type PublicationScope } from "@/lib/publish/publication-scope";

/**
 * The context an evaluation binds names in.
 *
 * Who evaluates (the authority, rechecked before and after every evaluation)
 * is kept apart from where the SQL's plain names belong (the home). The home
 * is an account identity, never an authority: a map's or workflow's SQL is
 * bound in its stored home whoever opens it, and a deactivated home is still
 * read for a caller the reach kernel permits. The reach is always the
 * authority's: a caller sees in another person's home only what the caller
 * can reach. A workflow's evaluation also carries the workflow, whose
 * declared outputs take their plain names for this runner.
 *
 * The purpose decides how a name that does not bind fails: the console keeps
 * the engine's generic unknown-table refusal, a resource evaluation (a
 * layer, tile, render, widget, export, search or workflow step) names the
 * reference it could not bind.
 */
const contextBrand: unique symbol = Symbol("evaluation context");

export type EvaluationPurpose = "console" | "resource";

export interface EvaluationContext {
  readonly [contextBrand]: true;
  readonly authority: AccountScope | PublicationScope;
  readonly home: string | null;
  readonly workflow: string | null;
  readonly purpose: EvaluationPurpose;
}

export function isEvaluationContext(scope: unknown): scope is EvaluationContext {
  return !!scope && typeof scope === "object" && contextBrand in scope && scope[contextBrand] === true;
}

function context(
  authority: AccountScope | PublicationScope,
  home: string | null,
  purpose: EvaluationPurpose,
  workflow: string | null = null,
): EvaluationContext {
  return Object.freeze({ [contextBrand]: true as const, authority, home, workflow, purpose });
}

type Scope = AccountScope | PublicationScope | EvaluationContext;

/** Any dataset scope, read as a context. A signed-in caller's own SQL is the
 * console: its home is the caller. A publication evaluates in its map's home. */
export function contextOf(scope: Scope, db: Database = metadataDb()): EvaluationContext {
  if (isEvaluationContext(scope)) return scope;
  if (isPublicationScope(scope)) return context(scope, homeOf("maps", scope.mapId, db) ?? scope.ownerId, "resource");
  return context(scope, scope?.accountId ?? null, "console");
}

function homeOf(table: "maps" | "recipes", id: string, db: Database): string | null | undefined {
  const row = db.prepare(`SELECT home_account_id AS home FROM ${table} WHERE id = ?`).get(id) as { home: string | null } | undefined;
  return row ? row.home : undefined;
}

/**
 * A map's evaluation: its layers, tiles, renders, fields, widgets, search and
 * exports bind in the map's home with the caller's reach. A publication
 * already knows its map; a context already made is kept as it is. A map that
 * no longer exists evaluates in the caller's own home, as before.
 */
export function mapEvaluation(scope: Scope, mapId: string, db: Database = metadataDb()): Scope {
  if (isEvaluationContext(scope) || isPublicationScope(scope)) return scope;
  return context(scope, homeOf("maps", mapId, db) ?? scope.accountId, "resource");
}

/** A workflow's evaluation: its steps bind in the workflow's home with the
 * runner's reach, and its declared outputs bind for this runner. */
export function workflowEvaluation(scope: AccountScope, recipeId: string, db: Database = metadataDb()): EvaluationContext {
  return context(scope, homeOf("recipes", recipeId, db) ?? scope.accountId, "resource", recipeId);
}

/** The authority behind any dataset scope. */
export function authorityOf(scope: Scope): AccountScope | PublicationScope {
  return isEvaluationContext(scope) ? scope.authority : scope;
}

/** A layer's evaluation: its map's, when the layer names one. */
export function layerEvaluation(scope: Scope, layer: { mapId?: string | null }, db: Database = metadataDb()): Scope {
  return layer.mapId ? mapEvaluation(scope, layer.mapId, db) : scope;
}
