import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { DuckDBConnection } from "@duckdb/node-api";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb } from "@/lib/metadata/db";
import { listTables } from "@/lib/metadata/tables";
import { limits } from "@/lib/limits";
import { currentTrustedOperation, TrustedSettlementOverdue } from "@/lib/trusted-operation";
import { drainAccountWork } from "@/lib/auth/account-deletion-admission";
import * as engine from "@/lib/duckdb";
import * as remoteFetch from "@/lib/net/remote-fetch";
import * as ingest from "./ingest";
import * as ownership from "./file-ownership";
import * as csv from "./csv-content";
import { ingestSource } from "./gdal-formats";
import { importFromUrl } from "./remote";
import { refreshTable } from "./refresh";
import * as archive from "./container";
import { POST as upload } from "@/app/api/tables/route";
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

it("a committed link import answers its success when removing its download fails, logs it once, and a retry adds no second dataset", async () => {
  serveCsv();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const original = ownership.removeAccountFile;
  vi.spyOn(ownership, "removeAccountFile").mockImplementation(async (file, options) => {
    // Removing the downloaded source fails once the dataset is registered.
    if (listTables().length > 0 && String(file).includes(`${path.sep}tmp${path.sep}`)) throw new Error("EBUSY: the downloaded source could not be removed");
    return original(file, options);
  });
  const url = "https://example.test/plain.csv";
  const first = await importFromUrl(testAccountScope(), url).then(value => ({ value }), error => ({ error }));
  // A client retries a link import whose answer was an error.
  if ("error" in first) await importFromUrl(testAccountScope(), url).catch(() => undefined);
  expect(first).toMatchObject({ value: { tables: [{ name: "plain" }] } });
  expect(warn).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith("Trusted import cleanup failed after its commit",
    expect.objectContaining({ errors: [expect.objectContaining({ message: expect.stringContaining("EBUSY") })] }));
  expect(listTables().filter(t => t.sourceParams?.url === url)).toHaveLength(1);
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

const kmz = () => buildZip([{ name: "doc.kml", data: Buffer.from(buildKml([{ name: "points", points: [[1, 2, "a"]] }])) }]);
function serveKmz(bytes: Buffer) {
  vi.spyOn(remoteFetch, "openRemote").mockImplementation(async () =>
    ({ statusCode: 200, headers: {}, finalUrl: "https://example.test/points.kmz", body: Readable.from([bytes]) }) as unknown as remoteFetch.RemoteResponse);
}
type Removal = Parameters<typeof ownership.removeAccountFile>[1];
/** Holds the first removal that matches, until released. */
function holdRemoval(matches: (file: string, options: Removal) => boolean) {
  const reached = Promise.withResolvers<string>(), release = Promise.withResolvers<void>();
  const original = ownership.removeAccountFile;
  let held = false, removed = false;
  vi.spyOn(ownership, "removeAccountFile").mockImplementation(async (file, options) => {
    if (held || !matches(String(file), options)) return original(file, options);
    held = true; reached.resolve(String(file)); await release.promise;
    const value = await original(file, options); removed = true; return value;
  });
  return { reached: reached.promise, release: () => release.resolve(), removed: () => removed };
}
/** Holds the first removal of an extraction folder that starts once the work
 * has committed, until released. */
const holdExtractionRemoval = (committed: () => boolean) => holdRemoval((_file, options) => !!options?.recursive && committed());
/** An upload's received file: a plain file directly in the scratch folder. */
const receivedFile = (file: string, options: Removal) => !options?.recursive && path.dirname(file) === path.join(dir, "tmp");
function uploadRequest(bytes: string | Uint8Array, filename: string) {
  const form = new FormData(); form.set("file", new File([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], filename));
  return testAccountRequest(new Request("http://instance.test/api/tables", { method: "POST", body: form }));
}
/** The operation that reads a delimited file's content, the root of the work. */
function rememberContentRead() {
  const original = csv.requireCsvContent;
  const read: ReturnType<typeof remember>[] = [];
  vi.spyOn(csv, "requireCsvContent").mockImplementation(async (...args) => { read.push(remember()); return original(...args); });
  return read;
}
/** The operation that prepares the archive, the root of the work. */
function rememberPreparation() {
  const original = archive.extractArchive;
  const prepared: ReturnType<typeof remember>[] = [];
  vi.spyOn(archive, "extractArchive").mockImplementation(async (...args) => { prepared.push(remember()); return original(...args); });
  return prepared;
}

it.each(["upload", "link"] as const)("a committed spatial import (%s) answers at the settlement allowance while its extraction folder's removal is held, logs that once and drains after the release", async road => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const bytes = kmz(), file = path.join(dir, "points.kmz"); await writeFile(file, bytes);
  if (road === "link") serveKmz(bytes);
  const prepared = rememberPreparation();
  const removal = holdExtractionRemoval(() => listTables().length > 0);
  const scope = testAccountScope();
  let answer: { value?: Awaited<ReturnType<typeof ingestSource>>; error?: unknown } | undefined;
  void (road === "upload" ? ingestSource(scope, file, "points.kmz") : importFromUrl(scope, "https://example.test/points.kmz"))
    .then(value => { answer = { value }; }, error => { answer = { error }; });
  const folder = await removal.reached;
  const operation = prepared[0]!;
  let drained = false; void operation.drained.then(() => { drained = true; });
  let accountReleased = false; void drainAccountWork(scope.accountId!).then(() => { accountReleased = true; });
  try {
    await vi.advanceTimersByTimeAsync(34_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // Answered at the allowance, while the removal is still held.
    expect(answer).toEqual({ value: expect.objectContaining({ tables: [expect.objectContaining({ id: listTables()[0]?.id })] }) });
    expect(listTables()).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("Trusted import cleanup overdue after its commit", expect.any(TrustedSettlementOverdue));
    expect(drained).toBe(false); expect(removal.removed()).toBe(false);
    // Either road keeps the account's work until the removal has run.
    expect(accountReleased).toBe(false);
  } finally { removal.release(); }
  await operation.drained;
  expect(removal.removed()).toBe(true); expect(existsSync(folder)).toBe(false);
  await drainAccountWork(scope.accountId!);
  expect(warn).toHaveBeenCalledOnce();
});

it("a committed spatial refresh answers at the settlement allowance while its extraction folder's removal is held, keeps the account's work until it ran, logs that once and drains after the release", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  serveKmz(kmz());
  const scope = testAccountScope();
  const [table] = (await importFromUrl(scope, "https://example.test/points.kmz")).tables;
  await Promise.all([...owners].map(o => o.drained));
  const prepared = rememberPreparation();
  const removal = holdExtractionRemoval(() => listTables()[0]?.file !== table.file);
  let answer: { value?: Awaited<ReturnType<typeof refreshTable>>; error?: unknown } | undefined;
  void refreshTable(scope, table.name).then(value => { answer = { value }; }, error => { answer = { error }; });
  const folder = await removal.reached;
  const operation = prepared[0]!;
  let drained = false; void operation.drained.then(() => { drained = true; });
  let accountReleased = false; void drainAccountWork(scope.accountId!).then(() => { accountReleased = true; });
  try {
    await vi.advanceTimersByTimeAsync(34_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // Answered at the allowance, while the removal is still held.
    expect(answer).toEqual({ value: expect.objectContaining({ id: table.id, file: listTables()[0].file }) });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("Trusted refresh cleanup overdue after its commit", expect.any(TrustedSettlementOverdue));
    expect(drained).toBe(false); expect(removal.removed()).toBe(false);
    // The account's work is held until the removal has run.
    expect(accountReleased).toBe(false);
  } finally { removal.release(); }
  await operation.drained;
  expect(removal.removed()).toBe(true); expect(existsSync(folder)).toBe(false);
  await drainAccountWork(scope.accountId!);
  expect(warn).toHaveBeenCalledOnce();
});

it.each(["import", "refresh"] as const)("a spatial %s whose extraction folder cannot be removed after its commit answers its success and logs the failure once", async kind => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const bytes = kmz(), file = path.join(dir, "points.kmz"); await writeFile(file, bytes);
  serveKmz(bytes);
  const scope = testAccountScope();
  const previous = kind === "refresh" ? (await importFromUrl(scope, "https://example.test/points.kmz")).tables[0] : undefined;
  const original = ownership.removeAccountFile;
  const committed = () => previous ? listTables()[0]?.file !== previous.file : listTables().length > 0;
  vi.spyOn(ownership, "removeAccountFile").mockImplementation(async (target, options) => {
    if (options?.recursive && committed()) throw new Error("EBUSY: the extraction folder could not be removed");
    return original(target, options);
  });
  const result = kind === "import" ? (await ingestSource(scope, file, "points.kmz")).tables[0] : await refreshTable(scope, previous!.name);
  expect(result).toMatchObject({ id: listTables().at(-1)!.id });
  expect(warn).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith(`Trusted ${kind} cleanup failed after its commit`,
    expect.objectContaining({ errors: [expect.objectContaining({ message: expect.stringContaining("EBUSY") })] }));
});

it("a committed upload answers 201 when removing its received file fails, logs that once, and a retry adds no second dataset", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rememberContentRead();
  const original = ownership.removeAccountFile;
  vi.spyOn(ownership, "removeAccountFile").mockImplementation(async (file, options) => {
    // Removing the received file fails once the dataset is registered.
    if (listTables().length > 0 && receivedFile(String(file), options)) throw new Error("EBUSY: the received file could not be removed");
    return original(file, options);
  });
  const first = await upload(uploadRequest("name,value\na,1\n", "plain.csv"));
  // A client retries an upload whose answer was an error.
  if (first.status !== 201) await upload(uploadRequest("name,value\na,1\n", "plain.csv"));
  expect(first.status).toBe(201);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith("Trusted import cleanup failed after its commit",
    expect.objectContaining({ errors: [expect.objectContaining({ message: expect.stringContaining("EBUSY") })] }));
  expect(listTables()).toHaveLength(1);
});

