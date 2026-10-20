import { expect, it } from "vitest";
import { assertPictureMarks, colourCentre, PICTURE_MARKS, pictureMarkSql } from "../../../test-support/picture-pixels";
import { pictureProofClient } from "../../../test-support/pictures-http";
import { encodePng } from "@/lib/export/png-codec";
it("the transport-only seed cannot satisfy a mark proof", () => {
  const flat = encodePng({ width: 692, height: 296, rgba: new Uint8Array(692 * 296 * 4).fill(128) });
  expect(() => colourCentre(flat, [26, 93, 74])).toThrow("mark is absent");
  expect(pictureMarkSql()).toHaveLength(3);
});
it("outside proof clients refuse the development listener before any request", () => {
  expect(() => pictureProofClient("http://127.0.0.1:3000", "fixture")).toThrow("separate port");
});

it("the mark oracle rejects a seeded displaced mark as well as a blank picture", () => {
  const pixels = (shift: number) => {
    const rgba = new Uint8Array(692 * 296 * 4).fill(255);
    for (const [i, mark] of PICTURE_MARKS.entries()) {
      const x = Math.round((495 + mark.dx) * 692 / 990) + (i === 0 ? shift : 0);
      const y = Math.round((212 + mark.dy) * 296 / 424);
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
