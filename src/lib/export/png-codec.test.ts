import { describe, expect, it } from "vitest";
import { decodePng, encodePng, pngDimensions, scaleImage, PngShapeError } from "./png-codec";
import { decodePng as probeDecode } from "../../../scripts/png-probe.mjs";

/**
 * The check's codec: a round trip through the encoder and the decoder is
 * exact, the journey's independent probe decoder reads what the encoder
 * writes, the header read agrees, area averaging keeps a block's colour
 * and the mean of a checkerboard, and an unsupported shape is refused
 * rather than misread.
 */
function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const [r, g, b] = paint(x, y); const i = (y * width + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
  return { width, height, rgba };
}
const at = (img: { width: number; rgba: Uint8Array }, x: number, y: number) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

describe("png-codec", () => {
  it("round-trips exactly and agrees with the independent probe decoder", () => {
    let seed = 0x2545f491;
    const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 24) & 0xff; };
    const src = image(37, 23, (x, y) => (x + y) % 3 === 0 ? [rand(), rand(), rand()] : [x * 6 & 0xff, y * 11 & 0xff, 30]);
    const png = encodePng(src);
    expect(pngDimensions(png)).toEqual({ width: 37, height: 23 });
    const back = decodePng(png);
    expect(back.width).toBe(37); expect(back.height).toBe(23);
    expect(Buffer.from(back.rgba).equals(Buffer.from(src.rgba))).toBe(true);
    const probe = probeDecode(Buffer.from(png));
    expect(probe.at(5, 7)).toEqual([...at(src, 5, 7), 255]);
    expect(probe.at(36, 22)).toEqual([...at(src, 36, 22), 255]);
  });
  it("area averaging keeps a solid block's colour and averages a checkerboard", () => {
    const src = image(64, 40, (x, y) => x >= 48 && y >= 30 ? [200, 30, 30] : (x + y) % 2 ? [0, 0, 0] : [255, 255, 255]);
    const small = scaleImage(src, 32, 20);
    expect(at(small, 30, 18)).toEqual([200, 30, 30]);
    const mid = at(small, 5, 5);
    expect(mid.every((v) => Math.abs(v - 128) <= 1)).toBe(true);
    const odd = scaleImage(src, 48, 30);
    expect(odd.width).toBe(48); expect(odd.height).toBe(30);
    expect(at(odd, 46, 29)).toEqual([200, 30, 30]);
  });
  it("refuses shapes it does not decode", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(PngShapeError);
    const png = Buffer.from(encodePng(image(4, 4, () => [1, 2, 3])));
    png[28] = 1; // interlace flag inside IHDR
    expect(() => decodePng(new Uint8Array(png))).toThrow(/interlaced/);
  });
});
