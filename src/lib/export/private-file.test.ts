import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { openPrivateExport } from "./private-file";

const seam = vi.hoisted(() => ({ afterStat: undefined as undefined | (() => void), closed: vi.fn() }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), stat = handle.stat.bind(handle), close = handle.close.bind(handle);
    handle.stat = (async (...params: Parameters<typeof stat>) => { const value = await stat(...params); seam.afterStat?.(); return value; }) as typeof stat;
    handle.close = async () => { seam.closed(); await close(); };
    return handle;
  } };
});
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "open-result-")); process.env.DEZFIL_DATA_DIR = directory;
  closeMetadataDb(); seam.afterStat = undefined; seam.closed.mockClear();
});
afterEach(async () => { closeMetadataDb(); process.env.DEZFIL_DATA_DIR = initialDir; await rm(directory, { recursive: true, force: true }); });
it("closes the opened descriptor and removes the result when activity is withdrawn during stat", async () => {
  const scope = testAccountScope(), file = path.join(directory, "result.csv"); await writeFile(file, "private");
  const cleanup = vi.fn(() => rm(file, { force: true }));
  seam.afterStat = () => metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(scope.accountId);
  await expect(openPrivateExport(scope, { path: file, cleanup })).rejects.toMatchObject({ code: "authentication_required" });
  expect(seam.closed).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce();
  await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
});
it("hands an active initiator a held descriptor and its measured size", async () => {
  const scope = testAccountScope(), file = path.join(directory, "result.csv"); await writeFile(file, "private");
  const cleanup = vi.fn(async () => {}), result = await openPrivateExport(scope, { path: file, cleanup });
  try { expect(result.size).toBe(7); expect(await result.handle.readFile("utf8")).toBe("private"); expect(cleanup).not.toHaveBeenCalled(); }
  finally { await result.handle.close(); }
});
