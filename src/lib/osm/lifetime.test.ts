import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { DuckDBConnection } from "@duckdb/node-api";
import { PassThrough, Readable } from "node:stream";
import path from "node:path";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb } from "@/lib/metadata/db";
import { listTables } from "@/lib/metadata/tables";
import { limits } from "@/lib/limits";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { drainAccountWork } from "@/lib/auth/account-deletion-admission";
import * as source from "@/lib/net/remote-fetch";
import * as ingest from "@/lib/ingest/ingest";
import { refreshTable } from "@/lib/ingest/refresh";
import { importOsm, previewOsm } from "./import";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";

const response = { elements: [
  { type: "node", id: 1, lat: 2, lon: 1, tags: { name: "Point" } },
  { type: "way", id: 2, nodes: [10, 11], geometry: [{ lat: 2, lon: 1 }, { lat: 3, lon: 2 }], tags: { highway: "residential", name: "Road" } },
] };
const request = { ql: "nwr; out geom;", name: "source" };
let dir: string;
const owners = new Set<NonNullable<ReturnType<typeof currentTrustedOperation>>>();
function remember() { const owner = currentTrustedOperation(); if (owner) owners.add(owner); return owner; }
function reply(body: Readable) { return { statusCode: 200, headers: {}, finalUrl: "https://example.test/api/interpreter", body } as unknown as source.RemoteResponse; }
beforeEach(async () => {
  dir = await mkdtemp(path.join(scratchRoot, "osm-case-")); vi.stubEnv("DEZFIL_DATA_DIR", dir); closeMetadataDb(); testAccountScope();
  vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(100);
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(200);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => { await Promise.all([...owners].map(o => o.drained)); owners.clear(); vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const preview = (signal?: AbortSignal) => (previewOsm as (r: typeof request, s?: AbortSignal) => ReturnType<typeof previewOsm>)(request, signal);
const tables = () => readdir(path.join(dir, "tables")).catch(() => []);

it.each(["departure", "deadline"])("preview %s stops source preparation with its original refusal", async reason => {
  const caller = new AbortController(), body = new PassThrough(), opened = Promise.withResolvers<void>(); let signal: AbortSignal | undefined;
  vi.spyOn(source, "openRemote").mockImplementation(async (_url, options) => { remember(); signal = options?.signal; opened.resolve(); return reply(body); });
  const work = preview(caller.signal).catch(error => error);
  await opened.promise; await vi.advanceTimersByTimeAsync(0);
  if (reason === "departure") caller.abort(); else await vi.advanceTimersByTimeAsync(101);
  const stopped = signal?.aborted; body.end(JSON.stringify(response));
  const outcome = await work;
  if (reason === "departure") expect(outcome).toBeInstanceOf(EvaluationCancelled);
  else expect(outcome).toMatchObject({ code: "query_timeout", status: 408 });
  expect(stopped).toBe(true);
});

it("an accepted import retains its processing policy after departure through every class", async () => {
  const caller = new AbortController(); let owner: ReturnType<typeof remember>;
  vi.spyOn(source, "openRemote").mockImplementation(async (_url, options) => {
    owner = remember(); caller.abort(); expect(options?.timeoutMs).toBe((limits.overpassTimeoutS + 30) * 1000);
    return reply(Readable.from([Buffer.from(JSON.stringify(response))]));
  });
  const result = await (importOsm as (...args: unknown[]) => ReturnType<typeof importOsm>)(testAccountScope(), request, caller.signal);
  expect(result).toHaveLength(2); expect(owner?.kind).toBe("import"); expect(owner?.signal.aborted).toBe(false);
});

it("expiry before the last class commit removes every new class", async () => {
  vi.spyOn(source, "openRemote").mockImplementation(async () => { remember(); return reply(Readable.from([Buffer.from(JSON.stringify(response))])); });
  const original = ingest.buildArtifact; let built = 0;
  vi.spyOn(ingest, "buildArtifact").mockImplementation(async (...args) => { const result = await original(...args); built++; await vi.advanceTimersByTimeAsync(101); return result; });
  await expect(importOsm(testAccountScope(), request)).rejects.toMatchObject({ code: "data_processing_timeout" });
  expect(built).toBe(2); expect(listTables()).toEqual([]); expect(await tables()).toEqual([]);
});

it.each(["preview", "import"])("%s preserves resource identity through the Overpass wrapper", async kind => {
  const refusal = new ApiError("engine_memory_exceeded", "Source preparation memory", 422);
  vi.spyOn(source, "openRemote").mockRejectedValue(refusal);
  await expect(kind === "preview" ? preview() : importOsm(testAccountScope(), request)).rejects.toBe(refusal);
});

it("refresh expiry aborts its source and preserves the committed group", async () => {
  vi.spyOn(source, "openRemote").mockImplementation(async () => reply(Readable.from([Buffer.from(JSON.stringify(response))])));
  const imported = await importOsm(testAccountScope(), request);
  const body = new PassThrough(), opened = Promise.withResolvers<void>(); let sourceSignal: AbortSignal | undefined;
  vi.mocked(source.openRemote).mockImplementation(async (_url, options) => { remember(); sourceSignal = options?.signal; opened.resolve(); return reply(body); });
  const work = refreshTable(testAccountScope(), imported[0].name).catch(error => error);
  await opened.promise; await vi.advanceTimersByTimeAsync(201); const aborted = sourceSignal?.aborted;
  body.end(JSON.stringify(response));
  expect(await work).toMatchObject({ code: "data_processing_timeout" }); expect(aborted).toBe(true);
  expect(listTables().map(t => t.file).sort()).toEqual(imported.map(t => t.file).sort()); expect((await tables()).sort()).toEqual(imported.map(t => path.basename(t.file)).sort());
});

it.each(["import", "refresh", "empty refresh"])("%s preserves native class memory refusal and committed data", async kind => {
  vi.spyOn(source, "openRemote").mockImplementation(async () => { remember(); return reply(Readable.from([Buffer.from(JSON.stringify(response))])); });
  const previous = kind === "import" ? [] : await importOsm(testAccountScope(), request);
  if (kind === "empty refresh") vi.mocked(source.openRemote).mockImplementation(async () => reply(Readable.from([Buffer.from(JSON.stringify({ elements: [] }))])));
  const original = DuckDBConnection.prototype.run;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
    if (/^COPY/.test(sql.trim())) throw new Error("Out of Memory Error: could not allocate block");
    return original.call(this, sql, ...args);
  });
  await expect(kind === "import" ? importOsm(testAccountScope(), request) : refreshTable(testAccountScope(), previous[0].name)).rejects.toMatchObject({ code: "engine_memory_exceeded", status: 422 });
  expect(listTables().map(t => t.file).sort()).toEqual(previous.map(t => t.file).sort());
  expect((await tables()).sort()).toEqual(previous.map(t => path.basename(t.file)).sort());
});

it("one departing preview does not stop another caller's source read", async () => {
  const caller = new AbortController(), firstOpened = Promise.withResolvers<void>(), opened = Promise.withResolvers<void>(); const bodies: PassThrough[] = [];
  vi.spyOn(source, "openRemote").mockImplementation(async (_url, options) => {
    remember(); const body = new PassThrough(); bodies.push(body);
    options?.signal?.addEventListener("abort", () => body.destroy(options.signal?.reason), { once: true });
    if (bodies.length === 1) firstOpened.resolve();
    if (bodies.length === 2) opened.resolve(); return reply(body);
  });
  const first = preview(caller.signal).catch(error => error); await firstOpened.promise;
  const second = preview().catch(error => error);
  await opened.promise; await vi.advanceTimersByTimeAsync(0); caller.abort(); await vi.advanceTimersByTimeAsync(0);
  const stopped = bodies[0].destroyed, retained = !bodies[1].destroyed;
  bodies.forEach(body => body.end(JSON.stringify(response)));
  expect(await first).toBeInstanceOf(EvaluationCancelled); expect(await second).toMatchObject({ featureCount: 2 });
  expect(stopped).toBe(true); expect(retained).toBe(true);
});

it("an import keeps the account's work until a removal left to its cleanup path has run", async () => {
  vi.spyOn(source, "openRemote").mockImplementation(async () => reply(Readable.from([Buffer.from(JSON.stringify(response))])));
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let operation: ReturnType<typeof remember>, removed = false;
  const original = ingest.buildArtifact;
  vi.spyOn(ingest, "buildArtifact").mockImplementation(async (...args) => {
    // The first class leaves a removal to the operation's cleanup path, held until released.
    if (!operation) { operation = remember(); operation!.defer(async () => { reached.resolve(); await release.promise; removed = true; }); }
    return original(...args);
  });
  const scope = testAccountScope();
  const work = importOsm(scope, request);
  await reached.promise;
  // An account deletion starts draining the account's work now.
  let accountReleased = false; void drainAccountWork(scope.accountId!).then(() => { accountReleased = true; });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(accountReleased).toBe(false);
  } finally { release.resolve(); }
  expect(await work).toHaveLength(2);
  await operation!.drained;
  expect(removed).toBe(true);
  await drainAccountWork(scope.accountId!);
  expect(accountReleased).toBe(true);
});
