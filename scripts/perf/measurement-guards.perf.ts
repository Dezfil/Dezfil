/** Red-capable measurement guards, kept in the perf configuration.
 * These drive the actual builder with each named stage fault; a successful
 * assertion means the seeded measurement was refused, not native no-residue.
 */
import { test, expect } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildGpkg } from "../../test-support/gpkg";
import { buildLayerArtifact, enumerateLayers } from "../../src/lib/ingest/gdal-formats";
import { bytes, classify, observeCopy, refusal, type Seed } from "./copy-residue-observer";
import { pairValues, summarize, validateFilterOrder } from "./label-heap-summary.mjs";
import { inspectLabelRetainer } from "./heap-retainers.mjs";

const command = "DEZFIL_GUARDS_OUTPUT=perf-logs/guards.json npx vitest run --config scripts/perf/vitest.perf.config.ts scripts/perf/measurement-guards.perf.ts";

test("copy-residue stage and observation seeds are refused or inconclusive", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp-guards-"));
  const instance = await DuckDBInstance.create(":memory:", process.env.DUCKDB_EXTENSION_DIR ? { extension_directory: process.env.DUCKDB_EXTENSION_DIR } : {});
  const conn = await instance.connect();
  const results = [];
  try {
    await conn.run("LOAD spatial");
    const broken = path.join(root, "broken.gpkg"), complete = path.join(root, "complete.gpkg");
    buildGpkg(broken, [{ name: "broken", kind: "corrupt", goodPointRows: 1_000_000 }]);
    buildGpkg(complete, [{ name: "broken", kind: "corrupt", goodPointRows: 1_000_000, validLastPoint: true }]);
    for (const seed of ["pre-copy", "post-copy", "unobserved"] as Seed[]) {
      const input = path.join(root, `${seed}.gpkg`), dest = path.join(root, `${seed}.parquet`);
      await copyFile(seed === "post-copy" ? complete : broken, input);
      const { spatial } = await enumerateLayers(conn, "geopackage", { datasets: [input], scratchDir: null });
      const observed = observeCopy(conn, seed);
      let error: unknown;
      try { await buildLayerArtifact(observed.conn, "geopackage", spatial[0], dest); }
      catch (e) { error = e; }
      expect(error).toBeDefined();
      const result = classify(observed.attempts.at(-1), seed, observed.binds);
      if (seed === "pre-copy") {
        expect(observed.binds.at(-1)?.status).toBe("refused");
        expect(observed.attempts).toHaveLength(0);
        expect(result.measurement).toBe("refused");
      } else if (seed === "post-copy") {
        expect(observed.attempts[0].status).toBe("completed");
        expect(observed.attempts[0].metadata.accepted).toBe(true);
        expect(observed.attempts[0].atRejection[dest].logical).toBeGreaterThan(0);
        expect(bytes(dest).exists).toBe(false); // actual post-COPY owner ran
        expect(result.measurement).toBe("refused");
      } else {
        expect(observed.binds[0].status).toBe("bound");
        expect(observed.attempts[0].status).toBe("copy-rejected");
        expect(observed.attempts[0].error?.message).toContain("Unsupported geometry type in WKB");
        expect(observed.attempts[0].observations).toHaveLength(0);
        expect(result.classification).toBe("none-observed");
        expect(result.measurement).toBe("inconclusive");
      }
      const record = { seed, result, refusal: refusal(error), attempts: observed.attempts, binds: observed.binds, afterBuilder: bytes(dest) };
      results.push(record); console.log(JSON.stringify({ seed, result }));
    }
    const output = process.env.DEZFIL_GUARDS_OUTPUT ?? path.join(root, "guards.json");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ command, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), results }, null, 2) + "\n");
  } finally { conn.closeSync(); instance.closeSync(); await rm(root, { recursive: true, force: true }); }
});

test("retained-heap omitted, late and refused filter settlements never become valid treatment", () => {
  const targetId = "removed-target";
  const deletion = { kind: "request", method: "DELETE", path: `/api/layers/${targetId}`, ms: 20 };
  const patch = { kind: "response", method: "PATCH", path: deletion.path, filters: true, status: 200, ms: 10 };
  expect(validateFilterOrder([deletion], targetId, true)).toEqual({ valid: false, reason: "settling filter PATCH not observed before DELETE" });
  expect(validateFilterOrder([deletion, { ...patch, ms: 30 }], targetId, true).valid).toBe(false);
  expect(validateFilterOrder([{ ...patch, status: 422 }, deletion], targetId, true).valid).toBe(false);
  expect(validateFilterOrder([patch, deletion], targetId, true).valid).toBe(true);
  expect(validateFilterOrder([patch, deletion], targetId, false).valid).toBe(false);
  console.log(JSON.stringify({ seed: "skipped-filter-wire", measurement: "refused", browserSeed: "perf-logs/guard-skipped-filter.json" }));
});

