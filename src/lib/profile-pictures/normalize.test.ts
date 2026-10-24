import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  animatedPng, animatedWebp, corruptJpeg, corruptPng, gif, holdsCentre, hugePng, orientedPortraitJpeg, RECORDS,
  squareWebp, svg, tallPng, textNamedJpg, transparentPng, truncatedJpeg, wideJpeg,
} from "../../../test-support/profile-picture-fixtures";
import { normalizePicture, pictureProcessorCounts } from "./normalize";
import { PICTURE_LIMITS } from "./limits";

// The stored copy of a picture, from real fixtures through the real image
// library: the centred square the right way up, transparency kept, every
// embedded record dropped; and every refusal with its code, the header
// refusals before any pixel is decoded.

let folder: string;
beforeAll(() => { folder = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "normalize-")); });
afterAll(() => rmSync(folder, { recursive: true, force: true }));

let named = 0;
function saved(bytes: Buffer, name = `upload-${named++}`): string {
  const file = path.join(folder, name);
  writeFileSync(file, bytes);
  return file;
}
const normalize = (bytes: Buffer, name?: string) => normalizePicture(saved(bytes, name)).picture;

describe("the stored copy", () => {
  it.each([
    ["a wide JPEG", wideJpeg],
    ["a tall PNG", tallPng],
    ["a still WebP", squareWebp],
    ["a portrait with embedded orientation", orientedPortraitJpeg],
  ])("keeps the centred square of %s, the right way up, as one 320 pixel WebP", async (_label, fixture) => {
    const stored = await normalize(await fixture());
    const meta = await sharp(stored).metadata();
    expect([meta.format, meta.width, meta.height, meta.pages ?? 1]).toEqual(["webp", PICTURE_LIMITS.side, PICTURE_LIMITS.side, 1]);
    expect(await holdsCentre(stored)).toBe(true);
  });

  it("would see a top-left crop and an ignored orientation as wrong", async () => {
    // Controls on the check itself: the pictures a wrong normalization
    // makes do not pass it.
    const side = PICTURE_LIMITS.side;
    const wide = await wideJpeg();
    const topLeft = await sharp(wide).resize(side, side, { fit: "cover", position: "left top" }).webp().toBuffer();
    expect(await holdsCentre(topLeft)).toBe(false);
    const oriented = await orientedPortraitJpeg();
    const ignored = await sharp(oriented, { autoOrient: false }).resize(side, side, { fit: "cover" }).webp().toBuffer();
    expect(await holdsCentre(ignored)).toBe(false);
  });

  it("keeps transparency, so the circle's background shows through", async () => {
    const stored = await normalize(await transparentPng());
    const { data, info } = await sharp(stored).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    expect(alpha(160, 160)).toBe(0);
    expect(alpha(4, 4)).toBe(255);
  });

  it("drops the camera, place and appended records the upload carried", async () => {
    const upload = await orientedPortraitJpeg();
    const input = await sharp(upload).metadata();
    // The fixture carries what must go, so absence below is not vacuous.
    expect(input.orientation).toBe(6);
    for (const record of Object.values(RECORDS)) expect(upload.includes(Buffer.from(record)), record).toBe(true);
    expect(input.exif?.length).toBeGreaterThan(0);
    expect(input.xmp?.length).toBeGreaterThan(0);
    const stored = await normalize(upload);
    for (const record of Object.values(RECORDS)) expect(stored.includes(Buffer.from(record)), record).toBe(false);
    const meta = await sharp(stored).metadata();
    expect([meta.exif, meta.xmp, meta.icc, meta.iptc, meta.orientation]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("runs the library with its operation cache off", async () => {
    await normalize(await squareWebp());
    expect(sharp.cache()).toMatchObject({ memory: { max: 0 }, files: { max: 0 }, items: { max: 0 } });
  });
});

describe("the refusals", () => {
  const still = "Choose a still JPEG, PNG or WebP image.";
  it.each([
    ["an SVG", svg, "unsupported_image", 415, `The file is an SVG image. ${still}`],
    ["a GIF", gif, "unsupported_image", 415, `The file is a GIF image. ${still}`],
    ["an animated WebP", animatedWebp, "unsupported_image", 415, `The image is animated. ${still}`],
    ["an animated PNG", animatedPng, "unsupported_image", 415, `The image is animated. ${still}`],
    ["a text file named .jpg", textNamedJpg, "unsupported_image", 415, `The file is not a JPEG, PNG or WebP image. ${still}`],
    ["an image over 64 million pixels", () => hugePng(), "image_too_large", 413,
      "The image is 8,001 by 8,001 pixels, over the fixed limit of 64 million. Choose a smaller still JPEG, PNG or WebP image."],
  ] as const)("refuses %s before any pixel is decoded", async (_label, fixture, code, status, message) => {
    const before = pictureProcessorCounts();
    await expect(normalize(await fixture(), "face.jpg")).rejects.toMatchObject({ code, status, message });
    expect(pictureProcessorCounts().decoded).toBe(before.decoded);
  });

  it("decodes an image at exactly 64 million pixels' worth of header", async () => {
    // The bound is "over": 8,000 by 8,000 passes the header and fails only
    // on its missing data, when processing meets it.
    const before = pictureProcessorCounts();
    await expect(normalize(hugePng(8000, 8000))).rejects.toMatchObject({ code: "unsupported_image", message: `The image is damaged or incomplete. ${still}` });
    expect(pictureProcessorCounts().decoded).toBe(before.decoded + 1);
  });

  it.each([
    ["a JPEG whose scan is garbage", corruptJpeg],
    ["a PNG whose data fails its checksum", corruptPng],
    ["a truncated JPEG", truncatedJpeg],
  ])("refuses %s when processing meets it", async (_label, fixture) => {
    const before = pictureProcessorCounts();
    await expect(normalize(await fixture())).rejects.toMatchObject({ code: "unsupported_image", status: 415, message: `The image is damaged or incomplete. ${still}` });
    expect(pictureProcessorCounts().decoded).toBe(before.decoded + 1);
  });
});
