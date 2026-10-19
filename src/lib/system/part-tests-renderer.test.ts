import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { POST } from "@/app/api/instance/parts/[part]/test/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { encodePng } from "@/lib/export/png-codec";
import {
  RENDER_CHECK_GROUND_COLOR,
  RENDER_CHECK_MARK,
  RENDER_CHECK_MARK_COLOR,
  RENDER_CHECK_PATH,
  RENDER_CHECK_SIZE,
} from "@/lib/export/render-check";
import type { RenderBrowser, RenderDriver } from "@/lib/export/render-driver";
import { renderMapImage, renderQueueState, renderStats } from "@/lib/export/render-image";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { PART_TEST_LIMITS, partTestWords, type PartTestAnswer } from "./part-test-answer";
import { PART_TEST_ENDING_MS, partTestsSettled, testPart } from "./part-tests";

/**
 * The image renderer's Test: the browser as configured now photographs the
 * render route's fixed check picture, and the image is read back at the
 * mark and on the ground. A browser missing where its setting points is
 * not found and never launched, one that crashes at its start is failed,
 * one that never answers is past its limit at 10 seconds with its slot
 * given back, and an image that is not the picture is failed. With every
 * image slot in use it answers busy at once and launches nothing. No answer
 * holds a path, the browser's output or an error's words.
 *
 * A browser that never answers its launch is ended at the Test's limit by
 * its own process, so no image's browser starts beside it while it lives.
 *
 * The missing, crashing and hanging browsers are stand-in programs started
 * by the real driver; the drawn and the flat pictures come from a driver
 * put in its place. Nothing here reaches outside this machine.
 */

keepRequestsOnThisMachine();

/** A driver put in the real one's place, when a test sets one. */
const stand = vi.hoisted(() => ({ driver: null as null | RenderDriver }));
vi.mock("@/lib/export/render-driver", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/export/render-driver")>();
  return { ...real, puppeteerDriver: async () => stand.driver ?? real.puppeteerDriver() };
});

const SCRATCH = path.join(process.cwd(), ".claude/test-data");
const ORIGIN = "http://instance.test";

let f: ReturnType<typeof instanceSettingsFixture>;
let seen: unknown[] = [];
let bin: string;
/** Stand-in programs still running at a test's end, stopped by their own id. */
let pids: string[] = [];

beforeEach(() => {
  f = instanceSettingsFixture();
  mkdirSync(SCRATCH, { recursive: true });
  bin = mkdtempSync(path.join(SCRATCH, "renderer-"));
  seen = []; pids = []; stand.driver = null;
});
afterEach(() => partTestsSettled());
afterEach(() => {
  try {
    // No answer holds a path, the browser's output or an error's words.
    const text = JSON.stringify(seen);
    for (const word of [f.dir, bin, SCRATCH, "boom", "secret", "chromium", "Chromium", "DEZFIL_CHROMIUM_PATH", "render_", "browser", "Error"]) {
      expect(text, `an answer holds ${word}`).not.toContain(word);
    }
  } finally {
    for (const file of pids) {
      if (!existsSync(file)) continue;
      try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch { /* already gone */ }
    }
    vi.useRealTimers();
    rmSync(bin, { recursive: true, force: true });
    f.close();
  }
});

async function test(baseUrl = "http://127.0.0.1:3216"): Promise<PartTestAnswer> {
  const answer = await testPart(f.context, "image_renderer", f.db, Date.now(), baseUrl);
  seen.push(answer);
  return answer;
}

/** A stand-in browser program that notes each start and then runs `body`. */
function program(name: string, body: string): { file: string; started: () => boolean } {
  const file = path.join(bin, name);
  const log = path.join(bin, `${name}.started`);
  writeFileSync(file, `#!/bin/sh\n: > '${log}'\n${body}\n`, { mode: 0o755 });
  return { file, started: () => existsSync(log) };
}

/** Probe this fixture's own PID without a process-table command. A zombie
 * still counts as present: the next browser must start after it is reaped. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** The check picture as the page draws it, or a flat one. */
function picture(drawn: boolean): Uint8Array {
  const { width, height } = RENDER_CHECK_SIZE;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const inMark = x >= RENDER_CHECK_MARK.x && x < RENDER_CHECK_MARK.x + RENDER_CHECK_MARK.width &&
      y >= RENDER_CHECK_MARK.y && y < RENDER_CHECK_MARK.y + RENDER_CHECK_MARK.height;
    const color = drawn && inMark ? RENDER_CHECK_MARK_COLOR : RENDER_CHECK_GROUND_COLOR;
    rgba.set([...color, 255], (y * width + x) * 4);
  }
  return encodePng({ width, height, rgba });
}

