import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import type { TrustedOperation } from "@/lib/trusted-operation";

/** Own the archive's inputs as well as its output: destroying a zip output
 * alone does not close the file streams feeding its compression pipeline. */
export function ownedArchive(operation: TrustedOperation) {
  const zip = new ZipFile(), output = zip.outputStream as Readable;
  const readers = new Set<ReadStream>(), closing = new Set<Promise<void>>();
  let failure: unknown, complete = false;
  const fail = (error: unknown) => {
    failure ??= error;
    for (const reader of readers) reader.destroy(error as Error);
    output.destroy(error as Error);
  };
  zip.on("error", fail);
  // A source may fail before the destination pipeline is attached.
  output.on("error", () => {});
  const stop = operation.onStop(() => zip.emit("error", operation.signal.reason));
  return {
    zip,
    async addFile(file: string, entry: string) {
      operation.assertCanCommit();
      const info = await stat(file);
      operation.assertCanCommit();
      zip.addReadStreamLazy(entry, { size: info.size, mtime: info.mtime, mode: info.mode }, callback => {
        if (failure || operation.signal.aborted) { callback(failure ?? operation.signal.reason, undefined!); return; }
        const reader = createReadStream(file);
        readers.add(reader);
        reader.on("error", error => zip.emit("error", error));
        const closed = finished(reader, { cleanup: true }).catch(() => {});
        closing.add(closed);
        void closed.then(() => { readers.delete(reader); closing.delete(closed); });
        callback(null, reader);
      });
    },
    async finish(file: string) {
      operation.assertCanCommit();
      if (failure) throw failure;
      const writing = pipeline(output, createWriteStream(file), { signal: operation.signal });
      try { zip.end(); await writing; complete = true; }
      catch (error) { zip.emit("error", error); await writing.catch(() => {}); throw failure ?? error; }
    },
    async close() {
      stop();
      if (!complete) zip.emit("error", failure ?? new Error("Archive assembly ended."));
      await Promise.all([...closing]);
    },
  };
}
