import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { getRecipe, listSteps, touchRecipe } from "@/lib/metadata/recipes";
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

const stepIdsOf = (recipeId: string, db: Database) =>
  new Set(listSteps(recipeId, db).map((s) => s.id));

function requireRecipe(recipeId: string, db: Database): void {
  if (!getRecipe(recipeId, db)) {
    throw new ApiError("not_found", `No recipe with id "${recipeId}".`, 404);
  }
}

export function readLayout(recipeId: string, db: Database = metadataDb()): StoredLayout {
  requireRecipe(recipeId, db);
  const stored = getLayout(recipeId, db);
  return { ...stored, document: pruneLayout(stored.document, stepIdsOf(recipeId, db)) };
}

export function writeLayout(
  recipeId: string,
  body: unknown,
  db: Database = metadataDb(),
): StoredLayout {
  return db.transaction(() => {
    requireRecipe(recipeId, db);
    const stepIds = stepIdsOf(recipeId, db);
    const document = normalizeLayout(body, stepIds);
    const current = getLayout(recipeId, db);
    const seen = pruneLayout(current.document, stepIds);
    if (canonicalLayout(seen) === canonicalLayout(document)) {
      return { document, updatedAt: current.updatedAt };
    }
    const written = putLayout(recipeId, document, db);
    touchRecipe(recipeId, db);
    return { document, updatedAt: written.updatedAt };
  })();
}

/** What the layout routes put on the wire: the document and its write time. */
export function layoutPayload(stored: StoredLayout) {
  return {
    steps: stored.document.steps,
    sources: stored.document.sources,
    notes: stored.document.notes,
    updatedAt: stored.updatedAt,
  };
}
