// The documentation's pictures and recordings, read from their own headers:
// shared by the picture script, which writes the manifest, and the page
// contract, which holds the manifest to the files. Plain JavaScript over the
// bytes, so the check needs nothing installed beyond the repository.

/** The frame every scene is taken in: CSS pixels and the pixel ratio. */
export const FRAME = { width: 1440, height: 900, scale: 2 };

/** The bounds of section 7, in bytes. "KB" and "MB" are read as the
 * decimal units, the stricter of the two readings. */
export const PICTURE_MAX_BYTES = 250_000;
export const PICTURE_AIM_BYTES = 200_000;

/** The canvas of a WebP file in pixels, from its first chunk, or null when
 * the bytes are not a WebP file this reader knows. */
export function webpSize(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 30 || buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = buffer.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 ") {
    // A key frame: a three-byte tag, the start code, then two 14-bit sizes.
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return null;
}
