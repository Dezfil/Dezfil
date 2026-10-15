import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { proveErasure } from "../../test-support/account-erasure-proof";
import { erasureInventory } from "./auth/account-erasure-inventory";
import { withConnection } from "./duckdb";
import { withTrustedOperation } from "./trusted-operation";
import { purgeQueryStores } from "./query/retained";

const scratch = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => {
  await purgeQueryStores();
  directory = mkdtempSync(path.join(scratch, "trusted-memory-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  vi.stubEnv("DEZFIL_TRUSTED_MEMORY_MB", "32");
});
afterEach(async () => { await purgeQueryStores(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const work = <T>(name: string, run: Parameters<typeof withConnection<T>>[0]) =>
  withTrustedOperation({ kind: "interactive-read", name }, () => withConnection(run));
const payload = "md5(i::VARCHAR) || md5((i+10000000)::VARCHAR) || md5((i+20000000)::VARCHAR) || md5((i+30000000)::VARCHAR)";
const table = (name: string, rows: number) => `CREATE TABLE ${name} AS SELECT i, ${payload} AS payload FROM range(${rows}) t(i)`;
const spillBytes = () => withConnection(async conn => Number((await conn.runAndReadAll("SELECT coalesce(sum(size), 0) FROM duckdb_temporary_files()")).getRows()[0][0]));
const control = () => expect(work("Small inspection", async conn => (await conn.runAndReadAll("SELECT 42")).getRows())).resolves.toEqual([[42]]);

it("uses the configured shared memory and isolated fourfold scratch budgets", async () => {
  await work("Settings inspection", async conn => {
    const rows = (await conn.runAndReadAll("SELECT name, value FROM duckdb_settings() WHERE name IN ('memory_limit', 'max_temp_directory_size', 'temp_directory')")).getRows();
    expect(Object.fromEntries(rows.map(row => [row[0], row[1]]))).toEqual({ memory_limit: "30.5 MiB", max_temp_directory_size: "122.0 MiB", temp_directory: path.join(directory, "engine-spill") });
  });
});

it("answers a real non-spilling memory failure and recovers", async () => {
  await expect(work("Dataset inspection", conn => conn.run("SELECT list(i) FROM range(10000000) t(i)"))).rejects.toMatchObject({
    status: 422, code: "engine_memory_exceeded", message: expect.stringContaining("32 MB memory budget shared by trusted data work"),
  });
  await control();
});

it("completes real spilling work within the shared allowance", async () => {
  await work("Data preparation", conn => conn.run(table("spilling", 300000)));
  const bytes = await spillBytes();
  expect(bytes).toBeGreaterThan(0); expect(bytes).toBeLessThanOrEqual(128000000);
  const files = readdirSync(path.join(directory, "engine-spill"));
  expect(files.length).toBeGreaterThan(0);
  expect(files.reduce((sum, file) => sum + statSync(path.join(directory, "engine-spill", file)).size, 0)).toBeLessThanOrEqual(128000000);
  await work("Read prepared data", async conn => {
    expect((await conn.runAndReadAll("SELECT count(*), sum(length(payload)) FROM spilling")).getRows()).toEqual([[300000n, 38400000n]]);
    await conn.run("DROP TABLE spilling");
  });
  process.stdout.write(JSON.stringify({ observation: "trusted-spill", bytes, allowance: 128000000 }) + "\n");
  await control();
});

it("refuses actual scratch exhaustion with its own budget and recovers", async () => {
  await expect(work("Import preparation", conn => conn.run(table("too_large", 4000000)))).rejects.toMatchObject({
    status: 422, code: "engine_memory_exceeded", message: expect.stringContaining("128 MB scratch budget shared by trusted data work"),
  });
  expect(await spillBytes()).toBeLessThanOrEqual(128000000);
  await control();
});

it("measures one allowance while two trusted operations overlap", async () => {
  const release = Promise.withResolvers<void>();
  const ready = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const operations = ready.map((arrived, index) => work(`Preparation ${index}`, async conn => {
    try { await conn.run(table(`overlap_${index}`, 400000)); arrived.resolve(); await release.promise; }
    finally { arrived.resolve(); }
  }));
  const results = Promise.all(operations);
  try {
    await Promise.all(ready.map(r => r.promise));
    const bytes = await spillBytes();
    expect(bytes).toBeGreaterThan(32000000); expect(bytes).toBeLessThanOrEqual(128000000);
    process.stdout.write(JSON.stringify({ observation: "overlapping-trusted-spill", bytes, allowance: 128000000 }) + "\n");
  } finally { release.resolve(); await results; }
  await control();
});

it("shares the trusted instance across separately loaded server modules", async () => {
  await work("First module", conn => conn.run("CREATE TABLE module_control AS SELECT 42 AS value"));
  vi.resetModules();
  const other = await import("./duckdb");
  expect(await other.withConnection(async conn => (await conn.runAndReadAll("SELECT * FROM module_control")).getRows())).toEqual([[42]]);
});

it("clears abandoned scratch on a new engine start and preserves every neighbouring artifact", async () => {
  const sentinels = ["tables/control.parquet", "metadata.sqlite", "tiles/control.pmtiles", "tmp/control", "exports/control.zip"];
  for (const file of sentinels) { mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); writeFileSync(path.join(directory, file), file); }
  mkdirSync(path.join(directory, "engine-spill"));
  writeFileSync(path.join(directory, "engine-spill", "abandoned.tmp"), Buffer.alloc(1024));
  await control();
  expect(readdirSync(path.join(directory, "engine-spill"))).toEqual([]);
  for (const file of sentinels) expect(readFileSync(path.join(directory, file), "utf8")).toBe(file);
});

it("starts after a killed spilling process without charging abandoned files to its allowance", async () => {
  const compiled = path.join(directory, "trusted-storage.mjs");
  const dependency = createRequire(import.meta.url).resolve("@duckdb/node-api");
  writeFileSync(compiled, ts.transpileModule(readFileSync("src/lib/trusted-storage.ts", "utf8").replace('"@duckdb/node-api"', JSON.stringify(dependency)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const spill = path.join(directory, "engine-spill");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createTrustedInstance } from ${JSON.stringify(pathToFileURL(compiled).href)};
    const instance = await createTrustedInstance({}, ${JSON.stringify(spill)}, 32);
    const conn = await instance.connect();
    await conn.run(${JSON.stringify(table("abandoned", 300000))});
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let error = ""; child.stderr.on("data", chunk => { error += chunk; });
  try {
    await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error(error || "The spilling child exited early."); })]);
    expect(readdirSync(spill).length).toBeGreaterThan(0);
    child.kill("SIGKILL"); await exited;
    expect(readdirSync(spill).length).toBeGreaterThan(0);
    await control();
    expect(readdirSync(spill)).toEqual([]);
    await work("Replacement preparation", conn => conn.run(table("replacement", 300000)));
    expect(await spillBytes()).toBeGreaterThan(0);
    await control();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
});

it("purges the populated shared spill store after native drainage while keeping durable data", async () => {
  const id = "file:trusted-spill";
  const controlPath = path.join(directory, "control.parquet");
  writeFileSync(controlPath, "durable control");
  await proveErasure({ ...erasureInventory, stores: { [id]: erasureInventory.stores[id] } }, {
    [id]: {
      async populate() {
        await work("Target preparation", conn => conn.run(table("target_data", 300000)));
        await work("Control preparation", conn => conn.run(table("control_data", 300000)));
        expect(await spillBytes()).toBeGreaterThan(0);
      },
      observe() {
        const files = readdirSync(directory).includes("engine-spill") ? readdirSync(path.join(directory, "engine-spill")) : [];
        return { target: files, control: files, outsideControl: { store: "file:tables", entries: [readFileSync(controlPath, "utf8")] } };
      },
      dispose() {},
    },
  }, purgeQueryStores);
});
