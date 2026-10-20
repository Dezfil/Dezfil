import { describe, expect, it } from "vitest";
import { webpDimensions } from "./picture-encode";

// Headers written from the WebP container's definition, one per kind.
function riff(chunk: string, body: Buffer): Uint8Array {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "latin1"); head.writeUInt32LE(12 + body.length, 4); head.write("WEBP", 8, "latin1");
  head.write(chunk, 12, "latin1"); head.writeUInt32LE(body.length, 16);
  return new Uint8Array(Buffer.concat([head, body]));
}
const lossy = (width: number, height: number) => {
  const body = Buffer.alloc(10);
  body.writeUIntLE(0, 0, 3); body[3] = 0x9d; body[4] = 0x01; body[5] = 0x2a;
  body.writeUInt16LE(width, 6); body.writeUInt16LE(height, 8);
  return riff("VP8 ", body);
};
const lossless = (width: number, height: number) => {
  const body = Buffer.alloc(10);
  body[0] = 0x2f; body.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  return riff("VP8L", body);
};
const extended = (width: number, height: number) => {
  const body = Buffer.alloc(10);
  body.writeUIntLE(width - 1, 4, 3); body.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", body);
};

describe("webpDimensions", () => {
  it("reads the pixel size of a lossy, a lossless and an extended file", () => {
    expect(webpDimensions(lossy(1980, 848))).toEqual({ width: 1980, height: 848 });
    expect(webpDimensions(lossless(3312, 879))).toEqual({ width: 3312, height: 879 });
    expect(webpDimensions(extended(5000, 1200))).toEqual({ width: 5000, height: 1200 });
  });

  it("reads nothing from bytes that are not a WebP image", () => {
    expect(webpDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(webpDimensions(new Uint8Array(Buffer.from("RIFF0000WAVEfmt ").subarray(0, 16)))).toBeNull();
    const broken = lossy(10, 10); broken[23] = 0;
    expect(webpDimensions(broken)).toBeNull();
  });
});
