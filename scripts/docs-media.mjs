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
export const RECORDING_MAX_BYTES = 1_500_000;
export const RECORDING_MAX_SECONDS = 8;
/** At most this many recorded scenes, each with its two takes. */
export const RECORDINGS_MAX = 12;

// ---------------------------------------------------------------------------
// Takes: every scene is taken in the light theme and in the dark theme. The
// light take carries the scene's own name, which is what pages and the README
// name; the dark take sits beside it with `.dark` before the extension
// (`templates.webp` and `templates.dark.webp`) and is found by that name.

/** The app's two themes, in the order a run takes them. */
export const THEMES = ["light", "dark"];

const DARK = /\.dark\.(webp|webm)$/;

/** Whether a picture or recording is a dark take. */
export const isDarkTake = (file) => DARK.test(file);

/** The theme a file's name says it was taken in. */
export const takeTheme = (file) => (isDarkTake(file) ? "dark" : "light");

/** A light take's dark take, beside it. */
export const darkTake = (file) => file.replace(/\.(webp|webm)$/, ".dark.$1");

/** A dark take's light take, beside it. */
export const lightTake = (file) => file.replace(DARK, ".$1");

/** A scene's file in a theme: the scene's own name in the light theme, its
 * dark take in the dark theme. */
export const takeFile = (file, theme) => (theme === "dark" ? darkTake(file) : file);

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

// ---------------------------------------------------------------------------
// WebM: an EBML document. Only the elements the manifest needs are read:
// the document type, the segment's duration and the video track's size.

const EBML = 0x1a45dfa3, DOC_TYPE = 0x4282, SEGMENT = 0x18538067, INFO = 0x1549a966, TIMECODE_SCALE = 0x2ad7b1, DURATION = 0x4489;
const TRACKS = 0x1654ae6b, TRACK_ENTRY = 0xae, TRACK_TYPE = 0x83, CODEC = 0x86, VIDEO = 0xe0, PIXEL_WIDTH = 0xb0, PIXEL_HEIGHT = 0xba;

/** An EBML variable-length number at `at`: an element id keeps its length
 * marker, a size drops it; a size of all ones is unknown. */
function vint(buffer, at, marker) {
  const first = buffer[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length += 1;
  if (at + length > buffer.length) return null;
  const low = 0xff >> length;
  let value = marker ? first : first & low;
  let unknown = (first & low) === low;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + buffer[at + i];
    if (buffer[at + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown: !marker && unknown };
}

/** The elements between `start` and `end`, each with its data's bounds. */
function* children(buffer, start, end) {
  let at = start;
  while (at < end) {
    const id = vint(buffer, at, true);
    const size = id && vint(buffer, at + id.length, false);
    if (!size) return;
    const from = at + id.length + size.length;
    const to = size.unknown ? end : Math.min(end, from + size.value);
    yield { id: id.value, from, to };
    at = to;
  }
}

const find = (buffer, parent, id) => [...children(buffer, parent.from, parent.to)].find((element) => element.id === id) ?? null;
const unsigned = (buffer, element) => (element ? buffer.subarray(element.from, element.to).reduce((value, byte) => value * 256 + byte, 0) : null);
const float = (buffer, element) => {
  if (!element) return null;
  const bytes = element.to - element.from;
  return bytes === 4 ? buffer.readFloatBE(element.from) : bytes === 8 ? buffer.readDoubleBE(element.from) : null;
};

/** A WebM file's video size in pixels and its length in seconds (to the
 * millisecond), from its own header, or null when the bytes are not a WebM
 * file with a duration and one video track. */
export function webmInfo(bytes) {
  const buffer = Buffer.from(bytes);
  const whole = { from: 0, to: buffer.length };
  const header = find(buffer, whole, EBML);
  const docType = header && find(buffer, header, DOC_TYPE);
  if (!docType || buffer.toString("latin1", docType.from, docType.to) !== "webm") return null;
  const segment = find(buffer, whole, SEGMENT);
  const info = segment && find(buffer, segment, INFO);
  const tracks = segment && find(buffer, segment, TRACKS);
  if (!info || !tracks) return null;
  const scale = unsigned(buffer, find(buffer, info, TIMECODE_SCALE)) ?? 1_000_000;
  const duration = float(buffer, find(buffer, info, DURATION));
  const video = [...children(buffer, tracks.from, tracks.to)]
    .filter((element) => element.id === TRACK_ENTRY && unsigned(buffer, find(buffer, element, TRACK_TYPE)) === 1)
    .map((entry) => ({ entry, video: find(buffer, entry, VIDEO) }));
  if (duration === null || video.length !== 1 || !video[0].video) return null;
  const codec = find(buffer, video[0].entry, CODEC);
  return {
    width: unsigned(buffer, find(buffer, video[0].video, PIXEL_WIDTH)),
    height: unsigned(buffer, find(buffer, video[0].video, PIXEL_HEIGHT)),
    length: Math.round((duration * scale) / 1e6) / 1000,
    codec: codec ? buffer.toString("latin1", codec.from, codec.to) : null,
  };
}
