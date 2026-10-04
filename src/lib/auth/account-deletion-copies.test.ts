import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { exportTable } from "@/lib/table-service";
import { exportQueryResult } from "@/lib/export/layer-export";
import { drainAccountWork } from "./account-deletion-admission";
const root = process.env.DEZFIL_DATA_DIR!; let folder: string;
beforeEach(async () => { folder = await mkdtemp(path.join(root, "copies-")); process.env.DEZFIL_DATA_DIR = folder; closeMetadataDb(); resetQueryInstance(); });
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = root; await rm(folder, { recursive: true, force: true }); });
it.each(["dataset", "query"])("refuses a %s copy crossing acceptance and awaits its cleanup", async kind => {
  const target = testAccountScope(undefined, "target"), member = testAccountScope(undefined, "member");
  const source = path.join(folder, "data.csv"); await writeFile(source, "value\n42\n");
  const data = await ingestFile(target, source, "data.csv");
  shareProject("member", "p", [["target", "editor"]], [data.id]);
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = DuckDBConnection.prototype.run; let used = false;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function(this: DuckDBConnection, sql, ...args) {
    const result = await original.call(this, sql, ...args);
    if (!used && sql.startsWith("COPY (")) { used = true; ready.resolve(); await release.promise; }
    return result;
  });
  const pending = kind === "dataset" ? exportTable(member, data.id, "csv") : exportQueryResult(member, 'SELECT * FROM "target.data"', "csv");
  const outcome = pending.then(value => value, error => error);
  await ready.promise; metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  let done = false; const drained = drainAccountWork("target").then(() => { done = true; });
  await new Promise(r => setImmediate(r));
  try { expect(done).toBe(false); } finally { release.resolve(); }
  expect(await outcome).toBeInstanceOf(Error); await drained;
  for (const directory of ["tmp", "tiles/scratch"]) expect(await readdir(path.join(folder, directory)).catch(() => [])).toEqual([]);
});
it("binds a render subrequest's inputs across async contexts and waits for browser close", async () => {
  const { AsyncResource } = await import("node:async_hooks");
  const { renderMapImage } = await import("@/lib/export/render-image");
  const { initialDefinition } = await import("@/lib/export/image-definition");
  const { createMap } = await import("@/lib/map-service");
  const { executeQuery } = await import("@/lib/query/execute");
  const { delegatedWorkKey } = await import("./account-deletion-work");
  const target = testAccountScope(undefined, "target"), member = testAccountScope(undefined, "member");
  const source = path.join(folder, "data.csv"); await writeFile(source, "value\n42\n");
  const data = await ingestFile(target, source, "data.csv"); shareProject("member", "p", [["target", "editor"]], [data.id]);
  const map = createMap(member, "Independent map");
  const requestContext = new AsyncResource("separate-render-subrequest");
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), closing = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  const credential = "proof-delegation";
  const delegated = Object.freeze({ ...member, workKey: delegatedWorkKey(credential) });
  const rendered = renderMapImage(member, { mapId: map.id, baseUrl: "http://instance.test", credential,
    definition: initialDefinition({ appearance: "light", camera: { lng: 0, lat: 0, zoom: 1 }, canvasWidth: 800, legendPresent: false, legendCorner: null, visibleWidgetIds: [], basemapLayers: null }, { width: 800, scale: 1 }),
    driver: { launch: async () => ({ render: async () => {
      await requestContext.runInAsyncScope(() => executeQuery(delegated, 'SELECT * FROM "target.data"'));
      ready.resolve(); await release.promise; return { png: new Uint8Array([1, 2, 3]) };
    }, close: async () => { closing.resolve(); await closed.promise; }, kill() {} }) },
  });
  const outcome = rendered.catch(error => error);
  await ready.promise; metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  let done = false; const drained = drainAccountWork("target").then(() => { done = true; });
  try {
    release.resolve(); expect(await outcome).toBeInstanceOf(Error); await closing.promise;
    await new Promise(r => setImmediate(r)); expect(done).toBe(false);
  } finally { closed.resolve(); requestContext.emitDestroy(); }
  await drained;
});
it("holds a direct artifact stream until close and observed cleanup", async () => {
  const { streamPrivateCopy } = await import("@/lib/export/copy-stream");
  const target = testAccountScope(undefined, "target");
  const source = path.join(folder, "stream.csv"); await writeFile(source, "value\n42\n");
  const data = await ingestFile(target, source, "data.csv");
  const cleanup = Promise.withResolvers<void>(), cleaning = Promise.withResolvers<void>();
  const response = await streamPrivateCopy(target, [{ table: "data_tables", id: data.id }], async () => ({ path: source, filename: "stream.csv", contentType: "text/csv", cleanup: async () => { cleaning.resolve(); await cleanup.promise; } }));
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  let done = false; const drained = drainAccountWork("target").then(() => { done = true; });
  expect(await response.text()).toContain("42"); await cleaning.promise;
  try { await new Promise(r => setImmediate(r)); expect(done).toBe(false); }
  finally { cleanup.resolve(); }
  await drained;
});
