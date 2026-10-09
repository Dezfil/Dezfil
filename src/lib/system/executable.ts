import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * Whether a configured program is there to run: a file check, never a run.
 * A name with a directory in it is that file; a bare name is looked up on
 * the search path, as the system would when running it. Found means an
 * executable regular file; a missing file, a folder or a file without the
 * right to run it is not found.
 */
export function executableFound(program: string): boolean {
  if (!program) return false;
  if (program.includes("/") || program.includes(path.sep)) return runnable(program);
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    if (folder && runnable(path.join(folder, program))) return true;
  }
  return false;
}

function runnable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
