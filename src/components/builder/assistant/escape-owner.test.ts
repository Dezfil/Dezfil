import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantOwnsEscape } from "./escape-owner";

/** Focus decides Escape's owner. The DOM here is a minimal stand-in for
 * an element tree, enough for the closest() walk the rule makes. */
class FakeElement {
  constructor(readonly attributes: Record<string, string>, readonly parent: FakeElement | null = null) {}
  closest(selector: string): FakeElement | null {
    const name = selector.slice(1, -1);
    for (let node: FakeElement | null = this as FakeElement; node; node = node.parent) if (name in node.attributes) return node;
    return null;
  }
}
afterEach(() => vi.unstubAllGlobals());

describe("assistantOwnsEscape", () => {
  it("is true for a target inside the pane and false outside it or for no element", () => {
    vi.stubGlobal("Element", FakeElement);
    const pane = new FakeElement({ "data-assistant-pane": "" });
    const inside = new FakeElement({}, new FakeElement({}, pane));
    const outside = new FakeElement({}, new FakeElement({}));
    expect(assistantOwnsEscape(inside as unknown as EventTarget)).toBe(true);
    expect(assistantOwnsEscape(outside as unknown as EventTarget)).toBe(false);
    expect(assistantOwnsEscape(null)).toBe(false);
    expect(assistantOwnsEscape({} as EventTarget)).toBe(false);
  });
});
