import type { Database } from "better-sqlite3";
import { withStorageRecovery } from "@/lib/system/storage-reserve";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { requireDeletingAccount } from "@/lib/metadata/account-erasure";
import { inflightSettled } from "@/lib/query/inflight";
import { eraseAccountStaging } from "@/lib/query/staging";
import { drainSketchWrites } from "@/lib/sketch/store";
import { drainAccountRefreshes } from "./fence";
import { retirementsSettled } from "./retire";
import { registerAccountFile, ownedFileRecords, removeAccountFile } from "./file-ownership";
export { registerAccountFile, accountFiles } from "./file-ownership";
/** Captured current paths supplement the durable obligations for generations
 * created before ownership tracking. Unknown files are never attributed by UUID. */
export async function eraseAccountFiles(accountId: string, captured: readonly { id: string; file: string }[], db: Database): Promise<void> {
  db.transaction(() => requireDeletingAccount(accountId, db)).immediate();
  await Promise.all([drainAccountRefreshes(accountId), drainSketchWrites(captured.map(t => t.id)), eraseAccountStaging(accountId)]);
  await inflightSettled();
  for (const table of captured) await withStorageRecovery(() => registerAccountFile(accountId, table.file));
  // A failed retirement remains in its ledger and is retried below. Waiting
  // here also observes any already scheduled unlink before attempting it again.
  const owned = ownedFileRecords().filter(r => r.accountId === accountId);
  const retired = owned.map(r => path.join(dataDir(), r.file));
  await retirementsSettled(retired).catch(() => {});
  const live = db.prepare("SELECT file FROM data_tables WHERE owner_id <> ?").all(accountId) as { file: string }[];
  for (const record of owned) {
    if (live.some(t => t.file === record.file || record.directory && t.file.startsWith(`${record.file}/`))) throw new Error("Owned file still belongs to another dataset.");
    await withStorageRecovery(() => removeAccountFile(path.join(dataDir(), record.file), { recursive: record.directory }));
  }
  await retirementsSettled(retired);
}
