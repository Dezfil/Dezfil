import { describe, expect, it } from "vitest";
import { encodePng } from "@/lib/export/png-codec";
import { webpDimensions } from "@/lib/export/picture-encode";
import { CARD_STORED_SIZE, cardDefinition, completeShape, pictureRequest } from "./card";
import { PICTURE_SHAPES, type PictureShape } from "./shapes";

/** A WebP header of the extended kind, enough to carry its pixel size. */
function webp(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1"); bytes.writeUInt32LE(22, 4); bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8X", 12, "latin1"); bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(bytes);
}
const png = (width: number, height: number) => encodePng({ width, height, rgba: new Uint8Array(width * height * 4).fill(128) });
const masters = {
  card: png(1980, 848),
  wide: png(PICTURE_SHAPES.wide.frame.width * 3, PICTURE_SHAPES.wide.frame.height * 3),
};
const declaration = { map: "map", layers: [{ id: "layer" }], failures: [], unsupported: [], paintedStyle: "ground", requestedStyle: "ground" };
function encodedFor(shape: PictureShape) {
  return pictureRequest(shape).sizes.map((size) => (size.type === "image/png" ? png(size.width, size.height) : webp(size.width, size.height)));
}
const result = (shape: PictureShape, change = {}, encoded = encodedFor(shape)) => ({
  png: masters[shape], abandoned: [] as string[], consumed: JSON.stringify({ ...declaration, ...change }), encoded,
});

describe("the card definition", () => {
  it("keeps the saved camera at each shape's frame and master scale with no overlays", () => {
    const saved = { lng: 1, lat: 2, zoom: 3, pitch: 42, bearing: 15 };
    expect(cardDefinition(saved, "dark")).toMatchObject({ size: { width: 1980, height: 848 }, mapScale: 2, viewport: saved, appearance: "dark", widgets: [], title: null, legend: { visible: false } });
    const wide = PICTURE_SHAPES.wide.frame;
    expect(cardDefinition(saved, "light", "wide")).toMatchObject({ size: { width: wide.width * 3, height: wide.height * 3 }, mapScale: 3, viewport: saved });
  });

  it("asks each shape's kept sizes as WebP, and the card's default PNG last", () => {
    const card = pictureRequest("card");
    expect(card.frame.padding).toEqual(PICTURE_SHAPES.card.padding);
    expect(card.sizes.map((s) => [s.width, s.type])).toEqual([
      [360, "image/webp"], [720, "image/webp"], [1080, "image/webp"], [1440, "image/webp"], [1980, "image/webp"],
      [CARD_STORED_SIZE.width, "image/png"],
    ]);
    expect(pictureRequest("wide").sizes.every((s) => s.type === "image/webp")).toBe(true);
  });
});

describe("completeShape", () => {
  it("accepts a legitimately one-colour render with every size it asked for", () => {
    const card = completeShape(result("card"), "map", ["layer"], "ground", "card");
    expect(card.png).not.toBeNull();
    expect(card.sized.map((s) => s.width)).toEqual([360, 720, 1080, 1440, 1980]);
    expect(card.sized.every((s) => s.shape === "card" && webpDimensions(s.bytes)?.width === s.width)).toBe(true);
    const wide = completeShape(result("wide"), "map", ["layer"], "ground", "wide");
    expect(wide.png).toBeNull();
    expect(wide.sized.map((s) => s.width)).toEqual([1104, 1656, 2208, 3312]);
  });

  it.each([
    ["failed layer", { failures: ["could not draw"] }],
    ["unsupported layer", { unsupported: ["layer"] }],
    ["wrong ground", { paintedStyle: "old" }],
    ["fallback", { paintedStyle: null }],
    ["missing layer", { layers: [] }],
    ["wrong map", { map: "other" }],
  ])("rejects %s even when the renderer settled", (_name, change) => {
    expect(() => completeShape(result("card", change), "map", ["layer"], "ground", "card")).toThrow();
  });

  it("rejects an abandoned request and an absent or malformed declaration", () => {
    for (const candidate of [{ ...result("card"), abandoned: ["tiles.test"] }, { ...result("card"), consumed: undefined }, { ...result("card"), consumed: "{" }]) {
      expect(() => completeShape(candidate, "map", ["layer"], "ground", "card")).toThrow();
    }
  });

  it("rejects a master of another size, a missing size, a size of the wrong pixels and a format other than asked", () => {
    expect(() => completeShape({ ...result("card"), png: masters.wide }, "map", ["layer"], "ground", "card")).toThrow();
    const encoded = encodedFor("card");
    expect(() => completeShape(result("card", {}, encoded.slice(1)), "map", ["layer"], "ground", "card")).toThrow();
    expect(() => completeShape(result("card", {}, [webp(361, 154), ...encoded.slice(1)]), "map", ["layer"], "ground", "card")).toThrow();
    expect(() => completeShape(result("card", {}, [png(360, 154), ...encoded.slice(1)]), "map", ["layer"], "ground", "card")).toThrow();
    expect(() => completeShape(result("card", {}, [...encoded.slice(0, -1), webp(692, 296)]), "map", ["layer"], "ground", "card")).toThrow();
    expect(() => completeShape({ ...result("card"), encoded: undefined }, "map", ["layer"], "ground", "card")).toThrow();
  });
});
