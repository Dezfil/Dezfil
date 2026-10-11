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
 *
 * A template's evaluation has no account home: its home is the template's
 * version, and its plain names are that version's datasets and bundled
 * results alone, mounted from the artifacts the template module prepared.
 * The caller's reach adds nothing to it, so a template's SQL naming a
 * person's dataset, or another template's, binds nothing.
 */
const contextBrand: unique symbol = Symbol("evaluation context");

export type EvaluationPurpose = "console" | "resource";

/** One dataset or bundled result of a template's version, as the engine
 * mounts it: its id (the template's own form), the name its SQL uses, its
 * artifact relative to the data folder, and what the dataset reader
 * measured of it. */
export interface TemplateMount {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly geometryColumn: string | null;
  readonly geometryType: string | null;
  readonly rowCount: number;
  readonly crsAssumed: boolean;
}

/** Where a template's SQL binds its names: the version, its datasets, and
 * its bundled results under the output names their steps declare. */
export interface TemplateHome {
  readonly template: string;
  readonly version: number;
  readonly datasets: readonly TemplateMount[];
  readonly outputs: readonly TemplateMount[];
}

export interface EvaluationContext {
  readonly [contextBrand]: true;
  readonly authority: AccountScope | PublicationScope;
  readonly home: string | null;
  readonly workflow: string | null;
  readonly purpose: EvaluationPurpose;
  readonly resource?: { kind: "maps" | "recipes"; id: string };
  /** Present for a template's evaluation, whose home is the version. */
  readonly template?: TemplateHome;
}

export function isEvaluationContext(scope: unknown): scope is EvaluationContext {
  return !!scope && typeof scope === "object" && contextBrand in scope && scope[contextBrand] === true;
}

function context(
  authority: AccountScope | PublicationScope,
  home: string | null,
  purpose: EvaluationPurpose,
  workflow: string | null = null,
  resource?: EvaluationContext["resource"],
  template?: TemplateHome,
): EvaluationContext {
  return Object.freeze({ [contextBrand]: true as const, authority, home, workflow, purpose,
    ...(resource ? { resource } : {}), ...(template ? { template } : {}) });
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
  return context(scope, homeOf("maps", mapId, db) ?? scope.accountId, "resource", null, { kind: "maps", id: mapId });
}

/** A workflow's evaluation: its steps bind in the workflow's home with the
 * runner's reach, and its declared outputs bind for this runner. */
export function workflowEvaluation(scope: AccountScope, recipeId: string, db: Database = metadataDb()): EvaluationContext {
  return context(scope, homeOf("recipes", recipeId, db) ?? scope.accountId, "resource", recipeId, { kind: "recipes", id: recipeId });
}

/** A template's evaluation: its layers' and steps' SQL bind in the
 * template's version, never in an account's home, with the caller as the
 * authority rechecked around it. A resource evaluation, so a name it cannot
 * bind is refused naming the reference. */
export function templateEvaluation(scope: AccountScope, home: TemplateHome): EvaluationContext {
  return context(scope, null, "resource", null, undefined, Object.freeze({
    template: home.template,
    version: home.version,
    datasets: Object.freeze([...home.datasets]),
    outputs: Object.freeze([...home.outputs]),
  }));
}

/** The authority behind any dataset scope. */
export function authorityOf(scope: Scope): AccountScope | PublicationScope {
  return isEvaluationContext(scope) ? scope.authority : scope;
}

/** A layer's evaluation: its map's, when the layer names one. */
export function layerEvaluation(scope: Scope, layer: { mapId?: string | null }, db: Database = metadataDb()): Scope {
  return layer.mapId ? mapEvaluation(scope, layer.mapId, db) : scope;
}
