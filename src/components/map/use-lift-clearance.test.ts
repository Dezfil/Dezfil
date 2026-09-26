import { describe, it, expect } from "vitest";
import { horizontalCollision } from "./use-lift-clearance";

/** The lift trigger is purely horizontal: a wide canvas leaves the corner's column free of the
 * centered bar, so the corner stays grounded. */
describe("horizontalCollision", () => {
  const legend = { left: 16, right: 296 };

  it("collides when the bar's edge enters the corner's column", () => {
    // 1440×900 with the inspector open: the centered 680px bar starts
    // ~200px in — inside a typical legend's column.
    expect(horizontalCollision(legend, { left: 200, right: 880 })).toBe(true);
  });

  it("stays clear when the bar starts past the corner plus the gap", () => {
    // A wide canvas: the bar's left edge is well past the legend.
    expect(horizontalCollision(legend, { left: 440, right: 1120 })).toBe(false);
  });

  it("treats the clearance gap as part of the collision band", () => {
    // 8px of daylight is not enough at the pre-emptive default gap.
    expect(horizontalCollision(legend, { left: 304, right: 984 })).toBe(true);
    // An explicit gap draws the band exactly: 13px of daylight clears 12.
    expect(horizontalCollision(legend, { left: 309, right: 989 }, 12)).toBe(
      false,
    );
  });

  it("is symmetric — a right corner ahead of the bar behaves the same", () => {
    const attribution = { left: 1200, right: 1420 };
    expect(horizontalCollision(attribution, { left: 380, right: 1060 })).toBe(
      false,
    );
    expect(horizontalCollision(attribution, { left: 520, right: 1200 })).toBe(
      true,
    );
  });
});
