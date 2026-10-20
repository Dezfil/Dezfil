import assert from "node:assert/strict";
import sharp from "sharp";
import { decodePng, type DecodedImage } from "../src/lib/export/png-codec";
import { PICTURE_SHAPES, type PictureShape } from "../src/lib/pictures/shapes";

/** A picture's pixels, whether the server answered its PNG or a kept size. */
export async function decodePicture(bytes: Uint8Array): Promise<DecodedImage> {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return decodePng(bytes);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

const matches = (image: DecodedImage, offset: number, colour: readonly number[]) =>
  colour.every((value, channel) => Math.abs(image.rgba[offset + channel] - value) < 18);

/** Where a colour is drawn: the centre of its pixels, their count and their box. */
export function colourIn(image: DecodedImage, colour: readonly number[]) {
  let x = 0, y = 0, count = 0, left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (let row = 0; row < image.height; row++) for (let column = 0; column < image.width; column++) {
    if (!matches(image, (row * image.width + column) * 4, colour)) continue;
    x += column + 0.5; y += row + 0.5; count++;
    left = Math.min(left, column); right = Math.max(right, column + 1); top = Math.min(top, row); bottom = Math.max(bottom, row + 1);
  }
  return { x: x / count, y: y / count, count, left, right, top, bottom, width: image.width, height: image.height };
}

export function colourCentre(bytes: Uint8Array, colour: readonly number[]) {
  const found = colourIn(decodePng(bytes), colour);
  if (found.count < 12) throw new Error("The expected mark is absent; a flat successful image is not a rendering proof.");
  return found;
}

/** Three marks placed by Web Mercator pixel offsets from the saved centre
 * at the saved zoom, and two anchors on their own layer outside them. The
 * anchors set the box a picture frames, so hiding, filtering or restyling
 * a mark moves no other mark. */
export const PICTURE_MARKS = [
  { dx: -200, dy: 0, colour: [233, 90, 45] },
  { dx: 0, dy: 0, colour: [26, 93, 74] },
  { dx: 200, dy: 100, colour: [40, 80, 220] },
] as const;
export const PICTURE_ANCHORS = [{ dx: -320, dy: -80 }, { dx: 320, dy: 180 }] as const;
export const PICTURE_ANCHOR_COLOUR = [0, 160, 220] as const;
export const PICTURE_CAMERA = { lng: 13.4, lat: 0, zoom: 10, pitch: 0, bearing: 0 };
const WORLD = 512 * 2 ** PICTURE_CAMERA.zoom;
const lngOf = (dx: number) => PICTURE_CAMERA.lng + dx * 360 / WORLD;
const latOf = (dy: number) => Math.atan(Math.sinh(-dy * 2 * Math.PI / WORLD)) * 180 / Math.PI;
export const pointStyle = (colour: readonly number[], radius: number) => ({
  fill: { type: "constant" as const, color: { r: colour[0], g: colour[1], b: colour[2], a: 1 } },
  stroke: { r: 0, g: 0, b: 0, a: 1 }, fillOpacity: 1, strokeWidth: 0, strokeOpacity: 0, pointRadius: radius, opacity: 1,
});
/** The mark layers, in PICTURE_MARKS order, and the anchors' layer last. */
export function pictureMarkSql() {
  const marks = PICTURE_MARKS.map((mark, i) => ({ name: `Mark ${i}`, sql: `SELECT ST_Point(${lngOf(mark.dx)}, ${latOf(mark.dy)}) AS geom`, style: pointStyle(mark.colour, 10) }));
  const anchors = PICTURE_ANCHORS.map(a => `SELECT ST_Point(${lngOf(a.dx)}, ${latOf(a.dy)}) AS geom`).join(" UNION ALL ");
  return [...marks, { name: "Anchors", sql: anchors, style: pointStyle(PICTURE_ANCHOR_COLOUR, 4) }];
}

/** Web Mercator in world units, 0 to 1 across. */
export const mercator = (lng: number, lat: number) => [
  (lng + 180) / 360,
  (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2,
] as const;

/**
 * Where a flat, north-up picture of a shape draws a point, in the pixels of
 * an image of that shape `imageWidth` wide, by Fit's rule worked out here
 * from the shape's frame and margin: the box of `framed` scaled to the
 * frame inside the margin, no closer than Fit's closest zoom, centred.
 */
export function framedPosition(shape: PictureShape, framed: readonly (readonly [number, number])[], imageWidth: number) {
  const { frame, padding } = PICTURE_SHAPES[shape];
  const points = framed.map(([lng, lat]) => mercator(lng, lat));
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const availableWidth = frame.width - padding.left - padding.right, availableHeight = frame.height - padding.top - padding.bottom;
  const scale = Math.min(availableWidth / Math.max(maxX - minX, 1e-12), availableHeight / Math.max(maxY - minY, 1e-12), 512 * 2 ** 15);
  const k = imageWidth / frame.width;
  return {
    /** Image pixels per world unit. */
    scale: scale * k,
    at: (lng: number, lat: number) => {
      const [x, y] = mercator(lng, lat);
      return { x: (padding.left + availableWidth / 2 + (x - (minX + maxX) / 2) * scale) * k, y: (padding.top + availableHeight / 2 + (y - (minY + maxY) / 2) * scale) * k };
    },
  };
}

const anchorFrame = (imageWidth: number) => framedPosition("card", PICTURE_ANCHORS.map(a => [lngOf(a.dx), latOf(a.dy)] as const), imageWidth);
/** Where the card's default PNG draws a mark. */
export function pictureMarkPosition(mark: { dx: number; dy: number }) {
  return anchorFrame(692).at(lngOf(mark.dx), latOf(mark.dy));
}
/** The card's default PNG pixels per pixel of the saved zoom. */
export function pictureMarkScale() {
  return anchorFrame(692).scale / WORLD;
}

/** Geometry, not image inequality: a missing or displaced mark must fail. */
export function assertPictureMarks(bytes: Uint8Array) {
  for (const mark of PICTURE_MARKS) {
    const measured = colourCentre(bytes, mark.colour), expected = pictureMarkPosition(mark);
    assert.deepEqual([measured.width, measured.height], [692, 296]);
    assert.ok(Math.abs(measured.x - expected.x) < 2, "Mark longitude differs from the framed data");
    assert.ok(Math.abs(measured.y - expected.y) < 2, "Mark latitude differs from the framed data");
  }
}

/** Check a small interior patch so missing marks cannot pass by changing
 * unrelated pixels elsewhere in the picture. */
export function assertPicturePatch(bytes: Uint8Array, x: number, y: number, colour: readonly number[]) {
  const image = decodePng(bytes);
  assert.deepEqual([image.width, image.height], [692, 296]);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const offset = (Math.floor(y) + dy) * image.width * 4 + (Math.floor(x) + dx) * 4;
    assert.ok(matches(image, offset, colour), "Expected colour missing at the computed patch");
  }
}
