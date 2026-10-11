import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { listTables } from "@/lib/metadata/tables";
import { templateArtifactsInUse } from "@/lib/templates/artifacts";

/**
 * Boot sweep of the artifact directory: an artifact file no registered
 * table references is unreachable by every code path — a stranded refresh
 * loser, an abandoned retirement, a candidate from a process that died
 * mid-build — unless it is the engine's copy of an installed template's
 * data, which is kept while a version needs it. At process start no
 * refresh is in flight, so removing the rest is safe; registered artifacts
 * and the copies an installed template needs are untouchable by
 * construction, because the sweep diffs the directory against the registry
 * and the installed versions' records. Removals are logged, and a repeat
 * run is a no-op.
 */
export async function sweepTableArtifacts(): Promise<number> {
  const dir = path.join(dataDir(), "tables");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    // Only "not there yet" means nothing to sweep. Any other read failure
    // is unusable storage and must surface through the fail-fast boot hook, not report a clean
    // zero-file sweep.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const registered = new Set(listTables().map((t) => path.basename(t.file)));
  const templates = await templateArtifactsInUse();
  let removed = 0;
  for (const entry of entries) {
    if (registered.has(entry) || templates.has(entry)) continue;
    await rm(path.join(dir, entry), { force: true });
    removed += 1;
    console.warn(`boot sweep: removed unreferenced table artifact ${entry}`);
  }
  return removed;
}
