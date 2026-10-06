import { mkdtempSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { writeStoredSettings } from "./store";
import * as lane from "@/lib/operations/lane";
import * as renderer from "@/lib/export/render-image";
import { initialDefinition } from "@/lib/export/image-definition";
import { rateLimit, resetRateLimits, tileMaxPerWindow } from "@/lib/publish/rate-limit";

const root = process.env.DEZFIL_DATA_DIR!;
const cleanups: (() => void)[] = [], runs: Promise<unknown>[] = [];
beforeEach(() => {
  vi.stubEnv("DEZFIL_DATA_DIR", mkdtempSync(path.join(root, "live-lanes-")));
  for (const key of ["OPERATION_CONCURRENCY", "OPERATION_QUEUE_MAX", "EXPORT_RENDER_CONCURRENCY", "EXPORT_RENDER_TIMEOUT_S", "PUBLIC_RATE_LIMIT", "PUBLIC_TILE_RATE_LIMIT"]) vi.stubEnv(`DEZFIL_${key}`, "");
  closeMetadataDb(); metadataDb(); lane.resetLane(); resetRateLimits();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.allSettled(runs.splice(0)); await lane.laneSettled();
  lane.resetLane(); resetRateLimits(); closeMetadataDb(); vi.useRealTimers(); vi.unstubAllEnvs();
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const write = (values: Record<string, number>) => writeStoredSettings(values, metadataDb());
function operation(id: string, order: string[]) {
  const held = Promise.withResolvers<void>(); cleanups.push(held.resolve);
  lane.submit(id, async () => { order.push(id); await held.promise; });
  return held;
}
const definition = initialDefinition({ appearance: "light", camera: { lng: 0, lat: 0, zoom: 2 }, canvasWidth: 800,
  legendPresent: false, legendCorner: null, visibleWidgetIds: [], basemapLayers: null }, { width: 800, scale: 1 });
function image(id: string, order: string[], module = renderer, scope = testAccountScope(), signal?: AbortSignal) {
  const held = Promise.withResolvers<void>(); cleanups.push(held.resolve);
  const run = module.renderMapImage(scope, { mapId: id, definition, credential: `fixture-${id}`, baseUrl: "http://instance.test", signal,
    driver: { launch: async () => ({ render: async () => { order.push(id); await held.promise; return { png: new Uint8Array([1]) }; },
      close: async () => {}, kill: () => {} }) } });
  runs.push(run); void run.catch(() => {});
  return { ...held, run };
}

it("drains operation concurrency after a decrease and preserves accepted FIFO waiters when the queue shrinks", async () => {
  write({ operationConcurrency: 3, operationQueueMax: 3 });
  const order: string[] = [], a = operation("a", order), b = operation("b", order), c = operation("c", order);
  const d = operation("d", order), e = operation("e", order), f = operation("f", order);
  write({ operationConcurrency: 1, operationQueueMax: 1 });
  expect(lane.laneDepth()).toEqual({ executing: 3, waiting: 3 });
  expect(() => lane.submit("overflow", async () => {})).toThrow(/already waiting/);
  a.resolve(); await flush(); b.resolve(); await flush();
  expect(order).toEqual(["a", "b", "c"]);
  c.resolve(); await flush(); expect(order).toEqual(["a", "b", "c", "d"]);
  d.resolve(); await flush(); e.resolve(); await flush(); f.resolve(); await lane.laneSettled();
  expect(order).toEqual(["a", "b", "c", "d", "e", "f"]);
});

it("wakes the operation lane only after an increase commits, with no release or new submission", async () => {
  write({ operationConcurrency: 1 });
  const order: string[] = []; operation("a", order); operation("b", order); operation("c", order);
  expect(() => metadataDb().transaction(() => { write({ operationConcurrency: 3 }); throw new Error("rollback"); })()).toThrow();
  expect(order).toEqual(["a"]);
  metadataDb().transaction(() => { write({ operationConcurrency: 2 }); expect(order).toEqual(["a"]); })();
  expect(order).toEqual(["a", "b"]);
  expect(lane.cancel("c")).toBe(true); write({ operationConcurrency: 3 }); expect(order).toEqual(["a", "b"]);
});

it("never hands an image slot to a waiter above a lowered concurrency", async () => {
  write({ exportRenderConcurrency: 3 });
  const order: string[] = [], a = image("a", order), b = image("b", order), c = image("c", order);
  image("d", order); image("e", order); await flush();
  write({ exportRenderConcurrency: 1 });
  a.resolve(); await a.run; await flush();
  expect(renderer.renderQueueState()).toEqual({ active: 2, waiting: 2 });
  b.resolve(); await b.run; await flush(); expect(order).toEqual(["a", "b", "c"]);
  c.resolve(); await c.run; await flush(); expect(order).toEqual(["a", "b", "c", "d"]);
});

it("wakes queued images after an increase commits and skips a cancelled waiter", async () => {
  write({ exportRenderConcurrency: 1 });
  const order: string[] = [], cancelled = new AbortController();
  image("a", order); const b = image("b", order, renderer, testAccountScope(), cancelled.signal); image("c", order); image("d", order);
  await flush(); cancelled.abort(); await expect(b.run).rejects.toThrow();
  expect(() => metadataDb().transaction(() => { write({ exportRenderConcurrency: 3 }); throw new Error("rollback"); })()).toThrow();
  expect(renderer.renderQueueState()).toEqual({ active: 1, waiting: 2 });
  metadataDb().transaction(() => { write({ exportRenderConcurrency: 2 }); expect(renderer.renderQueueState()).toEqual({ active: 1, waiting: 2 }); })();
  await flush(); expect(order).toEqual(["a", "c"]);
  expect(renderer.renderQueueState()).toEqual({ active: 2, waiting: 1 });
});

it("shares image occupancy across two loaded route bundles", async () => {
  write({ exportRenderConcurrency: 1 });
  const order: string[] = [], first = image("a", order); await flush();
  vi.resetModules();
  const other = await import("@/lib/export/render-image"), accounts = await import("@/lib/test-support/accounts");
  const otherDb = await import("@/lib/metadata/db");
  try {
    const next = image("b", order, other, accounts.testAccountScope()); await flush();
    expect(other.renderQueueState()).toEqual({ active: 1, waiting: 1 });
    expect(renderer.renderQueueState()).toEqual({ active: 1, waiting: 1 });
    first.resolve(); await first.run; await flush(); expect(order).toEqual(["a", "b"]);
    next.resolve(); await next.run;
  } finally { for (const cleanup of cleanups) cleanup(); await Promise.allSettled(runs); otherDb.closeMetadataDb(); }
});

it("keeps active and waiting image deadlines and timeout messages at their admitted budget", async () => {
  write({ exportRenderConcurrency: 1, exportRenderTimeoutS: 20 });
  vi.useFakeTimers();
  const order: string[] = [], active = image("active", order), waiting = image("waiting", order);
  await vi.advanceTimersByTimeAsync(0);
  write({ exportRenderTimeoutS: 10 });
  const later = image("later", order);
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(later.run).rejects.toMatchObject({ code: "render_timeout", message: expect.stringContaining("10s export budget") });
  expect(renderer.renderQueueState()).toEqual({ active: 1, waiting: 1 });
  await vi.advanceTimersByTimeAsync(10_000);
  for (const admitted of [active, waiting]) await expect(admitted.run).rejects.toMatchObject({ code: "render_timeout", message: expect.stringContaining("20s export budget") });
  expect(order).toEqual(["active"]);
  expect(renderer.renderQueueState()).toEqual({ active: 0, waiting: 0 });
});

it.each(["view", "tile"])("keeps the %s window count and expiry through a decrease and an increase", kind => {
  const setting = kind === "view" ? "publicRateLimit" : "publicTileRateLimit";
  const request = (now: number) => rateLimit(kind, now, kind === "tile" ? tileMaxPerWindow() : undefined);
  write({ [setting]: 3 });
  expect([request(1), request(2), request(3), request(4)]).toEqual([true, true, true, false]);
  write({ [setting]: 2 }); expect(request(5000)).toBe(false);
  write({ [setting]: 4 }); expect([request(6000), request(6001), request(10_000)]).toEqual([true, false, false]);
  expect(request(10_001)).toBe(true);
});
