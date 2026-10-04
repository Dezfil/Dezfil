import { metadataDb } from "@/lib/metadata/db";
import { requireAdmin } from "./admin";
import type { AuthContext } from "./credentials";
import { deletionJournals, readDeletionJournal } from "./account-deletion-journal";
import type { DeletionStatus } from "./account-deletion";

export interface PendingDeletion {
  id: string; state: "pending" | "needs-retry";
  account: { id: string; name: string; email: string; isAdmin: boolean };
}
/** Cleanup reservations remain visible to admins even after profile erasure.
 * No SQL name, inventory, stage, file path or underlying failure is exposed. */
export function listAccountDeletions(context: AuthContext): PendingDeletion[] {
  requireAdmin(context, metadataDb(), Date.now());
  return deletionJournals().map(journal => ({ id: journal.id, state: journal.state,
    account: { id: journal.accountId, ...journal.identity } }));
}
export function accountDeletionStatus(context: AuthContext, id: string): DeletionStatus {
  requireAdmin(context, metadataDb(), Date.now());
  const journal = readDeletionJournal(id);
  return { id: journal.id, state: journal.state };
}
