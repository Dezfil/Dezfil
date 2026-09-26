import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThumbnailCapture } from "../map/capture";
import {
  createThumbnailRunner,
  type ThumbnailCyclePlan,
  type ThumbnailRunnerDeps,
} from "./thumbnail-cycle";

/**
 * The gates on a card image's capture cycle: the second image only for
 * a theme-following map, only after the first is stored, single-flight
 * latest-wins, a floor between offscreen renders, skipped while the
 * document is hidden, a hard timeout handed to the ground, and every
 * failure silent — the map's existing images are the storage's to keep,
 * so a failed cycle simply never completes.
 */

const capture = (): ThumbnailCapture => ({
  blob: new Blob(["live"]),
  width: 640,
  height: 360,
  overlay: { tag: "overlay" } as unknown as HTMLCanvasElement,
  camera: {
    lng: 1,
    lat: 2,
    zoom: 3,
    pitch: 4,
    bearing: 5,
    padding: { top: 62, right: 14, bottom: 14, left: 372 },
  },
  host: { cssWidth: 1200, cssHeight: 800, pixelRatio: 2 },
  paintedStyleUrl: "https://tiles.test/styles/positron",
});

const themed: ThumbnailCyclePlan = {
  themed: {
    theme: "light",
    live: {
      theme: "light",
      styleUrl: "https://tiles.test/styles/positron",
      fallbackColor: "#e9ecef",
    },
    other: {
      theme: "dark",
      styleUrl: "https://tiles.test/styles/dark",
      fallbackColor: "#0b0e14",
    },
    basemapLayers: { labels: false },
    basemapKind: "vector",
  },
};

const single: ThumbnailCyclePlan = { themed: null };

