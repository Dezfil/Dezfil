import { describe, it, expect } from "vitest";
import { mapCardImageAddress } from "./map-card-image";

describe("the map card image's address", () => {
  it("carries the viewer's theme beside the picture version, so a toggle is a new address", () => {
    const light = mapCardImageAddress("m1", "server-3", "light");
    const dark = mapCardImageAddress("m1", "server-3", "dark");
    expect(light).toBe("/api/maps/m1/thumbnail?v=server-3&theme=light");
    expect(dark).toBe("/api/maps/m1/thumbnail?v=server-3&theme=dark");
    expect(light).not.toBe(dark);
  });

  it("is a new address for every new picture version and the same one while the version holds", () => {
    expect(mapCardImageAddress("m1", "server-4", "light")).not.toBe(mapCardImageAddress("m1", "server-3", "light"));
    expect(mapCardImageAddress("m1", "server-3", "light")).toBe(mapCardImageAddress("m1", "server-3", "light"));
    // An old picture's version keeps its own address, encoded.
    expect(mapCardImageAddress("m1", "old-2026-09-06T10:00:00Z", "dark"))
      .toBe("/api/maps/m1/thumbnail?v=old-2026-09-06T10%3A00%3A00Z&theme=dark");
  });
});
