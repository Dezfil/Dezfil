import { describe, expect, it, vi } from "vitest";
import { refreshSequentially } from "./refresh-sequentially";

describe("connection refresh all", () => {
  it("never starts a second snapshot while the first is in flight", async () => {
    let active = 0;
    let maximum = 0;
    const settled: string[] = [];
    const refresh = vi.fn(async (name: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      if (name === "broken") throw new Error("broken source");
    });

    await refreshSequentially(
      ["roads", "broken", "places"],
      refresh,
      (name) => settled.push(name),
    );

    expect(maximum).toBe(1);
    expect(refresh.mock.calls.map(([name]) => name)).toEqual([
      "roads",
      "broken",
      "places",
    ]);
    expect(settled).toEqual(["roads", "broken", "places"]);
  });

  it("a cancelled run never starts the snapshot after the cancel", async () => {
    const controller = new AbortController();
    const refresh = vi.fn(async (name: string) => {
      // The user cancels while the first row is in flight.
      if (name === "roads") controller.abort();
      await Promise.resolve();
    });

    await refreshSequentially(
      ["roads", "places"],
      refresh,
      undefined,
      controller.signal,
    );

    expect(refresh.mock.calls.map(([name]) => name)).toEqual(["roads"]);
  });
});
