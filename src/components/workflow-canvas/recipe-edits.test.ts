import { describe, it, expect } from "vitest";
import { EditLanes } from "./recipe-edits";

describe("the recipe-edit lanes", () => {
  it("serializes one node's edits, newest waiting sent when the flight lands, while other nodes run side by side", async () => {
    const lanes = new EditLanes<number>();
    expect(lanes.offer("a", 1)).toEqual({ send: 1, superseded: null });
    expect(lanes.offer("a", 2)).toEqual({ send: null, superseded: null });
    expect(lanes.offer("a", 3)).toEqual({ send: null, superseded: 2 });
    // Another node is not held up.
    expect(lanes.offer("b", 9)).toEqual({ send: 9, superseded: null });
    expect(lanes.busy("a")).toBe(true);
    let idle = false;
    void lanes.whenIdle("a").then(() => {
      idle = true;
    });
    expect(lanes.landed("a")).toBe(3);
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(lanes.landed("a")).toBeNull();
    await Promise.resolve();
    expect(idle).toBe(true);
    expect(lanes.busy("a")).toBe(false);
    expect(lanes.landed("b")).toBeNull();
    await expect(lanes.whenIdle("b")).resolves.toBeUndefined();
  });
});
