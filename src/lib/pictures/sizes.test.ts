import { isolatePictureData } from "@/lib/test-support/picture-data";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMap } from "@/lib/map-service";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { dataDir } from "@/lib/config";
import { copyThumbnail, publishedPictureFormat, publishedPictureGeneration, readPicture, readThumbnail, removeThumbnail } from "@/lib/map-thumbnails";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { requestPicture } from "./state";
import { pictureTarget, publishPicture } from "./publication";
import { asFirstRecipe, publishedManifest, sizedPicture as images } from "@/lib/test-support/picture-sizes";
import type { PictureImages } from "./card";

isolatePictureData();
const scope = testAccountScope();
afterAll(closeMetadataDb);

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
  it("answers the narrowest size at least as wide, the widest, the one shape under either name, and the PNG when nothing is named", async () => {
    const map = createMap(scope, "Sizes");
    await publish(map.id, images("light"), images("dark"));
    expect(await read(map.id, "dark", { shape: "card", width: 800 })).toEqual({ type: "image/webp", text: "dark:card-1080" });
    expect(await read(map.id, "light", { shape: "card", width: 1980 })).toEqual({ type: "image/webp", text: "light:card-1980" });
    expect(await read(map.id, "light", { shape: "card", width: 99999 })).toEqual({ type: "image/webp", text: "light:card-2904" });
    // The wide name answers the one shape kept now.
    expect(await read(map.id, "light", { shape: "wide", width: 1500 })).toEqual({ type: "image/webp", text: "light:card-1980" });
    expect(await read(map.id, "light", { shape: "wide" })).toEqual({ type: "image/webp", text: "light:card-2904" });
    expect(await read(map.id, "dark", { width: 100 })).toEqual({ type: "image/webp", text: "dark:card-360" });
    expect(await read(map.id, "light")).toEqual({ type: "image/png", text: "light:png" });
    expect((await readThumbnail(scope, map.id, "dark"))?.toString()).toBe("dark:png");
    expect(await publishedPictureFormat(map.id)).toEqual({ sized: true, recipe: 2 });
    expect(publishedManifest(map.id)).toMatchObject({ sizes: { card: [360, 720, 1080, 1440, 1980, 2904] }, recipe: 2 });
    expect(publishedManifest(map.id).sizes).not.toHaveProperty("wide");
  });

  it("serves one sized picture for both themes when the map has one appearance", async () => {
    const map = createMap(scope, "Fixed ground");
    metadataDb().prepare("UPDATE maps SET basemap = 'light' WHERE id = ?").run(map.id);
    await publish(map.id, images("only"));
    expect(await read(map.id, "dark", { shape: "wide", width: 2000 })).toEqual({ type: "image/webp", text: "only:card-2904" });
    expect(files(map.id).filter((name) => name.endsWith(".webp"))).toHaveLength(6);
  });

  it("answers an older picture's PNG whatever is named, and retires every size a later set does not keep", async () => {
    const map = createMap(scope, "Older");
    await publish(map.id, images("first"), images("first-dark"));
    const before = files(map.id);
    expect(before.filter((name) => name.endsWith(".webp"))).toHaveLength(12);
    await publish(map.id, Buffer.from("png only"), Buffer.from("png only dark"));
    expect(await read(map.id, "light", { shape: "wide", width: 1200 })).toEqual({ type: "image/png", text: "png only" });
    expect(await publishedPictureFormat(map.id)).toEqual({ sized: false, recipe: 0 });
    expect(files(map.id).filter((name) => name.endsWith(".webp"))).toEqual([]);
    await publish(map.id, images("second"), images("second-dark"));
    const after = files(map.id);
    expect(after.filter((name) => name.endsWith(".webp"))).toHaveLength(12);
    expect(after.some((name) => before.includes(name))).toBe(false);
  });

  it("copies the sizes and the recipe into a duplicate and erases them with the map's pictures", async () => {
    const from = createMap(scope, "Original");
    const to = createMap(scope, "Copy");
    await publish(from.id, images("orig"), images("orig-dark"));
    await copyThumbnail(scope, from.id, to.id);
    expect(await read(to.id, "dark", { shape: "card", width: 700 })).toEqual({ type: "image/webp", text: "orig-dark:card-720" });
    expect(await publishedPictureFormat(to.id)).toEqual({ sized: true, recipe: 2 });
    await removeThumbnail(scope, to.id);
    expect(files(to.id)).toEqual([]);
    expect(files(from.id).filter((name) => name.endsWith(".webp"))).toHaveLength(12);
  });

  it("copies a single appearance's sizes into a duplicate", async () => {
    const from = createMap(scope, "One ground"), to = createMap(scope, "One ground copy");
    for (const id of [from.id, to.id]) metadataDb().prepare("UPDATE maps SET basemap = 'light' WHERE id = ?").run(id);
    await publish(from.id, images("only"));
    await copyThumbnail(scope, from.id, to.id);
    expect(files(to.id).filter((name) => name.endsWith(".webp"))).toHaveLength(6);
    expect(await read(to.id, "dark", { shape: "wide", width: 1200 })).toEqual({ type: "image/webp", text: "only:card-1440" });
  });

  it("keeps a duplicate's recipe when it cannot copy every size, so it stays a picture framed on its data", async () => {
    const from = createMap(scope, "Missing a size"), to = createMap(scope, "Missing a size copy");
    await publish(from.id, images("orig"), images("orig-dark"));
    rmSync(path.join(dataDir(), "thumbnails", files(from.id).find((name) => name.endsWith(".light.card-720.webp"))!));
    await copyThumbnail(scope, from.id, to.id);
    expect(await publishedPictureFormat(to.id)).toEqual({ sized: false, recipe: 2 });
    expect(await read(to.id, "light", { shape: "card", width: 1000 })).toEqual({ type: "image/png", text: "orig:png" });
    expect(files(to.id).filter((name) => name.endsWith(".webp"))).toEqual([]);
  });

  it("refuses a set whose appearances kept different sizes", async () => {
    const map = createMap(scope, "Uneven");
    const dark = images("dark");
    dark.sized = dark.sized.filter((size) => size.width !== 360);
    await expect(publish(map.id, images("light"), dark)).rejects.toThrow();
    expect(files(map.id)).toEqual([]);
  });
});

