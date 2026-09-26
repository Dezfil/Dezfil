import { describe, expect, it } from "vitest";
import { createPaintedStyleStamp } from "./painted-style";

/**
 * the painted-style stamp must name the
 * request that completed, never the latest requested. MapLibre fires
 * "style.load" without detail when a fresh style object finishes
 * loading and with a `style` detail when a diff is applied in place; a
 * newer diffed request aborts an older diffed one, so the one ordering
 * that survives is the constructor's initial request completing after a
 * toggle has requested the other style.
 */

function harness(initialUrl: string) {
  const s1 = { id: "S1" };
  const s2 = { id: "S2" };
  const dataset: Record<string, string> = {};
  const instance = { style: s1 as unknown };
  const stamp = createPaintedStyleStamp(
    instance as { style: unknown },
    { dataset } as unknown as HTMLElement,
    initialUrl,
  );
  return { stamp, dataset, instance, s1, s2 };
}

describe("the painted-style stamp", () => {
  it("the initial request completing after a toggle stamps the initial style, then the diff stamps the toggled one", () => {
    const h = harness("https://tiles.test/positron");
    // Toggle while the initial request is in flight: the latest requested
    // is dark, but what loads first is the initial positron.
    h.stamp.onStyleLoad({}, "https://tiles.test/dark", false);
    expect(h.dataset.paintedBasemap).toBe("https://tiles.test/positron");
    // Then the diff applies dark in place: the event carries the style.
    h.stamp.onStyleLoad({ style: h.s1 }, "https://tiles.test/dark", false);
    expect(h.dataset.paintedBasemap).toBe("https://tiles.test/dark");
  });

  it("a rebuilt style (a new style object, no detail) is the latest request", () => {
    const h = harness("https://tiles.test/positron");
    h.instance.style = h.s2;
    h.stamp.onStyleLoad({}, "https://tiles.test/dark", false);
    expect(h.dataset.paintedBasemap).toBe("https://tiles.test/dark");
  });

  it("the plain initial load stamps the initial request", () => {
    const h = harness("https://tiles.test/positron");
    h.stamp.onStyleLoad({}, "https://tiles.test/positron", false);
    expect(h.dataset.paintedBasemap).toBe("https://tiles.test/positron");
  });

  it("the fallback clears the stamp, and a retry after it stamps the retried style", () => {
    const h = harness("https://tiles.test/positron");
    h.stamp.onStyleLoad({}, "https://tiles.test/positron", false);
    h.stamp.onStyleLoad({ style: h.s1 }, "https://tiles.test/positron", true);
    expect(h.dataset.paintedBasemap).toBeUndefined();
    h.stamp.onStyleLoad({ style: h.s1 }, "https://tiles.test/dark", false);
    expect(h.dataset.paintedBasemap).toBe("https://tiles.test/dark");
  });
});
