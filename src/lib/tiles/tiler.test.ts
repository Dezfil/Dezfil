import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { knownTilerVersion, probeTilerVersion, runTiler, tilerAvailable, tilerFound, tilerVersion, tippecanoePath } from "./tiler";

/**
 * Tiler capability probe. The dev/CI environment has tippecanoe installed —
 * the real binary answers the probe; a broken path degrades to unavailable
 * instead of throwing.
 */

/** Every program this file's code started, by its path. */
const runs = vi.hoisted(() => ({ programs: [] as string[] }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, execFile: ((file: string, ...rest: unknown[]) => {
    runs.programs.push(file);
    return (real.execFile as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.execFile };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dezfil-tiler-"));
  runs.programs = [];
});
afterEach(() => {
  delete process.env.DEZFIL_TIPPECANOE;
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in tiler: answers its version, then runs `body` for a build. */
function program(name: string, body: string, mode = 0o755): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tippecanoe v0.0-${name}" >&2; exit 0; fi\n${body}\n`, { mode });
  return file;
}

describe("tiler capability", () => {
  it("finds the real tippecanoe and reports its version", async () => {
    expect(await tilerAvailable()).toBe(true);
    expect(await tilerVersion()).toMatch(/tippecanoe/);
  });

  it("degrades to unavailable when the binary cannot run", async () => {
    process.env.DEZFIL_TIPPECANOE = "/nonexistent/tippecanoe";
    expect(tippecanoePath()).toBe("/nonexistent/tippecanoe");
    expect(await tilerAvailable()).toBe(false);
    expect(await tilerVersion()).toBeNull();
  });

  it("re-probes when the configured binary changes back", async () => {
    process.env.DEZFIL_TIPPECANOE = "/nonexistent/tippecanoe";
    expect(await tilerAvailable()).toBe(false);
    delete process.env.DEZFIL_TIPPECANOE;
    expect(await tilerAvailable()).toBe(true);
  });
});

describe("what is known without running the tiler", () => {
  it("finds the configured binary by a file check, on the search path for a bare name, running nothing", () => {
    expect(tilerFound()).toBe(true);
    process.env.DEZFIL_TIPPECANOE = program("present", "exit 0");
    expect(tilerFound()).toBe(true);
    for (const missing of ["/nonexistent/tippecanoe", "no-such-tiler-on-the-search-path", dir, program("unrunnable", "exit 0", 0o644)]) {
      process.env.DEZFIL_TIPPECANOE = missing;
      expect(tilerFound(), missing).toBe(false);
    }
    expect(runs.programs).toEqual([]);
  });

  it("knows the version only once a probe of the configured binary has answered, and reading it runs nothing", async () => {
    process.env.DEZFIL_TIPPECANOE = program("first", "exit 0");
    expect(knownTilerVersion()).toBeNull();
    expect(runs.programs).toEqual([]);
    expect(await tilerVersion()).toBe("tippecanoe v0.0-first");
    expect(knownTilerVersion()).toBe("tippecanoe v0.0-first");
    // Another binary: nothing known of it yet.
    process.env.DEZFIL_TIPPECANOE = program("second", "exit 0");
    expect(knownTilerVersion()).toBeNull();
    expect(runs.programs).toHaveLength(1);
  });

  it("a fresh probe reads the binary as it is now, and every later read sees it", async () => {
    const file = program("before", "exit 0");
    process.env.DEZFIL_TIPPECANOE = file;
    expect(await tilerVersion()).toBe("tippecanoe v0.0-before");
    writeFileSync(file, `#!/bin/sh\necho "tippecanoe v0.0-after" >&2\n`, { mode: 0o755 });
    // The memo still answers the first probe until one is asked afresh.
    expect(await tilerVersion()).toBe("tippecanoe v0.0-before");
    expect(await probeTilerVersion()).toBe("tippecanoe v0.0-after");
    expect(knownTilerVersion()).toBe("tippecanoe v0.0-after");
    expect(await tilerVersion()).toBe("tippecanoe v0.0-after");
  });
});

describe("one bounded run of the tiler", () => {
  const points = () => {
    const input = path.join(dir, "points.geojsonl");
    // Two places: the tiler guesses its zooms from the spread between them.
    writeFileSync(input, [[13.4, 52.52], [13.41, 52.53]]
      .map(coordinates => JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates } })).join("\n") + "\n");
    return { input, output: path.join(dir, "points.pmtiles") };
  };

  it("builds an archive with the real tiler", async () => {
    const { input, output } = points();
    expect(await runTiler(input, output, 30_000)).toEqual({ ok: true });
    expect(statSync(output).size).toBeGreaterThan(0);
  });

  it("names a missing program, a failure with its last words, and a run stopped past its time or by its signal", async () => {
    const { input, output } = points();
    process.env.DEZFIL_TIPPECANOE = "/nonexistent/tippecanoe";
    expect(await runTiler(input, output, 5_000)).toEqual({ ok: false, reason: "not_found", detail: "" });
    process.env.DEZFIL_TIPPECANOE = program("crashing", 'echo "boom: one" >&2\necho "boom: two" >&2\nexit 3');
    expect(await runTiler(input, output, 5_000)).toEqual({ ok: false, reason: "failed", detail: "boom: one boom: two" });
    process.env.DEZFIL_TIPPECANOE = program("hanging", "exec sleep 30");
    const started = Date.now();
    expect(await runTiler(input, output, 300)).toMatchObject({ ok: false, reason: "timed_out" });
    const controller = new AbortController();
    const stopped = runTiler(input, output, 30_000, controller.signal);
    setTimeout(() => controller.abort(), 100);
    expect(await stopped).toMatchObject({ ok: false, reason: "timed_out" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