function harness(over: Partial<ThumbnailRunnerDeps> = {}) {
  const uploads: { query: string; body: string }[] = [];
  const grounds: { req: Parameters<ThumbnailRunnerDeps["renderGround"]>[0]; resolve: (c: HTMLCanvasElement) => void; reject: (e: Error) => void }[] = [];
  let tokens = 0;
  const deps: ThumbnailRunnerDeps = {
    capture: async () => capture(),
    upload: async (query, blob) => {
      uploads.push({ query, body: await blob.text() });
      return true;
    },
    renderGround: (req) =>
      new Promise((resolve, reject) => {
        grounds.push({ req, resolve, reject });
      }),
    compose: async (ground) =>
      new Blob([`composed:${(ground as unknown as { tag: string }).tag}`]),
    hidden: () => false,
    mintCycle: () => `cycle-${++tokens}`,
    ...over,
  };
  const runner = createThumbnailRunner(deps, { floorMs: 10_000, timeoutMs: 20_000 });
  return { deps, runner, uploads, grounds };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the thumbnail cycle's gates", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("a map on a chosen basemap stores one image and never starts a ground", async () => {
    const h = harness();
    await h.runner.run(single);
    expect(h.uploads).toEqual([{ query: "", body: "live" }]);
    expect(h.grounds).toEqual([]);
  });

  it("a theme-following map stores the live theme's image, then the other theme's under the same cycle", async () => {
    const h = harness();
    const done = h.runner.run(themed);
    await flush();
    expect(h.uploads).toEqual([{ query: "theme=light&cycle=cycle-1", body: "live" }]);
    expect(h.grounds).toHaveLength(1);
    const { req } = h.grounds[0];
    expect(req).toMatchObject({
      styleUrl: "https://tiles.test/styles/dark",
      camera: capture().camera,
      host: capture().host,
      basemapLayers: { labels: false },
      basemapKind: "vector",
      fallbackColor: "#0b0e14",
      timeoutMs: 20_000,
    });
    expect(req.signal?.aborted).toBe(false);
    h.grounds[0].resolve({ tag: "ground" } as unknown as HTMLCanvasElement);
    await done;
    expect(h.uploads[1]).toEqual({
      query: "theme=dark&cycle=cycle-1",
      body: "composed:ground",
    });
  });

  it("starts the ground only after the first image is stored: a refused first write ends the cycle", async () => {
    const h = harness({ upload: async () => false });
    await h.runner.run(themed);
    expect(h.grounds).toEqual([]);
  });

  it("skips the ground while the document is hidden; the first image still lands", async () => {
    const h = harness({ hidden: () => true });
    await h.runner.run(themed);
    expect(h.uploads).toHaveLength(1);
    expect(h.grounds).toEqual([]);
  });

  it("is single-flight, latest wins: a new cycle abandons the running ground and its late result is never stored", async () => {
    const h = harness();
    const runner = createThumbnailRunner(h.deps, { floorMs: 0, timeoutMs: 20_000 });
    const first = runner.run(themed);
    await flush();
    expect(h.grounds).toHaveLength(1);
    const second = runner.run(themed);
    await flush();
    expect(h.grounds[0].req.signal?.aborted).toBe(true);
    expect(h.grounds).toHaveLength(2);
    // The first ground resolves late anyway: nothing of it is stored.
    h.grounds[0].resolve({ tag: "stale" } as unknown as HTMLCanvasElement);
    await first;
    expect(h.uploads.map((u) => u.query)).toEqual([
      "theme=light&cycle=cycle-1",
      "theme=light&cycle=cycle-2",
    ]);
    h.grounds[1].resolve({ tag: "fresh" } as unknown as HTMLCanvasElement);
    await second;
    expect(h.uploads[2]).toEqual({
      query: "theme=dark&cycle=cycle-2",
      body: "composed:fresh",
    });
  });

  it("keeps a floor between grounds, and a cycle waiting on the floor is superseded like any other", async () => {
    const h = harness();
    const first = h.runner.run(themed);
    await flush();
    expect(h.grounds).toHaveLength(1);
    h.grounds[0].resolve({ tag: "g1" } as unknown as HTMLCanvasElement);
    await first;
    // Four seconds later: the next cycle stores its first image at once
    // but its ground waits for the floor.
    await vi.advanceTimersByTimeAsync(4_000);
    const second = h.runner.run(themed);
    await flush();
    expect(h.uploads.map((u) => u.query)).toContain("theme=light&cycle=cycle-2");
    expect(h.grounds).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.grounds).toHaveLength(1);
    // A third cycle during the wait supersedes the second before it starts.
    const third = h.runner.run(themed);
    await flush();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(h.grounds).toHaveLength(2);
    expect(h.grounds[1].req.signal?.aborted).toBe(false);
    await second;
    h.grounds[1].resolve({ tag: "g3" } as unknown as HTMLCanvasElement);
    await third;
    expect(h.uploads.map((u) => u.query)).toEqual([
      "theme=light&cycle=cycle-1",
      "theme=dark&cycle=cycle-1",
      "theme=light&cycle=cycle-2",
      "theme=light&cycle=cycle-3",
      "theme=dark&cycle=cycle-3",
    ]);
  });

  it("every failure is silent and stores no second image: a ground that rejects, a composite that is null, a capture that throws", async () => {
    const rejecting = harness();
    const run = rejecting.runner.run(themed);
    await flush();
    rejecting.grounds[0].reject(new Error("timeout"));
    await expect(run).resolves.toBeUndefined();
    expect(rejecting.uploads).toHaveLength(1);

    const empty = harness({ compose: async () => null });
    const run2 = empty.runner.run(themed);
    await flush();
    empty.grounds[0].resolve({ tag: "g" } as unknown as HTMLCanvasElement);
    await expect(run2).resolves.toBeUndefined();
    expect(empty.uploads).toHaveLength(1);

    const throwing = harness({
      capture: async () => {
        throw new Error("no canvas");
      },
    });
    await expect(throwing.runner.run(themed)).resolves.toBeUndefined();
    expect(throwing.uploads).toEqual([]);
    expect(throwing.grounds).toEqual([]);
  });

  it("a failed second write is silent too", async () => {
    let calls = 0;
    const h = harness({
      upload: async () => {
        calls += 1;
        if (calls === 2) throw new Error("network");
        return true;
      },
    });
    const run = h.runner.run(themed);
    await flush();
    h.grounds[0].resolve({ tag: "g" } as unknown as HTMLCanvasElement);
    await expect(run).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("disposing abandons the running ground", async () => {
    const h = harness();
    const run = h.runner.run(themed);
    await flush();
    h.runner.dispose();
    expect(h.grounds[0].req.signal?.aborted).toBe(true);
    h.grounds[0].resolve({ tag: "late" } as unknown as HTMLCanvasElement);
    await run;
    expect(h.uploads).toHaveLength(1);
  });
});