describe("a picture made by the first sized recipe", () => {
  it("answers its own sizes under each shape name until a new picture replaces it", async () => {
    const map = createMap(scope, "First recipe");
    await publish(map.id, images("light"), images("dark"));
    asFirstRecipe(map.id);
    expect(await publishedPictureFormat(map.id)).toEqual({ sized: true, recipe: 1 });
    expect(await read(map.id, "light", { shape: "wide", width: 1500 })).toEqual({ type: "image/webp", text: "first-light:wide-1656" });
    expect(await read(map.id, "dark", { shape: "card", width: 2500 })).toEqual({ type: "image/webp", text: "first-dark:card-1980" });
    expect(await read(map.id, "dark", { width: 700 })).toEqual({ type: "image/webp", text: "first-dark:card-720" });
    expect(await read(map.id, "light")).toEqual({ type: "image/png", text: "light:png" });
    expect(files(map.id).filter((name) => name.endsWith(".webp"))).toHaveLength(18);
    // The new picture retires every size of the first, both shapes.
    await publish(map.id, images("next"), images("next-dark"));
    expect(files(map.id).filter((name) => name.endsWith(".webp"))).toHaveLength(12);
    expect(files(map.id).some((name) => name.includes(".wide-"))).toBe(false);
    expect(await read(map.id, "light", { shape: "wide", width: 1500 })).toEqual({ type: "image/webp", text: "next:card-1980" });
  });

  it("copies into a duplicate with both shapes, or as the first recipe without sizes when one is missing, and erases with the map", async () => {
    const from = createMap(scope, "First original"), whole = createMap(scope, "First copy"), partial = createMap(scope, "First copy, partial");
    await publish(from.id, images("orig"), images("orig-dark"));
    asFirstRecipe(from.id);
    await copyThumbnail(scope, from.id, whole.id);
    expect(await publishedPictureFormat(whole.id)).toEqual({ sized: true, recipe: 1 });
    expect(await read(whole.id, "dark", { shape: "wide", width: 2000 })).toEqual({ type: "image/webp", text: "first-dark:wide-2208" });
    expect(files(whole.id).filter((name) => name.endsWith(".webp"))).toHaveLength(18);
    rmSync(path.join(dataDir(), "thumbnails", files(from.id).find((name) => name.endsWith(".dark.wide-1104.webp"))!));
    await copyThumbnail(scope, from.id, partial.id);
    expect(await publishedPictureFormat(partial.id)).toEqual({ sized: false, recipe: 1 });
    await removeThumbnail(scope, whole.id);
    expect(files(whole.id)).toEqual([]);
  });

  it("keeps a single appearance's generation readable, as the start-up check reads it", async () => {
    const map = createMap(scope, "First, one ground");
    metadataDb().prepare("UPDATE maps SET basemap = 'light' WHERE id = ?").run(map.id);
    await publish(map.id, images("only"));
    const generation = await publishedPictureGeneration(map.id);
    asFirstRecipe(map.id);
    expect(generation).not.toBeNull();
    expect(await publishedPictureGeneration(map.id)).toBe(generation);
    expect(await publishedPictureFormat(map.id)).toEqual({ sized: true, recipe: 1 });
    expect(await read(map.id, "dark", { shape: "wide", width: 1200 })).toEqual({ type: "image/webp", text: "first-light:wide-1656" });
  });
});
