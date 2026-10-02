import { documentFacts, type DocumentFacts } from "@/lib/metadata/document-facts";
import { recordDocumentChanges } from "@/lib/metadata/revisions";
import type { AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { requireRecipe, listSteps, touchRecipe } from "@/lib/metadata/owned-recipes";
import { requirePermitted } from "@/lib/auth/reach";
import { listSteps as listRecipeSteps } from "@/lib/metadata/recipes";
import {
  canonicalLayout,
  getLayout,
  putLayout,
  type StoredLayout,
} from "@/lib/metadata/recipe-layouts";
import { normalizeLayout, pruneLayout } from "./layout-document";

/**
 * Reading and replacing a recipe's layout document.
 *
 * **A read says what is there now.** A node removed after its position was
 * stored is pruned on the way out, so the canvas never draws a node the
 * recipe no longer has, and never has to know it once did.
 *
 * **A write that changes the document is an edit**: it moves
 * the recipe's last-edited stamp, in the same transaction, exactly as a
 * rename does. A write that stores what was already stored moves nothing —
 * an autosaving canvas would otherwise mark every workflow it opened as
 * edited. "Already stored" is judged against what a **reader sees**, not
 * the raw row: a recipe with no row holds the empty document, and a row
 * may still carry a node the recipe has since lost, which a read prunes.
 * Sending back exactly what a read returned is never an edit.
 */

const stepIdsOf = (scope: AccountScope, recipeId: string, db: Database) =>
  new Set(listSteps(scope, recipeId, db).map((s) => s.id));

export function readLayout(scope: AccountScope, recipeId: string, db: Database = metadataDb()): StoredLayout & DocumentFacts {
  return db.transaction(() => {
  requireRecipe(scope, recipeId, db);
  const stored = getLayout(recipeId, db);
  return { ...documentFacts({ kind: "workflow", id: recipeId }, db), ...stored, document: pruneLayout(stored.document, stepIdsOf(scope, recipeId, db)) };
  })();
}

export function writeLayout(
  scope: AccountScope,
  recipeId: string,
  body: unknown,
  db: Database = metadataDb(),
): StoredLayout & DocumentFacts {
  return db.transaction(() => {
    // An edit, answered with the raw document: the owner's, the project
    // owner's or an editor's.
    requirePermitted(scope, "workflow", recipeId, "edit", db);
    const stepIds = new Set(listRecipeSteps(recipeId, db).map((s) => s.id));
    const document = normalizeLayout(body, stepIds);
    const current = getLayout(recipeId, db);
    const seen = pruneLayout(current.document, stepIds);
    if (canonicalLayout(seen) === canonicalLayout(document)) {
      return { ...documentFacts({ kind: "workflow", id: recipeId }, db), document, updatedAt: current.updatedAt };
    }
    const written = putLayout(recipeId, document, db);
    touchRecipe(scope, recipeId, db);
    recordDocumentChanges(scope, [{ kind: "workflow", id: recipeId }], db);
    return { ...documentFacts({ kind: "workflow", id: recipeId }, db), document, updatedAt: written.updatedAt };
  })();
}

/** What the layout routes put on the wire: the document and its write time. */
export function layoutPayload(stored: StoredLayout & DocumentFacts) {
  return {
    editRevision: stored.editRevision, lastChangedAt: stored.lastChangedAt, lastChangedBy: stored.lastChangedBy,
    steps: stored.document.steps,
    sources: stored.document.sources,
    notes: stored.document.notes,
    updatedAt: stored.updatedAt,
  };
}
