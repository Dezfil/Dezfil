import { isolatePictureData } from "@/lib/test-support/picture-data";
import { readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMap } from "@/lib/map-service";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { dataDir } from "@/lib/config";
import { copyThumbnail, publishedPictureSized, readPicture, readThumbnail, removeThumbnail } from "@/lib/map-thumbnails";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { requestPicture } from "./state";
import { pictureTarget, publishPicture } from "./publication";
import { PICTURE_SHAPES } from "./shapes";
import type { PictureImages } from "./card";

isolatePictureData();
const scope = testAccountScope();
afterAll(closeMetadataDb);

/** A picture whose every file says what it is, so a read names its pick. */
function images(tag: string): PictureImages {
  return {
    png: Buffer.from(`${tag}:png`),
    sized: (["card", "wide"] as const).flatMap((shape) => PICTURE_SHAPES[shape].widths.map((width) => ({
      shape, width, height: 1, bytes: Buffer.from(`${tag}:${shape}-${width}`),
    }))),
  };
}
const files = (mapId: string) => readdirSync(path.join(dataDir(), "thumbnails")).filter((name) => name.startsWith(`${mapId}.`) && !name.endsWith(".json"));

async function publish(mapId: string, light: Uint8Array | PictureImages, dark?: Uint8Array | PictureImages) {
  const target = pictureTarget(scope, mapId);
  const state = requestPicture(mapId, target.digest, Date.now(), true);
  await publishPicture(scope, target, state.requestedGeneration, { light, ...(dark ? { dark } : {}) }, NO_INPUTS);
}
const read = async (mapId: string, theme: "light" | "dark", want = {}) => {
  const answer = await readPicture(scope, mapId, theme, want);
  return answer && { type: answer.type, text: answer.bytes.toString() };
};

describe("a picture's kept sizes", () => {
  it("answers the narrowest size at least as wide, a shape's widest, the card for a width alone, and the PNG when nothing is named", async () => {
    const map = createMap(scope, "Sizes");
    await publish(map.id, images("light"), images("dark"));
    expect(await read(map.id, "light", { shape: "wide", width: 1500 })).toEqual({ type: "image/webp", text: "light:wide-1656" });
    expect(await read(map.id, "dark", { shape: "card", width: 800 })).toEqual({ type: "image/webp", text: "dark:card-1080" });
    expect(await read(map.id, "light", { shape: "card", width: 1980 })).toEqual({ type: "image/webp", text: "light:card-1980" });
    expect(await read(map.id, "light", { shape: "card", width: 99999 })).toEqual({ type: "image/webp", text: "light:card-1980" });
    expect(await read(map.id, "light", { shape: "wide" })).toEqual({ type: "image/webp", text: "light:wide-3312" });
    expect(await read(map.id, "dark", { width: 100 })).toEqual({ type: "image/webp", text: "dark:card-360" });
    expect(await read(map.id, "light")).toEqual({ type: "image/png", text: "light:png" });
    expect((await readThumbnail(scope, map.id, "dark"))?.toString()).toBe("dark:png");
    expect(await publishedPictureSized(map.id)).toBe(true);
  });

  it("serves one sized picture for both themes when the map has one appearance", async () => {
    const map = createMap(scope, "Fixed ground");
    metadataDb().prepare("UPDATE maps SET basemap = 'light' WHERE id = ?").run(map.id);
    await publish(map.id, images("only"));
    expect(await read(map.id, "dark", { shape: "wide", width: 2000 })).toEqual({ type: "image/webp", text: "only:wide-2208" });
    expect(files(map.id).filter((name) => name.endsWith(".webp"))).toHaveLength(9);
  });

  it("answers an older picture's PNG whatever is named, and retires every size a later set does not keep", async () => {
    const map = createMap(scope, "Older");
    await publish(map.id, images("first"), images("first-dark"));
    const before = files(map.id);
    expect(before.filter((name) => name.endsWith(".webp"))).toHaveLength(18);
    await publish(map.id, Buffer.from("png only"), Buffer.from("png only dark"));
    expect(await read(map.id, "light", { shape: "wide", width: 1200 })).toEqual({ type: "image/png", text: "png only" });
    expect(await publishedPictureSized(map.id)).toBe(false);
    expect(files(map.id).filter((name) => name.endsWith(".webp"))).toEqual([]);
    await publish(map.id, images("second"), images("second-dark"));
    const after = files(map.id);
    expect(after.filter((name) => name.endsWith(".webp"))).toHaveLength(18);
    expect(after.some((name) => before.includes(name))).toBe(false);
  });

  it("copies the sizes into a duplicate and erases them with the map's pictures", async () => {
    const from = createMap(scope, "Original");
    const to = createMap(scope, "Copy");
    await publish(from.id, images("orig"), images("orig-dark"));
    await copyThumbnail(scope, from.id, to.id);
    expect(await read(to.id, "dark", { shape: "card", width: 700 })).toEqual({ type: "image/webp", text: "orig-dark:card-720" });
    expect(await publishedPictureSized(to.id)).toBe(true);
    await removeThumbnail(scope, to.id);
    expect(files(to.id)).toEqual([]);
    expect(files(from.id).filter((name) => name.endsWith(".webp"))).toHaveLength(18);
  });

  it("refuses a set whose appearances kept different sizes", async () => {
    const map = createMap(scope, "Uneven");
    const dark = images("dark");
    dark.sized = dark.sized.filter((size) => size.width !== 360);
    await expect(publish(map.id, images("light"), dark)).rejects.toThrow();
    expect(files(map.id)).toEqual([]);
  });
});
