import { isolatePictureData } from "@/lib/test-support/picture-data";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createMap } from "@/lib/map-service";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { dataDir } from "@/lib/config";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { copyThumbnail, publishedPictureFormat, readPicture, readThumbnail, saveThemedThumbnail, servedThumbnails } from "@/lib/map-thumbnails";
import { asFirstRecipe, sizedPicture } from "@/lib/test-support/picture-sizes";
import { PictureRenderError } from "./card";
import { getPictureState, requestPicture, requestRemake, retirePicture, retiredPictures } from "./state";
import { pictureTarget, publishPicture } from "./publication";
import { PictureService } from "./service";
import { adoptPicture } from "./migration";

isolatePictureData();
const scope = testAccountScope();
afterAll(closeMetadataDb);
beforeEach(() => metadataDb().exec("DELETE FROM maps"));

let now = Date.now();
let outcome: () => Error = () => new Error("The basemap did not load.");
const service = () => new PictureService({ baseUrl: "http://fixture.test", now: () => now, available: () => true, run: async () => { throw outcome(); } });
const files = (mapId: string) => readdirSync(path.join(dataDir(), "thumbnails")).filter((name) => name.startsWith(`${mapId}.`));

/** A map with a current picture of the given kind and a re-make asked. */
async function pictured(name: string, kind: "saved view" | "first recipe" | "this recipe" | "template" | "template, unmarked") {
  const map = createMap(scope, name);
  const target = pictureTarget(scope, map.id);
  const state = requestPicture(map.id, target.digest, now, true);
  if (kind === "template" || kind === "template, unmarked") {
    // A template copy saves its release's pictures as they came.
    const release = (theme: string) => readFileSync(path.join(process.cwd(), "templates", "earthquakes", "3", "pictures", `${theme}.png`));
    for (const theme of ["light", "dark"] as const) {
      await saveThemedThumbnail(scope, map.id, theme, "release", kind === "template" ? Buffer.from(`marked-${theme}`) : release(theme), NO_INPUTS, null, kind === "template" ? "template" : undefined);
    }
    adoptPicture(map.id, target.digest, now);
  } else {
    await publishPicture(scope, target, state.requestedGeneration, kind === "saved view"
      ? { light: Buffer.from("saved-light"), dark: Buffer.from("saved-dark") }
      : { light: sizedPicture("light"), dark: sizedPicture("dark") }, NO_INPUTS);
    if (kind === "first recipe") asFirstRecipe(map.id);
  }
  expect(getPictureState(map.id)).toMatchObject({ state: "current" });
  requestRemake(map.id, now);
  return map.id;
}

/** Runs the map's waiting attempts as they fall due, `times` of them. A
 * service finds its renderer at a look or a request; here it is told. */
async function attempts(mapId: string, times: number, run = service()) {
  (run as unknown as { checkRenderer(): void }).checkRenderer();
  for (let i = 0; i < times; i++) {
    now = Math.max(now, getPictureState(mapId)!.nextAttemptAt);
    run.queue.tick(); await run.queue.drain();
  }
}

async function served(mapId: string): Promise<boolean> {
  const reads = await Promise.all([
    readPicture(scope, mapId, "light"), readPicture(scope, mapId, "dark"),
    readPicture(scope, mapId, "light", { shape: "card", width: 360 }), readPicture(scope, mapId, "dark", { shape: "wide" }),
    readThumbnail(scope, mapId),
  ]);
  const listed = (await servedThumbnails(scope, [mapId])).has(mapId);
  expect(new Set([...reads.map((answer) => answer !== null), listed]).size, "every road agrees").toBe(1);
  return listed;
}

describe("a picture framed at the saved view", () => {
  it("is served through two failed re-makes and retired at the third, on every road, its bytes kept", async () => {
    const id = await pictured("Saved view", "saved view");
    const kept = files(id);
    await attempts(id, 2);
    expect(getPictureState(id)).toMatchObject({ state: "failed", attemptCount: 2 });
    expect(await served(id)).toBe(true);
    await attempts(id, 1);
    expect(getPictureState(id)).toMatchObject({ state: "failed", attemptCount: 3 });
    expect(retiredPictures([id]).has(id)).toBe(true);
    expect(await served(id)).toBe(false);
    expect(files(id)).toEqual(kept);
    // A duplicate made now starts without it.
    const copy = createMap(scope, "Duplicate of a retired picture");
    await copyThumbnail(scope, id, copy.id);
    expect(await publishedPictureFormat(copy.id)).toBeNull();
    expect(files(copy.id)).toEqual([]);
  });

  it("stays retired through a drawing change, a refresh and a restart, each followed by failing attempts, until a picture lands", async () => {
    const id = await pictured("Stays retired", "saved view");
    await attempts(id, 3);
    expect(await served(id)).toBe(false);
    const run = service();
    // A drawing change: one appearance now.
    metadataDb().prepare("UPDATE maps SET basemap = 'light' WHERE id = ?").run(id);
    await run.request(id);
    await attempts(id, 2, run);
    expect(await served(id)).toBe(false);
    await run.refresh(id);
    await attempts(id, 1, run);
    expect(await served(id)).toBe(false);
    const restarted = service();
    await restarted.look();
    await attempts(id, 1, restarted);
    expect(await served(id)).toBe(false);
    expect(retiredPictures([id]).has(id)).toBe(true);
    // A picture landing ends it.
    const state = getPictureState(id)!;
    await publishPicture(scope, pictureTarget(scope, id), state.requestedGeneration, { light: sizedPicture("landed") }, NO_INPUTS);
    expect(retiredPictures([id]).has(id)).toBe(false);
    expect(await served(id)).toBe(true);
    expect((await readPicture(scope, id, "dark", { shape: "card", width: 700 }))?.bytes.toString()).toBe("landed:card-720");
  });

  it("is not retired by a failure reported for a request that has since been replaced", async () => {
    const id = await pictured("Late failure", "saved view");
    await attempts(id, 3);
    metadataDb().prepare("UPDATE map_pictures SET retired = 0 WHERE map_id = ?").run(id);
    const failed = getPictureState(id)!;
    requestPicture(id, failed.digest, now, true);
    expect(retirePicture(id, failed.requestedGeneration)).toBe(false);
    expect(await served(id)).toBe(true);
  });

  it("is never retired by an unsupported outcome, and keeps a retirement through one", async () => {
    outcome = () => new PictureRenderError("unsupported");
    try {
      const id = await pictured("Cannot be drawn", "saved view");
      await attempts(id, 3);
      expect(getPictureState(id)).toMatchObject({ state: "unsupported" });
      expect(await served(id)).toBe(true);
      outcome = () => new Error("The basemap did not load.");
      const retired = await pictured("Retired, then cannot be drawn", "saved view");
      await attempts(retired, 3);
      expect(await served(retired)).toBe(false);
      outcome = () => new PictureRenderError("unsupported");
      await service().refresh(retired);
      await attempts(retired, 1);
      expect(getPictureState(retired)).toMatchObject({ state: "unsupported" });
      expect(await served(retired)).toBe(false);
    } finally {
      outcome = () => new Error("The basemap did not load.");
    }
  });
});

describe("pictures that are never retired", () => {
  it.each(["first recipe", "this recipe", "template", "template, unmarked"] as const)("a %s picture stays served however often its re-make fails", async (kind) => {
    const id = await pictured(`Never retired: ${kind}`, kind);
    await attempts(id, 4);
    expect(getPictureState(id)).toMatchObject({ state: "failed", attemptCount: 4 });
    expect(retiredPictures([id]).has(id)).toBe(false);
    expect(await served(id)).toBe(true);
  });
});
