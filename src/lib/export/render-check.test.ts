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

/**
 * The image renderer's Test on the image lane, over injected drivers: it
 * takes a slot only when one is free now and no image waits, else answers
 * busy at once and launches nothing; an image asked while it runs waits
 * for it as behind any image, and starts by the Test's hard stop at the
 * latest, the Test's browser killed; and the lane never runs more
 * browsers than Images at once. No real browser anywhere.
 */

const def = () => initialDefinition(
  { appearance: "light", camera: { lng: 13.4, lat: 52.5, zoom: 11 }, canvasWidth: 1200, legendPresent: false, legendCorner: null, visibleWidgetIds: [], basemapLayers: null },
  { width: 1920, scale: 1 },
);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const LIMIT_MS = 10_000;

/** A driver whose every browser is counted while it lives: launched and
 * not yet closed or killed. `hold` keeps each render open until released. */
function lane(hold = false) {
  const state = { launched: 0, live: 0, most: 0, killed: 0, urls: [] as string[], releases: [] as (() => void)[] };
  const driver: RenderDriver = {
    async launch() {
      state.launched += 1; state.live += 1; state.most = Math.max(state.most, state.live);
      let gone = false;
      const leave = () => { if (!gone) { gone = true; state.live -= 1; } };
      const browser: RenderBrowser = {
        async render(input) {
          state.urls.push(input.url);
          if (hold) await new Promise<void>(resolve => state.releases.push(resolve));
          else await new Promise(resolve => setTimeout(resolve, 5));
          return { png: PNG };
        },
        async close() { leave(); },
        kill() { state.killed += 1; leave(); },
      };
      return browser;
    },
  };
  return { driver, state, releaseAll: () => { for (const release of state.releases.splice(0)) release(); } };
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
