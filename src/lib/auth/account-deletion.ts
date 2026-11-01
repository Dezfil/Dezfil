import { withStorageRecovery } from "@/lib/system/storage-reserve";
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { captureAccountContent, eraseAccountContent } from "@/lib/metadata/account-erasure-content";
import { eraseAccountCredentials } from "@/lib/metadata/account-erasure";
import { dissolveAcceptedAccountProjects } from "@/lib/metadata/account-erasure-projects";
import { compactMetadataStore } from "@/lib/metadata/account-compaction.mjs";
import { ownedFileRecords, registerAccountFile } from "@/lib/ingest/file-ownership";
import { eraseAccountFiles } from "@/lib/ingest/account-files";
import { eraseAccountWork } from "@/lib/assistant/account-erasure-work";
import { capturePreparedCopies, eraseAccountCopies } from "@/lib/export/account-erasure-copies";
import { eraseAccountQueryState } from "@/lib/query/account-erasure-query";
import { eraseAccountDerivatives } from "./account-erasure-derivatives";
import { eraseProviderCaches } from "./account-erasure-provider-caches";
import { drainAccountWork } from "./account-deletion-admission";
import { discardPreparedJournal, journalForAccount, readDeletionJournal, removeDeletionJournal, writeDeletionJournal, type DeletionJournal } from "./account-deletion-journal";
import { requireAdmin } from "./admin";
import type { AuthContext } from "./credentials";
import { deletionEligibility } from "./account-deletion-eligibility";

export interface DeletionStatus {
  id: string; state: "pending" | "needs-retry" | "completed";
  /** On a pending deletion's status: the reads admitted before it that it still waits on. */
  admittedReads?: number;
}
const key = Symbol.for("dezfil.account-deletion-continuations");
const host = process as typeof process & { [key]?: {
  running: Map<string, Promise<DeletionStatus>>; prepared: Map<string, Promise<void>>;
} };
const holder = host[key] ??= { running: new Map<string, Promise<DeletionStatus>>(), prepared: new Map<string, Promise<void>>() };
const workKey = (id: string, db: Database) => `${db.name}\0${id}`;
const status = (journal: DeletionJournal): DeletionStatus => ({ id: journal.id, state: journal.state });
export function pendingAccountDeletion(accountId: string): DeletionStatus | null {
  const journal = journalForAccount(accountId); return journal ? status(journal) : null;
}
function captureCopies(id: string, db: Database): Promise<void> {
  const key = workKey(id, db), existing = holder.prepared.get(key);
  if (existing) return existing;
  const settled = capturePreparedCopies(); void settled.catch(() => {}); holder.prepared.set(key, settled); return settled;
}
/** The confirmation service supplies its check here, inside the same
 * serialized transaction that records acceptance. */
export function acceptAccountDeletion(context: AuthContext, accountId: string, confirm: () => void,
  db: Database = metadataDb()): DeletionStatus {
  let prepared: string | undefined, accepted = false;
  try {
    const journal = db.transaction(() => {
      const { actor, pending, account } = deletionEligibility(context, accountId, db);
      if (pending) return pending;
      if (!account) throw new Error("Deletion eligibility requires an account.");
      confirm();
      db.prepare("UPDATE accounts SET status='deleting' WHERE id=?").run(accountId);
      const journal: DeletionJournal = { version: 1, id: randomUUID(), accountId, actorId: actor.id,
        invited: account.lastSignInAt === null,
        identity: { name: account.name, email: account.email, isAdmin: !!account.isAdmin },
        content: captureAccountContent(accountId, db), files: ownedFileRecords().filter(f => f.accountId === accountId), next: 0, state: "pending" };
      prepared = journal.id; writeDeletionJournal(journal); return journal;
    }).immediate();
    accepted = true;
    if (!journal.invited) captureCopies(journal.id, db);
    return status(journal);
  } catch (error) { if (prepared && !accepted) discardPreparedJournal(prepared); throw error; }
}
async function continueDeletion(journal: DeletionJournal, db: Database): Promise<DeletionStatus> {
  const { accountId, content } = journal;
  try {
    journal.state = "pending"; await withStorageRecovery(() => writeDeletionJournal(journal));
    // Stage numbers describe the next obligation. Replaying a stage after a
    // crash is safe, including dissolution whose transaction removes its source.
    const stages: (() => void | Promise<void>)[] = [
      async () => { await eraseAccountWork(accountId, content, db); await drainAccountWork(accountId, db); },
      () => withStorageRecovery(() => eraseAccountCredentials(accountId, db)),
      () => withStorageRecovery(() => { eraseAccountContent(accountId, db); }),
      () => withStorageRecovery(() => { dissolveAcceptedAccountProjects(accountId, journal.actorId, db); }),
      async () => { if (!journal.invited) { await eraseAccountCopies(accountId, db); await captureCopies(journal.id, db); } },
      async () => {
        for (const file of journal.files) await withStorageRecovery(() => registerAccountFile(accountId, file.file, file.directory));
        await eraseAccountFiles(accountId, content.datasets, db);
      },
      () => journal.invited ? undefined : eraseAccountDerivatives(accountId, content, db),
      () => journal.invited ? undefined : eraseAccountQueryState(accountId, db),
      () => journal.invited ? undefined : eraseProviderCaches(accountId, db),
      () => withStorageRecovery(() => { db.transaction(() => {
        if (journal.invited) db.prepare("DELETE FROM accounts WHERE id=? AND status='deleting'").run(accountId);
        else db.prepare(`UPDATE accounts SET status='deleted',name=NULL,email=NULL,password_hash=NULL,is_admin=NULL,
          created_at=NULL,updated_at=NULL,last_sign_in_at=NULL,picture_version=NULL,external_identity=NULL WHERE id=? AND status='deleting'`).run(accountId);
      }).immediate(); }),
      () => withStorageRecovery(() => { compactMetadataStore(db); }),
    ];
    while (journal.next < stages.length) {
      // Admitted work may need storage recovery to settle. Waiting for it
      // under that same latch blocks both its settlement and pending replies.
      await stages[journal.next]();
      journal.next++;
      await withStorageRecovery(() => writeDeletionJournal(journal));
    }
    removeDeletionJournal(journal.id);
    return { id: journal.id, state: "completed" };
  } catch {
    journal.state = "needs-retry";
    // If the volume itself is unwritable, the last durable journal still
    // blocks completion. Startup promotes it to retry before serving.
    try { await withStorageRecovery(() => writeDeletionJournal(journal)); } catch {}
    return status(journal);
  } finally { holder.prepared.delete(workKey(journal.id, db)); }
}
export function finishAccountDeletion(context: AuthContext, id: string, db: Database = metadataDb()): Promise<DeletionStatus> {
  requireAdmin(context, db, Date.now());
  const journal = readDeletionJournal(id), key = workKey(id, db), existing = holder.running.get(key);
  if (existing) return existing;
  const result = continueDeletion(journal, db).finally(() => holder.running.delete(key));
  holder.running.set(key, result); return result;
}
