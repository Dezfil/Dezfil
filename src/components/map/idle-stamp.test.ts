import { describe, expect, it } from "vitest";
import { MAP_IDLE_KEY, attachIdleStamp } from "./idle-stamp";

/** A map that fires the events the stamp listens to, and counts what is
 * still listening. */
function harness() {
  const listeners = new Map<string, Set<() => void>>();
  const instance = {
    on(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
      return instance;
    },
    off(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
      return instance;
    },
  };
  const fire = (type: string) => { for (const listener of listeners.get(type) ?? []) listener(); };
  const listening = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  const dataset: Record<string, string> = {};
  const dispose = attachIdleStamp(instance as never, { dataset } as unknown as HTMLElement);
  return { fire, listening, dataset, dispose };
}

describe("the idle stamp", () => {
  it("is absent until the map first comes to rest", () => {
    const h = harness();
    expect(h.dataset[MAP_IDLE_KEY]).toBeUndefined();
    h.fire("idle");
    expect(h.dataset[MAP_IDLE_KEY]).toBe("");
  });

  it("clears when data starts loading or the camera moves, and returns at the next rest", () => {
    const h = harness();
    for (const busy of ["dataloading", "movestart"]) {
      h.fire("idle");
      expect(h.dataset[MAP_IDLE_KEY]).toBe("");
      h.fire(busy);
      expect(h.dataset[MAP_IDLE_KEY]).toBeUndefined();
      // A frame drawn while tiles are still arriving is not a rest.
      h.fire("render");
      expect(h.dataset[MAP_IDLE_KEY]).toBeUndefined();
    }
    h.fire("idle");
    expect(h.dataset[MAP_IDLE_KEY]).toBe("");
  });

  it("stops listening and clears the stamp when disposed", () => {
    const h = harness();
    h.fire("idle");
    expect(h.listening()).toBe(3);
    h.dispose();
    expect(h.listening()).toBe(0);
    expect(h.dataset[MAP_IDLE_KEY]).toBeUndefined();
    h.fire("idle");
    expect(h.dataset[MAP_IDLE_KEY]).toBeUndefined();
  });
});
