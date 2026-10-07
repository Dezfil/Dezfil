import { describe, expect, it } from "vitest";
import {
  BOTH_FROM, CLOSED_SLOT, HELPER_OFFSET, MAP_MINIMUM, THREE_PANE_CHROME,
  bandLimits, bandOf, closeHelper, crossBand, openHelper, stageOffsets, visible,
} from "./helper-bands";

/**
 * The bands and the swap, as arithmetic and state transitions. The
 * geometry they decide is measured in the browser suite; what is held
 * here is the decision itself, at every named width.
 */

describe("the three bands", () => {
  it("are the stylesheet's chrome plus the map minimum: both dock from 1860", () => {
    expect(THREE_PANE_CHROME).toBe(1160);
    expect(MAP_MINIMUM).toBe(700);
    expect(BOTH_FROM).toBe(1860);
  });
  it("overlay at and below 1120, one docked from 1121 to 1859, both from 1860", () => {
    expect(bandOf(1000)).toBe("overlay");
    expect(bandOf(1100)).toBe("overlay");
    expect(bandOf(1120)).toBe("overlay");
    expect(bandOf(1121)).toBe("one");
    expect(bandOf(1440)).toBe("one");
    expect(bandOf(1859)).toBe("one");
    expect(bandOf(1860)).toBe("both");
    expect(bandOf(1920)).toBe("both");
  });
});

describe("the bands beside the always-open rail", () => {
  /** What the rail standing open adds to the chrome: 210 px open less the 54 px collapsed. */
  const SHIFT = 156;
  it("keep the map's 700 px with both docked: one helper just under 1860 plus the shift", () => {
    expect(bandOf(BOTH_FROM + SHIFT - 1, SHIFT)).toBe("one");
    expect(bandOf(1920, SHIFT)).toBe("one");
    expect(bandOf(BOTH_FROM + SHIFT, SHIFT)).toBe("both");
    expect(bandLimits(SHIFT).bothFrom - (THREE_PANE_CHROME + SHIFT)).toBe(MAP_MINIMUM);
  });
  it("move the overlay limit up by the same shift", () => {
    expect(bandOf(1120 + SHIFT, SHIFT)).toBe("overlay");
    expect(bandOf(1121 + SHIFT, SHIFT)).toBe("one");
    expect(bandLimits(SHIFT)).toEqual({ overlayAtMost: 1120 + SHIFT, bothFrom: 1860 + SHIFT });
  });
  it("stay where they are with no shift, the other two picks", () => {
    expect(bandLimits(0)).toEqual({ overlayAtMost: 1120, bothFrom: 1860 });
    expect([bandOf(1120, 0), bandOf(1121, 0), bandOf(1859, 0), bandOf(1860, 0)]).toEqual(["overlay", "one", "one", "both"]);
  });
});

describe("opening and closing by hand", () => {
  it("below the limit opening one replaces the other in one step", () => {
    const tools = openHelper(CLOSED_SLOT, "tools", "one");
    expect(visible(tools, "tools")).toBe(true);
    const swapped = openHelper(tools, "assistant", "one");
    expect(visible(swapped, "assistant")).toBe(true);
    expect(visible(swapped, "tools")).toBe(false);
    expect(swapped.lastOpened).toBe("assistant");
    const back = openHelper(swapped, "tools", "overlay");
    expect([visible(back, "tools"), visible(back, "assistant")]).toEqual([true, false]);
  });
  it("in the three-pane band opening one leaves the other open", () => {
    const both = openHelper(openHelper(CLOSED_SLOT, "tools", "both"), "assistant", "both");
    expect([visible(both, "tools"), visible(both, "assistant")]).toEqual([true, true]);
    expect(both.lastOpened).toBe("assistant");
  });
  it("closing closes only that helper", () => {
    const both = openHelper(openHelper(CLOSED_SLOT, "tools", "both"), "assistant", "both");
    const closed = closeHelper(both, "tools");
    expect([visible(closed, "tools"), visible(closed, "assistant")]).toEqual([false, true]);
  });
});

describe("the resize swap", () => {
  const both = (last: "tools" | "assistant") =>
    last === "assistant"
      ? openHelper(openHelper(CLOSED_SLOT, "tools", "both"), "assistant", "both")
      : openHelper(openHelper(CLOSED_SLOT, "assistant", "both"), "tools", "both");
  it("narrowing keeps the helper opened later by hand and hides the other, in both orders", () => {
    for (const last of ["tools", "assistant"] as const) {
      const narrowed = crossBand(both(last), "both", "one");
      expect(visible(narrowed, last)).toBe(true);
      expect(visible(narrowed, last === "tools" ? "assistant" : "tools")).toBe(false);
      expect(narrowed.hidden).toBe(last === "tools" ? "assistant" : "tools");
    }
  });
  it("widening returns the hidden helper, and a hidden helper kept its hand state throughout (D6)", () => {
    const narrowed = crossBand(both("tools"), "both", "one");
    expect(narrowed.assistant).toBe(true);
    const widened = crossBand(narrowed, "one", "both");
    expect([visible(widened, "tools"), visible(widened, "assistant")]).toEqual([true, true]);
    expect(widened.hidden).toBeNull();
  });
  it("a hand action below the limit forgets the hidden helper, so widening shows only what was open", () => {
    const narrowed = crossBand(both("tools"), "both", "one");
    const closedByHand = closeHelper(narrowed, "tools");
    expect([visible(closedByHand, "tools"), visible(closedByHand, "assistant")]).toEqual([false, false]);
    const widened = crossBand(closedByHand, "one", "both");
    expect([visible(widened, "tools"), visible(widened, "assistant")]).toEqual([false, false]);
    const reopened = openHelper(narrowed, "assistant", "one");
    expect([visible(reopened, "tools"), visible(reopened, "assistant")]).toEqual([false, true]);
    expect(crossBand(reopened, "one", "both").tools).toBe(false);
  });
  it("no hand order recorded: the assistant survives the narrowing", () => {
    const restored = { tools: true, assistant: true, lastOpened: null, hidden: null };
    const narrowed = crossBand(restored, "both", "one");
    expect(visible(narrowed, "assistant")).toBe(true);
    expect(visible(narrowed, "tools")).toBe(false);
  });
  it("a crossing with one helper open changes the slot's state not at all", () => {
    const one = openHelper(CLOSED_SLOT, "assistant", "both");
    expect(crossBand(one, "both", "one")).toBe(one);
    expect(crossBand(one, "one", "overlay")).toBe(one);
    expect(crossBand(one, "overlay", "both")).toBe(one);
  });
  it("a jump from the three-pane band straight to the overlay band hides as a narrowing does", () => {
    const narrowed = crossBand(both("assistant"), "both", "overlay");
    expect(narrowed.hidden).toBe("tools");
  });
});

describe("what the edges read", () => {
  it("a docked visible helper moves its own side by the width plus gutter; an overlaying one moves nothing", () => {
    const both = openHelper(openHelper(CLOSED_SLOT, "tools", "both"), "assistant", "both");
    expect(stageOffsets(both, "both")).toEqual({ left: HELPER_OFFSET, right: HELPER_OFFSET });
    expect(HELPER_OFFSET).toBe(354);
    const one = openHelper(CLOSED_SLOT, "assistant", "one");
    expect(stageOffsets(one, "one")).toEqual({ left: 0, right: HELPER_OFFSET });
    expect(stageOffsets(one, "overlay")).toEqual({ left: 0, right: 0 });
    const hidden = crossBand(both, "both", "one");
    expect(stageOffsets(hidden, "one")).toEqual({ left: 0, right: HELPER_OFFSET });
  });
});
