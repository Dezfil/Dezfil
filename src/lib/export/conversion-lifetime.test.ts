import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { ZipFile } from "yazl";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { limits } from "@/lib/limits";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { testAccountScope } from "@/lib/test-support/accounts";
import { stored } from "@/lib/test-support/geometry";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createProject, fileTable } from "@/lib/metadata/projects";
import { exportTable } from "@/lib/table-service";
import { assembleProjectExport, type ProjectExportSelection } from "./project-export";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";
let dir: string;
const owners = new Set<NonNullable<ReturnType<typeof currentTrustedOperation>>>();
function remember() { const op = currentTrustedOperation(); if (op) owners.add(op); return op; }
beforeEach(async () => {
  dir = await mkdtemp(path.join(scratchRoot, "export-case-")); vi.stubEnv("DEZFIL_DATA_DIR", dir); await mkdir(path.join(dir, "tables")); closeMetadataDb();
  vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(100); vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(200);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => { await Promise.all([...owners].map(o => o.drained)); owners.clear(); vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const files = (folder: string) => readdir(path.join(dir, folder)).catch(() => []);
const convert = (name: string, signal?: AbortSignal) => (exportTable as (...args: unknown[]) => ReturnType<typeof exportTable>)(testAccountScope(), name, "csv", signal);
async function project() {
  const p = createProject(testAccountScope(), { name: "Exports" }), a = await stored("SELECT 1 AS id"), b = await stored("SELECT 2 AS id"); fileTable(a.id, p.id); fileTable(b.id, p.id);
  return { id: p.id, selection: { maps: [], recipes: [], tables: [a.id, b.id], file: "exports", datasetFormat: "csv" } as ProjectExportSelection };
}
function onCopy(callback: () => Promise<void>) {
  const original = DuckDBConnection.prototype.run;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) { remember(); const result = await original.call(this, sql, ...args); if (sql.includes("FORMAT csv")) await callback(); return result; });
}
it.each(["departure", "deadline"])("conversion %s removes a late output and preserves the original", async reason => {
  const table = await stored("SELECT 1 AS id"), caller = new AbortController(); onCopy(async () => { if (reason === "departure") caller.abort(); else await vi.advanceTimersByTimeAsync(201); });
  const outcome = await convert(table.name, caller.signal).catch(e => e);
  if (reason === "departure") expect(outcome).toBeInstanceOf(EvaluationCancelled); else expect(outcome).toMatchObject({ code: "data_processing_timeout" });
  expect(await files("tmp")).toEqual([]); expect(await files("tables")).toEqual([path.basename(table.file)]);
});
it("project conversions share one processing deadline and remove earlier outputs", async () => {
  const p = await project(); let copies = 0; onCopy(async () => { copies++; await vi.advanceTimersByTimeAsync(110); });
  await expect(assembleProjectExport(testAccountScope(), p.id, p.selection)).rejects.toMatchObject({ code: "data_processing_timeout" });
  expect(copies).toBe(2); expect(await files("tmp")).toEqual([]); expect(await files("exports")).toEqual([]); expect(await files("tables")).toHaveLength(2);
});
it.each(["dataset", "project"])("%s preserves native memory refusal", async kind => {
  const p = await project(); onCopy(async () => { throw new Error("Out of Memory Error: could not allocate block"); });
  await expect(kind === "dataset" ? convert(p.selection.tables[0]) : assembleProjectExport(testAccountScope(), p.id, p.selection)).rejects.toMatchObject({ code: "engine_memory_exceeded", status: 422 });
  expect(await files("tmp")).toEqual([]); expect(await files("exports")).toEqual([]);
});
it("a shorter conversion refusal survives the project wrapper", async () => {
  const p = await project(), refusal = new ApiError("query_result_too_large", "shorter refusal", 413); onCopy(async () => { throw refusal; });
  await expect(assembleProjectExport(testAccountScope(), p.id, p.selection)).rejects.toBe(refusal);
});
it("departure during zip finalization removes every conversion and the archive", async () => {
  const p = await project(), caller = new AbortController(), original = ZipFile.prototype.end;
  vi.spyOn(ZipFile.prototype, "end").mockImplementation(function (this: ZipFile, ...args) { remember(); caller.abort(); return original.apply(this, args); });
  const outcome = await (assembleProjectExport as (...args: unknown[]) => ReturnType<typeof assembleProjectExport>)(testAccountScope(), p.id, p.selection, caller.signal).catch(e => e);
  expect(outcome).toBeInstanceOf(EvaluationCancelled); expect(await files("exports")).toEqual([]); expect(await files("tmp")).toEqual([]);
});
it("project preparation interrupts an inherited hardened read on departure", async () => {
  const p = await project(), caller = new AbortController(), entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  const { createRecipe } = await import("@/lib/metadata/recipes"); const { fileRecipe } = await import("@/lib/metadata/projects");
  const view = await import("@/lib/operations/recipe-view"); const { boundedEvaluation } = await import("@/lib/query/bounded");
  const recipe = createRecipe(testAccountScope(), "Preparation"); fileRecipe(recipe.id, p.id); p.selection.recipes.push(recipe.id);
  const original = view.readRecipe, interrupt = vi.spyOn(DuckDBConnection.prototype, "interrupt");
  vi.spyOn(view, "readRecipe").mockImplementation(async (...args) => {
    await boundedEvaluation(async () => { remember(); entered.resolve(); await held.promise; }, { scope: testAccountScope() });
    return original(...args);
  });
  const work = (assembleProjectExport as (...args: unknown[]) => ReturnType<typeof assembleProjectExport>)(testAccountScope(), p.id, p.selection, caller.signal).catch(e => e);
  await entered.promise; caller.abort(); await vi.advanceTimersByTimeAsync(0); const interrupted = interrupt.mock.calls.length;
  held.resolve(); expect(await work).toBeInstanceOf(EvaluationCancelled); expect(interrupted).toBeGreaterThan(0); expect(await files("exports")).toEqual([]);
});
