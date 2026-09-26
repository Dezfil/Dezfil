import { deflateSync, inflateSync } from "node:zlib";

/**
 * A small PNG codec for the check's derived images: the settled render is
 * decoded once, resampled by area averaging to each smaller step, and
 * encoded again with the runtime's own deflate. No library enters the
 * tree for this: the shapes a headless Chromium screenshot produces
 * (8-bit RGB or RGBA, no interlace) are the shapes decoded, and anything
 * else is refused with a worded error so a wrong decode never becomes a
 * wrong image.
 */

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, row-major, four bytes per pixel. */
  rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export class PngShapeError extends Error {}

/** The PNG's pixel dimensions from its header alone. */
export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24 || SIGNATURE.some((b, i) => png[i] !== b)) throw new PngShapeError("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG to RGBA. */
export function decodePng(png: Uint8Array): DecodedImage {
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) throw new PngShapeError("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new PngShapeError("interlaced PNG");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new PngShapeError(`unsupported PNG shape (bit depth ${bitDepth}, colour type ${colorType})`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  if (raw.length < (stride + 1) * height) throw new PngShapeError("truncated PNG data");
  const rgba = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      else if (filter !== 0) throw new PngShapeError(`unknown PNG filter ${filter}`);
      current[i] = v & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels; const d = (y * width + x) * 4;
      rgba[d] = current[s]; rgba[d + 1] = current[s + 1]; rgba[d + 2] = current[s + 2];
      rgba[d + 3] = channels === 4 ? current[s + 3] : 255;
    }
    previous.set(current);
  }
  return { width, height, rgba };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode RGBA as an 8-bit RGB PNG (a rendered map is opaque), each row
 * under the Paeth filter, deflated at the highest level: bytes are what
 * the check's bound is about. */
export function encodePng(image: DecodedImage): Uint8Array {
  const { width, height, rgba } = image;
  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4; const d = x * 3;
      current[d] = rgba[s]; current[d + 1] = rgba[s + 1]; current[d + 2] = rgba[s + 2];
    }
    const row = y * (stride + 1);
    filtered[row] = 4;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 3 ? current[i - 3] : 0;
      const up = previous[i];
      const upLeft = i >= 3 ? previous[i - 3] : 0;
      filtered[row + 1 + i] = (current[i] - paeth(left, up, upLeft)) & 0xff;
    }
    previous.set(current);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filtered, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

/** Resample by area averaging: every output pixel is the mean of the
 * source box it covers, fractional edges weighted, so a downscale keeps
 * thin marks as lighter marks rather than dropping them. */
export function scaleImage(image: DecodedImage, width: number, height: number): DecodedImage {
  if (width === image.width && height === image.height) return image;
  const out = new Uint8Array(width * height * 4);
  const sx = image.width / width; const sy = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = y * sy; const y1 = (y + 1) * sy;
    const yStart = Math.floor(y0); const yEnd = Math.min(Math.ceil(y1), image.height);
    for (let x = 0; x < width; x += 1) {
      const x0 = x * sx; const x1 = (x + 1) * sx;
      const xStart = Math.floor(x0); const xEnd = Math.min(Math.ceil(x1), image.width);
      let r = 0; let g = 0; let b = 0; let a = 0; let total = 0;
      for (let yy = yStart; yy < yEnd; yy += 1) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = xStart; xx < xEnd; xx += 1) {
          const w = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const i = (yy * image.width + xx) * 4;
          r += image.rgba[i] * w; g += image.rgba[i + 1] * w; b += image.rgba[i + 2] * w; a += image.rgba[i + 3] * w;
          total += w;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / total); out[o + 1] = Math.round(g / total); out[o + 2] = Math.round(b / total); out[o + 3] = Math.round(a / total);
    }
  }
  return { width, height, rgba: out };
}
