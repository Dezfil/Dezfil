import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { limits } from "@/lib/limits";
import { currentTrustedOperation } from "@/lib/trusted-operation";
import { testAccountScope } from "@/lib/test-support/accounts";
import { stored } from "@/lib/test-support/geometry";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getTableByName } from "@/lib/metadata/tables";
import { retirementsSettled } from "@/lib/ingest/retire";
import { resetRefreshFences } from "@/lib/ingest/fence";
import * as ingest from "@/lib/ingest/ingest";
import * as builder from "./build";
import { geometryRevision } from "./read";
import { setGeometry } from "./mutate";
import { clearGeometry } from "./clear";

const scratchRoot = process.env.DEZFIL_DATA_DIR ?? "/tmp";
const choice = { format: "wkt", columns: ["payload"] };
let dir: string;
const owners = new Set<NonNullable<ReturnType<typeof currentTrustedOperation>>>();
function remember() { const op = currentTrustedOperation(); if (op) owners.add(op); return op; }
beforeEach(async () => {
  dir = await mkdtemp(path.join(scratchRoot, "geometry-case-")); vi.stubEnv("DEZFIL_DATA_DIR", dir); await mkdir(path.join(dir, "tables")); closeMetadataDb(); resetRefreshFences();
  vi.spyOn(limits, "queryTimeoutMs", "get").mockReturnValue(100); vi.spyOn(limits, "dataProcessingTimeoutMs", "get").mockReturnValue(200);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => { await Promise.all([...owners].map(o => o.drained)); owners.clear(); await retirementsSettled(); vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); resetRefreshFences(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
async function base(kind: string) {
  const raw = await stored("SELECT 'POINT (10 20)' payload");
  const table = kind === "set" ? raw : (await setGeometry(testAccountScope(), raw.name, geometryRevision(raw), choice)).table;
  await retirementsSettled(); return table;
}
function afterBuild(kind: string, callback: () => Promise<void>) {
  if (kind === "set") {
    const original = builder.buildGeometryArtifact;
    vi.spyOn(builder, "buildGeometryArtifact").mockImplementation(async (...args) => { remember(); const value = await original(...args); await callback(); return value; });
  } else {
    const original = ingest.measureArtifact;
    vi.spyOn(ingest, "measureArtifact").mockImplementation(async (...args) => { remember(); const value = await original(...args); await callback(); return value; });
  }
}
const change = (kind: string, table: Awaited<ReturnType<typeof base>>, signal?: AbortSignal) => kind === "set"
  ? (setGeometry as (...args: unknown[]) => ReturnType<typeof setGeometry>)(testAccountScope(), table.name, geometryRevision(table), choice, signal)
  : (clearGeometry as (...args: unknown[]) => ReturnType<typeof clearGeometry>)(testAccountScope(), table.name, geometryRevision(table), signal);
it.each(["set", "clear"])("%s expiry immediately before replacement retains the committed artifact", async kind => {
  const table = await base(kind); afterBuild(kind, async () => { await vi.advanceTimersByTimeAsync(201); });
  await expect(change(kind, table)).rejects.toMatchObject({ code: "data_processing_timeout", status: 408 });
  expect(getTableByName(table.name)?.file).toBe(table.file); expect(await readdir(path.join(dir, "tables"))).toEqual([path.basename(table.file)]);
});
it.each(["set", "clear"])("accepted %s survives departure beyond the query budget", async kind => {
  const table = await base(kind), caller = new AbortController(); let policy: string | undefined;
  afterBuild(kind, async () => { policy = remember()?.kind; caller.abort(); await vi.advanceTimersByTimeAsync(101); });
  const result = await change(kind, table, caller.signal);
  expect(policy).toBe("geometry-change"); expect(result.table.file).not.toBe(table.file);
});
it.each(["set", "clear"])("%s preserves native memory identity and releases its mutation fence", async kind => {
  const table = await base(kind), original = DuckDBConnection.prototype.run;
  const failure = vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function (this: DuckDBConnection, sql, ...args) { remember(); if (sql.startsWith("COPY")) throw new Error("Out of Memory Error: could not allocate block"); return original.call(this, sql, ...args); });
  await expect(change(kind, table)).rejects.toMatchObject({ code: "engine_memory_exceeded", status: 422 });
  expect(getTableByName(table.name)?.file).toBe(table.file); expect(await readdir(path.join(dir, "tables"))).toEqual([path.basename(table.file)]);
  failure.mockRestore(); await expect(change(kind, table)).resolves.toHaveProperty("revision");
});
