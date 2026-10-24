import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { admitAccountWork } from "@/lib/auth/account-deletion-admission";
import { inDeletionWork } from "@/lib/auth/account-deletion-work";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { picturePath } from "./store";

/** A served picture: its bytes and the entity tag over them. */
export interface ServedPicture {
  readonly bytes: Buffer;
  readonly tag: string;
}

/** The answer for an address with no picture: no picture, a replaced or
 * removed one, a person under deletion or nobody by that name. */
export const NO_PICTURE = "There is no picture at this address.";
const noPicture = () => new ApiError("not_found", NO_PICTURE, 404);

/**
 * Read a person's current picture for an active account: any person the
 * reads that carry a picture version name, a deactivated one included, with
 * or without a shared project. `version` names the picture the reader was
 * told of; a version that is no longer current answers as no picture, and
 * none at all reads the current one. The row's version is resolved now and
 * its file opened before anything is answered, under the subject's work
 * lease, so an accepted deletion ends the reads.
 */
export async function readProfilePicture(scope: AccountScope, sqlName: string, version: string | null,
  db: Database = metadataDb()): Promise<ServedPicture> {
  const reader = requireAccountScope(scope, db);
  const subject = db.prepare("SELECT id, picture_version FROM accounts WHERE sql_name = ? AND status NOT IN ('deleting', 'deleted')")
    .get(sqlName) as { id: string; picture_version: string | null } | undefined;
  const current = subject?.picture_version;
  if (!subject || !current || (version !== null && version !== current)) throw noPicture();
  const lease = admitAccountWork([reader, subject.id], db);
  try {
    const bytes = await inDeletionWork(lease, () => readFile(picturePath(subject.id, current))).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw noPicture();
      throw error;
    });
    lease.assertCommit();
    return { bytes, tag: `"${createHash("sha256").update(bytes).digest("base64url")}"` };
  } catch (error) {
    throw error instanceof ApiError && error.code === "not_found" ? noPicture() : error;
  } finally {
    lease.release();
  }
}

/** Whether the client already holds these bytes, by any tag it names. */
export function clientHolds(request: Request, tag: string): boolean {
  const named = request.headers.get("if-none-match");
  if (named === null) return false;
  return named.split(",").some((item) => {
    const value = item.trim();
    return value === "*" || value.replace(/^W\//, "") === tag;
  });
}
