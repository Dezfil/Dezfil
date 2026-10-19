import { expect, it } from "vitest";
import { readPaintedStyle, unsupportedRenderLayers } from "./declaration";
it("declares the painted style, never the requested fallback", () => {
  expect(readPaintedStyle({ querySelector: () => null })).toBeNull();
  expect(readPaintedStyle({ querySelector: () => ({ getAttribute: () => "old-style" }) })).toBe("old-style");
});
it("declares unsupported layers structurally without parsing failure prose", () => {
  expect(unsupportedRenderLayers([{ id: "a", tiled: true, liveDimensions: 1 }, { id: "b", tiled: false, liveDimensions: 1 }, { id: "c", tiled: true, liveDimensions: 0 }])).toEqual(["a"]);
});
