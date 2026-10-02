import type { Database } from "better-sqlite3";
import type { AccountScope } from "@/lib/auth/scope";
import { canReach } from "@/lib/auth/reach";
import { metadataDb } from "./db";
import { documentFacts } from "./document-facts";
import type { DocumentKey } from "./revisions";

/** Capture surviving results inside the content transaction, including
 * withdrawn filings, and disclose only documents the actor still reaches. */
export function documentResults(scope: AccountScope, documents: DocumentKey[], db: Database = metadataDb()) {
  const unique = new Map(documents.map(document => [`${document.kind}:${document.id}`, document]));
  return [...unique.values()].filter(document => canReach(scope, document.kind, document.id, db))
    .map(document => ({ ...document, editRevision: documentFacts(document, db).editRevision }));
}
export function revisionEnvelope<K extends string, T extends { editRevision?: string }>(key: K, value: T): { editRevision: string } & Record<K, T> {
  if (!value.editRevision) throw new Error("A document response requires its captured edit revision.");
  return { [key]: value, editRevision: value.editRevision } as { editRevision: string } & Record<K, T>;
}
