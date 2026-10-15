import { purgeQueryStores } from "@/lib/query/retained";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import { currentTrustedOperation, withTrustedOperation } from "@/lib/trusted-operation";
import { closeMetadataDb } from "@/lib/metadata/db";
import { listTables } from "@/lib/metadata/tables";
import { testAccountScope } from "@/lib/test-support/accounts";
import { refreshTable } from "@/lib/ingest/refresh";
import * as source from "@/lib/net/remote-fetch";
import { POST as countRoute } from "@/app/api/imports/overture/count/route";
import { listDivisionCountries, resetDivisionCaches } from "./divisions";
import { countOverture, countOvertureLevels, previewOvertureFeatures, importOverture, type OvertureImportParams } from "./import";
import { listOvertureReleases, resetReleaseCache } from "./releases";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";
const params: OvertureImportParams = { theme: "divisions", release: "2026-06-17.0", scope: { type: "bbox", bbox: [1, 1, 1.01, 1.01] }, semantics: "intersect" };
const meta = { rowCount: 1, geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false };
const conn = { run: vi.fn(), runAndReadAll: vi.fn(), interrupt: vi.fn(), disconnectSync: vi.fn() };
let dir: string;
const owners = new Set<NonNullable<ReturnType<typeof currentTrustedOperation>>>();
function remember() { const op = currentTrustedOperation(); if (op) owners.add(op); return op; }
const rows = () => ({ getRowObjects: () => [{ code: "DE", name: "Germany", xmin: 1, ymin: 1, xmax: 1.01, ymax: 1.01, n: 1, column_name: "id", subtype: "country", samples: [], geometry: null }] });
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(async () => {
  dir = await mkdtemp(path.join(scratchRoot, "overture-case-")); vi.stubEnv("DEZFIL_DATA_DIR", dir); closeMetadataDb(); testAccountScope(); resetDivisionCaches(); resetReleaseCache();
  vi.resetAllMocks(); vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(100); vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(200);
  conn.run.mockImplementation(async () => { remember(); }); conn.runAndReadAll.mockImplementation(async () => { remember(); return rows(); });
  vi.spyOn(DuckDBInstance, "create").mockImplementation(async () => ({
    connect: vi.fn().mockResolvedValueOnce({ run: vi.fn().mockResolvedValue(undefined), disconnectSync: vi.fn() }).mockResolvedValue(conn as unknown as DuckDBConnection),
    closeSync: vi.fn(),
  }) as unknown as DuckDBInstance);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => { await Promise.all([...owners].map(o => o.drained)); owners.clear(); await purgeQueryStores(); vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const countries = (signal?: AbortSignal) => (listDivisionCountries as (r: string, s?: AbortSignal) => ReturnType<typeof listDivisionCountries>)(params.release, signal);
const build = async (_params: OvertureImportParams, artifact: string) => { remember(); await mkdir(path.dirname(artifact), { recursive: true }); await writeFile(artifact, "candidate"); return meta; };
it("shared divisions retain the first deadline after one reader departs", async () => {
  const held = Promise.withResolvers<ReturnType<typeof rows>>(), caller = new AbortController();
  conn.runAndReadAll.mockImplementation(async () => { remember(); return held.promise; });
  const first = countries(caller.signal).catch(e => e); await flush(); await vi.advanceTimersByTimeAsync(40);
  const second = countries().catch(e => e); await flush(); caller.abort(); await flush();
  const interruptedEarly = conn.interrupt.mock.calls.length;
  await vi.advanceTimersByTimeAsync(61); held.resolve(rows()); await flush();
  expect(await first).toBeInstanceOf(EvaluationCancelled); expect(await second).toMatchObject({ code: "query_timeout" });
  expect(interruptedEarly).toBe(0); expect(conn.runAndReadAll).toHaveBeenCalledOnce(); expect(conn.interrupt).toHaveBeenCalledOnce();
});
it("the last division reader stops its source on departure", async () => {
  const held = Promise.withResolvers<ReturnType<typeof rows>>(), caller = new AbortController();
  conn.runAndReadAll.mockImplementation(async () => { remember(); return held.promise; });
  const work = countries(caller.signal).catch(e => e); await flush(); caller.abort(); await flush(); const stopped = conn.interrupt.mock.calls.length; held.resolve(rows()); await flush();
  expect(await work).toBeInstanceOf(EvaluationCancelled); expect(stopped).toBe(1);
});
it("shared division preparation inherits an accepted processing deadline", async () => {
  conn.runAndReadAll.mockImplementation(async () => { remember(); await vi.advanceTimersByTimeAsync(201); return rows(); });
  await expect(withTrustedOperation({ kind: "import", name: "Import" }, () => countries())).rejects.toMatchObject({ code: "data_processing_timeout" });
});
it.each([countOverture, countOvertureLevels, previewOvertureFeatures])("read %s includes source preparation in its deadline", async read => {
  conn.run.mockImplementation(async () => { remember(); await vi.advanceTimersByTimeAsync(101); });
  await expect(read(params)).rejects.toMatchObject({ code: "query_timeout", status: 408 }); expect(conn.runAndReadAll).not.toHaveBeenCalled();
});
it.each([countOverture, countOvertureLevels, previewOvertureFeatures])("read %s preserves native preparation memory refusal", async read => {
  conn.run.mockImplementation(async sql => { remember(); if (sql.includes("httpfs")) throw new Error("Out of Memory Error: could not allocate block"); });
  await expect(read(params)).rejects.toMatchObject({ code: "engine_memory_exceeded", status: 422 });
});
it("release discovery and the count share one request deadline", async () => {
  vi.spyOn(source, "openRemote").mockImplementation(async () => { remember(); await vi.advanceTimersByTimeAsync(70); return { statusCode: 200, body: Readable.from([Buffer.from("<Prefix>release/2026-06-17.0/</Prefix>")]) } as source.RemoteResponse; });
  conn.runAndReadAll.mockImplementation(async () => { remember(); await vi.advanceTimersByTimeAsync(40); return rows(); });
  const response = await countRoute(new Request("http://localhost/api/imports/overture/count", { method: "POST", body: JSON.stringify({ theme: "divisions", bbox: [1,1,1.01,1.01] }) }));
  expect(response.status).toBe(408); expect(await response.json()).toMatchObject({ error: { code: "query_timeout" } });
});
it("release discovery never replaces a resource refusal with fallback releases", async () => {
  const refusal = new ApiError("engine_memory_exceeded", "preparation refused", 422); vi.spyOn(source, "openRemote").mockRejectedValue(refusal);
  await expect(listOvertureReleases()).rejects.toBe(refusal);
});
it("accepted import continues after departure with its processing policy", async () => {
  const caller = new AbortController(); let owner: ReturnType<typeof remember>;
  const table = await (importOverture as (...args: unknown[]) => ReturnType<typeof importOverture>)(testAccountScope(), params, async (...args: Parameters<typeof build>) => { owner = remember(); caller.abort(); return build(...args); }, caller.signal);
  expect(table.source).toBe("overture"); expect(owner?.kind).toBe("import"); expect(owner?.signal.aborted).toBe(false);
});
it("expiry immediately before import commit removes the candidate", async () => {
  await expect(importOverture(testAccountScope(), params, async (...args) => { const result = await build(...args); await vi.advanceTimersByTimeAsync(201); return result; })).rejects.toMatchObject({ code: "data_processing_timeout" });
  expect(listTables()).toEqual([]); expect(await readdir(path.join(dir, "tables"))).toEqual([]);
});
it("refresh preserves native memory identity and the previous artifact", async () => {
  const table = await importOverture(testAccountScope(), params, build);
  conn.run.mockImplementation(async sql => { remember(); if (sql.includes("httpfs")) throw new Error("Out of Memory Error: could not allocate block"); });
  await expect(refreshTable(testAccountScope(), table.name)).rejects.toMatchObject({ code: "engine_memory_exceeded" });
  expect(listTables()[0].file).toBe(table.file); expect(await readdir(path.join(dir, "tables"))).toEqual([path.basename(table.file)]);
});
