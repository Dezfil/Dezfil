// Profile picture fixtures, made in the test rather than committed. Each
// still image marks its centred square in four colours and paints magenta
// outside it, so a stored square shows at a glance whether it holds the
// centre, the right way up.
import sharp from "sharp";

type Rgb = readonly [number, number, number];
export const MARKS = {
  topLeft: [220, 30, 30], topRight: [30, 170, 60], bottomLeft: [40, 60, 220], bottomRight: [240, 200, 20],
  outside: [255, 0, 255],
} as const satisfies Record<string, Rgb>;

/** Camera, place and appended records a stored picture must not keep. */
export const RECORDS = { camera: "DezfilFixtureCamera", place: "DezfilFixturePlace", appended: "DEZFIL-APPENDED-PAYLOAD" } as const;

/** Raw RGB pixels of a marked image of the given display size. */
function markedPixels(width: number, height: number): Buffer {
  const side = Math.min(width, height), left = (width - side) / 2, top = (height - side) / 2;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= left && x < left + side && y >= top && y < top + side;
      const right = x - left >= side / 2, bottom = y - top >= side / 2;
      const colour = !inside ? MARKS.outside : bottom ? (right ? MARKS.bottomRight : MARKS.bottomLeft) : right ? MARKS.topRight : MARKS.topLeft;
      pixels.set(colour, (y * width + x) * 3);
    }
  }
  return pixels;
}

const marked = (width: number, height: number) => sharp(markedPixels(width, height), { raw: { width, height, channels: 3 } });

/** Wide, its centre a square in the middle of a band. */
export const wideJpeg = () => marked(900, 300).jpeg({ quality: 95 }).toBuffer();
/** Tall, its centre a square in the middle of a column. */
export const tallPng = () => marked(300, 900).png().toBuffer();
/** A still WebP of the marked square alone. */
export const squareWebp = () => marked(480, 480).webp({ quality: 95 }).toBuffer();

/** A portrait shot stored on its side: the pixels are the portrait turned
 * a quarter turn back, and the embedded orientation turns them upright. It
 * carries camera and place records and a payload after its end. */
export async function orientedPortraitJpeg(): Promise<Buffer> {
  const stored = await marked(400, 600).rotate(270).png().toBuffer();
  const jpeg = await sharp(stored).withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: RECORDS.camera, Model: "Fixture" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 8/1 0/1" } })
    .withXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:City="${RECORDS.place}"/></rdf:RDF></x:xmpmeta>`)
    .jpeg({ quality: 95 }).toBuffer();
  return Buffer.concat([jpeg, Buffer.from(RECORDS.appended)]);
}

/** A square whose middle is fully transparent and its edge opaque. */
export function transparentPng(): Promise<Buffer> {
  const side = 400, pixels = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const middle = Math.hypot(x - side / 2, y - side / 2) < side / 4;
      pixels.set([20, 120, 130, middle ? 0 : 255], (y * side + x) * 4);
    }
  }
  return sharp(pixels, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer();
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** One PNG chunk: its length, type, data and checksum. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4), sum = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  length.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A still PNG with an animation control chunk after its header: what
 * marks an animated PNG, whose other frames a still decoder skips. */
export async function animatedPng(): Promise<Buffer> {
  const still = await marked(64, 64).png().toBuffer();
  const afterHeader = PNG_SIGNATURE.length + 8 + 13 + 4;
  const control = Buffer.alloc(8); control.writeUInt32BE(2, 0); control.writeUInt32BE(0, 4);
  return Buffer.concat([still.subarray(0, afterHeader), chunk("acTL", control), still.subarray(afterHeader)]);
}

/** A PNG whose header declares 8,001 by 8,001 pixels over almost no data. */
export function hugePng(width = 8001, height = 8001): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x01])), chunk("IEND", Buffer.alloc(0))]);
}

export async function animatedWebp(): Promise<Buffer> {
  const frame = (background: string) => sharp({ create: { width: 64, height: 64, channels: 3, background } }).png().toBuffer();
  return sharp([await frame("#1a8f3c"), await frame("#c0392b")], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
}

export const gif = () => marked(64, 64).gif().toBuffer();
export const svg = () => Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>');
export const textNamedJpg = () => Buffer.from("This is a note, saved with a .jpg name.\n");

/** A JPEG whose headers are intact up to its scan, and whose scan is
 * garbage that never ends. */
export async function corruptJpeg(): Promise<Buffer> {
  const jpeg = await wideJpeg();
  const scan = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  return Buffer.concat([jpeg.subarray(0, scan + 2 + jpeg.readUInt16BE(scan + 2) + 16), Buffer.alloc(4000, 0x55)]);
}

/** A PNG whose image data no longer matches its checksum. */
export async function corruptPng(): Promise<Buffer> {
  const png = Buffer.from(await tallPng());
  const data = png.indexOf(Buffer.from("IDAT", "latin1")) + 4;
  for (let i = data + 8; i < data + 200; i += 1) png[i] ^= 0x5a;
  return png;
}

/** The first part of a JPEG, cut off in its scan. */
export const truncatedJpeg = async () => { const jpeg = await wideJpeg(); return jpeg.subarray(0, Math.floor(jpeg.length * 0.6)); };

/** The colour a stored picture shows at a point, by its nearest mark. */
export async function markAt(picture: Buffer, x: number, y: number): Promise<keyof typeof MARKS> {
  const { data, info } = await sharp(picture).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  const pixel = [data[at], data[at + 1], data[at + 2]];
  const distance = (colour: Rgb) => colour.reduce((sum, value, i) => sum + (value - pixel[i]) ** 2, 0);
  return (Object.keys(MARKS) as (keyof typeof MARKS)[]).reduce((best, name) => distance(MARKS[name]) < distance(MARKS[best]) ? name : best);
}

/** Whether a square picture holds the fixture's centre the right way up:
 * each quadrant's middle shows its own mark, and no corner shows outside. */
export async function holdsCentre(picture: Buffer): Promise<boolean> {
  const { width = 0 } = await sharp(picture).metadata();
  const q = width / 4, edge = Math.max(2, Math.round(width / 40));
  const expected: [number, number, keyof typeof MARKS][] = [
    [q, q, "topLeft"], [3 * q, q, "topRight"], [q, 3 * q, "bottomLeft"], [3 * q, 3 * q, "bottomRight"],
    [edge, edge, "topLeft"], [width - edge, edge, "topRight"], [edge, width - edge, "bottomLeft"], [width - edge, width - edge, "bottomRight"],
  ];
  for (const [x, y, mark] of expected) if (await markAt(picture, Math.floor(x), Math.floor(y)) !== mark) return false;
  return true;
}
