import { currentStorageWriter } from "@/lib/system/storage-fence";
import { rethrowStorageFailure } from "@/lib/system/storage-errors";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { dataDir } from "@/lib/config";
import { registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";
import { refuse } from "./refusals";

/**
 * A copy's datasets as files: each dataset and bundled result of an
 * installed version copied byte for byte into a fresh artifact of the
 * copier's under the data folder's `tables/`, as an upload's artifact is
 * made. The artifact is registered for its owner before a byte is written,
 * so an account deletion that begins meanwhile knows it, and its bytes are
 * held to the version's record as they land: a member that differs from
 * its record is refused and its artifact removed. The template's own file
 * is only read.
 */

export interface CopiedArtifact {
  /** The dataset's id to be: the artifact is named by it, as an upload's. */
  id: string;
  /** The artifact, relative to the data folder. */
  file: string;
}

/** Copy one member of a version folder into a fresh artifact of
 * `accountId`'s, held to `sha256`. */
export async function copyDatasetFile(accountId: string, folder: string, member: string, sha256: string): Promise<CopiedArtifact> {
  const id = randomUUID();
  const file = path.join("tables", `${id}.parquet`);
  const target = path.join(dataDir(), file);
  registerAccountFile(accountId, target);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    const hash = createHash("sha256");
    await pipeline(
      createReadStream(path.join(folder, member)),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(target, { flags: "wx" }),
      { signal: currentStorageWriter()?.signal },
    );
    if (hash.digest("hex") !== sha256) refuse("template_record_mismatch", `The member "${member}" differs from its record.`);
    return { id, file };
  } catch (error) {
    await removeAccountFile(target, { force: true });
    rethrowStorageFailure(error);
    throw error;
  }
}

/** Remove the artifacts a copy made, with their ownership records. */
export async function removeCopiedArtifacts(copied: readonly CopiedArtifact[]): Promise<void> {
  for (const artifact of copied) await removeAccountFile(path.join(dataDir(), artifact.file), { force: true });
}
