import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { DuckDBConnection } from "@duckdb/node-api";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb } from "@/lib/metadata/db";
import { listTables } from "@/lib/metadata/tables";
import { limits } from "@/lib/limits";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import * as engine from "@/lib/duckdb";
import * as remoteFetch from "@/lib/net/remote-fetch";
import * as ingest from "./ingest";
import * as ownership from "./file-ownership";
import * as csv from "./csv-content";
import { ingestSource } from "./gdal-formats";
import { importFromUrl } from "./remote";
import { refreshTable } from "./refresh";
import * as archive from "./container";
import { buildZip } from "../../../test-support/zip";
import { buildKml } from "../../../test-support/kml";
import { buildGpkg } from "../../../test-support/gpkg";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";

let dir: string, source: string;
const owners = new Set<NonNullable<ReturnType<typeof currentTrustedOperation>>>();
const remember = () => { const owner = currentTrustedOperation(); if (owner) owners.add(owner); return owner; };
beforeEach(async () => {
  dir = await mkdtemp(path.join(scratchRoot, "processing-case-")); vi.stubEnv("DEZFIL_DATA_DIR", dir); closeMetadataDb();
  source = path.join(dir, "plain.csv"); await writeFile(source, "name,value\na,1\n"); testAccountScope();
  await engine.withConnection(async () => {});
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(100);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => { await Promise.all([...owners].map(o => o.drained)); owners.clear(); vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const artifacts = async () => readdir(path.join(dir, "tables")).catch(() => []);

it("accepted file processing survives its caller and shares admission with preparation", async () => {
  const caller = new AbortController(); let admitted: ReturnType<typeof remember>;
  const original = csv.requireCsvContent;
  vi.spyOn(csv, "requireCsvContent").mockImplementation(async (...args) => { admitted = remember(); caller.abort(); return original(...args); });
  const result = await (ingestSource as (...args: unknown[]) => ReturnType<typeof ingestSource>)(testAccountScope(), source, "plain.csv", undefined, undefined, undefined, caller.signal);
  expect(result.tables).toHaveLength(1); expect(admitted?.kind).toBe("import"); expect(admitted?.signal.aborted).toBe(false);
});

it("preparation consumes the same processing deadline as the file build", async () => {
  const original = csv.requireCsvContent;
  vi.spyOn(csv, "requireCsvContent").mockImplementation(async (...args) => { remember(); await vi.advanceTimersByTimeAsync(101); return original(...args); });
  await expect(ingestSource(testAccountScope(), source, "plain.csv")).rejects.toMatchObject({ code: "data_processing_timeout", status: 408 });
  await Promise.all([...owners].map(o => o.drained)); expect(listTables()).toEqual([]); expect(await artifacts()).toEqual([]);
});

it("expiry immediately before file registration removes its completed artifact", async () => {
  const original = engine.withConnection;
  vi.spyOn(engine, "withConnection").mockImplementation(async work => { const owner = remember(); const value = await original(work); vi.spyOn(performance, "now").mockReturnValue((owner?.deadline ?? 100) + 1); return value; });
  await expect(ingestSource(testAccountScope(), source, "plain.csv")).rejects.toMatchObject({ code: "data_processing_timeout" });
  await Promise.all([...owners].map(o => o.drained)); expect(listTables()).toEqual([]); expect(await artifacts()).toEqual([]);
});

it("all container artifacts share one deadline and a late refusal registers none", async () => {
  const file = path.join(dir, "group.gpkg"); buildGpkg(file, [{ name: "first", kind: "points", rows: [[1, 2, "a"]] }, { name: "second", kind: "points", rows: [[3, 4, "b"]] }]);
  const original = ingest.measureArtifact; let measured = 0;
  vi.spyOn(ingest, "measureArtifact").mockImplementation(async (...args) => {
    const owner = remember(), value = await original(...args);
    if (++measured === 2) vi.spyOn(performance, "now").mockReturnValue((owner?.deadline ?? 100) + 1);
    return value;
  });
  await expect(ingestSource(testAccountScope(), file, "group.gpkg")).rejects.toMatchObject({ code: "data_processing_timeout" });
  await Promise.all([...owners].map(o => o.drained)); expect(measured).toBe(2); expect(owners.size).toBe(1);
  expect(listTables()).toEqual([]); expect(await artifacts()).toEqual([]);
});

it.each(["plain.csv", "group.gpkg"])("trusted COPY memory refusal survives the %s ingest wrapper", async filename => {
  let file = source;
  if (filename.endsWith("gpkg")) { file = path.join(dir, filename); buildGpkg(file, [{ name: "points", kind: "points", rows: [[1, 2, "a"]] }]); }
  const original = DuckDBConnection.prototype.run;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
    remember(); if (/^COPY/.test(sql.trim())) throw new Error("Out of Memory Error: could not allocate block");
    return original.call(this, sql, ...args);
  });
  await expect(ingestSource(testAccountScope(), file, filename)).rejects.toMatchObject({ code: "engine_memory_exceeded", status: 422 });
  await Promise.all([...owners].map(o => o.drained)); expect(listTables()).toEqual([]); expect(await artifacts()).toEqual([]);
});

function serveCsv() {
  vi.spyOn(remoteFetch, "openRemote").mockImplementation(async (_url, options) => {
    remember(); expect(options?.signal).toBe(currentTrustedOperation()?.signal);
    return { statusCode: 200, headers: {}, finalUrl: "https://example.test/plain.csv", body: Readable.from(["name,value\nb,2\n"]) } as unknown as remoteFetch.RemoteResponse;
  });
}
it("link preparation receives the processing signal and keeps the shorter link budget", async () => {
  const refusal = new (await import("@/lib/api/errors")).ApiError("remote_timeout", "Short download limit", 504);
  vi.spyOn(remoteFetch, "openRemote").mockImplementation(async (_url, options) => {
    const owner = remember(); expect(owner?.kind).toBe("import"); expect(options?.signal).toBe(owner?.signal);
    expect(options?.timeoutMs).toBe(limits.remoteTimeoutMs); throw refusal;
  });
  await expect(importFromUrl(testAccountScope(), "https://example.test/plain.csv")).rejects.toBe(refusal);
});

it("a refused URL refresh preserves the previous file and identity", async () => {
  const table = await ingest.ingestFile(testAccountScope(), source, "plain.csv", { source: "url", sourceParams: { url: "https://example.test/plain.csv" } });
  const previous = await readFile(path.join(dir, table.file)); serveCsv();
  const original = engine.withConnection;
  vi.spyOn(engine, "withConnection").mockImplementation(async work => { const owner = remember(), value = await original(work); vi.spyOn(performance, "now").mockReturnValue((owner?.deadline ?? 100) + 1); return value; });
  await expect(refreshTable(testAccountScope(), table.name)).rejects.toMatchObject({ code: "data_processing_timeout" });
  await Promise.all([...owners].map(o => o.drained)); expect(listTables()[0]).toMatchObject({ id: table.id, file: table.file });
  expect(await readFile(path.join(dir, table.file))).toEqual(previous); expect(await artifacts()).toEqual([path.basename(table.file)]);
});

it("processing expiry aborts a stalled link body and removes its scratch file", async () => {
  const body = new PassThrough(), opened = Promise.withResolvers<void>();
  vi.spyOn(remoteFetch, "openRemote").mockImplementation(async () => {
    remember(); opened.resolve();
    return { statusCode: 200, headers: {}, finalUrl: "https://example.test/plain.csv", body } as unknown as remoteFetch.RemoteResponse;
  });
  const result = importFromUrl(testAccountScope(), "https://example.test/plain.csv").catch(error => error);
  await opened.promise; await vi.advanceTimersByTimeAsync(101);
  const stopped = body.destroyed; body.end("name,value\na,1\n");
  expect(await result).toMatchObject({ code: "data_processing_timeout" });
  expect(stopped).toBe(true); expect(await readdir(path.join(dir, "tmp"))).toEqual([]);
});

it("a committed link import stays a success when its source cleanup crosses the deadline", async () => {
  serveCsv();
  const original = ownership.removeAccountFile;
  let crossed = false;
  vi.spyOn(ownership, "removeAccountFile").mockImplementation(async (file, options) => {
    // The downloaded source is removed after the dataset is registered.
    if (!crossed && listTables().length > 0 && String(file).includes(`${path.sep}tmp${path.sep}`)) { crossed = true; await vi.advanceTimersByTimeAsync(101); }
    return original(file, options);
  });
  const result = await importFromUrl(testAccountScope(), "https://example.test/plain.csv");
  expect(crossed).toBe(true);
  expect(result.tables.map(t => t.name)).toEqual(["plain"]); expect(listTables().map(t => t.name)).toEqual(["plain"]);
});

it.each(["support", "credentials", "blob"])("credentialed object %s preparation preserves memory identity", async stage => {
  vi.stubEnv("DEZFIL_OBJECT_STORE_CREDENTIALS", "1");
  vi.spyOn(remoteFetch, "openRemote").mockResolvedValue({ statusCode: 200, headers: {}, body: Readable.from([]), finalUrl: "https://example.test/file.geojson" } as unknown as remoteFetch.RemoteResponse);
  const run = DuckDBConnection.prototype.run;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
    remember();
    if (sql.includes("INSTALL httpfs") || sql.includes("CREATE SECRET")) {
      if ((stage === "support" && sql.includes("INSTALL")) || (stage === "credentials" && sql.includes("CREATE SECRET"))) throw new Error("Out of Memory Error: could not allocate block");
      return undefined as never;
    }
    return run.call(this, sql, ...args);
  });
  const read = vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockRejectedValue(new Error("Out of Memory Error: failed to offload data block: max_temp_directory_size limit"));
  await expect(importFromUrl(testAccountScope(), "s3://bucket/file.geojson")).rejects.toMatchObject({ code: "engine_memory_exceeded", status: 422 });
  if (stage !== "blob") expect(read).not.toHaveBeenCalled();
  expect(listTables()).toEqual([]); expect(await artifacts()).toEqual([]);
  expect(await readdir(path.join(dir, "tmp")).catch(() => [])).toEqual([]);
});

