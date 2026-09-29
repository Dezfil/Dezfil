import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, afterEach } from "vitest";
import { EvaluationCancelled } from "@/lib/api/errors";
import {
  renderMapImage,
  renderQueueState,
  renderStats,
  type RenderBrowser,
  type RenderDriver,
} from "./render-image";
import { initialDefinition } from "./image-definition";
import { limits } from "@/lib/limits";

/**
 * The renderer's bounds and lifecycle, over an injected driver: the cap
 * queues, the budget covers the wait, timeout / crash / cancel each
 * release the slot and kill the browser, and a missing browser answers
 * its coded error. No real browser anywhere.
 */

const def = () =>
  initialDefinition(
    {
      appearance: "light",
      camera: { lng: 13.4, lat: 52.5, zoom: 11 },
      canvasWidth: 1200,
      legendPresent: false,
      legendCorner: null,
      visibleWidgetIds: [],
      basemapLayers: null,
    },
    { width: 1920, scale: 1 },
  );

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function browserStub(overrides: Partial<RenderBrowser> = {}): {
  browser: RenderBrowser;
  killed: () => boolean;
} {
  let killed = false;
  const browser: RenderBrowser = {
    render: async () => ({ png: PNG }),
    close: async () => {},
    kill: () => {
      killed = true;
    },
    ...overrides,
  };
  return { browser, killed: () => killed };
}

function driverOf(browser: RenderBrowser): RenderDriver {
  return { launch: async () => browser };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  delete process.env.DEZFIL_EXPORT_RENDER_TIMEOUT_S;
  delete process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY;
});

