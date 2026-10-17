// Pictures and recordings for the documentation's tests, made in the test
// rather than committed: a WebP from sharp, and a WebM document built by hand,
// element by element, so the manifest's rules are held without an encoder.
import sharp from "sharp";

/** One EBML element: its id, an eight-byte size (or the unknown size a
 * stream writes) and its data. */
function element(id: number, data: Buffer | Buffer[], unknownSize = false): Buffer {
  const body = Buffer.concat(Array.isArray(data) ? data : [data]);
  const hex = id.toString(16);
  const idBytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const size = unknownSize ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]);
  if (!unknownSize) size.writeUInt32BE(body.length, 4);
  return Buffer.concat([idBytes, size, body]);
}
const uint = (value: number) => Buffer.from([(value >> 8) & 0xff, value & 0xff]);
const double = (value: number) => { const b = Buffer.alloc(8); b.writeDoubleBE(value); return b; };

/** A WebM document with one VP8 video track: its size in pixels, its
 * duration in milliseconds (null for none) and `payload` bytes of cluster. */
export function webm({ docType = "webm", duration = 5000 as number | null, width = 2880, height = 1800, unknownSegment = false, payload = 16 } = {}): Buffer {
  const info = [element(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40])), ...(duration === null ? [] : [element(0x4489, double(duration))])];
  const track = element(0xae, [element(0x83, Buffer.from([1])), element(0x86, Buffer.from("V_VP8")), element(0xe0, [element(0xb0, uint(width)), element(0xba, uint(height))])]);
  return Buffer.concat([
    element(0x1a45dfa3, element(0x4282, Buffer.from(docType))),
    element(0x18538067, [element(0x1549a966, info), element(0x1654ae6b, track), element(0x1f43b675, Buffer.alloc(payload))], unknownSegment),
  ]);
}

/** A flat WebP picture of the given size. */
export function webp(width: number, height: number, background = { r: 238, g: 241, b: 236 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).webp({ quality: 80 }).toBuffer();
}

/** A WebP picture of noise, which does not compress: for a file over its
 * bound. */
export function noisyWebp(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < raw.length; i += 1) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; raw[i] = seed >> 16; }
  return sharp(raw, { raw: { width, height, channels: 3 } }).webp({ quality: 100 }).toBuffer();
}
