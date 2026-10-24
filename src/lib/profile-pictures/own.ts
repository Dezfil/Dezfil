import type { Database } from "better-sqlite3";
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
 * reception and processing run under its work lease, and the received file
 * goes once the processing has settled. Answers the account as it stands. */
export async function setOwnPicture(scope: AccountScope, request: Request): Promise<Account> {
  const accountId = requireAccountScope(scope);
  const write = admitPictureWrite(accountId, accountId);
  try {
    const picture = await write.run(() => receivePicture(request, accountId));
    return (await publishPicture(write, picture, own(scope))).account;
  } finally {
    write.release();
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

async function receivePicture(request: Request, accountId: string): Promise<Buffer> {
  const received = await receiveUpload(request, accountId, PICTURE_RECEPTION);
  try {
    const work = normalizePicture(received.tmpPath);
    try {
      return await work.picture;
    } finally {
      await work.settled;
    }
  } finally {
    // A removal that fails keeps the file's record; the start-up sweep of
    // the upload scratch and the account's deletion take it.
    await removeAccountFile(received.tmpPath).catch(() => undefined);
  }
}