describe("cancellation exists before the first await, and the theme is the painted one", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("disposing the runner while the first write is in flight stops the cycle: no ground, no second write", async () => {
    let release: (ok: boolean) => void = () => {};
    const h = harness({
      upload: (query) =>
        new Promise((resolve) => {
          release = resolve;
          void query;
        }),
    });
    const run = h.runner.run(themed);
    await flush();
    h.runner.dispose();
    release(true);
    await run;
    expect(h.grounds).toEqual([]);
  });

  it("an older cycle whose capture resolves late never stores, and never abandons the newer cycle", async () => {
    const captures: ((c: ThumbnailCapture) => void)[] = [];
    const h = harness({
      capture: () => new Promise((resolve) => captures.push(resolve)),
    });
    const runner = createThumbnailRunner(h.deps, { floorMs: 0, timeoutMs: 20_000 });
    const older = runner.run(themed);
    const newer = runner.run(themed);
    await flush();
    // The newer cycle captures and proceeds first.
    captures[1](capture());
    await flush();
    expect(h.uploads.map((u) => u.query)).toEqual(["theme=light&cycle=cycle-1"]);
    expect(h.grounds).toHaveLength(1);
    // The older capture resolves afterwards: nothing of it is stored and
    // the newer ground is still alive.
    captures[0](capture());
    await older;
    expect(h.uploads).toHaveLength(1);
    expect(h.grounds).toHaveLength(1);
    expect(h.grounds[0].req.signal?.aborted).toBe(false);
    h.grounds[0].resolve({ tag: "g" } as unknown as HTMLCanvasElement);
    await newer;
    expect(h.uploads.map((u) => u.query)).toEqual([
      "theme=light&cycle=cycle-1",
      "theme=dark&cycle=cycle-1",
    ]);
  });

  it("a capture painted in the other theme's style is stored under that theme, and the ground is rendered for the plan's own", async () => {
    const h = harness({
      capture: async () => ({ ...capture(), paintedStyleUrl: "https://tiles.test/styles/dark" }),
    });
    const run = h.runner.run(themed);
    await flush();
    expect(h.uploads.map((u) => u.query)).toEqual(["theme=dark&cycle=cycle-1"]);
    expect(h.grounds[0].req).toMatchObject({
      styleUrl: "https://tiles.test/styles/positron",
      fallbackColor: "#e9ecef",
    });
    h.grounds[0].resolve({ tag: "g" } as unknown as HTMLCanvasElement);
    await run;
    expect(h.uploads[1].query).toBe("theme=light&cycle=cycle-1");
  });

  it("a capture painted on the fallback (no style) is labelled with the plan's theme", async () => {
    const h = harness({
      capture: async () => ({ ...capture(), paintedStyleUrl: null }),
    });
    const run = h.runner.run(themed);
    await flush();
    expect(h.uploads.map((u) => u.query)).toEqual(["theme=light&cycle=cycle-1"]);
    h.grounds[0].resolve({ tag: "g" } as unknown as HTMLCanvasElement);
    await run;
  });
});

