import { describe, expect, it } from "vitest";
import { encodePng } from "@/lib/export/png-codec";
import { webpDimensions } from "@/lib/export/picture-encode";
import { CARD_STORED_SIZE, cardDefinition, completePicture, pictureRequest } from "./card";
import { PICTURE_SHAPE } from "./shapes";

/** A WebP header of the extended kind, enough to carry its pixel size. */
function webp(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1"); bytes.writeUInt32LE(22, 4); bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8X", 12, "latin1"); bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(bytes);
}
const png = (width: number, height: number) => encodePng({ width, height, rgba: new Uint8Array(width * height * 4).fill(128) });
// The master: the 968 by 494 frame at three device pixels per CSS pixel.
const master = png(2904, 1482);
const declaration = { map: "map", layers: [{ id: "layer" }], failures: [], unsupported: [], paintedStyle: "ground", requestedStyle: "ground" };
function encodedFor() {
  return pictureRequest().sizes.map((size) => (size.type === "image/png" ? png(size.width, size.height) : webp(size.width, size.height)));
}
const result = (change = {}, encoded = encodedFor()) => ({
  png: master, abandoned: [] as string[], consumed: JSON.stringify({ ...declaration, ...change }), encoded,
});

describe("the card definition", () => {
  it("keeps the saved camera at the shape's frame and master scale with no overlays", () => {
    const saved = { lng: 1, lat: 2, zoom: 3, pitch: 42, bearing: 15 };
    expect(cardDefinition(saved, "dark")).toMatchObject({ size: { width: 2904, height: 1482 }, mapScale: 3, viewport: saved, appearance: "dark", widgets: [], title: null, legend: { visible: false } });
  });

  it("asks the kept sizes as WebP in the frame's proportion, and the default PNG last", () => {
    const asked = pictureRequest();
    expect(asked.frame.padding).toEqual(PICTURE_SHAPE.padding);
    expect(asked.sizes.map((s) => [s.width, s.height, s.type])).toEqual([
      [360, 184, "image/webp"], [720, 367, "image/webp"], [1080, 551, "image/webp"], [1440, 735, "image/webp"], [1980, 1010, "image/webp"], [2904, 1482, "image/webp"],
      [692, 353, "image/png"],
    ]);
    expect(CARD_STORED_SIZE).toEqual({ width: 692, height: 353 });
  });
});

describe("completePicture", () => {
  it("accepts a legitimately one-colour render with every size it asked for", () => {
    const picture = completePicture(result(), "map", ["layer"], "ground");
    expect(picture.png).not.toBeNull();
    expect(picture.sized.map((s) => s.width)).toEqual([360, 720, 1080, 1440, 1980, 2904]);
    expect(picture.sized.every((s) => s.shape === "card" && webpDimensions(s.bytes)?.width === s.width)).toBe(true);
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
    for (const candidate of [{ ...result(), abandoned: ["tiles.test"] }, { ...result(), consumed: undefined }, { ...result(), consumed: "{" }]) {
      expect(() => completePicture(candidate, "map", ["layer"], "ground")).toThrow();
    }
  });

  it("rejects a master of another size, a missing size, a size of the wrong pixels and a format other than asked", () => {
    // The earlier recipe's card master, 990 by 424 at two.
    expect(() => completePicture({ ...result(), png: png(1980, 848) }, "map", ["layer"], "ground")).toThrow();
    const encoded = encodedFor();
    expect(() => completePicture(result({}, encoded.slice(1)), "map", ["layer"], "ground")).toThrow();
    expect(() => completePicture(result({}, [webp(361, 184), ...encoded.slice(1)]), "map", ["layer"], "ground")).toThrow();
    expect(() => completePicture(result({}, [png(360, 184), ...encoded.slice(1)]), "map", ["layer"], "ground")).toThrow();
    expect(() => completePicture(result({}, [...encoded.slice(0, -1), webp(692, 353)]), "map", ["layer"], "ground")).toThrow();
    expect(() => completePicture(result({}, [...encoded.slice(0, -1), png(692, 296)]), "map", ["layer"], "ground")).toThrow();
    expect(() => completePicture({ ...result(), encoded: undefined }, "map", ["layer"], "ground")).toThrow();
  });
});
