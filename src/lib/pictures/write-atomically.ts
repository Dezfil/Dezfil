import { currentStorageWriter } from "@/lib/system/storage-fence";
import { randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { observeDeletionCleanup } from "@/lib/auth/account-deletion-work";
import { rethrowStorageFailure } from "@/lib/system/storage-errors";

/** Write whole, then rename into place: a reader never sees a partial file. */
export async function writeAtomically(target: string, bytes: Uint8Array | string, authorize: () => void, published?: () => void) {
  currentStorageWriter()?.assertCanCommit();
  await mkdir(path.dirname(target), { recursive: true });
  authorize();
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, bytes, { signal: currentStorageWriter()?.signal });
    // Authorization and publication share one event-loop turn.
    currentStorageWriter()?.assertCanCommit();
    authorize();
    renameSync(temp, target);
    published?.();
  } catch (error) {
    await observeDeletionCleanup(() => rm(temp, { force: true }));
    rethrowStorageFailure(error);
    throw error;
  }
}

