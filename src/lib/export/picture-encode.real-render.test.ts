import puppeteer, { type Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePicture } from "../../../test-support/picture-pixels";
import { edgeRise, luminance } from "../../../test-support/edge-rise";
import { PICTURE_QUALITY, pictureRequest } from "@/lib/pictures/card";
import { PICTURE_SHAPE } from "@/lib/pictures/shapes";
import { encodePictureSizes, webpDimensions } from "./picture-encode";
import { encodePng, type DecodedImage } from "./png-codec";

const chromium = process.env.DEZFIL_CHROMIUM_PATH;

/** A master with one hard vertical edge a little off a whole pixel, so no
 * reduction lands on it exactly, optionally spread by a box blur. */
function master(width: number, height: number, blur = 0): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const edge = width * 0.437;
  for (let x = 0; x < width; x++) {
    const share = blur ? Math.min(1, Math.max(0, (x + 0.5 - edge + blur / 2) / blur)) : x + 0.5 >= edge ? 1 : 0;
    const value = Math.round(30 + share * 200);
    for (let y = 0; y < height; y++) rgba.set([value, value, value, 255], (y * width + x) * 4);
  }
  return encodePng({ width, height, rgba });
}
const riseAcross = (image: DecodedImage) => {
  const row = Math.floor(image.height / 2), line: number[] = [];
  for (let x = 0; x < image.width; x++) { const o = (row * image.width + x) * 4; line.push(luminance(image.rgba[o], image.rgba[o + 1], image.rgba[o + 2])); }
  return edgeRise(line);
};

/**
 * The kept sizes as the renderer's own browser makes them: each at
 * exactly its size and format, reduced without softening a hard edge
 * (the rise from 10 to 90 percent stays within two of its pixels, where a
 * master already spread over six fails), and a browser that answers
 * another format than asked failing the render rather than storing it.
 *
 * Run with DEZFIL_CHROMIUM_PATH at Playwright's headless shell:
 * npm test -- src/lib/export/picture-encode.real-render.test.ts --maxWorkers=1
 */
describe.skipIf(!chromium)("the renderer's browser encodes the kept sizes", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await puppeteer.launch({ executablePath: chromium, headless: true }); }, 60000);
  afterAll(async () => { await browser?.close(); });

  it("makes every kept size at its pixel size and format, keeping a hard edge sharp", async () => {
    const { frame, scale } = PICTURE_SHAPE;
    const page = await browser.newPage();
    try {
      const request = pictureRequest();
      const encoded = await encodePictureSizes(page, master(frame.width * scale, frame.height * scale), request);
      expect(encoded).toHaveLength(request.sizes.length);
      for (const [i, size] of request.sizes.entries()) {
        const image = await decodePicture(encoded[i]);
        expect([image.width, image.height], `${size.width}`).toEqual([size.width, size.height]);
        if (size.type === "image/webp") expect(webpDimensions(encoded[i])).toEqual({ width: size.width, height: size.height });
        else expect(Buffer.from(encoded[i]).subarray(1, 4).toString("latin1")).toBe("PNG");
        expect(riseAcross(image), `${size.width}: the edge's rise`).toBeLessThanOrEqual(2);
      }
      expect(request.quality).toBe(PICTURE_QUALITY);
    } finally { await page.close(); }
  }, 120000);

  it("measures a softened master as soft: the sharpness bound can fail", async () => {
    const page = await browser.newPage();
    try {
      const [encoded] = await encodePictureSizes(page, master(1980, 848, 6), { frame: { padding: { top: 0, right: 0, bottom: 0, left: 0 } }, sizes: [{ width: 1980, height: 848, type: "image/webp" }], quality: PICTURE_QUALITY });
      expect(riseAcross(await decodePicture(encoded))).toBeGreaterThan(2);
    } finally { await page.close(); }
  }, 60000);

  it("fails when the browser answers another format than asked", async () => {
    const page = await browser.newPage();
    try {
      // A browser without a WebP encoder answers PNG for a WebP request.
      await page.evaluate(() => {
        const original = OffscreenCanvas.prototype.convertToBlob;
        OffscreenCanvas.prototype.convertToBlob = function (this: OffscreenCanvas) { return original.call(this, { type: "image/png" }); };
      });
      await expect(encodePictureSizes(page, master(968, 494), pictureRequest())).rejects.toThrow("could not be encoded");
    } finally { await page.close(); }
  }, 60000);
});
