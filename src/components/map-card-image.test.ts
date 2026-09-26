import { describe, it, expect } from "vitest";
import { mapCardImageAddress } from "./map-card-image";

describe("the map card image's address", () => {
  it("carries the viewer's theme beside the version key, so a toggle is a new address", () => {
    const light = mapCardImageAddress("m1", "2026-09-06T10:00:00Z", "light");
    const dark = mapCardImageAddress("m1", "2026-09-06T10:00:00Z", "dark");
    expect(light).toBe("/api/maps/m1/thumbnail?v=2026-09-06T10%3A00%3A00Z&theme=light");
    expect(dark).toBe("/api/maps/m1/thumbnail?v=2026-09-06T10%3A00%3A00Z&theme=dark");
    expect(light).not.toBe(dark);
  });
});
