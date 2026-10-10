import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDefinition } from "./image-definition";
import { RENDER_CHECK_DEFINITION, RENDER_CHECK_PATH } from "./render-check";
import {
  renderCheckImage,
  renderMapImage,
  renderQueueState,
  renderStats,
  type RenderBrowser,
  type RenderDriver,
} from "./render-image";
import type { RenderLaunchContext } from "./render-driver";

/**
 * The image renderer's Test on the image lane, over injected drivers: it
 * takes a slot only when one is free now and no image waits, else answers
 * busy at once and launches nothing; an image asked while it runs waits
 * for it as behind any image, and starts by the Test's hard stop at the
 * latest, the Test's browser killed; the Test's launch is held to the
 * Test's own time and ended at its stop, an export's keeping the driver's
 * own; a slot is kept until its browser has closed or been ended, the
 * Test's by its limit; and the lane never runs more browsers than Images
 * at once. No real browser anywhere.
 */

const def = () => initialDefinition(
  { appearance: "light", camera: { lng: 13.4, lat: 52.5, zoom: 11 }, canvasWidth: 1200, legendPresent: false, legendCorner: null, visibleWidgetIds: [], basemapLayers: null },
  { width: 1920, scale: 1 },
);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const LIMIT_MS = 10_000;

/** A driver whose every browser is counted while it lives: launched and
 * not yet closed, or ended outright and not yet exited. `hold` keeps each
 * render open until released; `closeMs` makes each close take that long,
 * and "held" keeps it open until the test lets it finish, so only a kill
 * ends the browser before then; `exitMs` is how long a killed browser's
 * process takes to exit, its kill settling then, as the real one's does. */
function lane(hold = false, closeMs: number | "held" = 0, exitMs = 0) {
  const state = { launched: 0, live: 0, most: 0, killed: 0, urls: [] as string[], releases: [] as (() => void)[], closes: [] as (() => void)[] };
  const driver: RenderDriver = {
    async launch() {
      state.launched += 1; state.live += 1; state.most = Math.max(state.most, state.live);
      let gone = false;
      let exit: Promise<void> | null = null;
      const leave = () => { if (!gone) { gone = true; state.live -= 1; } };
      const browser: RenderBrowser = {
        async render(input) {
          state.urls.push(input.url);
          if (hold) await new Promise<void>(resolve => state.releases.push(resolve));
          else await new Promise(resolve => setTimeout(resolve, 5));
          return { png: PNG };
        },
        async close() {
          // A browser already ended outright has closed once its process exits.
          if (exit) return exit;
          if (closeMs === "held") await new Promise<void>(resolve => state.closes.push(resolve));
          else if (closeMs > 0) await new Promise(resolve => setTimeout(resolve, closeMs));
          leave();
        },
        kill() {
          state.killed += 1;
          if (exitMs === 0) { leave(); return (exit = Promise.resolve()); }
          return (exit ??= new Promise<void>(resolve => setTimeout(() => { leave(); resolve(); }, exitMs)));
        },
      };
      return browser;
    },
  };
  return {
    driver, state,
    releaseAll: () => { for (const release of state.releases.splice(0)) release(); },
    finishCloses: () => { for (const close of state.closes.splice(0)) close(); },
  };
}

const image = (driver: RenderDriver, mapId = "m1") => renderMapImage(testAccountScope(), {
  mapId, definition: def(), credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3216", driver,
});
const check = (driver: RenderDriver, timeoutMs = LIMIT_MS) => renderCheckImage({
  baseUrl: "http://127.0.0.1:3216", credential: "fixture-render-credential", accountId: testAccountScope().accountId, timeoutMs, driver,
});
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

afterEach(() => {
  vi.useRealTimers();
  delete process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY;
});

