import { expect, it } from "vitest";
import { WebMercatorViewport } from "@deck.gl/core";
import { assertPicturePatch, assertPictureMarks, colourCentre, framedPosition, PICTURE_MARKS, pictureMarkPosition, pictureMarkSql } from "../../../test-support/picture-pixels";
import { PICTURE_SHAPES } from "./shapes";
import { pictureProofClient } from "../../../test-support/pictures-http";
import { encodePng } from "@/lib/export/png-codec";
it("the transport-only seed cannot satisfy a mark proof", () => {
  const flat = encodePng({ width: 692, height: 296, rgba: new Uint8Array(692 * 296 * 4).fill(128) });
  expect(() => colourCentre(flat, [26, 93, 74])).toThrow("mark is absent");
  expect(pictureMarkSql()).toHaveLength(PICTURE_MARKS.length + 1);
});
it("outside proof clients refuse the development listener before any request", () => {
  expect(() => pictureProofClient("http://127.0.0.1:3000", "fixture")).toThrow("separate port");
});

it("the mark oracle rejects a seeded displaced mark as well as a blank picture", () => {
  const pixels = (shift: number) => {
    const rgba = new Uint8Array(692 * 296 * 4).fill(255);
    for (const [i, mark] of PICTURE_MARKS.entries()) {
      const at = pictureMarkPosition(mark);
      const x = Math.round(at.x) + (i === 0 ? shift : 0);
      const y = Math.round(at.y);
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) rgba.set([...mark.colour, 255], ((y + dy) * 692 + x + dx) * 4);
    }
    return encodePng({ width: 692, height: 296, rgba });
  };
  expect(() => assertPictureMarks(pixels(20))).toThrow("longitude");
  expect(() => assertPictureMarks(pixels(0))).not.toThrow();
});
it("the never-opened client accepts a separately provisioned remote instance", () => {
  expect(() => pictureProofClient("https://pictures.example.test", "fixture")).not.toThrow();
});

it("a seeded unchanged colour cannot pass the drawing-change patch oracle", () => {
  const rgba = new Uint8Array(692 * 296 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([180, 25, 160, 255], offset);
  const changed = encodePng({ width: 692, height: 296, rgba });
  expect(() => assertPicturePatch(changed, 100, 100, [233, 90, 45])).toThrow("colour missing");
  expect(() => assertPicturePatch(changed, 100, 100, [180, 25, 160])).not.toThrow();
});

it("works out Fit's framing as deck.gl's own fit does, in each shape", () => {
  const box: [number, number][] = [[13.4, -0.006], [13.46, 0.012]];
  for (const shape of ["card", "wide"] as const) {
    const { frame, padding } = PICTURE_SHAPES[shape];
    const fitted = new WebMercatorViewport({ ...frame }).fitBounds(box, { padding, maxZoom: 15 });
    const ours = framedPosition(shape, box, frame.width);
    for (const point of [[13.4, -0.006], [13.43, 0.003], [13.46, 0.012]] as const) {
      const [x, y] = fitted.project(point);
      expect(ours.at(...point).x).toBeCloseTo(x, 3);
      expect(ours.at(...point).y).toBeCloseTo(y, 3);
    }
  }
});
