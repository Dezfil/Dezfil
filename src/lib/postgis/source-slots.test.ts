import { describe, expect, it } from "vitest";
import { createSourceSlots, sourceCallLimit, workerPoolSize } from "./source-slots";

describe("the worker pool size, read as the runtime reads UV_THREADPOOL_SIZE", () => {
  it.each([
    [undefined, 4], ["16", 16], ["1", 1], ["0", 1], ["", 1], ["none", 1],
    [" 8", 8], ["12 workers", 12], ["1024", 1024], ["2000", 1024], ["-3", 1024],
  ])("%j starts %i workers", (value, size) => {
    expect(workerPoolSize(value)).toBe(size);
  });
});

it("lets source calls take three quarters of the pool, and leaves a worker free from two workers up", () => {
  expect([1, 2, 3, 4, 5, 8, 16, 1024].map(size => sourceCallLimit(size))).toEqual([1, 1, 2, 3, 3, 6, 12, 768]);
  for (let size = 2; size <= 1024; size++) expect(sourceCallLimit(size)).toBeLessThan(size);
});

it("hands out at most its limit, in the order asked, and passes a released slot on", async () => {
  const slots = createSourceSlots(2);
  const first = await slots.acquire(), second = await slots.acquire();
  const order: string[] = [];
  const third = slots.acquire().then(release => { order.push("third"); return release; });
  const fourth = slots.acquire().then(release => { order.push("fourth"); return release; });
  await Promise.resolve();
  expect(order).toEqual([]);
  expect(slots.state()).toEqual({ active: 2, waiting: 2 });
  // A second release of the same slot frees nothing more.
  first(); first();
  const thirdRelease = await third;
  await Promise.resolve();
  expect(order).toEqual(["third"]);
  expect(slots.state()).toEqual({ active: 2, waiting: 1 });
  second();
  const fourthRelease = await fourth;
  expect(order).toEqual(["third", "fourth"]);
  thirdRelease(); fourthRelease();
  expect(slots.state()).toEqual({ active: 0, waiting: 0 });
});

it("a caller that leaves while waiting takes no slot, keeps no place and gets its own reason", async () => {
  const slots = createSourceSlots(1);
  const held = await slots.acquire();
  const controller = new AbortController(), reason = new Error("refused while waiting");
  const leaving = slots.acquire(controller.signal), next = slots.acquire();
  controller.abort(reason);
  await expect(leaving).rejects.toBe(reason);
  expect(slots.state()).toEqual({ active: 1, waiting: 1 });
  held();
  const release = await next;
  expect(slots.state()).toEqual({ active: 1, waiting: 0 });
  release();
  // Already gone: refused at once, without a slot.
  await expect(slots.acquire(controller.signal)).rejects.toBe(reason);
  expect(slots.state()).toEqual({ active: 0, waiting: 0 });
});

it("refuses a limit that is not a positive integer", () => {
  for (const limit of [0, -1, 1.5, Number.NaN]) expect(() => createSourceSlots(limit)).toThrow(RangeError);
});
