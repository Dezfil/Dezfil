import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

/** The kinds whose ownership can be transferred. Datasets, connections and
 * jobs are not among them: their ownership never changes. */
export type TransferKind = "map" | "workflow" | "project";

/** One validated ownership change: this resource, from this owner, to this one. */
export interface OwnershipTransition {
  kind: TransferKind;
  id: string;
  from: string;
  to: string;
}

/**
 * Run a transfer's writes through the ownership gate.
 *
 * The store refuses every ownership change on maps, workflows and projects
 * unless the gate names exactly that row and that transition. This opens the
 * gate for the one transition, runs the change, and closes the gate again,
 * all in one transaction: on success the gate is gone before the commit, and
 * on any failure the rollback removes it with everything else. Authority and
 * the recipient's eligibility are the caller's to check, inside `change` or
 * before it; the store additionally refuses a recipient who is not active.
 */
export function throughTransferGate<T>(transition: OwnershipTransition, db: Database = metadataDb(), change: () => T): T {
  return db.transaction(() => {
    db.prepare(`INSERT INTO ownership_transfer_gate
      (singleton, resource_kind, resource_id, from_owner_id, to_owner_id) VALUES (1, ?, ?, ?, ?)`)
      .run(transition.kind, transition.id, transition.from, transition.to);
    const result = change();
    db.prepare("DELETE FROM ownership_transfer_gate WHERE singleton = 1").run();
    return result;
  })();
}
