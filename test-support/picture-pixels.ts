import assert from "node:assert/strict";
import { decodePng } from "../src/lib/export/png-codec";
export function colourCentre(bytes: Uint8Array, colour: readonly number[]) {
  const image = decodePng(bytes);
  let x = 0, y = 0, count = 0;
  for (let row = 0; row < image.height; row++) for (let column = 0; column < image.width; column++) {
    const offset = (row * image.width + column) * 4;
    if (colour.every((value, channel) => Math.abs(image.rgba[offset + channel] - value) < 18)) { x += column + 0.5; y += row + 0.5; count++; }
  }
  if (count < 12) throw new Error("The expected mark is absent; a flat successful image is not a rendering proof.");
  return { x: x / count, y: y / count, count, width: image.width, height: image.height };
}
export const PICTURE_MARKS = [
  { dx: -200, dy: 0, colour: [233, 90, 45] },
  { dx: 0, dy: 0, colour: [26, 93, 74] },
  { dx: 200, dy: 100, colour: [40, 80, 220] },
] as const;
export const PICTURE_CAMERA = { lng: 13.4, lat: 0, zoom: 10, pitch: 0, bearing: 0 };
export function pictureMarkSql() {
  const world = 512 * 2 ** PICTURE_CAMERA.zoom;
  return PICTURE_MARKS.map((mark, i) => {
    const lng = PICTURE_CAMERA.lng + mark.dx * 360 / world;
    const lat = Math.atan(Math.sinh(-mark.dy * 2 * Math.PI / world)) * 180 / Math.PI;
    return { name: `Mark ${i}`, sql: `SELECT ST_Point(${lng}, ${lat}) AS geom`, style: {
      fill: { type: "constant" as const, color: { r: mark.colour[0], g: mark.colour[1], b: mark.colour[2], a: 1 } },
      stroke: { r: 0, g: 0, b: 0, a: 1 }, fillOpacity: 1, strokeWidth: 0, strokeOpacity: 0, pointRadius: 10, opacity: 1,
    } };
  });
}

/** Geometry, not image inequality: a missing or displaced mark must fail. */
export function assertPictureMarks(bytes: Uint8Array) {
  for (const mark of PICTURE_MARKS) {
    const measured = colourCentre(bytes, mark.colour);
    assert.deepEqual([measured.width, measured.height], [692, 296]);
    assert.ok(Math.abs(measured.x - (495 + mark.dx) * 692 / 990) < 2, "Mark longitude differs from the saved view");
    assert.ok(Math.abs(measured.y - (212 + mark.dy) * 296 / 424) < 2, "Mark latitude differs from the saved view");
  }
}

export function pictureMarkPosition(mark: { dx: number; dy: number }) {
  return { x: (495 + mark.dx) * 692 / 990, y: (212 + mark.dy) * 296 / 424 };
}
/** Check a small interior patch so missing marks cannot pass by changing
 * unrelated pixels elsewhere in the picture. */
export function assertPicturePatch(bytes: Uint8Array, x: number, y: number, colour: readonly number[]) {
  const image = decodePng(bytes);
  assert.deepEqual([image.width, image.height], [692, 296]);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const offset = (Math.floor(y) + dy) * image.width * 4 + (Math.floor(x) + dx) * 4;
    assert.ok(colour.every((value, channel) => Math.abs(image.rgba[offset + channel] - value) < 18), "Expected colour missing at the computed patch");
  }
}
