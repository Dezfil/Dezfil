import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Ensure the data directory exists and is writable. Called at server startup
 * and by the readiness check; throws with a actionable message when the
 * mounted volume is missing or read-only.
 */
export async function ensureDataDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new Error(`Data directory ${dir} cannot be created`, { cause });
  }
  const probe = path.join(dir, `.dezfil-write-probe-${randomUUID()}`);
  try {
    await writeFile(probe, "");
    await rm(probe);
  } catch (cause) {
    throw new Error(`Data directory ${dir} is not writable`, { cause });
  }
}
