import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { POST } from "@/app/api/instance/parts/[part]/test/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createLayer } from "@/lib/layer-service";
import { createMap } from "@/lib/map-service";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { getTileRecord } from "@/lib/metadata/tiles";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { privateTileAccess } from "@/lib/tiles/access";
import { ensureTiles, resetTileBuilds, tileBuildStateForTests, tileBuildsSettled } from "@/lib/tiles/build";
import { tileArchivePath, tileScratchDir } from "@/lib/tiles/paths";
import { knownTilerVersion } from "@/lib/tiles/tiler";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { PART_TEST_LIMITS, partTestWords, type PartTestAnswer } from "./part-test-answer";
import { testPart } from "./part-tests";

/**
 * The tile builder's Test: the tiler as configured now, its version probed
 * first, builds a small archive from a few fixed points in a folder of its
 * own under the tile scratch, which is removed whatever happens. A missing
 * program is not found, one that fails is failed, one that does not finish
 * within 30 seconds is stopped and past its limit, and no answer holds a
 * path, the program's output or an error's words. The run is the build
 * lane's own bounded step taken outside the lane, so beside a layer build
 * held mid-run it answers within its limit and leaves the build as it was.
 */

keepRequestsOnThisMachine();

/** Every program started from this process, by its path. */
const runs = vi.hoisted(() => ({ programs: [] as string[] }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, execFile: ((file: string, ...rest: unknown[]) => {
    runs.programs.push(file);
    return (real.execFile as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.execFile };
});

const SCRATCH = path.join(process.cwd(), ".claude/test-data");

let f: ReturnType<typeof instanceSettingsFixture>;
/** Every answer a Test gave in this file, searched after each test. */
let seen: unknown[] = [];
/** Where this test's stand-in programs and their records live. */
let bin: string;
/** Opens a held build's gate, when a test holds one. */
let release: (() => void) | null = null;
/** Programs a failing test may have left running, ended by their own ids. */
let leftovers: number[] = [];

beforeEach(() => {
  f = instanceSettingsFixture();
  mkdirSync(SCRATCH, { recursive: true });
  bin = mkdtempSync(path.join(SCRATCH, "tiler-"));
  seen = []; runs.programs = []; release = null; leftovers = [];
  resetTileBuilds();
});
afterEach(async () => {
  try {
    // No answer holds a path, the program's output or an error's words.
    const text = JSON.stringify(seen);
    for (const word of [f.dir, bin, SCRATCH, "boom", "secret", "tippecanoe", "pmtiles", "geojson", "part-test", "ENOENT", "SIGTERM", "Error"]) {
      expect(text, `an answer holds ${word}`).not.toContain(word);
    }
  } finally {
    vi.useRealTimers();
    release?.();
    for (const pid of leftovers) if (Number.isInteger(pid) && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
    await tileBuildsSettled();
    resetTileBuilds();
    resetQueryInstance();
    rmSync(bin, { recursive: true, force: true });
    f.close();
  }
});

async function test(): Promise<PartTestAnswer> {
  const answer = await testPart(f.context, "tile_builder", f.db);
  seen.push(answer);
  return answer;
}

/** A stand-in tiler: it notes each call's arguments, answers its version
 * as the real one does, and runs `build` for a build. */
function tiler(name: string, build: string): { file: string; calls: () => string[] } {
  const file = path.join(bin, name);
  const log = path.join(bin, `${name}.log`);
  writeFileSync(file, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${log}'`,
    'if [ "$1" = "--version" ]; then exec tippecanoe --version; fi',
    build,
  ].join("\n") + "\n", { mode: 0o755 });
  return { file, calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

/** Every file in the data folder by its bytes' digest. */
function files(): Record<string, string> {
  return Object.fromEntries(readdirSync(f.dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.relative(f.dir, path.join(entry.parentPath, entry.name)))
    .map(file => [file, createHash("sha256").update(readFileSync(path.join(f.dir, file))).digest("hex")]).sort());
}
/** Whether a process is still there. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const settings = () => f.db.prepare("SELECT key, value FROM workspace_settings ORDER BY key").all();
const scratch = () => existsSync(tileScratchDir()) ? readdirSync(tileScratchDir()) : [];

describe("the tile builder's Test", () => {
  it("probes the version first, builds a test archive under the tile scratch and removes it, passing with its time; the folder and the settings unchanged", async () => {
    const real = tiler("real", 'exec tippecanoe "$@"');
    vi.stubEnv("DEZFIL_TIPPECANOE", real.file);
    const before = { files: files(), settings: settings() };
    expect(knownTilerVersion()).toBeNull();

    expect(await test()).toEqual({ part: "tile_builder", result: "passed", milliseconds: expect.any(Number) });
    const [probe, build, ...more] = real.calls();
    expect(probe).toBe("--version");
    expect(more).toEqual([]);
    const output = build.split(" ")[1];
    expect(path.dirname(path.dirname(output))).toBe(tileScratchDir());
    expect(path.basename(path.dirname(output))).toMatch(/^part-test-/);
    expect(existsSync(path.dirname(output))).toBe(false);
    expect(scratch()).toEqual([]);
    // The version is known from then on.
    expect(knownTilerVersion()).toMatch(/^tippecanoe v\d/);
    expect({ files: files(), settings: settings() }).toEqual(before);
    expect(partTestWords({ part: "tile_builder", result: "passed", milliseconds: 900 }).text).toBe("Built a test archive in 900 ms");
  });

  it("is reached through the route as configured now, with the tiler the search path finds", async () => {
    const response = await POST(socketRequest(new Request("http://instance.test/api/instance/parts/tile_builder/test", {
      method: "POST", headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test" } })), { params: Promise.resolve({ part: "tile_builder" }) });
    const body = await response.json();
    seen.push(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({ part: "tile_builder", result: "passed" });
    expect(runs.programs).toEqual(["tippecanoe", "tippecanoe"]);
  });

  it("answers not found for a program missing where its setting points, running nothing", async () => {
    for (const missing of [path.join(bin, "absent"), "no-such-tiler-on-the-search-path"]) {
      vi.stubEnv("DEZFIL_TIPPECANOE", missing);
      expect(await test()).toEqual({ part: "tile_builder", result: "failed", reason: "not_found" });
    }
    expect(runs.programs).toEqual([]);
    expect(scratch()).toEqual([]);
    expect(partTestWords({ part: "tile_builder", result: "failed", reason: "not_found" }).text).toBe("The tile builder is not where its setting points.");
  });

  it("answers failed for a program that fails, without its words, and removes its folder", async () => {
    const crashing = tiler("crashing", `echo "boom: ${f.dir}/secret" >&2\necho "boom on stdout"\nexit 3`);
    vi.stubEnv("DEZFIL_TIPPECANOE", crashing.file);
    expect(await test()).toEqual({ part: "tile_builder", result: "failed", reason: "failed" });
    expect(crashing.calls()).toHaveLength(2);
    expect(scratch()).toEqual([]);
    expect(partTestWords({ part: "tile_builder", result: "failed", reason: "failed" }).text).toBe("Could not build the test archive.");
  });

  it("answers failed when the program finishes without an archive", async () => {
    vi.stubEnv("DEZFIL_TIPPECANOE", tiler("idle", "exit 0").file);
    expect(await test()).toEqual({ part: "tile_builder", result: "failed", reason: "failed" });
    expect(scratch()).toEqual([]);
  });

  it("answers past its limit for a program that does not finish within it, stopping it and removing its folder", async () => {
    const pid = path.join(bin, "hanging.pid");
    vi.stubEnv("DEZFIL_TIPPECANOE", tiler("hanging", `echo $$ > '${pid}'\nexec sleep 120`).file);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const answer = test();
    for (let i = 0; i < 500 && !existsSync(pid); i += 1) await sleep(10);
    expect(existsSync(pid)).toBe(true);
    expect(scratch()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PART_TEST_LIMITS.tile_builder * 1000 + 1000);
    expect(await answer).toEqual({ part: "tile_builder", result: "failed", reason: "timed_out" });
    vi.useRealTimers();
    const program = Number(readFileSync(pid, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(program, 0)).toThrow(), { timeout: 5000 });
    await vi.waitFor(() => expect(scratch()).toEqual([]), { timeout: 5000 });
  });

  it("ends a program that ignores the stop after a short grace, keeping its folder until it is gone", async () => {
    const pid = path.join(bin, "stubborn.pid");
    // The stop is ignored before the id is noted, whole.
    vi.stubEnv("DEZFIL_TIPPECANOE", tiler("stubborn", `trap '' TERM\necho $$ > '${pid}.tmp' && mv '${pid}.tmp' '${pid}'\nexec sleep 120`).file);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const answer = test();
    for (let i = 0; i < 500 && !existsSync(pid); i += 1) await sleep(10);
    const program = Number(readFileSync(pid, "utf8"));
    leftovers.push(program);
    await vi.advanceTimersByTimeAsync(PART_TEST_LIMITS.tile_builder * 1000);
    expect(await answer).toEqual({ part: "tile_builder", result: "failed", reason: "timed_out" });
    // Asked to stop, it runs on for now, and its folder stays while it does.
    await sleep(200);
    expect(alive(program)).toBe(true);
    expect(scratch()).toHaveLength(1);
    // Past the grace it is ended outright, and only then is its folder removed.
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(alive(program), "the stopped program is still running").toBe(false), { timeout: 5000 });
    await vi.waitFor(() => expect(scratch()).toEqual([]), { timeout: 5000 });
  });

  it("runs once for concurrent Tests, both getting its answer", async () => {
    const real = tiler("real", 'exec tippecanoe "$@"');
    vi.stubEnv("DEZFIL_TIPPECANOE", real.file);
    const [one, two] = await Promise.all([test(), test()]);
    expect(one).toMatchObject({ part: "tile_builder", result: "passed" });
    expect(two).toEqual(one);
    expect(real.calls().filter(call => call.startsWith("-o "))).toHaveLength(1);
  });
});

describe("beside a layer build", () => {
  it("answers within its limit while a layer build is held mid-run, and leaves the build as it was", async () => {
    // A tiler that holds a layer's build until released, and lets the
    // Test's own run through: the gate is the build's input, never the
    // Test's.
    const started = path.join(bin, "started");
    const opened = path.join(bin, "released");
    const gated = tiler("gated", [
      'for input; do :; done',
      'case "$input" in */part-test-*) exec tippecanoe "$@";; esac',
      `: > '${started}'`,
      `while [ ! -f '${opened}' ]; do sleep 0.01; done`,
      'exec tippecanoe "$@"',
    ].join("\n"));
    vi.stubEnv("DEZFIL_TIPPECANOE", gated.file);
    release = () => writeFileSync(opened, "go");

    const source = path.join(bin, "stations.csv");
    writeFileSync(source, ["name,lon,lat", "a,13.410,52.520", "b,13.402,52.523", "c,13.330,52.510", "d,13.360,52.480"].join("\n"));
    const scope = testAccountScope();
    await ingestFile(scope, source, "stations.csv");
    const map = createMap(scope, "m");
    const layer = await createLayer(scope, map.id, { name: "Stations", sql: "SELECT name, geometry FROM stations" },
      { expectedRevision: readDocumentRevision({ kind: "map", id: map.id })?.editRevision });
    const input = { layerId: layer.id, sql: "SELECT name, geometry FROM stations", filters: [], geometryColumn: "geometry", columns: ["name"], projection: "" };

    expect(ensureTiles(privateTileAccess(scope, layer.id), input).state).toBe("building");
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 });
    const held = { state: tileBuildStateForTests(), record: getTileRecord(layer.id) };
    expect(held.state.active).toEqual([layer.id]);
    expect(held.record?.state).toBe("building");

    const asked = Date.now();
    expect(await test()).toMatchObject({ part: "tile_builder", result: "passed" });
    expect(Date.now() - asked).toBeLessThan(PART_TEST_LIMITS.tile_builder * 1000);
    // The build is still held where it was, and nothing joined its queue.
    expect(existsSync(opened)).toBe(false);
    expect({ state: tileBuildStateForTests(), record: getTileRecord(layer.id) }).toEqual(held);

    release();
    await tileBuildsSettled();
    expect(getTileRecord(layer.id)).toMatchObject({ state: "ready", featureCount: 4 });
    expect(existsSync(tileArchivePath(layer.id))).toBe(true);
    // One build of the layer, and one run of the Test, each its own.
    const builds = gated.calls().filter(call => call.startsWith("-o "));
    expect(builds).toHaveLength(2);
    expect(builds.filter(call => call.includes("/part-test-"))).toHaveLength(1);
  }, PART_TEST_LIMITS.tile_builder * 1000 + 30_000);
});
