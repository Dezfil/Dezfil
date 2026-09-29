import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { compileOperation } from "./compile";
import { ApiError } from "@/lib/api/errors";
import type { AccountScope } from "@/lib/auth/scope";

const provider = vi.hoisted(() => ({ geocode: vi.fn(), isochrone: vi.fn() }));
vi.mock("@/lib/geocode/provider", async original => ({ ...await original<typeof import("@/lib/geocode/provider")>(), geocodeAddress: provider.geocode }));
vi.mock("@/lib/isochrone/provider", async original => ({ ...await original<typeof import("@/lib/isochrone/provider")>(), askIsochrone: provider.isochrone }));
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string, scopes: Record<string, AccountScope>;
const context = () => ({ deadlineAt: Date.now() + 60_000, timeoutError: () => new ApiError("operation_timeout", "Timed out", 408) });
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "private-stage-"));
  process.env.DEZFIL_DATA_DIR = directory;
  vi.stubEnv("DEZFIL_GEOCODER_URL", "https://provider.example.test/search");
  vi.stubEnv("DEZFIL_ISOCHRONE_URL", "https://provider.example.test/isochrone");
  closeMetadataDb(); resetQueryInstance(); scopes = {};
  for (const owner of ["alice", "bob", "admin"]) {
    scopes[owner] = testAccountScope(undefined, owner);
    const addresses = path.join(directory, `${owner}-addresses.csv`), origins = path.join(directory, `${owner}-origins.csv`);
    await writeFile(addresses, `sentinel,address\n${owner},${owner}-first\n${owner},${owner}-second\n`);
    await writeFile(origins, `sentinel,lon,lat\n${owner},1,2\n`);
    await ingestFile(scopes[owner], addresses, "addresses.csv");
    await ingestFile(scopes[owner], origins, "origins.csv");
  }
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  provider.geocode.mockReset().mockResolvedValue({ outcome: "matched", lon: 1, lat: 2, display: "Found", attribution: "Fixture", source: "wire" });
  provider.isochrone.mockReset().mockResolvedValue({ bands: [{ minutes: 5, status: "answered", wkt: "POLYGON((0 0,0 1,1 1,0 0))" }], snappedLon: 1, snappedLat: 2, source: "wire" });
});
afterEach(async () => { vi.unstubAllEnvs(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = initialDir; await rm(directory, { recursive: true, force: true }); });
async function prepare(kind: string, scope = scopes.alice) {
  const compiled = await compileOperation(scope, kind, kind === "geocode_addresses"
    ? { input: "addresses", column: "address", name: "answer" }
    : { input: "origins", travel_mode: "walking", bands: [5], name: "answer" });
  return compiled.prepare!(context());
}
async function stageFiles() { return (await readdir(path.join(directory, "tables"))).filter(name => /^(geocode|isochrone)-stage-/.test(name)); }
it.each(["geocode_addresses", "isochrone"])("prepares %s using a private named input rather than file SQL", async kind => {
  const prepared = await prepare(kind);
  try {
    expect(prepared.sql).not.toMatch(/read_parquet|\.parquet|\/tables\//i);
    expect((prepared as typeof prepared & { inputs?: unknown[] }).inputs).toHaveLength(1);
    expect(await stageFiles()).toHaveLength(1);
  } finally { await prepared.cleanup(); }
  expect(await stageFiles()).toEqual([]);
});
it("stops provider preparation when the initiating account is deactivated", async () => {
  provider.geocode.mockImplementation(async () => {
    metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
    return { outcome: "matched", lon: 1, lat: 2, display: "Found", attribution: "Fixture", source: "wire" };
  });
  await expect(prepare("geocode_addresses")).rejects.toMatchObject({ code: "authentication_required" });
  expect(provider.geocode).toHaveBeenCalledTimes(1);
  expect(await stageFiles()).toEqual([]);
});

it.each(["geocode_addresses", "isochrone"])("materializes %s for each owner with only durable source lineage", async kind => {
  const { materialize } = await import("./materialize");
  const { executeQuery } = await import("@/lib/query/execute");
  const { scopedDatasets } = await import("@/lib/query/access");
  for (const owner of Object.keys(scopes)) {
    const scope = scopes[owner], prepared = await prepare(kind, scope);
    try {
      for (const actor of Object.values(scopes)) await expect(executeQuery(actor, `SELECT * FROM "${prepared.inputs![0].name}"`)).rejects.toMatchObject({ code: "sql_error" });
      const result = await materialize(scope, { name: "answer", operation: kind, sql: prepared.sql, inputs: prepared.inputs, disclosure: prepared.disclosure });
      expect((await executeQuery(scope, "SELECT DISTINCT sentinel FROM answer")).preview).toEqual([{ sentinel: owner }]);
      const source = scopedDatasets(scope).find(table => table.name === (kind === "geocode_addresses" ? "addresses" : "origins"))!;
      expect(result.sourceParams).toMatchObject({ inputs: [{ id: source.id, name: source.name }] });
      expect(result.sourceParams).not.toHaveProperty("sql");
      expect(JSON.stringify(result.sourceParams)).not.toMatch(/__stage_|\.parquet|\/tables\//);
    } finally { await prepared.cleanup(); }
    expect(await stageFiles()).toEqual([]);
  }
});
it("refuses another owner, forged copies and publications before acquiring a connection", async () => {
  const { boundedEvaluation } = await import("@/lib/query/bounded");
  const { createMap } = await import("@/lib/map-service");
  const { publishMap } = await import("@/lib/publish/publish-service");
  const { resolvePublication } = await import("@/lib/publish/publication-scope");
  const engine = await import("@/lib/duckdb");
  const prepared = await prepare("geocode_addresses"), input = prepared.inputs![0];
  const map = createMap(scopes.alice, "Publication"), publication = resolvePublication(publishMap(scopes.alice, map.id).token)!.scope;
  const connect = vi.spyOn(engine, "connectQueryInstance"), callback = vi.fn();
  try {
    for (const owner of [scopes.bob, scopes.admin]) await expect(boundedEvaluation(callback, { scope: owner, inputs: [input] })).rejects.toMatchObject({ code: "not_found" });
    await expect(boundedEvaluation(callback, { scope: scopes.alice, inputs: [JSON.parse(JSON.stringify(input))] })).rejects.toMatchObject({ code: "not_found" });
    await expect(boundedEvaluation(callback, { scope: publication, inputs: [input] })).rejects.toMatchObject({ code: "authentication_required" });
    expect(connect).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); await prepared.cleanup(); }
});
it("ignores fabricated staging fields on the public SQL operation", async () => {
  const { POST } = await import("@/app/api/query/route");
  const { testAccountRequest } = await import("@/lib/test-support/accounts");
  const prepared = await prepare("geocode_addresses");
  try {
    const response = await POST(testAccountRequest(new Request("http://instance.test/api/query", { method: "POST", body: JSON.stringify({
      sql: `SELECT * FROM "${prepared.inputs![0].name}"`, inputs: prepared.inputs, trusted: true,
    }) }), undefined, "alice"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "sql_error" } });
  } finally { await prepared.cleanup(); }
});
it("invalidates an admitted staging read immediately and defers unlink until it releases", async () => {
  const { boundedEvaluation } = await import("@/lib/query/bounded");
  const prepared = await prepare("geocode_addresses"), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const pending = boundedEvaluation(async conn => {
    entered.resolve(); await release.promise;
    return (await conn.runAndReadAll(`SELECT count(*) FROM "${prepared.inputs![0].name}"`)).getRowObjects();
  }, { scope: scopes.alice, inputs: prepared.inputs });
  await entered.promise;
  const cleanup = prepared.cleanup();
  expect(await stageFiles()).toHaveLength(1);
  release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "not_found" });
  await cleanup; expect(await stageFiles()).toEqual([]);
  await expect(boundedEvaluation(async () => true, { scope: scopes.alice, inputs: prepared.inputs })).rejects.toMatchObject({ code: "not_found" });
});
it.each(["cancel", "timeout", "failure"])("cleans staging and partial output after %s", async outcome => {
  const { materialize } = await import("./materialize");
  const { EvaluationCancelled } = await import("@/lib/query/bounded");
  const prepared = await prepare("geocode_addresses"), caller = new AbortController();
  if (outcome === "cancel") caller.abort();
  try {
    const sql = outcome === "timeout"
      ? `SELECT count(*) AS n FROM "${prepared.inputs![0].name}", range(4000000000) r WHERE r.range % 7 = 3`
      : outcome === "failure" ? `SELECT missing_column FROM (${prepared.sql})` : prepared.sql;
    const pending = materialize(scopes.alice, { name: "answer", operation: "geocode_addresses", sql, inputs: prepared.inputs,
      signal: caller.signal, ...(outcome === "timeout" ? { budgetMs: 30, timeoutError: context().timeoutError } : {}) });
    if (outcome === "cancel") await expect(pending).rejects.toBeInstanceOf(EvaluationCancelled);
    else await expect(pending).rejects.toMatchObject({ code: outcome === "timeout" ? "operation_timeout" : "sql_error" });
  } finally { await prepared.cleanup(); }
  expect(await stageFiles()).toEqual([]);
  expect(metadataDb().prepare("SELECT id FROM data_tables WHERE name = 'answer'").all()).toEqual([]);
});
it.each(["geocode_addresses", "isochrone"])("the real job executor passes %s inputs and performs final cleanup", async operation => {
  const { startRun } = await import("./run"), { jobSettled } = await import("./lane");
  const { requireJob } = await import("@/lib/metadata/owned-jobs");
  const job = await startRun(scopes.alice, { operation, parameters: operation === "geocode_addresses"
    ? { input: "addresses", column: "address", name: "answer" }
    : { input: "origins", travel_mode: "walking", bands: [5], name: "answer" } });
  await jobSettled(job.id);
  expect(requireJob(scopes.alice, job.id)).toMatchObject({ state: "succeeded", outputName: "answer" });
  expect(await stageFiles()).toEqual([]);
});
it("removes a partially written stage when preparation fails", async () => {
  const { prepareStagingInput } = await import("@/lib/query/staging");
  await expect(prepareStagingInput(scopes.alice, "geocode", async file => {
    await writeFile(file, "partial"); throw new Error("writer failed");
  })).rejects.toThrow("writer failed");
  expect(await stageFiles()).toEqual([]);
});

