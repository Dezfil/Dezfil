import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { ownedFileRecords, removeAccountFile } from "@/lib/ingest/file-ownership";

async function names(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
/** Startup only. No private-copy ticket or image writer survives its process.
 * Ingest and tile scratch, and unregistered table candidates, have their own
 * boot sweeps. Preserve published images while removing interrupted writes. */
export async function cleanAbandonedDeletionCandidates(): Promise<void> {
  const exports = path.join(dataDir(), "exports");
  for (const name of await names(exports)) await removeAccountFile(path.join(exports, name), { recursive: true });
  for (const record of ownedFileRecords().filter(record => record.file.startsWith("exports/"))) {
    await removeAccountFile(path.join(dataDir(), record.file), { recursive: record.directory });
  }
  const images = path.join(dataDir(), "thumbnails"), evidence = path.join(dataDir(), "artifact-inputs", "thumbnails");
  for (const directory of [images, evidence]) {
    for (const name of (await names(directory)).filter(name => name.endsWith(".tmp"))) await rm(path.join(directory, name), { force: true });
  }
}
