import { purgeQueryStores } from "@/lib/query/retained";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { limits } from "@/lib/limits";
import { EvaluationCancelled } from "@/lib/api/errors";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { drainAccountWork } from "@/lib/auth/account-deletion-admission";
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
import { sourceSlots } from "./source-slots";

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
  vi.spyOn(DuckDBInstance, "create").mockImplementation(async () => ({
    connect: vi.fn().mockResolvedValueOnce({ run: vi.fn().mockResolvedValue(undefined), disconnectSync: vi.fn() }).mockResolvedValue(conn as unknown as DuckDBConnection),
    closeSync: vi.fn(),
  }) as unknown as DuckDBInstance);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
});
afterEach(async () => { await Promise.all([...owners].map(o => o.drained)); owners.clear(); await purgeQueryStores(); vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const read = (signal?: AbortSignal) => (testConnection as (t: typeof target, s?: AbortSignal) => ReturnType<typeof testConnection>)(target, signal);
const build = async (_target: ConnectionTarget, _recipe: PostgisRecipe, artifact: string) => { remember(); await mkdir(path.dirname(artifact), { recursive: true }); await writeFile(artifact, "candidate"); return meta; };
it.each(["departure", "deadline"])("%s during DNS starts no native work", async reason => {
  const held = Promise.withResolvers<string[]>(), caller = new AbortController(); vi.mocked(egress.resolveAllowed).mockImplementation(async () => { remember(); return held.promise; });
  const work = read(caller.signal).catch(e => e); await flush(); if (reason === "departure") caller.abort(); else await vi.advanceTimersByTimeAsync(101); held.resolve(["192.0.2.1"]); await flush();
  const outcome = await work; if (reason === "departure") expect(outcome).toBeInstanceOf(EvaluationCancelled); else expect(outcome).toMatchObject({ code: "query_timeout" }); expect(conn.run).not.toHaveBeenCalled();
});
it("every source attachment takes its statement ceiling from its operation's remaining time, with an independent identity", async () => {
  await read(); await browseRemoteTables(target); await withPg(target, async () => {});
  vi.mocked(egress.resolveAllowed).mockImplementationOnce(async () => { remember(); await vi.advanceTimersByTimeAsync(40); return ["192.0.2.1"]; });
  await read();
  conn.run.mockImplementation(async sql => { remember(); if (sql.startsWith("COPY")) throw new Error("Out of Memory Error: could not allocate block"); });
  await expect(importPostgis(testAccountScope(), recipe)).rejects.toMatchObject({ code: "engine_memory_exceeded" });
  const attaches = conn.run.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.startsWith("ATTACH"));
  expect(attaches).toHaveLength(5);
  // Reads have 100 ms here and imports 200 ms; the fourth read spent 40 ms resolving its host.
  expect(attaches.map(sql => sql.match(/statement_timeout=(\d+)/)?.[1])).toEqual(["100", "100", "100", "60", "200"]);
  for (const sql of attaches) { expect(sql).toContain("connect_timeout=10"); expect(sql).toMatch(/application_name=''dezfil_source_[a-f0-9]{32}''/); }
  expect(new Set(attaches.map(sql => sql.match(/application_name=([^ ]+)/)?.[0])).size).toBe(5);
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
it("work that cancels on departure keeps the 30 s source ceiling when more time is left, and processing takes all of it", async () => {
  vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(60_000); vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(3_600_000);
  conn.runAndReadAll.mockImplementation(async () => { throw new Error("IO Error: source query failed: ERROR:  canceling statement due to statement timeout\n"); });
  await expect(read()).rejects.toMatchObject({ code: "query_timeout", status: 408, message: "The PostGIS source query took too long." });
  conn.runAndReadAll.mockImplementation(async sql => ({ getRowObjects: () => sql.includes("information_schema.columns") ? [{ column_name: "id", udt_name: "int4" }] : [{ v: "source" }] }));
  conn.run.mockImplementation(async sql => { if (sql.startsWith("COPY")) throw new Error("Out of Memory Error: could not allocate block"); });
  await expect(importPostgis(testAccountScope(), recipe)).rejects.toMatchObject({ code: "engine_memory_exceeded" });
  const attaches = conn.run.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.startsWith("ATTACH"));
  expect(attaches.map(sql => sql.match(/statement_timeout=(\d+)/)?.[1])).toEqual(["30000", "3600000"]);
});
it("a source timeout during processing answers the import's own time limit through the import wrapper", async () => {
  conn.run.mockImplementation(async sql => { if (sql.startsWith("COPY")) throw new Error("ERROR: canceling statement due to statement timeout"); });
  await expect(importPostgis(testAccountScope(), recipe)).rejects.toMatchObject({ code: "data_processing_timeout", status: 408,
    message: expect.stringContaining("PostGIS import exceeded the 0.2 s processing time limit.") });
});
it("a source timeout during an interactive read answers the read's own time limit", async () => {
  conn.runAndReadAll.mockImplementation(async () => { throw new Error("IO Error: source query failed: ERROR:  canceling statement due to statement timeout\n"); });
  await expect(read()).rejects.toMatchObject({ code: "query_timeout", status: 408,
    message: expect.stringContaining("PostGIS source exceeded the 0.1 s query time limit.") });
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
it("a refresh whose stored relation no longer resolves keeps the recipe refusal through the source operation", async () => {
  const table = await importPostgis(testAccountScope(), recipe, build);
  const connectionBefore = getConnection(testAccountScope(), target.id);
  conn.runAndReadAll.mockImplementation(async sql => { remember(); return { getRowObjects: () => sql.includes("information_schema.columns") ? [] : [{ v: "moved" }] }; });
  await expect(refreshTable(testAccountScope(), table.name)).rejects.toMatchObject({ code: "not_refreshable", status: 409,
    message: 'The stored recipe for "public.attrs" no longer resolves on this connection. The previous snapshot data is unchanged.' });
  expect(listTables()[0].file).toBe(table.file); expect(getConnection(testAccountScope(), target.id)).toEqual(connectionBefore);
});
it("expiry during native teardown does not interrupt its own cleanup", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  conn.run.mockImplementation(async sql => { remember(); if (sql.startsWith("DETACH")) { entered.resolve(); await release.promise; } });
  const work = read().catch(e => e); await entered.promise; await vi.advanceTimersByTimeAsync(101);
  const interrupted = conn.interrupt.mock.calls.length; release.resolve();
  expect(await work).toMatchObject({ code: "query_timeout" }); expect(interrupted).toBe(0); expect(conn.disconnectSync).toHaveBeenCalledOnce();
});
it.each(["departure", "deadline"])("a source call that finds every slot taken waits inside its lifetime, and %s there refuses it before it reaches the source", async reason => {
  const slots = sourceSlots(), caller = new AbortController();
  const held = await Promise.all(Array.from({ length: slots.limit }, () => slots.acquire()));
  const sourceCalls = () => conn.run.mock.calls.map(([sql]) => String(sql)).filter(sql => /^(INSTALL postgres|ATTACH|DETACH)/.test(sql));
  let outcome: unknown;
  try {
    const work = read(caller.signal).catch(error => error); await flush();
    expect(slots.state()).toEqual({ active: slots.limit, waiting: 1 });
    if (reason === "departure") caller.abort(); else await vi.advanceTimersByTimeAsync(101);
    outcome = await work;
    // The wait left the queue and no source statement started, so there was nothing to cancel.
    expect(slots.state()).toEqual({ active: slots.limit, waiting: 0 });
    expect(sourceCalls()).toEqual([]);
  } finally { for (const release of held) release(); }
  if (reason === "departure") expect(outcome).toBeInstanceOf(EvaluationCancelled); else expect(outcome).toMatchObject({ code: "query_timeout" });
  // A free slot lets the next read reach the source, and hands its slots back.
  await expect(read()).resolves.toMatchObject({ serverVersion: "source" });
  expect(sourceCalls().map(sql => sql.split(" ")[0])).toEqual(["INSTALL", "ATTACH", "DETACH"]);
  expect(slots.state()).toEqual({ active: 0, waiting: 0 });
});
it("an import keeps the account's work until a removal left to its cleanup path has run", async () => {
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let operation: ReturnType<typeof remember>, removed = false;
  const scope = testAccountScope();
  const work = importPostgis(scope, recipe, async (...args: Parameters<typeof build>) => {
    // The build leaves a removal to the operation's cleanup path, held until released.
    operation = remember(); operation!.defer(async () => { reached.resolve(); await release.promise; removed = true; });
    return build(...args);
  });
  await reached.promise;
  // An account deletion starts draining the account's work now.
  let accountReleased = false; void drainAccountWork(scope.accountId!).then(() => { accountReleased = true; });
  try {
    await flush();
    expect(accountReleased).toBe(false);
  } finally { release.resolve(); }
  expect(await work).toMatchObject({ source: "postgis" });
  await operation!.drained;
  expect(removed).toBe(true);
  await drainAccountWork(scope.accountId!);
  expect(accountReleased).toBe(true);
});