it("releases the staging lease when an evaluation is cancelled after mounting", async () => {
  const { boundedEvaluation, EvaluationCancelled } = await import("@/lib/query/bounded");
  const prepared = await prepare("geocode_addresses"), caller = new AbortController(), entered = Promise.withResolvers<void>();
  const pending = boundedEvaluation(async conn => {
    entered.resolve();
    return conn.runAndReadAll(`SELECT count(*) FROM "${prepared.inputs![0].name}", range(4000000000) r WHERE r.range % 7 = 3`);
  }, { scope: scopes.alice, inputs: prepared.inputs, signal: caller.signal });
  await entered.promise; caller.abort();
  await expect(pending).rejects.toBeInstanceOf(EvaluationCancelled);
  await prepared.cleanup(); expect(await stageFiles()).toEqual([]);
});
it("keeps an abandoned mounting pass's file until the connection drains", async () => {
  const { boundedEvaluation, EvaluationCancelled } = await import("@/lib/query/bounded");
  const { DuckDBConnection } = await import("@duckdb/node-api");
  const prepared = await prepare("geocode_addresses"), caller = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = DuckDBConnection.prototype.run;
  const spy = vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: InstanceType<typeof DuckDBConnection>, ...args) {
    if (String(args[0]).startsWith("CREATE TEMP VIEW") && String(args[0]).includes(prepared.inputs![0].name)) {
      entered.resolve(); await release.promise;
    }
    return original.apply(this, args);
  });
  const pending = boundedEvaluation(async () => true, { scope: scopes.alice, inputs: prepared.inputs, signal: caller.signal });
  try {
    await entered.promise; caller.abort();
    await expect(pending).rejects.toBeInstanceOf(EvaluationCancelled);
    let cleaned = false;
    const cleanup = prepared.cleanup().then(() => { cleaned = true; });
    expect(await stageFiles()).toHaveLength(1); expect(cleaned).toBe(false);
    release.resolve(); await cleanup;
    expect(await stageFiles()).toEqual([]);
  } finally { release.resolve(); await pending.catch(() => {}); await prepared.cleanup(); spy.mockRestore(); }
});
