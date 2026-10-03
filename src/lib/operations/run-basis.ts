import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { publishedMessage } from "@/lib/api/error-catalogue";
import { cascadeMatchesExecutable } from "@/lib/metadata/cascades";
import { readDocumentRevision } from "@/lib/metadata/revisions";

/** A run's own promotions advance its durable basis. Read that basis each
 * time; a member's captured token can predate another member's promotion. */
export function matchesRunBasis(recipeId: string, executableRevision: string, cascadeId: string | undefined, db: Database): boolean {
  return cascadeId
    ? cascadeMatchesExecutable(cascadeId, recipeId, db)
    : readDocumentRevision({ kind: "workflow", id: recipeId }, db)?.executableRevision === executableRevision;
}

export function requireRunBasis(recipeId: string, executableRevision: string, cascadeId: string | undefined, db: Database): void {
  if (!matchesRunBasis(recipeId, executableRevision, cascadeId, db)) {
    throw new ApiError("plan_changed", publishedMessage("plan_changed"), 409);
  }
}
