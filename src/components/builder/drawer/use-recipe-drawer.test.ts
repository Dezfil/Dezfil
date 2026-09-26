import { describe, it, expect } from "vitest";
import {
  DRAWER_GUTTER,
  DRAWER_WIDTH,
  OVERLAY_BELOW,
  edgeOffset,
} from "./use-recipe-drawer";

/**
 * The frozen container's arithmetic.
 *
 * The geometry itself is measured in the browser, where it can actually be
 * wrong. What is asserted here is the arithmetic that decides it: the one
 * width the pivot fixed, and what the drawer adds to the stage's left edge.
 */

describe("the one width", () => {
  it("is 342 — the number, not the inspector's width", () => {
    // Written out, because the inspector narrows to 306 below the breakpoint
    // and a comparison against "whatever the inspector is" would drift with
    // it. Doc 06 froze the number.
    expect(DRAWER_WIDTH).toBe(342);
  });
});

describe("what the drawer adds to the stage's left edge", () => {
  it("adds the width plus the gutter when it displaces", () => {
    expect(edgeOffset({ open: true, overlay: false })).toBe(
      DRAWER_WIDTH + DRAWER_GUTTER,
    );
  });

  it("adds nothing when it is shut", () => {
    expect(edgeOffset({ open: false, overlay: false })).toBe(0);
  });

  it("adds nothing in overlay mode", () => {
    // The overlay's whole point: below the breakpoint the map keeps its full
    // width beneath. This is also why the browser criterion asserts something
    // else entirely in that mode — an edge that cannot move cannot fail.
    expect(edgeOffset({ open: true, overlay: true })).toBe(0);
  });

  it("uses the shell's own breakpoint rather than inventing a second", () => {
    expect(OVERLAY_BELOW).toBe(1120);
  });
});
