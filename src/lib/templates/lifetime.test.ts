import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import * as files from "node:fs/promises";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { resetQueryInstance } from "@/lib/duckdb";
import { limits } from "@/lib/limits";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { buildTemplate, writeShippedFolder, type BuiltTemplate } from "../../../test-support/templates/builder";
import * as catalogue from "./catalogue";
import * as installation from "./install";
import * as bindings from "./bindings";
import * as layerGeometry from "@/lib/layer-geometry";
import { fetchTemplate, inDownloadTurn, setDownloadSeamForTests } from "./download";
import { downloadedTemplatesDir } from "./installed";
import { checkShippedSet } from "./shipped";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";
let fixtureDir: string, dir: string, template: BuiltTemplate;
const owners = new Set<NonNullable<ReturnType<typeof currentTrustedOperation>>>();
function remember() { const op = currentTrustedOperation(); if (op) owners.add(op); return op; }
beforeAll(async () => { fixtureDir = await mkdtemp(path.join(scratchRoot, "template-fixtures-")); template = await buildTemplate(fixtureDir); });
afterAll(async () => { await rm(fixtureDir, { recursive: true, force: true }); });
beforeEach(async () => {
  resetQueryInstance();
  dir = await mkdtemp(path.join(scratchRoot, "template-case-")); vi.stubEnv("DEZFIL_DATA_DIR", dir); closeMetadataDb(); testAccountScope();
  vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(200); vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(5_000);
  vi.spyOn(catalogue, "fetchTarget").mockImplementation(async () => { remember(); return { kind: "listed", entry: { facts: template.facts, archive: template.archive, size: template.size, sha256: template.sha256, picture: { state: "not_kept" } }, where: { kind: "folder", folder: fixtureDir, source: "environment" } } as catalogue.FetchTarget; });
  vi.spyOn(catalogue, "downloadedSize").mockResolvedValue(null); vi.spyOn(catalogue, "requireCatalogueAt").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => { setDownloadSeamForTests(null); await Promise.all([...owners].map(o => o.drained)); owners.clear(); vi.useRealTimers(); vi.restoreAllMocks(); resetQueryInstance(); closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const fetch = (signal?: AbortSignal) => (fetchTemplate as (...args: unknown[]) => ReturnType<typeof fetchTemplate>)(testAccountScope(), template.facts.id, 1, metadataDb(), signal);
const flush = () => vi.advanceTimersByTimeAsync(0);
const installedFiles = () => readdir(downloadedTemplatesDir(), { recursive: true }).catch(() => []);
async function install() { const scratch = path.join(dir, "scratch"); await mkdir(scratch); return installation.installTemplateArchive(testAccountScope(), scratch, template.archive, { id: template.facts.id, version: template.facts.version, size: template.size, sha256: template.sha256 }, { kind: "folder" }); }
it("target preparation consumes the installation deadline before queue admission", async () => {
  const original = vi.mocked(catalogue.fetchTarget).getMockImplementation()!;
  vi.mocked(catalogue.fetchTarget).mockImplementation(async (...args) => { const value = await original(...args); await vi.advanceTimersByTimeAsync(201); return value; });
  const called = vi.spyOn(installation, "installTemplateArchive");
  await expect(fetch()).rejects.toMatchObject({ code: "data_processing_timeout" }); expect(called).not.toHaveBeenCalled(); expect(await installedFiles()).toEqual([]);
});
it("shared downloads survive departure and retain their original deadline", async () => {
  const held = Promise.withResolvers<void>(), atTurn = Promise.withResolvers<void>(), caller = new AbortController(); let turns = 0, policy: string | undefined;
  setDownloadSeamForTests({ transfer: async () => { policy = remember()?.kind; turns++; atTurn.resolve(); await held.promise; } });
  const first = fetch(caller.signal).catch(e => e); await atTurn.promise; await vi.advanceTimersByTimeAsync(80);
  const second = fetch().catch(e => e); await flush(); caller.abort(); await flush(); const stillActive = [...owners].every(o => !o.signal.aborted);
  await vi.advanceTimersByTimeAsync(121); held.resolve(); const results = await Promise.all([first, second]);
  expect(policy).toBe("template-install"); expect(stillActive).toBe(true); expect(turns).toBe(1); for (const result of results) expect(result).toMatchObject({ code: "data_processing_timeout" }); expect(await installedFiles()).toEqual([]);
});
it("a queued installation expires without starting a transfer", async () => {
  const held = Promise.withResolvers<void>(), previous = inDownloadTurn(() => held.promise); let transfers = 0, finished = false;
  setDownloadSeamForTests({ transfer: () => { remember(); transfers++; } });
  const work = fetch().then(v => { finished = true; return v; }, e => { finished = true; return e; });
  await flush(); await vi.advanceTimersByTimeAsync(201); await flush(); const settledWhileQueued = finished;
  held.resolve(); await previous; const result = await work;
  expect(settledWhileQueued).toBe(true); expect(result).toMatchObject({ code: "data_processing_timeout" }); expect(transfers).toBe(0); expect(await installedFiles()).toEqual([]);
});
it("an accepted installation completes after caller departure", async () => {
  const caller = new AbortController(); let policy: string | undefined;
  setDownloadSeamForTests({ transfer: () => { const op = remember(); policy = op?.kind; caller.abort(); expect(op?.signal.aborted).toBe(false); } });
  expect(await fetch(caller.signal)).toMatchObject({ downloaded: true }); expect(policy).toBe("template-install"); expect(await installedFiles()).not.toEqual([]);
});
it("expiry after validation refuses the final folder replacement", async () => {
  const original = bindings.admitTemplateBindings;
  vi.spyOn(bindings, "admitTemplateBindings").mockImplementation(async (...args) => { remember(); await original(...args); await vi.advanceTimersByTimeAsync(201); });
  await expect(install()).rejects.toMatchObject({ code: "data_processing_timeout" }); expect(await installedFiles()).toEqual([]);
});
it("native dataset memory refusal survives the template reader", async () => {
  const original = DuckDBConnection.prototype.run;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) { remember(); if (sql.startsWith("COPY") && sql.includes("/version/")) throw new Error("Out of Memory Error: could not allocate block"); return original.call(this, sql, ...args); });
  await expect(install()).rejects.toMatchObject({ code: "engine_memory_exceeded", status: 422 }); expect(await installedFiles()).toEqual([]);
});
it("hardened validation retains its own memory refusal", async () => {
  const refusal = new ApiError("query_memory_exceeded", "Hardened memory", 400); vi.spyOn(layerGeometry, "inspectLayerGeometry").mockRejectedValue(refusal);
  await expect(install()).rejects.toBe(refusal); expect(await installedFiles()).toEqual([]);
});
it("processing expiry stops hardened validation with the processing refusal", async () => {
  let stopped = false;
  vi.spyOn(layerGeometry, "inspectLayerGeometry").mockImplementation(async (_scope, _sql, signal) => { remember(); await vi.advanceTimersByTimeAsync(201); stopped = signal?.aborted ?? false; throw new EvaluationCancelled(); });
  await expect(install()).rejects.toMatchObject({ code: "data_processing_timeout" }); expect(stopped).toBe(true); expect(await installedFiles()).toEqual([]);
});
it("the shipped-set check preserves a hardened resource refusal", async () => {
  const shipped = await writeShippedFolder(path.join(dir, "shipped"), [template]);
  const refusal = new ApiError("query_memory_exceeded", "Hardened memory", 400); vi.spyOn(layerGeometry, "inspectLayerGeometry").mockRejectedValue(refusal);
  await expect(checkShippedSet(testAccountScope(), shipped)).rejects.toBe(refusal);
});

it("expiry while preparing the destination leaves no installed folder", async () => {
  const original = files.mkdir;
  vi.spyOn(files, "mkdir").mockImplementation(async (...args: Parameters<typeof files.mkdir>) => {
    const result = await original(...args);
    if (String(args[0]) === path.join(downloadedTemplatesDir(), template.facts.id)) await vi.advanceTimersByTimeAsync(201);
    return result;
  });
  await expect(install()).rejects.toMatchObject({ code: "data_processing_timeout" });
  expect(await installedFiles()).toEqual([]);
});
