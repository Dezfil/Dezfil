import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { DuckDBConnection } from "@duckdb/node-api";
import { resetQueryInstance } from "@/lib/duckdb";
import { exportQueryResult } from "@/lib/export/layer-export";
import { closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { fenceStorageWriters } from "./storage-fence";

/** Computes for far longer than any run, writing nothing until its one row. */
const COMPUTING = "SELECT sum(range) AS total FROM range(1000000000000)";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb(); resetQueryInstance();
});
afterEach(async () => {
  vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

/** The real engine's COPY, seen entering and ending at the native call. */
function watchCopies(): { ended: Promise<string> }[] {
  const copies: { ended: Promise<string> }[] = [];
  const original = DuckDBConnection.prototype.run;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(function (this: DuckDBConnection, ...args: Parameters<DuckDBConnection["run"]>) {
    const running = original.apply(this, args);
    if (/^\s*COPY\b/.test(args[0])) copies.push({ ended: running.then(() => "returned", (error: Error) => error.message) });
    return running;
  });
  return copies;
}

async function executingCopy(copies: { ended: Promise<string> }[]) {
  const answer = exportQueryResult(testAccountScope(), COMPUTING, "csv").then(() => null, (error: unknown) => error);
  await vi.waitFor(() => expect(copies).toHaveLength(1), { timeout: 30_000 });
  expect(await stillRunning(copies[0], 300), "the query must still be computing when the fence fires").toBe("running");
  return { answer };
}
const stillRunning = (copy: { ended: Promise<string> }, ms: number) => Promise.race([copy.ended, pause(ms).then(() => "running")]);

it("the storage fence interrupts a COPY executing in the real engine and settles only once it has returned", async () => {
  const copies = watchCopies();
  const { answer } = await executingCopy(copies);
  const fence = await fenceStorageWriters(10_000);
  try {
    expect(fence.overdue).toBe(0);
    expect(await stillRunning(copies[0], 0)).toMatch(/^INTERRUPT Error/);
    expect(await answer).toMatchObject({ code: "storage_exhausted" });
    expect(await readdir(path.join(dir, "data", "tiles", "scratch"))).toEqual([]);
  } finally { fence.release(); }
});

it("negative control: with the interruption disabled the same COPY keeps running and the fence reports it overdue", async () => {
  const copies = watchCopies();
  const interrupt = vi.spyOn(DuckDBConnection.prototype, "interrupt").mockImplementation(() => {});
  const { answer } = await executingCopy(copies);
  const fence = await fenceStorageWriters(1_500);
  try {
    expect(fence.overdue).toBe(1);
    expect(await stillRunning(copies[0], 0)).toBe("running");
    expect(interrupt).toHaveBeenCalled();
  } finally {
    fence.release();
    // The evaluation goes on asking; the real interruption now ends the work this test started.
    interrupt.mockRestore();
    expect(await copies[0].ended).toMatch(/^INTERRUPT Error/);
    expect(await answer).toMatchObject({ code: "storage_exhausted" });
  }
});
