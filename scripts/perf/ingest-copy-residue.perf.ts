import { testAccountScope } from "@/lib/test-support/accounts";
/** Native copy-stage measurements and separately named controls.
 * Never joins the default unit suite. Fixtures are prepared once, then copied
 * outside each measured interval. No product COPY options or cleanup changed.
 */
import { test, expect, vi } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import * as duckdb from "../../src/lib/duckdb";
import * as remote from "../../src/lib/ingest/remote";
import { buildLayerArtifact, enumerateLayers, ingestSpatialFile } from "../../src/lib/ingest/gdal-formats";
import { refreshUrlSpatial } from "../../src/lib/ingest/refresh-spatial";
import { sweepTableArtifacts } from "../../src/lib/ingest/sweep";
import { closeMetadataDb, metadataDb } from "../../src/lib/metadata/db";
import { listTables, type DataTable } from "../../src/lib/metadata/tables";
import { lit } from "../../src/lib/ingest/ingest";
import { buildGpkg, type GpkgLayer } from "../../test-support/gpkg";
import { bytes, classify, observeCopy, refusal, type Seed, type Attempt, type Bind } from "./copy-residue-observer";
import { distribution } from "./label-heap-summary.mjs";

const ROWS = 1_000_000, WARM = 5, CUTOFF = 65_536;
const command = "DEZFIL_COPY_RESIDUE_OUTPUT=perf-logs/copy-residue.json npx vitest run --config scripts/perf/vitest.perf.config.ts scripts/perf/ingest-copy-residue.perf.ts";
const point = (name: string, goodPointRows = ROWS, validLastPoint = false): GpkgLayer => ({ name, kind: "corrupt", goodPointRows, validLastPoint });
interface Scenario { name: string; fixture: string; road: "ingest" | "refresh" | "direct"; seed?: Seed; success?: boolean; registrationFault?: boolean }
interface Sample {
  scenario: string; repetition: number; cold: boolean; road: string; input: ReturnType<typeof bytes>; inputRows: number | null;
  elapsedMs: number; refusal: ReturnType<typeof refusal> | null; outcome: ReturnType<typeof classify>;
  attempts: Attempt[]; binds: Bind[]; afterCleanup: Record<string, ReturnType<typeof bytes>>;
  beforeSweep: Record<string, ReturnType<typeof bytes>>; afterSweep: Record<string, ReturnType<typeof bytes>>;
  checkpointMs: { afterCleanup: number; beforeSweep: number; afterSweep: number };
  swept: number; registeredBefore: DataTable[]; registeredAfter: DataTable[]; preservedRegistered: boolean;
  ratio: { logical: number; allocated: number }; syntheticCutoff: number | null;
}

async function engine() {
  const instance = await DuckDBInstance.create(":memory:", process.env.DUCKDB_EXTENSION_DIR ? { extension_directory: process.env.DUCKDB_EXTENSION_DIR } : {});
  const conn = await instance.connect();
  try { await conn.run("LOAD spatial"); } finally { conn.closeSync(); }
  return instance;
}

async function rowGroups(conn: DuckDBConnection, file: string) {
  return (await conn.runAndReadAll(`SELECT row_group_id, max(row_group_num_rows) AS rows,
    max(row_group_bytes) AS uncompressed_row_group_bytes,
    sum(total_compressed_size) AS compressed_column_bytes,
    sum(total_uncompressed_size) AS uncompressed_column_bytes
    FROM parquet_metadata(${lit(file)}) GROUP BY row_group_id ORDER BY row_group_id`)).getRowObjectsJson();
}

