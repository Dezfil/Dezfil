import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";
import { accountLabels, type AccountLabel } from "./accounts";
import { readDocumentRevision, type DocumentKey } from "./revisions";

export interface DocumentFacts {
  editRevision: string;
  lastChangedAt: string | null;
  lastChangedBy: AccountLabel | null;
}
/** Reached projections only. Capture in the same SQLite snapshot as the
 * document/children, before asynchronous presentation. No owner fallback. */
export function documentFacts(document: DocumentKey, db: Database = metadataDb()): DocumentFacts {
  const revision = readDocumentRevision(document, db);
  if (!revision?.editRevision) throw new Error("A reached document must have an edit revision.");
  return { editRevision: revision.editRevision, lastChangedAt: revision.lastChangedAt,
    lastChangedBy: revision.lastChangedBy ? accountLabels([revision.lastChangedBy], db).get(revision.lastChangedBy) ?? null : null };
}
export function factsOf(value: DocumentFacts): DocumentFacts {
  return { editRevision: value.editRevision, lastChangedAt: value.lastChangedAt, lastChangedBy: value.lastChangedBy };
}
