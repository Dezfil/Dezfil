import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ingestFile } from "./ingest/ingest";
import { testAccountScope } from "./test-support/accounts";
import { closeMetadataDb } from "./metadata/db";
import { inspectTable, tableFeatures } from "./table-service";
import { readTableCatalogue } from "./table-catalogue";
import { inspectGeometry, previewGeometry } from "./geometry/service";
import { geometryRevision } from "./geometry/read";
import { currentTrustedOperation } from "./trusted-operation";
import { EvaluationCancelled } from "./api/errors";
import { limits } from "./limits";
import * as budgetReader from "./query/budget-reader";
import { updateOwnedTableGeometryType, getOwnedTableByName } from "./metadata/owned-tables";
import * as engine from "./duckdb";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";

let dir: string, table: Awaited<ReturnType<typeof ingestFile>>;
beforeEach(async () => {
  dir = await mkdtemp(path.join(scratchRoot, "inspection-case-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); closeMetadataDb();
  const file = path.join(dir, "points.csv"); await writeFile(file, "lon,lat\n1,2\n");
  table = await ingestFile(testAccountScope(), file, "points.csv");
  vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(100);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const readers = {
  inspection: (signal: AbortSignal) => inspectTable(testAccountScope(), table.name, signal),
  features: (signal: AbortSignal) => tableFeatures(testAccountScope(), table.name, { signal }),
  catalogue: (signal: AbortSignal) => readTableCatalogue(testAccountScope(), { limit: 32, columns: 64, columnOffset: 0 }, signal),
  geometry: (signal: AbortSignal) => inspectGeometry(testAccountScope(), table.name, signal),
  preview: (signal: AbortSignal) => previewGeometry(testAccountScope(), table.name, geometryRevision(table), { format: "pair", columns: ["lon", "lat"] }, signal),
};

it.each(Object.entries(readers))("%s admits before connection preparation and cancels departure", async (_name, read) => {
  const caller = new AbortController(), release = Promise.withResolvers<void>();
  let owner: ReturnType<typeof currentTrustedOperation>;
  vi.spyOn(engine, "withConnection").mockImplementation(async () => { owner = currentTrustedOperation(); await release.promise; return undefined; });
  const work = read(caller.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(0); caller.abort(); release.resolve();
  expect(await work).toBeInstanceOf(EvaluationCancelled);
  expect(owner?.kind).toBe("interactive-read"); expect(owner?.signal.aborted).toBe(true);
  await owner?.drained;
});

it.each(Object.entries(readers))("%s uses one deadline through connection preparation", async (_name, read) => {
  const release = Promise.withResolvers<void>(); let owner: ReturnType<typeof currentTrustedOperation>;
  vi.spyOn(engine, "withConnection").mockImplementation(async () => { owner = currentTrustedOperation(); await release.promise; return undefined; });
  const work = read(new AbortController().signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(101); release.resolve();
  expect(await work).toMatchObject({ code: "query_timeout", status: 408 });
  await owner?.drained;
});

it("expiry immediately before inspection repair leaves committed geometry metadata intact", async () => {
  const scope = testAccountScope();
  updateOwnedTableGeometryType(scope, table, "MIXED");
  const original = budgetReader.readBudgetedRows;
  let calls = 0;
  vi.spyOn(budgetReader, "readBudgetedRows").mockImplementation(async (...args) => {
    const rows = await original(...args);
    if (++calls === 2) await vi.advanceTimersByTimeAsync(101);
    return rows;
  });
  await expect(inspectTable(scope, table.name)).rejects.toMatchObject({ code: "query_timeout" });
  expect(getOwnedTableByName(scope, table.name)?.geometryType).toBe("MIXED");
});