it("archive extraction is inside processing and expiry removes its prepared files", async () => {
  const file = path.join(dir, "points.kmz");
  await writeFile(file, buildZip([{ name: "doc.kml", data: Buffer.from(buildKml([{ name: "points", points: [[1, 2, "a"]] }])) }]));
  const original = archive.extractArchive;
  vi.spyOn(archive, "extractArchive").mockImplementation(async (...args) => {
    remember(); const value = await original(...args); expect(await readdir(args[1])).toEqual(["doc.kml"]); await vi.advanceTimersByTimeAsync(101); return value;
  });
  await expect(ingestSource(testAccountScope(), file, "points.kmz")).rejects.toMatchObject({ code: "data_processing_timeout" });
  expect(listTables()).toEqual([]); expect(await artifacts()).toEqual([]);
  const scratch = path.join(dir, "tmp");
  expect(await readdir(scratch).catch(() => [])).toEqual([]);
});

it("hands the reception snapshot to a fresh processing deadline despite a settings change and departure", async () => {
  const { receiveUpload } = await import("./receive");
  const { removeAccountFile } = await import("./file-ownership");
  const caller = new AbortController();
  let held!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('--handoff\r\nContent-Disposition: form-data; name="file"; filename="plain.csv"\r\n\r\nname,value\na,1\n'));
    held = controller;
  } });
  const receiving = receiveUpload(new Request("http://instance.test/api/tables", {
    method: "POST", headers: { "content-type": "multipart/form-data; boundary=handoff" }, body, signal: caller.signal,
    duplex: "half",
  } as RequestInit));
  await vi.advanceTimersByTimeAsync(80);
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(1);
  held.enqueue(new TextEncoder().encode("\r\n--handoff--\r\n")); held.close();
  const received = await receiving;
  expect(received.budget.dataProcessingTimeoutMs).toBe(100);
  caller.abort();
  const original = csv.requireCsvContent;
  vi.spyOn(csv, "requireCsvContent").mockImplementation(async (...args) => {
    const owner = remember(); expect(owner?.budgetMs).toBe(100); expect(owner?.deadline).toBe(180);
    await vi.advanceTimersByTimeAsync(50); return original(...args);
  });
  try {
    const result = await ingestSource(testAccountScope(), received.tmpPath, received.filename, undefined, undefined, received.budget, caller.signal);
    expect(result.tables).toHaveLength(1);
  } finally { await removeAccountFile(received.tmpPath); }
});
