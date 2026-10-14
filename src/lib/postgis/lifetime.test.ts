import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { limits } from "@/lib/limits";
import { EvaluationCancelled } from "@/lib/api/errors";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { closeMetadataDb } from "@/lib/metadata/db";
import { listTables } from "@/lib/metadata/tables";
import { insertConnection, getConnection } from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountScope } from "@/lib/test-support/accounts";
import { refreshTable } from "@/lib/ingest/refresh";
import * as egress from "@/lib/net/egress";
import { withPg, testConnection, browseRemoteTables, type ConnectionTarget } from "./access";
import { importPostgis, type PostgisRecipe } from "./import";
import { createConnection, editConnection, testSavedConnection, browseConnection } from "./connection-service";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";
const target = { id: "source", name: "Source", host: "source.example", port: 5432, database: "gis", username: "reader", password: "fixture-only", ssl: false };
const recipe = { connectionId: target.id, schema: "public", table: "attrs" };
const health = { serverVersion: "source", postgisVersion: null };
const meta = { connectionHealth: health, rowCount: 1, geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false };
const conn = { run: vi.fn(), runAndReadAll: vi.fn(), interrupt: vi.fn(), disconnectSync: vi.fn() };
const owners = new Set<NonNullable<ReturnType<typeof currentTrustedOperation>>>();
function remember() { const op = currentTrustedOperation(); if (op) owners.add(op); return op; }
let dir: string;
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(async () => {
  dir = await mkdtemp(path.join(scratchRoot, "postgis-case-")); vi.stubEnv("DEZFIL_DATA_DIR", dir); closeMetadataDb(); resetSecretKeyCache(); insertConnection(testAccountScope(), target);
  vi.resetAllMocks(); vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(100); vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(200);
  vi.spyOn(egress, "resolveAllowed").mockImplementation(async () => { remember(); return ["192.0.2.1"]; });
  conn.run.mockImplementation(async () => { remember(); }); conn.runAndReadAll.mockImplementation(async sql => { remember(); return { getRowObjects: () => sql.includes("information_schema.columns") ? [{ column_name: "id", udt_name: "int4" }] : [{ v: "source" }] }; });
  vi.spyOn(DuckDBInstance, "create").mockResolvedValue({ connect: async () => conn as unknown as DuckDBConnection } as DuckDBInstance);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
});
afterEach(async () => { await Promise.all([...owners].map(o => o.drained)); owners.clear(); vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const read = (signal?: AbortSignal) => (testConnection as (t: typeof target, s?: AbortSignal) => ReturnType<typeof testConnection>)(target, signal);
const build = async (_target: ConnectionTarget, _recipe: PostgisRecipe, artifact: string) => { remember(); await mkdir(path.dirname(artifact), { recursive: true }); await writeFile(artifact, "candidate"); return meta; };
it.each(["departure", "deadline"])("%s during DNS starts no native work", async reason => {
  const held = Promise.withResolvers<string[]>(), caller = new AbortController(); vi.mocked(egress.resolveAllowed).mockImplementation(async () => { remember(); return held.promise; });
  const work = read(caller.signal).catch(e => e); await flush(); if (reason === "departure") caller.abort(); else await vi.advanceTimersByTimeAsync(101); held.resolve(["192.0.2.1"]); await flush();
  const outcome = await work; if (reason === "departure") expect(outcome).toBeInstanceOf(EvaluationCancelled); else expect(outcome).toMatchObject({ code: "query_timeout" }); expect(conn.run).not.toHaveBeenCalled();
});
it("every source attachment carries a statement ceiling and independent identity", async () => {
  await read(); await browseRemoteTables(target); await withPg(target, async () => {});
  const attaches = conn.run.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.startsWith("ATTACH"));
  expect(attaches).toHaveLength(3);
  for (const sql of attaches) { expect(sql).toContain("statement_timeout=30000"); expect(sql).toContain("connect_timeout=10"); expect(sql).toMatch(/application_name=''dezfil_source_[a-f0-9]{32}''/); }
  expect(new Set(attaches.map(sql => sql.match(/application_name=([^ ]+)/)?.[0])).size).toBe(3);
});
it("a late successful attachment is detached after expiry without running source queries", async () => {
  conn.run.mockImplementation(async sql => { remember(); if (sql.startsWith("ATTACH")) await vi.advanceTimersByTimeAsync(101); });
  await expect(read()).rejects.toMatchObject({ code: "query_timeout" });
  expect(conn.run.mock.calls.some(([sql]) => sql.startsWith("DETACH"))).toBe(true); expect(conn.runAndReadAll).not.toHaveBeenCalled(); expect(conn.disconnectSync).toHaveBeenCalledOnce();
});
it.each(["INSTALL postgres", "ATTACH", "COPY"])("native memory at %s keeps its identity and cleans the import", async stage => {
  conn.run.mockImplementation(async sql => { remember(); if (sql.startsWith(stage)) throw new Error("Out of Memory Error: could not allocate block"); });
  await expect(importPostgis(testAccountScope(), recipe)).rejects.toMatchObject({ code: "engine_memory_exceeded", status: 422 }); expect(listTables()).toEqual([]);
  expect(getConnection(testAccountScope(), target.id)?.lastCheckError).toBeNull();
});
it("source timeout during processing preserves its refusal through the import wrapper", async () => {
  conn.run.mockImplementation(async sql => { if (sql.startsWith("COPY")) throw new Error("ERROR: canceling statement due to statement timeout"); });
  await expect(importPostgis(testAccountScope(), recipe)).rejects.toMatchObject({ code: "query_timeout", status: 408 });
});
it.each(["create", "edit", "test", "catalogue"])("%s includes preparation and refuses a late metadata commit", async kind => {
  vi.mocked(egress.resolveAllowed).mockImplementation(async () => { remember(); await vi.advanceTimersByTimeAsync(101); return ["192.0.2.1"]; });
  const scope = testAccountScope();
  const work = kind === "create" ? createConnection(scope, { ...target, name: "New" }) : kind === "edit" ? editConnection(scope, target.id, { name: "New", host: "other.example", password: target.password }) : kind === "test" ? testSavedConnection(scope, target.id) : browseConnection(scope, target.id);
  await expect(work).rejects.toMatchObject({ code: "query_timeout" }); expect(getConnection(scope, target.id)?.name).toBe("Source");
});
it("accepted import continues after departure and refuses an expired final commit", async () => {
  const caller = new AbortController(); let policy: string | undefined;
  const lateBuild = async (...args: Parameters<typeof build>) => { policy = remember()?.kind; caller.abort(); const result = await build(...args); await vi.advanceTimersByTimeAsync(201); return result; };
  await expect((importPostgis as (...args: unknown[]) => ReturnType<typeof importPostgis>)(testAccountScope(), recipe, lateBuild, caller.signal)).rejects.toMatchObject({ code: "data_processing_timeout" });
  expect(policy).toBe("import"); expect(listTables()).toEqual([]); expect(await readdir(path.join(dir, "tables"))).toEqual([]);
});
it("a refused refresh retains its previous artifact and resource identity", async () => {
  const table = await importPostgis(testAccountScope(), recipe, build);
  conn.run.mockImplementation(async sql => { remember(); if (sql.startsWith("COPY")) throw new Error("Out of Memory Error: could not allocate block"); });
  await expect(refreshTable(testAccountScope(), table.name)).rejects.toMatchObject({ code: "engine_memory_exceeded" }); expect(listTables()[0].file).toBe(table.file);
});
it("expiry during native teardown does not interrupt its own cleanup", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  conn.run.mockImplementation(async sql => { remember(); if (sql.startsWith("DETACH")) { entered.resolve(); await release.promise; } });
  const work = read().catch(e => e); await entered.promise; await vi.advanceTimersByTimeAsync(101);
  const interrupted = conn.interrupt.mock.calls.length; release.resolve();
  expect(await work).toMatchObject({ code: "query_timeout" }); expect(interrupted).toBe(0); expect(conn.disconnectSync).toHaveBeenCalledOnce();
});
