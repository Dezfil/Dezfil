import type { Database } from "better-sqlite3";
import type { AccountScope } from "@/lib/auth/scope";
import { compareDocumentRevision, recordDocumentChanges, type DocumentKey } from "./revisions";

const projectOf = (document: DocumentKey, db: Database) =>
  (db.prepare(`SELECT project_id FROM ${document.kind === "map" ? "maps" : "recipes"} WHERE id = ?`)
    .get(document.id) as { project_id: string | null } | undefined)?.project_id;

/** The before and after memberships belong to the enclosing content
 * transaction. Dissolution also records documents no longer reachable. */
export function recordFiling<T>(scope: AccountScope, documents: DocumentKey[], apply: () => T, db: Database): T {
  const before = documents.map(document => projectOf(document, db));
  const value = apply();
  recordDocumentChanges(scope, documents.filter((document, i) => projectOf(document, db) !== before[i]), db);
  return value;
}
export function filedDocuments(projectId: string, db: Database): DocumentKey[] {
  return db.prepare(`SELECT 'map' AS kind, id FROM maps WHERE project_id = ?
    UNION ALL SELECT 'workflow' AS kind, id FROM recipes WHERE project_id = ?`).all(projectId, projectId) as DocumentKey[];
}
export function memberDocuments(change: { addMaps?: string[]; removeMaps?: string[]; addRecipes?: string[]; removeRecipes?: string[] }): DocumentKey[] {
  return [
    ...[...new Set([...(change.addMaps ?? []), ...(change.removeMaps ?? [])])].map(id => ({ kind: "map" as const, id })),
    ...[...new Set([...(change.addRecipes ?? []), ...(change.removeRecipes ?? [])])].map(id => ({ kind: "workflow" as const, id })),
  ];
}

/** Called only after every member's filing permission has been established. */
export function requireFilingRevisions(change: Parameters<typeof memberDocuments>[0] & { expectedRevisions?: unknown }, db: Database): void {
  const values = change.expectedRevisions;
  const bases = values !== null && typeof values === "object" && !Array.isArray(values) ? values as Record<string, unknown> : {};
  for (const document of memberDocuments(change)) {
    compareDocumentRevision({ ...document, expectedRevision: bases[`${document.kind}:${document.id}`] }, db, "expectedRevisions");
  }
}
