import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import type { Account } from "@/lib/metadata/accounts";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { receiveUpload, type ReceptionBounds } from "@/lib/ingest/receive";
import { removeAccountFile } from "@/lib/ingest/file-ownership";
import { PICTURE_LIMITS, RECEPTION_REMEDY, tooLargeMessage } from "./limits";
import { normalizePicture } from "./normalize";
import { admitPictureWrite, publishPicture } from "./store";

/** What one picture upload may take: the file, a small envelope beside it,
 * and the reception time, all fixed. */
export const PICTURE_RECEPTION: ReceptionBounds = Object.freeze({
  fileBytes: PICTURE_LIMITS.fileBytes,
  bodyBytes: PICTURE_LIMITS.fileBytes + PICTURE_LIMITS.envelopeBytes,
  receiveMs: PICTURE_LIMITS.receiveMs,
  tooLarge: tooLargeMessage,
  timeoutRemedy: RECEPTION_REMEDY,
});

/** The person themselves, still active at the commit. */
const own = (scope: AccountScope) => (db: Database) => { requireAccountScope(scope, db); };

/** Set the signed-in account's picture from the request's one file. The
 * write takes its place in the account's order before the body is read;
 * reception and processing run under its work lease. The answer leaves once
 * the received file is gone, so a success or a refusal leaves no upload
 * behind. Only a refusal at the processing deadline leaves on time, ahead
 * of the work it abandoned; the lease and the received file are then kept
 * until that work has settled. Answers the account as it stands. */
export async function setOwnPicture(scope: AccountScope, request: Request): Promise<Account> {
  const accountId = requireAccountScope(scope);
  const write = admitPictureWrite(accountId, accountId);
  let settled: Promise<void> = Promise.resolve();
  try {
    const picture = await write.run(() => receivePicture(request, accountId, cleanup => { settled = cleanup; }));
    const { account } = await publishPicture(write, picture, own(scope));
    await settled;
    return account;
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "data_processing_timeout")) await settled;
    throw error;
  } finally {
    void settled.then(() => write.release());
  }
}

/** Remove the signed-in account's picture; with none, nothing changes. */
export async function removeOwnPicture(scope: AccountScope): Promise<Account> {
  const accountId = requireAccountScope(scope);
  const write = admitPictureWrite(accountId, accountId);
  try {
    return (await publishPicture(write, null, own(scope))).account;
  } finally {
    write.release();
  }
}

/** The received file goes once the processing on it has settled, which
 * may be after the answer has left. `hold` takes that cleanup so the caller
 * keeps the work lease until it is done. */
async function receivePicture(request: Request, accountId: string, hold: (cleanup: Promise<void>) => void): Promise<Buffer> {
  const received = await receiveUpload(request, accountId, PICTURE_RECEPTION);
  const work = normalizePicture(received.tmpPath);
  // A removal that fails keeps the file's record; the start-up sweep of
  // the upload scratch and the account's deletion take it.
  hold(work.settled.then(() => undefined, () => undefined)
    .then(() => removeAccountFile(received.tmpPath).catch(() => undefined)));
  return work.picture;
}