describe("the renderer's Test on the image lane", () => {
  it("drives the fixed check picture at its own size, from no map, on a free slot", async () => {
    const test = lane();
    const before = renderStats().launches;
    const result = await check(test.driver);
    expect(result).toMatchObject({ png: PNG });
    expect(test.state.urls).toEqual([`http://127.0.0.1:3216${RENDER_CHECK_PATH}`]);
    expect(RENDER_CHECK_PATH).toBe("/render/check");
    expect(RENDER_CHECK_DEFINITION.size).toEqual({ width: 160, height: 100 });
    expect(renderStats().launches - before).toBe(1);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("at Images at once 1 answers busy at once, launching nothing, while an image renders and while one waits", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    const images = lane(true), test = lane();
    const first = image(images.driver, "a");
    await tick();
    expect(renderQueueState()).toEqual({ active: 1, waiting: 0 });
    const launches = renderStats().launches;
    expect(await check(test.driver)).toBe("busy");

    const second = image(images.driver, "b");
    await tick();
    expect(renderQueueState()).toEqual({ active: 1, waiting: 1 });
    expect(await check(test.driver)).toBe("busy");
    expect(test.state.launched).toBe(0);
    expect(renderStats().launches).toBe(launches);

    images.releaseAll(); await first;
    await vi.waitFor(() => expect(images.state.releases).toHaveLength(1));
    // The waiting image went first; the Test never queued behind it.
    expect(renderQueueState()).toEqual({ active: 1, waiting: 0 });
    images.releaseAll(); await second;
    expect(test.state.launched).toBe(0);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("takes a free slot beside a rendering image when nothing waits, its slot counted against Images at once", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "2";
    const images = lane(true), test = lane(true);
    const first = image(images.driver, "a");
    await tick();
    const testing = check(test.driver);
    await tick();
    expect(renderQueueState()).toEqual({ active: 2, waiting: 0 });
    // A third image waits for one of the two.
    const third = image(images.driver, "c");
    await tick();
    expect(renderQueueState()).toEqual({ active: 2, waiting: 1 });
    test.releaseAll();
    expect(await testing).toMatchObject({ png: PNG });
    await vi.waitFor(() => expect(images.state.releases).toHaveLength(2));
    images.releaseAll(); await Promise.all([first, third]);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("an image asked during the Test starts once the Test ends, by its hard stop at the latest, the Test's browser killed", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    vi.useFakeTimers();
    const test = lane(true), images = lane();
    const started = Date.now();
    const testing = check(test.driver).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.state.launched).toBe(1);
    let imageStarted: number | null = null;
    const asked: RenderDriver = { launch: (...args) => { imageStarted = Date.now(); return images.driver.launch(...args); } };
    const waiting = image(asked, "b");
    await vi.advanceTimersByTimeAsync(0);
    expect(renderQueueState()).toEqual({ active: 1, waiting: 1 });

    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    expect(await testing).toMatchObject({ error: { code: "render_timeout" } });
    expect(test.state.killed).toBeGreaterThan(0);
    expect(test.state.live).toBe(0);
    expect(imageStarted).not.toBeNull();
    expect(imageStarted! - started).toBeLessThanOrEqual(LIMIT_MS);
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toMatchObject({ png: PNG });
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("holds the Test's launch to the Test's own time and ends it at the hard stop; an export's launch keeps the driver's own", async () => {
    vi.useFakeTimers();
    const contexts: RenderLaunchContext[] = [];
    // A browser that never answers its launch, ended only by its stop.
    const neverStarts: RenderDriver = {
      launch: (_path, _flags, context) => {
        contexts.push(context);
        return new Promise<RenderBrowser>((_resolve, reject) => {
          context.stop?.addEventListener("abort", () => reject(new Error("ended")), { once: true });
        });
      },
    };
    const testing = check(neverStarts).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].launchTimeoutMs).toBeGreaterThan(LIMIT_MS - 1_000);
    expect(contexts[0].launchTimeoutMs).toBeLessThanOrEqual(LIMIT_MS);
    expect(contexts[0].stop?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    expect(await testing).toMatchObject({ error: { code: "render_timeout" } });
    expect(contexts[0].stop?.aborted).toBe(true);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });

    vi.useRealTimers();
    const exporting = lane();
    const recorded: RenderDriver = { launch: (...args) => { contexts.push(args[2]); return exporting.driver.launch(...args); } };
    await expect(image(recorded)).resolves.toMatchObject({ png: PNG });
    expect(contexts[1]).not.toHaveProperty("launchTimeoutMs");
    expect(contexts[1]).not.toHaveProperty("stop");
  });

  it("keeps the Test's slot until its browser has closed, so an image asked after it never runs beside it", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    const slow = lane(false, 300);
    expect(await check(slow.driver)).toMatchObject({ png: PNG });
    await expect(image(slow.driver)).resolves.toMatchObject({ png: PNG });
    expect(slow.state.launched).toBe(2);
    expect(slow.state.most, "two browsers ran at once with Images at once 1").toBe(1);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("keeps an image's slot until its browser has closed, ending one whose close hangs by its own handle past the grace and waiting for its exit", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    vi.useFakeTimers();
    const hanging = lane(false, "held", 500), next = lane();
    try {
      const first = image(hanging.driver, "a");
      await vi.advanceTimersByTimeAsync(10);
      expect(hanging.state.closes).toHaveLength(1);
      const second = image(next.driver, "b");
      await vi.advanceTimersByTimeAsync(10);
      // The first browser is closing: the slot is still its own.
      expect(next.state.launched, "an image's browser started beside one still closing").toBe(0);
      expect(renderQueueState()).toEqual({ active: 1, waiting: 1 });
      // Past the grace it is ended outright, and the slot stays its own until it has exited.
      await vi.advanceTimersByTimeAsync(3_100);
      expect(hanging.state.killed).toBe(1);
      expect(next.state.launched, "an image's browser started beside one ended but not yet exited").toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(first).resolves.toMatchObject({ png: PNG });
      expect(hanging.state.killed).toBe(1);
      expect(hanging.state.live).toBe(0);
      await expect(second).resolves.toMatchObject({ png: PNG });
      expect(next.state.launched).toBe(1);
      expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
    } finally {
      hanging.finishCloses();
    }
  });

  it("ends a Test's browser whose close hangs by the Test's limit, its slot back by then", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    vi.useFakeTimers();
    const hanging = lane(true, "held");
    try {
      const started = Date.now();
      let answered: number | null = null;
      const testing = check(hanging.driver).finally(() => { answered = Date.now(); });
      await vi.advanceTimersByTimeAsync(LIMIT_MS - 500);
      hanging.releaseAll();
      await vi.advanceTimersByTimeAsync(10);
      expect(hanging.state.closes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await testing).toMatchObject({ png: PNG });
      expect(answered! - started).toBeLessThanOrEqual(LIMIT_MS);
      expect(hanging.state.killed, "the Test's browser was not ended by its limit").toBe(1);
      expect(hanging.state.live).toBe(0);
      expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
    } finally {
      hanging.finishCloses();
    }
  });

  it("keeps the Test's slot until its browser has exited when its close hangs and its exit lags its kill, so an image asked after it never runs beside it", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    vi.useFakeTimers();
    const browsers = lane(false, "held", 500);
    try {
      const testing = check(browsers.driver);
      await vi.advanceTimersByTimeAsync(10);
      expect(browsers.state.closes).toHaveLength(1);
      const exporting = image(browsers.driver, "b");
      // The Test's close is ended at its limit, its browser exiting half a
      // second later; the image's own close is ended past its grace.
      await vi.advanceTimersByTimeAsync(LIMIT_MS + 5_000);
      await expect(testing).resolves.toMatchObject({ png: PNG });
      await expect(exporting).resolves.toMatchObject({ png: PNG });
      expect(browsers.state.launched).toBe(2);
      expect(browsers.state.most, "two browsers ran at once with Images at once 1").toBe(1);
      expect(browsers.state.live).toBe(0);
      expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
    } finally {
      browsers.finishCloses();
    }
  });

  it("keeps the Test's slot until its browser has exited when its render runs past its limit and its exit lags its kill", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    vi.useFakeTimers();
    const test = lane(true, 0, 500), images = lane();
    let liveAtLaunch: number | null = null;
    const asked: RenderDriver = { launch: (...args) => { liveAtLaunch = test.state.live; return images.driver.launch(...args); } };
    const testing = check(test.driver).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(10);
    const waiting = image(asked, "b");
    await vi.advanceTimersByTimeAsync(LIMIT_MS + 1_000);
    expect(await testing).toMatchObject({ error: { code: "render_timeout" } });
    await expect(waiting).resolves.toMatchObject({ png: PNG });
    expect(test.state.killed).toBe(1);
    expect(liveAtLaunch, "an image's browser started beside the Test's, ended but not yet exited").toBe(0);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
    test.releaseAll();
  });

  it("keeps the Test's slot until a launch it stopped has ended, when the browser's exit lags the stop", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    vi.useFakeTimers();
    let starting = 0;
    // A browser that never answers its launch, gone half a second after its stop.
    const neverStarts: RenderDriver = {
      launch: (_path, _flags, context) => {
        starting += 1;
        return new Promise<RenderBrowser>((_resolve, reject) => {
          context.stop?.addEventListener("abort", () => setTimeout(() => { starting -= 1; reject(new Error("ended")); }, 500), { once: true });
        });
      },
    };
    const images = lane();
    let startingAtLaunch: number | null = null;
    const asked: RenderDriver = { launch: (...args) => { startingAtLaunch = starting; return images.driver.launch(...args); } };
    const testing = check(neverStarts).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(10);
    const waiting = image(asked, "b");
    await vi.advanceTimersByTimeAsync(LIMIT_MS + 1_000);
    expect(await testing).toMatchObject({ error: { code: "render_timeout" } });
    await expect(waiting).resolves.toMatchObject({ png: PNG });
    expect(startingAtLaunch, "an image's browser started beside the Test's, stopped but not yet gone").toBe(0);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it.each([1, 2])("never runs more browsers than Images at once (%i), images and Tests together", async cap => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = String(cap);
    const shared = lane();
    const work: Promise<unknown>[] = [];
    for (let round = 0; round < 6; round += 1) {
      work.push(image(shared.driver, `m${round}`), check(shared.driver), check(shared.driver));
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const answers = await Promise.all(work);
    expect(shared.state.most).toBeLessThanOrEqual(cap);
    expect(shared.state.live).toBe(0);
    // Some Tests answered busy, and every image was made.
    expect(answers.filter(answer => answer === "busy").length).toBeGreaterThan(0);
    expect(answers.filter(answer => typeof answer === "object").length).toBeGreaterThanOrEqual(6);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });
});
