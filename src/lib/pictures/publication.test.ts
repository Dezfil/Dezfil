import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, expect, it } from "vitest";
import { createMap } from "@/lib/map-service";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { readThumbnail, publishedPictureGeneration } from "@/lib/map-thumbnails";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { requestPicture, getPictureState } from "./state";
import { pictureTarget, publishPicture } from "./publication";
isolatePictureData();
const scope = testAccountScope();
const map = createMap(scope, "Publication");
afterAll(closeMetadataDb);
it("publishes the whole set with matching evidence and row generations", async () => {
  const target = pictureTarget(scope, map.id);
  const state = requestPicture(map.id, target.digest, Date.now());
  await publishPicture(scope, target, state.requestedGeneration, { light: Buffer.from("light"), dark: Buffer.from("dark") }, NO_INPUTS);
  expect((await readThumbnail(scope, map.id, "light"))?.toString()).toBe("light");
  expect((await readThumbnail(scope, map.id, "dark"))?.toString()).toBe("dark");
  expect(await publishedPictureGeneration(map.id)).toBe(state.requestedGeneration);
  expect(getPictureState(map.id)).toMatchObject({ state: "current", publishedGeneration: state.requestedGeneration });
});
it("rejects a superseded attempt and keeps both previous images", async () => {
  const target = pictureTarget(scope, map.id);
  const old = requestPicture(map.id, target.digest, Date.now(), true);
  requestPicture(map.id, target.digest, Date.now(), true);
  await expect(publishPicture(scope, target, old.requestedGeneration, { light: Buffer.from("wrong"), dark: Buffer.from("wrong") }, NO_INPUTS)).rejects.toThrow();
  expect((await readThumbnail(scope, map.id, "light"))?.toString()).toBe("light");
  expect((await readThumbnail(scope, map.id, "dark"))?.toString()).toBe("dark");
});

it("publishes one fixed-ground image for both themes without retaining a second image", async () => {
  metadataDb().prepare("UPDATE maps SET basemap = 'light' WHERE id = ?").run(map.id);
  const target = pictureTarget(scope, map.id);
  const state = requestPicture(map.id, target.digest, Date.now());
  await publishPicture(scope, target, state.requestedGeneration, { light: Buffer.from("single") }, NO_INPUTS);
  expect((await readThumbnail(scope, map.id, "light"))?.toString()).toBe("single");
  expect((await readThumbnail(scope, map.id, "dark"))?.toString()).toBe("single");
  expect(await publishedPictureGeneration(map.id)).toBe(state.requestedGeneration);
});
