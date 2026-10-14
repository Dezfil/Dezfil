import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { limits } from "@/lib/limits";
import { EvaluationCancelled } from "@/lib/api/errors";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb } from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { getTableByName, listTables } from "@/lib/metadata/tables";
import { createMap } from "@/lib/map-service";
import { retirementsSettled } from "@/lib/ingest/retire";
import * as ingest from "@/lib/ingest/ingest";
import * as reader from "./read";
import { createSketch, appendFeature, deleteFeature, moveVertex, cascadeDeleteSketch, serializeSketchMutation } from "./store";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";
const point = { kind: "point", geometry: { type: "Point", coordinates: [1, 2] } };
const polygon = { kind: "polygon", geometry: { type: "Polygon", coordinates: [[[1,1],[2,1],[2,2],[1,1]]] } };
let dir: string;
const owners = new Set<NonNullable<ReturnType<typeof currentTrustedOperation>>>();
function remember() { const op = currentTrustedOperation(); if (op) owners.add(op); return op; }
const revision = (id: string) => readDocumentRevision({ kind: "map", id })?.editRevision;
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(async () => {
  dir = await mkdtemp(path.join(scratchRoot, "sketch-case-")); vi.stubEnv("DEZFIL_DATA_DIR", dir); closeMetadataDb();
  vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(100); vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(200);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => { await Promise.all([...owners].map(o => o.drained)); owners.clear(); await retirementsSettled(); vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
async function seed() { const map = createMap(testAccountScope(), "Drawing"); const sketch = await createSketch(testAccountScope(), map.id, polygon, { expectedRevision: revision(map.id) }); return { map, ...sketch }; }
it.each(["deadline", "departure"])("feature read stops on %s with its refusal intact", async reason => {
  const { table } = await seed(), held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), caller = new AbortController();
  const original = DuckDBConnection.prototype.runAndReadAll;
  vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(async function (this: DuckDBConnection, sql, ...args) { remember(); entered.resolve(); await held.promise; return original.call(this, sql, ...args); });
  const work = (reader.listFeatures as (...args: unknown[]) => ReturnType<typeof reader.listFeatures>)(testAccountScope(), table.name, caller.signal).catch(e => e);
  await entered.promise; if (reason === "departure") caller.abort(); else await vi.advanceTimersByTimeAsync(101); held.resolve();
  if (reason === "departure") expect(await work).toBeInstanceOf(EvaluationCancelled); else expect(await work).toMatchObject({ code: "query_timeout" });
});
it("map summaries share the original query deadline across sketches", async () => {
  const { map } = await seed(); await createSketch(testAccountScope(), map.id, point, { expectedRevision: revision(map.id) });
  const original = DuckDBConnection.prototype.runAndReadAll;
  vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(async function (this: DuckDBConnection, sql, ...args) { remember(); const value = await original.call(this, sql, ...args); if (sql.includes("GROUP BY kind")) await vi.advanceTimersByTimeAsync(60); return value; });
  await expect(reader.mapSketches(testAccountScope(), map.id)).rejects.toMatchObject({ code: "query_timeout" });
});
it("an expired queued change settles without bypassing its predecessor", async () => {
  const { table } = await seed(), held = Promise.withResolvers<void>(); const predecessor = serializeSketchMutation(table.id, () => held.promise);
  let finished = false;
  const expired = appendFeature(testAccountScope(), table.name, point).then(v => { finished = true; return v; }, e => { finished = true; return e; });
  await flush(); await vi.advanceTimersByTimeAsync(201); await flush(); const settledWhileQueued = finished;
  let successorFinished = false; const successor = appendFeature(testAccountScope(), table.name, point).then(v => { successorFinished = true; return v; });
  await flush(); const bypassed = successorFinished;
  held.resolve(); await predecessor; const refusal = await expired; await successor;
  expect(settledWhileQueued).toBe(true); expect(bypassed).toBe(false); expect(refusal).toMatchObject({ code: "data_processing_timeout" }); expect(getTableByName(table.name)?.rowCount).toBe(2);
});
it("an accepted queued cascade expires before deleting anything", async () => {
  const { table } = await seed(), held = Promise.withResolvers<void>(); const predecessor = serializeSketchMutation(table.id, () => held.promise);
  const work = cascadeDeleteSketch(testAccountScope(), table.name).catch(e => e); await flush(); await vi.advanceTimersByTimeAsync(201); held.resolve(); await predecessor;
  expect(await work).toMatchObject({ code: "data_processing_timeout" }); expect(getTableByName(table.name)?.file).toBe(table.file);
});
it.each(["create", "append", "delete", "move"])("%s refuses expiry immediately before its artifact commit", async kind => {
  const { table, map, featureId } = await seed(), original = ingest.measureArtifact;
  vi.spyOn(ingest, "measureArtifact").mockImplementation(async (...args) => { remember(); const result = await original(...args); await vi.advanceTimersByTimeAsync(201); return result; });
  const work = kind === "create" ? createSketch(testAccountScope(), map.id, point, { expectedRevision: revision(map.id) }) : kind === "append" ? appendFeature(testAccountScope(), table.name, point) : kind === "delete" ? deleteFeature(testAccountScope(), table.name, featureId) : moveVertex(testAccountScope(), table.name, featureId, 1, [2.1, 1]);
  await expect(work).rejects.toMatchObject({ code: "data_processing_timeout" }); expect(listTables().map(t => t.file)).toEqual([table.file]); expect(await readdir(path.join(dir, "tables"))).toEqual([path.basename(table.file)]);
});
it("mutation reads inherit processing after departure and beyond the query budget", async () => {
  const { table } = await seed(), caller = new AbortController(), original = reader.readFeatures; let policy: string | undefined;
  vi.spyOn(reader, "readFeatures").mockImplementation(async (...args) => { policy = remember()?.kind; caller.abort(); await vi.advanceTimersByTimeAsync(101); return original(...args); });
  await (appendFeature as (...args: unknown[]) => ReturnType<typeof appendFeature>)(testAccountScope(), table.name, point, caller.signal);
  expect(policy).toBe("sketch-change"); expect(getTableByName(table.name)?.rowCount).toBe(2);
});
it("native memory after writing a new sketch leaves no candidate or metadata", async () => {
  const map = createMap(testAccountScope(), "Drawing"), original = DuckDBConnection.prototype.runAndReadAll;
  vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(async function (this: DuckDBConnection, sql, ...args) { remember(); const result = await original.call(this, sql, ...args); if (sql.trim().startsWith("COPY")) throw new Error("Out of Memory Error: could not allocate block"); return result; });
  await expect(createSketch(testAccountScope(), map.id, point, { expectedRevision: revision(map.id) })).rejects.toMatchObject({ code: "engine_memory_exceeded" }); expect(listTables()).toEqual([]); expect(await readdir(path.join(dir, "tables"))).toEqual([]);
});