test("copy residue: cold and warm samples, controls and ownership", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp-residue-"));
  const savedData = process.env.DEZFIL_DATA_DIR;
  const samples: Sample[] = [];
  const fixtures: Record<string, string> = {};
  try {
    const definitions: Record<string, GpkgLayer[]> = {
      first: [point("broken")], later: [point("sibling", ROWS, true), point("broken")],
      complete: [point("broken", ROWS, true)], completeGroup: [point("sibling", ROWS, true), point("broken", ROWS, true)],
      oneRow: [point("broken", 0)],
    };
    const preparationStart = performance.now();
    for (const [name, layers] of Object.entries(definitions)) {
      fixtures[name] = path.join(root, `${name}.gpkg`);
      buildGpkg(fixtures[name], layers);
    }
    fixtures.invalid = path.join(root, "invalid.gpkg");
    await writeFile(fixtures.invalid, "not a GeoPackage");
    const fixturePreparationMs = performance.now() - preparationStart;
    const probe = await engine();
    const conn = await probe.connect();
    const installedVersion = (await conn.runAndReadAll("SELECT version() AS version")).getRowObjectsJson();
    const settings = (await conn.runAndReadAll("SELECT name, value FROM duckdb_settings() WHERE name IN ('threads', 'memory_limit', 'preserve_insertion_order') ORDER BY name")).getRowObjectsJson();
    const complete = path.join(root, "completed.parquet");
    const { spatial } = await enumerateLayers(conn, "geopackage", { datasets: [fixtures.complete], scratchDir: null });
    await buildLayerArtifact(conn, "geopackage", spatial[0], complete);
    const completed = { bytes: bytes(complete), rowGroups: await rowGroups(conn, complete) };
    // Ask the installed engine by making an unconfigured default COPY. The
    // recurring full-group row count is an empirical reading of its default,
    // independently checked against the builder's completed artifact below.
    const defaults = path.join(root, "default-row-group.parquet");
    await conn.run(`COPY (SELECT i FROM range(${ROWS}) t(i)) TO ${lit(defaults)} (FORMAT PARQUET)`);
    const defaultGroups = await rowGroups(conn, defaults);
    const fullGroups = defaultGroups.slice(0, -1).map(r => Number(r.rows));
    expect(new Set(fullGroups).size).toBe(1);
    const defaultRowGroupRows = fullGroups[0];
    expect(defaultRowGroupRows).toBeGreaterThan(0);
    expect(completed.rowGroups.slice(0, -1).every(r => Number(r.rows) === defaultRowGroupRows)).toBe(true);
    const prefix = (await readFile(complete)).subarray(0, CUTOFF);
    expect(prefix.length).toBe(CUTOFF);
    conn.closeSync(); probe.closeSync();

    const scenarios: Scenario[] = [
      { name: "native-first-layer", fixture: "first", road: "ingest" },
      { name: "native-later-layer", fixture: "later", road: "ingest" },
      { name: "native-builder-direct", fixture: "first", road: "direct" },
      { name: "synthetic-ingest-ownership", fixture: "first", road: "ingest", seed: "synthetic" },
      { name: "refresh-native-owner", fixture: "first", road: "refresh" },
      { name: "refresh-synthetic-owner", fixture: "first", road: "refresh", seed: "synthetic" },
      { name: "one-row-stage-control", fixture: "oneRow", road: "direct" },
      { name: "success-registration", fixture: "completeGroup", road: "ingest", success: true },
      { name: "pre-copy-refusal", fixture: "invalid", road: "ingest" },
      { name: "registration-rollback", fixture: "completeGroup", road: "ingest", registrationFault: true },
    ];
    for (const scenario of scenarios) {
      // Each scenario's first pair has a fresh engine; five subsequent copies
      // share that engine. Extension load, fixtures and refresh baselines are
      // preparation, not measured elapsed time. OS caches are not evicted.
      const instance = await engine();
      try {
        for (let repetition = 0; repetition <= WARM; repetition++) {
          const dir = path.join(root, scenario.name, String(repetition));
          await mkdir(dir, { recursive: true });
          closeMetadataDb(); process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
          const input = path.join(dir, "input.gpkg");
          await copyFile(fixtures[scenario.fixture], input);
          let observed: ReturnType<typeof observeCopy> | undefined;
          let observe = false;
          const connectionSpy = vi.spyOn(duckdb, "withConnection").mockImplementation(async action => {
            const c = await instance.connect();
            try {
              if (!observe) return await action(c);
              observed = observeCopy(c, scenario.seed ?? "none", prefix);
              return await action(observed.conn);
            } finally { c.closeSync(); }
          });
          const remoteSpy = vi.spyOn(remote, "resolveRemoteSource").mockResolvedValue({ sourcePath: input, filename: "input.gpkg", cleanup: async () => {} });
          try {
            let requested: DataTable | undefined;
            if (scenario.road === "refresh") {
              requested = (await ingestSpatialFile(testAccountScope(), fixtures.complete, "input.gpkg", { source: "url", sourceParams: { url: "https://fixture.invalid/input.gpkg" } })).tables[0];
            }
            const registeredBefore = listTables();
            if (scenario.registrationFault) metadataDb().exec("CREATE TRIGGER registration_refusal BEFORE INSERT ON data_tables WHEN (SELECT count(*) FROM data_tables) = 1 BEGIN SELECT RAISE(ABORT, 'seeded registration refusal'); END;");
            observe = true;
            let error: unknown;
            const start = performance.now();
            try {
              if (scenario.road === "refresh") await refreshUrlSpatial(testAccountScope(), requested!, requested!.name);
              else if (scenario.road === "direct") await duckdb.withConnection(async c => {
                const layers = await enumerateLayers(c, "geopackage", { datasets: [input], scratchDir: null });
                await buildLayerArtifact(c, "geopackage", layers.spatial[0], path.join(process.env.DEZFIL_DATA_DIR!, "tables", "direct.parquet"));
              });
              else await ingestSpatialFile(testAccountScope(), input, "input.gpkg");
            } catch (e) { error = e; }
            const elapsedMs = performance.now() - start;
            const attempts = observed?.attempts ?? [], binds = observed?.binds ?? [];
            const failed = attempts.find(a => a.status === "copy-rejected");
            const outcome = classify(failed ?? attempts.at(-1), scenario.seed ?? "none", binds);
            const paths = [...attempts.map(a => a.file), ...registeredBefore.map(t => path.join(process.env.DEZFIL_DATA_DIR!, t.file))];
            const inspect = () => Object.fromEntries(paths.map(f => [f, bytes(f)]));
            const afterCleanup = inspect();
            const cleanupMs = performance.now();
            const registeredAfter = listTables();
            const preservedRegistered = registeredBefore.every(t => registeredAfter.some(a => a.id === t.id && a.file === t.file && a.rowCount === t.rowCount) && bytes(path.join(process.env.DEZFIL_DATA_DIR!, t.file)).logical > 0);
            const beforeSweep = inspect();
            const beforeSweepMs = performance.now();
            const swept = await sweepTableArtifacts();
            const afterSweep = inspect();
            const afterSweepMs = performance.now();
            const residue = failed ? beforeSweep[failed.file] : { logical: 0, allocated: 0 };
            const result: Sample = { scenario: scenario.name, repetition, cold: repetition === 0, road: scenario.road,
              input: bytes(input), inputRows: scenario.fixture === "invalid" ? null : scenario.fixture === "oneRow" ? 1 : scenario.fixture === "later" || scenario.fixture === "completeGroup" ? 2 * (ROWS + 1) : ROWS + 1,
              elapsedMs, refusal: error ? refusal(error) : null, outcome, attempts, binds, afterCleanup, beforeSweep, afterSweep, swept,
              registeredBefore, registeredAfter, preservedRegistered,
              checkpointMs: { afterCleanup: cleanupMs, beforeSweep: beforeSweepMs, afterSweep: afterSweepMs },
              ratio: { logical: residue.logical / completed.bytes.logical, allocated: residue.allocated / completed.bytes.allocated },
              syntheticCutoff: scenario.seed === "synthetic" ? CUTOFF : null };
            samples.push(result);
            console.log(JSON.stringify({ scenario: scenario.name, repetition, outcome, elapsedMs, ratio: result.ratio, registered: registeredAfter.length }));
            if (scenario.success) {
              expect(error).toBeUndefined(); expect(registeredAfter).toHaveLength(2); expect(swept).toBe(0);
            } else {
              expect(error).toBeDefined(); expect(registeredAfter).toHaveLength(registeredBefore.length);
            }
            if (scenario.road === "refresh") expect(preservedRegistered).toBe(true);
            if (scenario.name === "native-later-layer") {
              const sibling = attempts.find(a => a.layer === "sibling")!;
              expect(sibling.status).toBe("completed");
              expect(failed!.atRejection[sibling.file].logical).toBeGreaterThan(0);
              expect(afterCleanup[sibling.file].exists).toBe(false);
            }
            if (scenario.seed === "synthetic") {
              expect(failed!.atRejection[failed!.file].logical).toBe(CUTOFF);
              expect(afterCleanup[failed!.file].logical).toBe(scenario.road === "refresh" ? 0 : CUTOFF);
              expect(afterSweep[failed!.file].exists).toBe(false);
            }
          } finally { connectionSpy.mockRestore(); remoteSpy.mockRestore(); }
        }
      } finally { instance.closeSync(); }
    }
    const summary = scenarios.map(s => {
      const raw = samples.filter(r => r.scenario === s.name), warm = raw.filter(r => !r.cold);
      return { scenario: s.name, cold: raw[0], warm: {
        elapsedMs: distribution(warm.map(r => r.elapsedMs)),
        logicalRatio: distribution(warm.map(r => r.ratio.logical)), allocatedRatio: distribution(warm.map(r => r.ratio.allocated)),
        classification: [...new Set(warm.map(r => r.outcome.classification))], measurement: [...new Set(warm.map(r => r.outcome.measurement))],
        checkpoints: Object.fromEntries(["atRejection", "afterCleanup", "beforeSweep", "afterSweep"].map(checkpoint => [checkpoint,
          Object.fromEntries(["logical", "allocated"].map(unit => [unit, distribution(warm.map(r => {
            const a = r.attempts.find(a => a.status === "copy-rejected") ?? r.attempts.at(-1);
            if (!a) return 0;
            return (checkpoint === "atRejection" ? a.atRejection[a.file] : r[checkpoint as "afterCleanup" | "beforeSweep" | "afterSweep"][a.file])[unit as "logical" | "allocated"];
          }))]))])),
      } };
    });
    const primary = samples.filter(s => ["native-first-layer", "native-later-layer"].includes(s.scenario));
    const crossed = primary.some(s => s.outcome.measurement === "confirmed" && s.outcome.classification === "bytes-remain" && s.ratio.logical > 0 && s.swept > 0);
    const boundVerdict = crossed ? "crossed" : primary.every(s => s.outcome.measurement === "confirmed") ? "not crossed" : "inconclusive";
    const require = createRequire(import.meta.url);
    const sourceFiles = ["scripts/perf/ingest-copy-residue.perf.ts", "scripts/perf/copy-residue-observer.ts", "test-support/gpkg.ts"];
    const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
    const report = { sourceHashes, row: "copy-residue", measuredAt: new Date().toISOString(), measuredCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      command, fixturePreparationMs, machine: { os: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, totalMemory: os.totalmem() },
      node: process.version, duckdb: installedVersion, nodeApi: require("@duckdb/node-api/package.json").version, sqlite: require("better-sqlite3/package.json").version,
      settings, defaultRowGroupRows, defaultRowGroupEvidence: { method: "Engine COPY with FORMAT PARQUET only, followed by parquet_metadata; recurring full-group row count (empirical default)", groups: defaultGroups },
      completed, fixtureBytes: Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, statSync(f).size])),
      units: "logical bytes = stat.size; allocated bytes = stat.blocks * 512; polling every 2 ms; nonzero observations carry monotonic ms relative to COPY promise rejection (negative is before)",
      isolation: "fresh data directory per repetition; one new in-memory default-config DuckDB engine per scenario, reused for five warm repetitions; first repetition is cold for that engine/input, OS cache not evicted; fixtures built once in one transaction and copied before timing; refresh baseline built before timing; source download replaced with local fixture handoff only; elapsed timings include diagnostic metadata inspection and are not throughput benchmarks; boot sweep invoked directly after pre-sweep observation, not a timed process restart",
      boundVerdict, samples, summary };
    const output = process.env.DEZFIL_COPY_RESIDUE_OUTPUT ?? path.join(root, "copy-residue.json");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ output, boundVerdict, summary: summary.map(({ scenario, warm }) => ({ scenario, warm })) }));
  } finally {
    vi.restoreAllMocks(); closeMetadataDb();
    if (savedData === undefined) delete process.env.DEZFIL_DATA_DIR; else process.env.DEZFIL_DATA_DIR = savedData;
    await rm(root, { recursive: true, force: true });
  }
});
