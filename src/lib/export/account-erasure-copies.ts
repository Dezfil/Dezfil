import type { Database } from "better-sqlite3";
import { requireDeletingAccount } from "@/lib/metadata/account-erasure";
import { lookRetention } from "./look-retention";
import { layerDownloadTickets, queryDownloadTickets } from "./layer-download-tickets";
import { projectExportTickets } from "./project-export-tickets";
import { drainAccountRenders } from "./render-work";

/** Capture at acceptance. Input attribution is deliberately absent from issued
 * private copies, so completion waits all existing preparations through cleanup. */
export function capturePreparedCopies(): Promise<void> {
  return Promise.all([layerDownloadTickets, queryDownloadTickets, projectExportTickets].map(s => s.settlePrepared())).then(() => {});
}
/** Internal only. Neither removal from a lookup nor a refused read proves erasure. */
export async function eraseAccountCopies(accountId: string, db: Database): Promise<void> {
  db.transaction(() => requireDeletingAccount(accountId, db)).immediate();
  await drainAccountRenders(accountId);
  lookRetention.eraseAccount(accountId);
  await Promise.all([layerDownloadTickets, queryDownloadTickets, projectExportTickets].map(s => s.eraseAccount(accountId)));
}
