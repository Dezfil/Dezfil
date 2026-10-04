import { inflightSettled } from "@/lib/query/inflight";
import { removeAccountFile } from "./file-ownership";
const key = Symbol.for("dezfil.artifact-retirements");
const host = globalThis as typeof globalThis & { [key]?: Map<string, Promise<void>> };
const pending = host[key] ??= new Map<string, Promise<void>>();
/** Background retirement never turns a committed swap into a request failure.
 * Failure stays outstanding, so account cleanup can observe and retry it. */
export function retireArtifact(absPath: string): void {
  const done = inflightSettled().then(() => removeAccountFile(absPath));
  pending.set(absPath, done);
  void done.then(() => { if (pending.get(absPath) === done) pending.delete(absPath); }, error => {
    console.warn(`artifact retirement failed for ${absPath}: ${error instanceof Error ? error.message : String(error)}`);
  });
}
export async function retirementsSettled(files?: readonly string[]): Promise<void> {
  for (const [file, promise] of [...pending]) {
    if (files && !files.includes(file)) continue;
    try { await promise; }
    catch { await removeAccountFile(file); pending.delete(file); }
  }
}

export function retirementsForTests(): string[] { return [...pending.keys()]; }
