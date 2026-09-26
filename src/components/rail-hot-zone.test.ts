import { describe, expect, it } from "vitest";
import {
  BUILDER_HOT_ZONE,
  WHOLE_RAIL,
  hotZoneShare,
  isBuilderPath,
} from "./rail-hot-zone";

// The rail's hot zone by page: the map builder keeps the left two-thirds;
// every other workspace page opens the whole rail.
describe("the rail's hot zone by page", () => {
  it("the map builder is the map detail route, and only that", () => {
    expect(isBuilderPath("/maps/abc123")).toBe(true);
    expect(isBuilderPath("/maps/abc123/")).toBe(true);
    // The gallery is not the builder — the route the rule most easily
    // over-matches, since it shares the builder's prefix.
    expect(isBuilderPath("/maps")).toBe(false);
    expect(isBuilderPath("/maps/")).toBe(false);
    expect(isBuilderPath("/")).toBe(false);
    expect(isBuilderPath("/data")).toBe(false);
    expect(isBuilderPath("/projects/p1")).toBe(false);
    expect(isBuilderPath("/v/token")).toBe(false);
  });

  it("the builder keeps the two-thirds zone; everywhere else the whole rail", () => {
    expect(BUILDER_HOT_ZONE).toBeCloseTo(2 / 3);
    expect(WHOLE_RAIL).toBe(1);
    expect(hotZoneShare("/maps/abc123")).toBe(BUILDER_HOT_ZONE);
    expect(hotZoneShare("/maps")).toBe(WHOLE_RAIL);
    expect(hotZoneShare("/data")).toBe(WHOLE_RAIL);
    expect(hotZoneShare("/sql")).toBe(WHOLE_RAIL);
  });
});
