import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { requirePermitted } from "@/lib/auth/reach";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { metadataDb } from "./db";

export type DocumentKey = { kind: "map" | "workflow"; id: string };
export type DocumentExpectation = (
  | { kind: "map"; action?: "edit" | "publish" | "sketch" | "delete" | "transfer" }
  | { kind: "workflow"; action?: "edit" | "run" | "delete" | "transfer" }
) & { id: string; expectedRevision: unknown };
export type CoveredChange = DocumentKey & { executable?: boolean };
export interface DocumentRevision extends DocumentKey {
  /** Nullable at the storage boundary; document creation and upgrade fill it. */
  editRevision: string | null;
  lastChangedAt: string | null;
  lastChangedBy: string | null;
  executableRevision: string | null;
}

const tableFor = (document: DocumentKey) => document.kind === "map" ? "maps" : "recipes";
const keyFor = (document: DocumentKey) => `${document.kind}:${document.id}`;
const newRevision = () => randomBytes(16).toString("hex");
const revisionPattern = /^[0-9a-f]{32}$/;
const recordings = new WeakMap<Database, {
  actor: string;
  changes: CoveredChange[];
}>();

/** Validate only after the caller's authorization checks. No normalization:
 * a supplied basis must be exactly the token paired with its read. */
export function validateEditRevision(value: unknown, input = "X-Edit-Revision"): string {
  if (typeof value !== "string" || !revisionPattern.test(value)) {
    throw new ApiError("invalid_request",
      `Read this item first, then send its editRevision in ${input}.`, 400);
  }
  return value;
}

/** A preflight before asynchronous validation, repeated inside the content
 * transaction. Permission always precedes any revision fact. */
export function requireDocumentRevision(scope: AccountScope, document: DocumentExpectation, db: Database = metadataDb()): void {
  if (document.kind === "map") requirePermitted(scope, "map", document.id, document.action ?? "edit", db);
  else requirePermitted(scope, "workflow", document.id, document.action ?? "edit", db);
  compareDocumentRevision(document, db);
}

/** Internal comparison after operation-specific authorization, including filing
 * withdrawal which does not require content-edit permission. */
export function compareDocumentRevision(document: DocumentKey & { expectedRevision: unknown }, db: Database = metadataDb(), input = "X-Edit-Revision"): void {
  const expected = validateEditRevision(document.expectedRevision, input);
  if (readDocumentRevision(document, db)?.editRevision !== expected) {
    throw new ApiError("stale_revision", ERROR_CATALOGUE.stale_revision, 409);
  }
}

/** Internal metadata read. Reached projections decide what a caller sees. */
export function readDocumentRevision(document: DocumentKey, db: Database = metadataDb()): DocumentRevision | null {
  const executable = document.kind === "workflow" ? "executable_revision" : "NULL";
  const row = db.prepare(`SELECT edit_revision, last_changed_at, last_changed_by,
    ${executable} AS executable_revision FROM ${tableFor(document)} WHERE id = ?`).get(document.id) as
    { edit_revision: string | null; last_changed_at: string | null; last_changed_by: string | null;
      executable_revision: string | null } | undefined;
  return row ? {
    kind: document.kind, id: document.id, editRevision: row.edit_revision,
    lastChangedAt: row.last_changed_at, lastChangedBy: row.last_changed_by,
    executableRevision: row.executable_revision,
  } : null;
}

function requireTransaction(db: Database) {
  if (!db.inTransaction) throw new Error("Document recording requires the content transaction.");
}

/** Creation is recorded in the insertion's transaction, by its acting scope.
 * Insert defaults protect older writers; this records the known creator. */
export function recordDocumentCreation(scope: AccountScope, document: DocumentKey, db: Database = metadataDb()): DocumentRevision {
  requireTransaction(db);
  requirePermitted(scope, document.kind, document.id, "edit", db);
  recordDocumentChanges(scope, [{ ...document, executable: document.kind === "workflow" }], db);
  return readDocumentRevision(document, db)!;
}

/** Record accepted covered changes inside their content/history transaction.
 * Callers establish permission at their own commit boundary, including the
 * narrow lifecycle exceptions. This is not an unversioned request handler.
 * Duplicate child changes advance their parent only once in this operation. */
export function recordDocumentChanges(scope: AccountScope, changes: readonly CoveredChange[], db: Database = metadataDb()): void {
  requireTransaction(db);
  const actor = requireAccountScope(scope, db);
  const unique = new Map<string, CoveredChange>();
  for (const change of changes) {
    if (change.executable && change.kind !== "workflow") throw new Error("Only a workflow has an executable revision.");
    const key = keyFor(change);
    unique.set(key, { ...change, executable: change.executable || unique.get(key)?.executable });
  }
  const pending = recordings.get(db);
  if (pending) {
    if (pending.actor !== actor) throw new Error("A document commit has one acting account.");
    for (const change of unique.values()) {
      pending.changes.push(change);
    }
    return;
  }
  const changedAt = new Date(Date.now()).toISOString();
  for (const change of unique.values()) {
    // Deleted documents have no resulting revision. Restoring an identity
    // through a later operation always mints a fresh token here.
    const executable = change.executable ? ", executable_revision = @executable" : "";
    db.prepare(`UPDATE ${tableFor(change)} SET edit_revision = @revision,
      last_changed_at = @time, last_changed_by = @actor${executable} WHERE id = @id`).run({
      revision: newRevision(), time: changedAt, actor, id: change.id,
      ...(change.executable ? { executable: newRevision() } : {}),
    });
  }
}

/** Internal composition for creation and lifecycle operations. Nested child
 * recorders contribute to one content transaction and each document advances
 * once. Routes check their preconditions again inside these synchronous
 * transactions; the application has one metadata writer process. */
export function recordDocumentBatch<T>(scope: AccountScope, apply: () => T, db: Database = metadataDb()): T {
  return db.transaction(() => {
    const actor = requireAccountScope(scope, db);
    const outer = recordings.get(db);
    if (outer) {
      if (outer.actor !== actor) throw new Error("A document commit has one acting account.");
      const length = outer.changes.length;
      try { return apply(); }
      catch (error) { outer.changes.length = length; throw error; }
    }
    const pending = { actor, changes: [] as CoveredChange[] };
    recordings.set(db, pending);
    let value: T;
    try { value = apply(); }
    finally { recordings.delete(db); }
    recordDocumentChanges(scope, pending.changes, db);
    return value;
  })();
}
