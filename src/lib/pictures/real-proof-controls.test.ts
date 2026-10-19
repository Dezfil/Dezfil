import { expect, it } from "vitest";
import { colourCentre, pictureMarkSql } from "../../../test-support/picture-pixels";
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
