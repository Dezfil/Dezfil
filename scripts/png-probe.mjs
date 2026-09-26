// Minimal, complete PNG decode for probe purposes: 8-bit
// RGB/RGBA, all five scanline filters (None/Sub/Up/Average/Paeth) —
// Chromium screenshots use several. Red-proven by unit fixtures that
// construct one PNG per filter type with known pixels; a partial
// decoder that miscounts is the measurement-defect class the plan
// names. No dependencies beyond node's zlib.
import { inflateSync } from "node:zlib";

/** Decode a PNG buffer to { width, height, at(x, y) -> [r,g,b,a] }. */
export function decodePng(buf) {
  if (
    buf.length < 8 ||
    buf.readUInt32BE(0) !== 0x89504e47 ||
    buf.readUInt32BE(4) !== 0x0d0a1a0a
  ) {
    throw new Error("not a PNG");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG unsupported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `unsupported PNG shape (bitDepth ${bitDepth}, colorType ${colorType})`,
    );
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? cur[i - channels] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown filter ${filter}`);
      cur[i] = v & 0xff;
    }
  }
  return {
    width,
    height,
    at(x, y) {
      const i = y * stride + x * channels;
      return [
        out[i],
        out[i + 1],
        out[i + 2],
        channels === 4 ? out[i + 3] : 255,
      ];
    },
  };
}

/** Count pixels satisfying `predicate([r,g,b,a])` within a region
 * (fractions of the image; whole image when omitted). */
export function countPixels(png, predicate, region = {}) {
  const x0 = Math.floor((region.x0 ?? 0) * png.width);
  const x1 = Math.ceil((region.x1 ?? 1) * png.width);
  const y0 = Math.floor((region.y0 ?? 0) * png.height);
  const y1 = Math.ceil((region.y1 ?? 1) * png.height);
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (predicate(png.at(x, y))) n += 1;
    }
  }
  return n;
}

/** Colored (saturated) pixels — the data-presence probe: map data is
 * colored; the offline fallback background is not. */
export function countColored(png, region = {}) {
  return countPixels(
    png,
    ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 40,
    region,
  );
}
