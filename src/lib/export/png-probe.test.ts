import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
// The probe is a plain script module (the journey consumes it); the red
// proof lives here in the unit suite.
import {
  decodePng,
  countPixels,
  countColored,
} from "../../../scripts/png-probe.mjs";

/**
 * The journey decoder's red proof (plan, measurement validity): one
 * constructed PNG per scanline filter with known pixels — a decoder that
 * mishandles any filter (the partial-decoder defect class) miscounts and
 * fails here.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Build an 8-bit RGB PNG from raw filtered scanlines. */
function pngFrom(width: number, height: number, filtered: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filtered)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A 2×2 image whose pixels are known: red, green / blue, gray.
const PIXELS = [
  [
    [200, 10, 10],
    [10, 200, 10],
  ],
  [
    [10, 10, 200],
    [128, 128, 128],
  ],
];

function rawLine(y: number): number[] {
  return PIXELS[y].flat();
}

function expectDecoded(png: Buffer): void {
  const img = decodePng(png);
  expect(img.width).toBe(2);
  expect(img.height).toBe(2);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) {
      const [r, g, b] = img.at(x, y);
      expect([r, g, b]).toEqual(PIXELS[y][x]);
    }
  }
}

describe("png-probe — every scanline filter decodes to the known pixels", () => {
  it("filter 0 (None)", () => {
    const f = Buffer.from([0, ...rawLine(0), 0, ...rawLine(1)]);
    expectDecoded(pngFrom(2, 2, f));
  });

  it("filter 1 (Sub)", () => {
    const sub = (line: number[]) =>
      line.map((v, i) => (v - (i >= 3 ? line[i - 3] : 0)) & 0xff);
    const f = Buffer.from([1, ...sub(rawLine(0)), 1, ...sub(rawLine(1))]);
    expectDecoded(pngFrom(2, 2, f));
  });

  it("filter 2 (Up)", () => {
    const up = (line: number[], prev: number[]) =>
      line.map((v, i) => (v - prev[i]) & 0xff);
    const zeros = new Array(6).fill(0);
    const f = Buffer.from([
      2,
      ...up(rawLine(0), zeros),
      2,
      ...up(rawLine(1), rawLine(0)),
    ]);
    expectDecoded(pngFrom(2, 2, f));
  });

  it("filter 3 (Average)", () => {
    const avg = (line: number[], prev: number[]) =>
      line.map(
        (v, i) => (v - (((i >= 3 ? line[i - 3] : 0) + prev[i]) >> 1)) & 0xff,
      );
    const zeros = new Array(6).fill(0);
    const f = Buffer.from([
      3,
      ...avg(rawLine(0), zeros),
      3,
      ...avg(rawLine(1), rawLine(0)),
    ]);
    expectDecoded(pngFrom(2, 2, f));
  });

  it("filter 4 (Paeth)", () => {
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    };
    const enc = (line: number[], prev: number[]) =>
      line.map(
        (v, i) =>
          (v -
            paeth(
              i >= 3 ? line[i - 3] : 0,
              prev[i],
              i >= 3 ? prev[i - 3] : 0,
            )) &
          0xff,
      );
    const zeros = new Array(6).fill(0);
    const f = Buffer.from([
      4,
      ...enc(rawLine(0), zeros),
      4,
      ...enc(rawLine(1), rawLine(0)),
    ]);
    expectDecoded(pngFrom(2, 2, f));
  });

  it("the colored-pixel probe counts data, not gray", () => {
    const f = Buffer.from([0, ...rawLine(0), 0, ...rawLine(1)]);
    const img = decodePng(pngFrom(2, 2, f));
    // Three saturated pixels; the gray one does not count.
    expect(countColored(img)).toBe(3);
    expect(
      countPixels(img, ([r]: number[]) => r > 150, {
        x0: 0,
        x1: 0.5,
        y0: 0,
        y1: 0.5,
      }),
    ).toBe(1);
  });

  it("refuses what it cannot decode (never a silent wrong count)", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/not a PNG/);
  });
});