it("a committed upload answers 201 at the settlement allowance while its received file's removal is held, logs that once and drains after the release", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const read = rememberContentRead();
  const removal = holdRemoval((file, options) => receivedFile(file, options) && listTables().length > 0);
  let answer: Response | undefined;
  void upload(uploadRequest("name,value\na,1\n", "plain.csv")).then(response => { answer = response; });
  const file = await removal.reached;
  const operation = read[0]!;
  let drained = false; void operation.drained.then(() => { drained = true; });
  try {
    await vi.advanceTimersByTimeAsync(34_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // Answered at the allowance, while the removal is still held.
    expect(answer?.status).toBe(201);
    expect(listTables()).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("Trusted import cleanup overdue after its commit", expect.any(TrustedSettlementOverdue));
    expect(drained).toBe(false); expect(removal.removed()).toBe(false);
  } finally { removal.release(); }
  await operation.drained;
  expect(removal.removed()).toBe(true); expect(existsSync(file)).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
});

it("a spatial upload keeps the account's work until its received file and its extraction folder are removed", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const prepared = rememberPreparation();
  const removal = holdRemoval((file, options) => receivedFile(file, options) && listTables().length > 0);
  const scope = testAccountScope();
  let answer: Response | undefined;
  void upload(uploadRequest(kmz(), "points.kmz")).then(response => { answer = response; });
  const file = await removal.reached;
  const operation = prepared[0]!;
  // An account deletion starts draining the account's work now.
  let accountReleased = false; void drainAccountWork(scope.accountId!).then(() => { accountReleased = true; });
  try {
    await vi.advanceTimersByTimeAsync(35_000);
    expect(answer?.status).toBe(201);
    expect(accountReleased).toBe(false);
  } finally { removal.release(); }
  await operation.drained;
  expect(removal.removed()).toBe(true); expect(existsSync(file)).toBe(false);
  expect(await readdir(path.join(dir, "tmp"))).toEqual([]);
  await drainAccountWork(scope.accountId!);
  expect(accountReleased).toBe(true);
});