/** A driver answering one picture, noting what it was asked. */
function answering(png: Uint8Array | null) {
  const asked: { appOrigin: string; url: string; credential: string; width: number; height: number }[] = [];
  const release: (() => void)[] = [];
  const driver: RenderDriver = {
    async launch(_path, _flags, context) {
      const browser: RenderBrowser = {
        async render(input) {
          asked.push({ appOrigin: context.appOrigin, url: input.url, credential: input.credential, width: input.width, height: input.height });
          if (!png) await new Promise<void>(resolve => release.push(resolve));
          return { png: png ?? picture(true) };
        },
        async close() {},
        kill() {},
      };
      return browser;
    },
  };
  return { driver, asked, release: () => { for (const go of release.splice(0)) go(); } };
}

/** Every file in the data folder by its bytes' digest. */
function files(): Record<string, string> {
  return Object.fromEntries(readdirSync(f.dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.relative(f.dir, path.join(entry.parentPath, entry.name)))
    .map(file => [file, createHash("sha256").update(readFileSync(path.join(f.dir, file))).digest("hex")]).sort());
}
const settings = () => f.db.prepare("SELECT key, value FROM workspace_settings ORDER BY key").all();

describe("the image renderer's Test", () => {
  it("photographs the check picture with the render credential and passes on the mark with its time; the folder and the settings unchanged", async () => {
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", program("browser", "exit 0").file);
    const drawn = answering(picture(true));
    stand.driver = drawn.driver;
    const before = { files: files(), settings: settings() };
    expect(await test("http://127.0.0.1:3216")).toEqual({ part: "image_renderer", result: "passed", milliseconds: expect.any(Number) });
    expect(drawn.asked).toEqual([{ appOrigin: "http://127.0.0.1:3216", url: `http://127.0.0.1:3216${RENDER_CHECK_PATH}`,
      credential: expect.stringMatching(/^dz_delegation_/), ...RENDER_CHECK_SIZE }]);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
    expect({ files: files(), settings: settings() }).toEqual(before);
    expect(partTestWords({ part: "image_renderer", result: "passed", milliseconds: 1800 }).text).toBe("Rendered a test image in 1.8 s");
  });

  it("is reached through the route, private and no-store, photographing this server's own page", async () => {
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", program("browser", "exit 0").file);
    vi.stubEnv("PORT", "3217");
    const drawn = answering(picture(true));
    stand.driver = drawn.driver;
    const response = await POST(socketRequest(new Request(`${ORIGIN}/api/instance/parts/image_renderer/test`, {
      method: "POST", headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: ORIGIN } })), { params: Promise.resolve({ part: "image_renderer" }) });
    const body = await response.json();
    seen.push(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({ part: "image_renderer", result: "passed" });
    expect(drawn.asked.map(asked => asked.url)).toEqual([`http://127.0.0.1:3217${RENDER_CHECK_PATH}`]);
  });

  it("fails on an image that is not the check picture", async () => {
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", program("browser", "exit 0").file);
    stand.driver = answering(picture(false)).driver;
    expect(await test()).toEqual({ part: "image_renderer", result: "failed", reason: "failed" });
    stand.driver = answering(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).driver;
    expect(await test()).toEqual({ part: "image_renderer", result: "failed", reason: "failed" });
  });

  it("answers not found for a browser missing where its setting points, launching nothing", async () => {
    const launches = renderStats().launches;
    for (const missing of [path.join(bin, "absent"), "no-such-browser-on-the-search-path"]) {
      vi.stubEnv("DEZFIL_CHROMIUM_PATH", missing);
      expect(await test()).toEqual({ part: "image_renderer", result: "failed", reason: "not_found" });
    }
    expect(renderStats().launches).toBe(launches);
    expect(partTestWords({ part: "image_renderer", result: "failed", reason: "not_found" }).text).toBe("The image renderer's browser is not where its setting points.");
  });

  it("answers failed for a browser that crashes at its start, without its words", async () => {
    const crashing = program("crashing", `echo "boom: ${f.dir}/secret" >&2\nexit 3`);
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", crashing.file);
    expect(await test()).toEqual({ part: "image_renderer", result: "failed", reason: "failed" });
    expect(crashing.started()).toBe(true);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
    expect(partTestWords({ part: "image_renderer", result: "failed", reason: "failed" }).text).toBe("Could not render the test image.");
  });

  it("answers past its limit for a browser that never answers, giving its slot back by then", async () => {
    const pid = path.join(bin, "hanging.pid");
    pids.push(pid);
    const hanging = program("hanging", `echo $$ > '${pid}'\nexec sleep 120`);
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", hanging.file);
    const asked = Date.now();
    expect(await test()).toEqual({ part: "image_renderer", result: "failed", reason: "timed_out" });
    // Stopped before the limit, so its browser is gone by then.
    expect(Date.now() - asked).toBeGreaterThanOrEqual(PART_TEST_LIMITS.image_renderer * 1000 - PART_TEST_ENDING_MS.image_renderer - 50);
    expect(Date.now() - asked).toBeLessThanOrEqual(PART_TEST_LIMITS.image_renderer * 1000);
    expect(hanging.started()).toBe(true);
    await vi.waitFor(() => expect(renderQueueState()).toEqual({ active: 0, waiting: 0 }), { timeout: 1000 });
  }, 30_000);

  it("ends a browser that never answers its launch at the Test's limit, so no image's browser starts beside it", async () => {
    vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "1");
    const list = path.join(bin, "never-ready.pids");
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", program("never-ready", `echo $$ >> '${list}'\nexec sleep 120`).file);
    const started = () => existsSync(list) ? readFileSync(list, "utf8").split("\n").filter(Boolean).map(Number) : [];
    const leaving = new AbortController();
    try {
      const asked = Date.now();
      const pending = test();
      await vi.waitFor(() => expect(started()).toHaveLength(1));
      expect(running(started()[0]), "the liveness probe must detect the running fixture").toBe(true);
      expect(await pending).toEqual({ part: "image_renderer", result: "failed", reason: "timed_out" });
      expect(Date.now() - asked).toBeLessThan(PART_TEST_LIMITS.image_renderer * 1000 + 2000);
      const [first] = started();
      expect(first).toEqual(expect.any(Number));
      // Images at once is 1 and the Test's slot is back: an image asked now
      // launches its own browser at once, which must find the Test's gone.
      const image = renderMapImage(testAccountScope(), { mapId: "m1", credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3216",
        signal: leaving.signal, definition: { viewport: { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 }, size: { width: 64, height: 64 },
          legend: { visible: false, corner: "bottom-left", size: "s" }, widgets: [], title: null, appearance: "light", mapScale: 1 } });
      void image.catch(() => {});
      await vi.waitFor(() => expect(started()).toHaveLength(2), { timeout: 5000 });
      expect(running(first), "the Test's browser still runs beside the image's").toBe(false);
      leaving.abort();
      await image.catch(() => {});
    } finally {
      // Every stand-in started here, stopped by its own id.
      for (const pid of started()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  }, 30_000);

  it("keeps a Test past its limit until its browser has exited, so a Test asked at once joins it, launching nothing", async () => {
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", program("browser", "exit 0").file);
    let launches = 0;
    const exits: (() => void)[] = [];
    // The first browser's render and close never end, and its process,
    // ended outright, exits only when the test lets it; any later one
    // draws the picture at once.
    stand.driver = { async launch() {
      launches += 1;
      if (launches > 1) return answering(picture(true)).driver.launch("", [], { appOrigin: "", deadline: 0, requestBoundMs: 0 });
      return { render: () => new Promise(() => {}), close: () => new Promise(() => {}),
        kill: () => new Promise<void>(resolve => exits.push(resolve)) };
    } };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const first = test();
      await vi.waitFor(() => expect(launches).toBe(1));
      await vi.advanceTimersByTimeAsync(PART_TEST_LIMITS.image_renderer * 1000);
      expect(await first).toEqual({ part: "image_renderer", result: "failed", reason: "timed_out" });
      // Time for the drive's own end to run its course: its close's grace is spent.
      await vi.advanceTimersByTimeAsync(100);
      expect(exits.length).toBeGreaterThan(0);
      // Its browser has not exited: a Test asked now gets that run's answer.
      const second = test();
      await sleep(200);
      expect(launches, "a second browser launched while the first had not exited").toBe(1);
      expect(await second).toEqual({ part: "image_renderer", result: "failed", reason: "timed_out" });
      expect(renderQueueState()).toEqual({ active: 1, waiting: 0 });
    } finally {
      vi.useRealTimers();
      for (const exit of exits.splice(0)) exit();
    }
    // Once it has exited, its slot is back and the next Test runs anew.
    await partTestsSettled();
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
    stand.driver = answering(picture(true)).driver;
    expect(await test()).toMatchObject({ part: "image_renderer", result: "passed" });
  });

  it("answers busy at once with every image slot in use, starting no browser", async () => {
    vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "1");
    const browser = program("browser", "exit 0");
    vi.stubEnv("DEZFIL_CHROMIUM_PATH", browser.file);
    const held = answering(null);
    const image = renderMapImage(testAccountScope(), { mapId: "m1", credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3216",
      driver: held.driver, definition: { viewport: { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 }, size: { width: 64, height: 64 },
        legend: { visible: false, corner: "bottom-left", size: "s" }, widgets: [], title: null, appearance: "light", mapScale: 1 } });
    await vi.waitFor(() => expect(held.asked).toHaveLength(1));
    const launches = renderStats().launches;
    const asked = Date.now();
    expect(await test()).toEqual({ part: "image_renderer", result: "failed", reason: "busy" });
    expect(Date.now() - asked).toBeLessThan(1000);
    expect(renderStats().launches).toBe(launches);
    expect(browser.started()).toBe(false);
    held.release();
    await image;
    expect(partTestWords({ part: "image_renderer", result: "failed", reason: "busy" }).text).toBe("Busy: every image slot is in use or an image is waiting.");
  });
});
