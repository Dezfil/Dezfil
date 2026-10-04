import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { refreshTable } from "@/lib/ingest/refresh";
import * as remote from "@/lib/ingest/remote";
import * as files from "@/lib/ingest/file-ownership";
import { drainAccountWork } from "./account-deletion-admission";
const root = process.env.DEZFIL_DATA_DIR!; let folder: string;
beforeEach(async () => { folder = await mkdtemp(path.join(root, "outputs-")); process.env.DEZFIL_DATA_DIR = folder; closeMetadataDb(); resetQueryInstance(); });
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = root; await rm(folder, { recursive: true, force: true }); });
it.each(["import", "refresh"])("holds rejected %s candidates through observed cleanup and preserves independent files", async kind => {
  const target = testAccountScope(undefined, "target"), control = testAccountScope(undefined, "control");
  const source = path.join(folder, "data.csv"); await writeFile(source, "value\n42\n");
  const own = await ingestFile(target, source, "same.csv"), other = await ingestFile(control, source, "same.csv");
  metadataDb().prepare("UPDATE data_tables SET source = 'url', source_params = ? WHERE id = ?").run(JSON.stringify({ url: "https://example.test/data.csv" }), own.id);
  vi.spyOn(remote, "resolveRemoteSource").mockResolvedValue({ sourcePath: source, filename: "data.csv", cleanup: async () => {} });
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>(), clean = Promise.withResolvers<void>();
  const run = DuckDBConnection.prototype.run;
  let used = false;
  vi.spyOn(DuckDBConnection.prototype, "run").mockImplementation(async function(this: DuckDBConnection, sql, ...args) {
    const result = await run.call(this, sql, ...args);
    if (!used && sql.startsWith("COPY (")) { used = true; ready.resolve(); await release.promise; }
    return result;
  });
  const remove = files.removeAccountFile;
  vi.spyOn(files, "removeAccountFile").mockImplementation(async (...args) => { cleaning.resolve(); await clean.promise; await remove(...args); });
  const pending = kind === "import" ? ingestFile(target, source, "candidate.csv") : refreshTable(target, own.name);
  const outcome = pending.catch(error => error);
  await ready.promise;
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  let done = false; const drained = drainAccountWork("target").then(() => { done = true; });
  try {
    await new Promise(r => setImmediate(r)); expect(done).toBe(false);
    release.resolve(); await cleaning.promise;
    await new Promise(r => setImmediate(r)); expect(done).toBe(false);
    const independent = await ingestFile(control, source, "independent.csv");
    expect(independent.rowCount).toBe(1);
  } finally { release.resolve(); clean.resolve(); }
  expect(await outcome).toBeInstanceOf(Error); await drained;
  const rows = metadataDb().prepare("SELECT file FROM data_tables ORDER BY file").all() as { file: string }[];
  expect(rows).toContainEqual({ file: other.file }); expect(rows).toContainEqual({ file: own.file });
  expect((await readdir(path.join(folder, "tables"))).sort()).toEqual(rows.map(row => path.basename(row.file)).sort());
});