test("retained-heap ratio uses baseline adjustments and the warm median; missing diagnostics are inconclusive", () => {
  // Raw heaps chosen independently: treatment cost 100, paired retained excess
  // 60; different baselines must cancel. Cold outlier never enters warm median.
  const arm = (beforeMount: number, mounted: number, afterRemoval: number, afterStyle: number) => ({
    heap: Object.fromEntries(Object.entries({ beforeMount, mounted, afterRemoval, afterIdle: afterRemoval, afterStyle }).map(([k, bytes]) => [k, { bytes, ms: 0 }])),
    guard: { valid: true, reason: null },
  });
  const pair = { arms: { treatment: arm(1000, 1100, 1080, 1020), control: arm(2000, 2100, 2020, 2020) } };
  expect(pairValues(pair)).toEqual({ mountedCost: 100, excess: { afterRemoval: 60, afterIdle: 60, afterStyle: 0 }, pairedRatio: .6 });
  const pairs = [10000, 100000, 250000].flatMap(scale => [0, 1, 2, 3, 4, 5].map(repetition => ({ ...pair,
    arms: repetition === 0 ? { ...pair.arms, treatment: arm(1000, 1100, 1400, 1020) } : pair.arms,
    scale, repetition, kind: "measurement" })));
  const result = summarize(pairs);
  expect(result.boundVerdict).toBe("inconclusive");
  expect(result.scales.every(s => s.ratio?.median === .6)).toBe(true);
  expect(result.scales.every(s => s.errors.includes("treatment label-store retaining path not demonstrated"))).toBe(true);
  const diagnostics = [10000, 100000, 250000].map(scale => ({ scale, kind: "diagnostic", arms: {
    treatment: { ...pair.arms.treatment, retainer: { matches: [{}] }, afterStyleRetainer: { matches: [] }, buildTrace: [{ kind: "sweep" }] },
    control: { ...pair.arms.control, retainer: { matches: [] }, afterStyleRetainer: { matches: [] }, buildTrace: [{ kind: "sweep" }] },
  } }));
  expect(summarize([...pairs, ...diagnostics]).boundVerdict).toBe("crossed");
  // A treatment ending below its baseline-adjusted control has released the
  // excess, even when the negative residual exceeds control drift in size.
  const released = pairs.map(p => ({ ...p, arms: { ...p.arms, treatment: { ...p.arms.treatment,
    heap: { ...p.arms.treatment.heap, afterStyle: { bytes: 1000, ms: 0 } },
  } } }));
  const releasedResult = summarize([...released, ...diagnostics]);
  expect(releasedResult.scales.every(s => s.excess?.afterStyle.median === -20 && s.controlDrift?.afterStyle === 0)).toBe(true);
  expect(releasedResult.boundVerdict).toBe("crossed");
  const surviving = pairs.map(p => ({ ...p, arms: { ...p.arms, treatment: { ...p.arms.treatment,
    heap: { ...p.arms.treatment.heap, afterStyle: { bytes: 1080, ms: 0 } },
  } } }));
  expect(summarize([...surviving, ...diagnostics]).boundVerdict).toBe("inconclusive");
});

test("snapshot attribution follows a rooted LabelBase key, refusing a UUID decoy and weak-only path", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp-snapshot-"));
  // A minimal V8-format graph with root -> context -> bases -> removed-id ->
  // LabelBase -> key -> FeatureCollection; a decoy UUID string is elsewhere.
  const strings = ["root", "system / Context", "Object", "removed-target", "key", "shape", "features", "FeatureCollection", "type", "label", "bases", "decoy"];
  const nodes = [
    0,0,1,1, // root: 1 edge
    0,1,3,1, // context: 1 edge
    0,2,5,2, // bases: 2 edges (real entry and decoy)
    0,2,7,3, // LabelBase: key, shape, features
    0,2,9,2, // FC: type, features
    1,7,11,0, // FeatureCollection string
    1,9,13,0, // label string
    0,2,15,0, // features
    1,3,17,0, // removed-target string decoy
  ];
  // edge types property=0, internal=1, weak=2, context=3; each destination
  // is a node-array offset, exactly as in V8's format.
  const edges = [1,1,4, 3,10,8, 0,3,12, 0,11,32, 0,4,16, 0,5,24, 0,6,28, 0,8,20, 0,6,28];
  const heap = { snapshot: { meta: { node_fields: ["type", "name", "id", "edge_count"], node_types: [["object", "string"]], edge_fields: ["type", "name_or_index", "to_node"], edge_types: [["property", "internal", "weak", "context"]] } }, nodes, edges, strings };
  const file = path.join(root, "seed.heapsnapshot");
  try {
    await writeFile(file, JSON.stringify(heap));
    expect(inspectLabelRetainer(file, "removed-target").matches).toHaveLength(1);
    edges[0] = 2; // only root edge made weak: no strong retaining path
    await writeFile(file, JSON.stringify(heap));
    expect(inspectLabelRetainer(file, "removed-target").matches).toHaveLength(0);
    edges[0] = 1; edges[8] = 32; // UUID property now points to a string decoy
    await writeFile(file, JSON.stringify(heap));
    expect(inspectLabelRetainer(file, "removed-target").matches).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
