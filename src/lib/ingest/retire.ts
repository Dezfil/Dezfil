import { rm } from "node:fs/promises";
import { inflightSettled } from "@/lib/query/inflight";

/**
 * Retire a replaced or deleted artifact: removal waits for the readers in
 * flight at retirement time, so a committed swap never yanks a file out
 * from under an evaluation that bound its path beforehand. The wait is
 * bounded — every evaluation is timed — and fire-and-forget by design: a
 * post-commit cleanup problem is logged, never an error the caller reads.
 * The boot sweep collects whatever a dying process abandons.
 */

const pending = new Set<Promise<void>>();

export function retireArtifact(absPath: string): void {
  const done = inflightSettled()
    .then(() => rm(absPath, { force: true }))
    .catch((error: unknown) => {
      console.warn(
        `artifact retirement failed for ${absPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .then(() => undefined);
  pending.add(done);
  void done.then(() => pending.delete(done));
}

/** Test hook: settles once every scheduled retirement has run. */
export async function retirementsSettled(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
