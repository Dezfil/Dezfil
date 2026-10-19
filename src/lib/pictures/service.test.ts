import { afterAll, expect, it } from "vitest";
import { createMap } from "@/lib/map-service";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb } from "@/lib/metadata/db";
import { saveThumbnail } from "@/lib/map-thumbnails";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { getPictureState } from "./state";
import { PictureService } from "./service";
import { pictureTarget, publishPicture } from "./publication";
const scope = testAccountScope();
afterAll(closeMetadataDb);
it("looks queue missing pictures before old ones, recover the renderer and do not remake current files after restart", async () => {
  let now = Date.now() + 10000, available = false;
  const old = createMap(scope, "Old"), missing = createMap(scope, "Missing");
  await saveThumbnail(scope, old.id, Buffer.from("old"));
  const launches: string[] = [];
  const make = () => new PictureService({ now: () => now, available: () => available, baseUrl: "http://fixture.test", run: async state => {
    launches.push(state.mapId);
    await publishPicture(scope, pictureTarget(scope, state.mapId), state.requestedGeneration, { light: Buffer.from("light"), dark: Buffer.from("dark") }, NO_INPUTS);
  } });
  let service = make(); await service.look(); await service.queue.drain();
  expect(launches).toEqual([]); expect(getPictureState(missing.id)?.state).toBe("unavailable");
  available = true; now += 3600000; await service.look(); await service.queue.drain();
  service.queue.tick(); await service.queue.drain();
  expect(launches).toEqual([missing.id, old.id]);
  service = make(); await service.look(); service.queue.tick(); await service.queue.drain();
  expect(launches).toHaveLength(2);
});
