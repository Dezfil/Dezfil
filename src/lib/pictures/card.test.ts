import { expect, it } from "vitest";
import { encodePng, decodePng } from "@/lib/export/png-codec";
import { cardDefinition, completePicture } from "./card";
const png = encodePng({ width: 990, height: 424, rgba: new Uint8Array(990 * 424 * 4).fill(128) });
const declaration = { map: "map", layers: [{ id: "layer" }], failures: [], unsupported: [], paintedStyle: "ground", requestedStyle: "ground" };
const result = (change = {}) => ({ png, abandoned: [], consumed: JSON.stringify({ ...declaration, ...change }) });
it("keeps the saved camera at the agreed composition size with no overlays", () => {
  expect(cardDefinition({ lng: 1, lat: 2, zoom: 3, pitch: 42, bearing: 15 }, "dark")).toMatchObject({ size: { width: 990, height: 424 }, viewport: { lng: 1, lat: 2, zoom: 3, pitch: 42, bearing: 15 }, appearance: "dark", mapScale: 1, widgets: [], title: null, legend: { visible: false } });
});
it("accepts a legitimately one-colour render and stores exactly 692 by 296", () => {
  expect(decodePng(completePicture(result(), "map", ["layer"], "ground"))).toMatchObject({ width: 692, height: 296 });
});
it.each([
  ["failed layer", { failures: ["could not draw"] }],
  ["unsupported layer", { unsupported: ["layer"] }],
  ["wrong ground", { paintedStyle: "old" }],
  ["fallback", { paintedStyle: null }],
  ["missing layer", { layers: [] }],
  ["wrong map", { map: "other" }],
])("rejects %s even when the renderer settled", (_name, change) => {
  expect(() => completePicture(result(change), "map", ["layer"], "ground")).toThrow();
});
it("rejects an abandoned request and an absent or malformed declaration", () => {
  for (const candidate of [{ ...result(), abandoned: ["tiles.test"] }, { png, abandoned: [] }, { ...result(), consumed: "{" }]) {
    expect(() => completePicture(candidate, "map", ["layer"], "ground")).toThrow();
  }
});