describe("renderMapImage — bounds and lifecycle", () => {
  it("renders through the driver and returns the bytes", async () => {
    const { browser } = browserStub();
    const png = await renderMapImage(testAccountScope(), {
      mapId: "m1",
      definition: def(),
      credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3000",
      driver: driverOf(browser),
    });
    expect(png.png).toBe(PNG);
    expect(png.abandoned).toEqual([]);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("a missing browser answers render_unavailable and releases its slot", async () => {
    const driver: RenderDriver = {
      launch: async () => {
        throw new Error("ENOENT");
      },
    };
    await expect(
      renderMapImage(testAccountScope(), {
        mapId: "m1",
        definition: def(),
        credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3000",
        driver,
      }),
    ).rejects.toMatchObject({ code: "render_unavailable" });
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("at cap 1 the second render queues; the first's release lets it run", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const slow = browserStub({
      render: async () => {
        await gate;
        return { png: PNG };
      },
    });
    const fast = browserStub();
    const first = renderMapImage(testAccountScope(), {
      mapId: "a",
      definition: def(),
      credential: "fixture-render-credential", baseUrl: "http://x",
      driver: driverOf(slow.browser),
    });
    // Give the first render its slot before the second asks.
    await new Promise((r) => setTimeout(r, 10));
    const second = renderMapImage(testAccountScope(), {
      mapId: "b",
      definition: def(),
      credential: "fixture-render-credential", baseUrl: "http://x",
      driver: driverOf(fast.browser),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(renderQueueState()).toEqual({ active: 1, waiting: 1 });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ png: PNG });
    await expect(second).resolves.toMatchObject({ png: PNG });
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("a queued render past the budget answers render_timeout", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    // Give the admitted render a longer captured budget, then prove the
    // later request's shorter queue budget independently.
    process.env.DEZFIL_EXPORT_RENDER_TIMEOUT_S = "0.2";
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const slow = browserStub({
      render: async () => {
        await gate;
        return { png: PNG };
      },
    });
    const first = renderMapImage(testAccountScope(), {
      mapId: "a",
      definition: def(),
      credential: "fixture-render-credential", baseUrl: "http://x",
      driver: driverOf(slow.browser),
    });
    process.env.DEZFIL_EXPORT_RENDER_TIMEOUT_S = "0.05";
    await expect(
      renderMapImage(testAccountScope(), {
        mapId: "b",
        definition: def(),
        credential: "fixture-render-credential", baseUrl: "http://x",
        driver: driverOf(browserStub().browser),
      }),
    ).rejects.toMatchObject({ code: "render_timeout" });
    releaseFirst();
    await first;
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  }, 10_000);

  it("a crash mid-render answers render_failed and frees the slot", async () => {
    const crashing = browserStub({
      render: async () => {
        throw new Error("Target closed");
      },
    });
    await expect(
      renderMapImage(testAccountScope(), {
        mapId: "m1",
        definition: def(),
        credential: "fixture-render-credential", baseUrl: "http://x",
        driver: driverOf(crashing.browser),
      }),
    ).rejects.toMatchObject({ code: "render_failed" });
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("the route's worded failure surfaces as render_failed prose", async () => {
    const failing = browserStub({
      render: async () => ({ failed: "The map could not be loaded (404)." }),
    });
    await expect(
      renderMapImage(testAccountScope(), {
        mapId: "m1",
        definition: def(),
        credential: "fixture-render-credential", baseUrl: "http://x",
        driver: driverOf(failing.browser),
      }),
    ).rejects.toMatchObject({
      code: "render_failed",
      message: "The map could not be loaded (404).",
    });
  });

  it("cancelling a never-settling render kills it and hands its slot to queued work", async () => {
    process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
    const controller = new AbortController();
    const started = deferred<void>();
    const held = browserStub({
      render: () => {
        started.resolve();
        return new Promise(() => {});
      },
    });
    const first = renderMapImage(testAccountScope(), {
      mapId: "held",
      definition: def(),
      credential: "fixture-render-credential", baseUrl: "http://x",
      signal: controller.signal,
      driver: driverOf(held.browser),
    });
    await started.promise;
    const second = renderMapImage(testAccountScope(), {
      mapId: "queued",
      definition: def(),
      credential: "fixture-render-credential", baseUrl: "http://x",
      driver: driverOf(browserStub().browser),
    });
    expect(renderQueueState()).toEqual({ active: 1, waiting: 1 });

    controller.abort();
    await expect(first).rejects.toBeInstanceOf(EvaluationCancelled);
    await expect(second).resolves.toMatchObject({ png: PNG });
    expect(held.killed()).toBe(true);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("a genuinely never-settling active render answers the coded timeout", async () => {
    process.env.DEZFIL_EXPORT_RENDER_TIMEOUT_S = "0.05";
    const hung = browserStub({
      render: () => new Promise(() => {}),
    });
    const run = renderMapImage(testAccountScope(), {
      mapId: "m1",
      definition: def(),
      credential: "fixture-render-credential", baseUrl: "http://x",
      driver: driverOf(hung.browser),
    });
    // Exactly the coded timeout: a watchdog expiry that
    // reads as render_failed is a misclassification, not a pass.
    await expect(run).rejects.toMatchObject({ code: "render_timeout" });
    expect(hung.killed()).toBe(true);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  }, 10_000);

  it("a late resolution cannot replace an active-render timeout", async () => {
    process.env.DEZFIL_EXPORT_RENDER_TIMEOUT_S = "0.05";
    const late = deferred<{ png: Uint8Array } | { failed: string }>();
    const held = browserStub({ render: () => late.promise });
    const run = renderMapImage(testAccountScope(), {
      mapId: "m1",
      definition: def(),
      credential: "fixture-render-credential", baseUrl: "http://x",
      driver: driverOf(held.browser),
    });

    await expect(run).rejects.toMatchObject({ code: "render_timeout" });
    late.resolve({ png: PNG });
    await Promise.resolve();

    await expect(run).rejects.toMatchObject({ code: "render_timeout" });
    expect(held.killed()).toBe(true);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("a late rejection after cancellation is observed and stays cancelled", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const late = deferred<{ png: Uint8Array } | { failed: string }>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const held = browserStub({
        render: () => {
          started.resolve();
          return late.promise;
        },
      });
      const run = renderMapImage(testAccountScope(), {
        mapId: "m1",
        definition: def(),
        credential: "fixture-render-credential", baseUrl: "http://x",
        signal: controller.signal,
        driver: driverOf(held.browser),
      });
      await started.promise;

      controller.abort();
      await expect(run).rejects.toBeInstanceOf(EvaluationCancelled);
      late.reject(new Error("late renderer rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      await expect(run).rejects.toBeInstanceOf(EvaluationCancelled);
      expect(unhandled).toEqual([]);
      expect(held.killed()).toBe(true);
      expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("carries the abandoned requests the driver reports, one entry per request", async () => {
    const { browser } = browserStub({
      render: async () => ({
        png: PNG,
        abandoned: ["tiles.example", "tiles.example"],
      }),
    });
    const result = await renderMapImage(testAccountScope(), {
      mapId: "m",
      definition: def(),
      credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3000",
      driver: driverOf(browser),
    });
    expect(result.png).toBe(PNG);
    expect(result.abandoned).toEqual(["tiles.example", "tiles.example"]);
  });

  it("hands the driver a per-request bound that fits the call's own budget", async () => {
    const seen: number[] = [];
    const { browser } = browserStub({
      render: async (input) => { seen.push(input.requestBoundMs); return { png: PNG }; },
    });
    await renderMapImage(testAccountScope(), { mapId: "m", definition: def(), credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3000", driver: driverOf(browser) });
    await renderMapImage(testAccountScope(), { mapId: "m", definition: def(), credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3000", driver: driverOf(browser), budgetMs: 30_000 });
    expect(seen).toEqual([limits.exportRequestTimeoutMs, 10_000]);
    expect(seen[1]).toBeLessThan(seen[0]);
  });
});

describe("physical renders are counted at the renderer", () => {
  it("every launch attempt counts, a failed one too, so a live figure reads the renderer rather than successful results", async () => {
    const before = renderStats().launches;
    const { browser } = browserStub();
    await renderMapImage(testAccountScope(), { mapId: "m1", definition: def(), credential: "fixture-render-credential", baseUrl: "http://x", driver: driverOf(browser) });
    await expect(renderMapImage(testAccountScope(), { mapId: "m1", definition: def(), credential: "fixture-render-credential", baseUrl: "http://x", driver: { launch: async () => { throw new Error("ENOENT"); } } })).rejects.toMatchObject({ code: "render_unavailable" });
    expect(renderStats().launches - before).toBe(2);
  });
});
