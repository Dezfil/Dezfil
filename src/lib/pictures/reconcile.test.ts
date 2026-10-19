import { afterAll, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createMap } from "@/lib/map-service";
import { closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { publishedPictureGeneration } from "@/lib/map-thumbnails";
import { pictureTarget } from "./publication";
import { getPictureState, requestPicture } from "./state";
import { reconcilePictureFiles } from "./reconcile";
const scope = testAccountScope();
afterAll(closeMetadataDb);
it("recovers after the publisher is killed between the manifest and metadata writes", async () => {
  const map = createMap(scope, "Crash boundary");
  const state = requestPicture(map.id, pictureTarget(scope, map.id).digest, Date.now() - 6000);
  const child = spawn(process.execPath, ["scripts/pictures-crash-child.mjs", map.id], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  expect(exit, stderr).toEqual({ code: null, signal: "SIGKILL" });
  closeMetadataDb();
  expect(await publishedPictureGeneration(map.id)).toBe(state.requestedGeneration);
  expect(getPictureState(map.id)?.publishedGeneration).toBe(0);
  const recovered = await reconcilePictureFiles(map.id, true, Date.now());
  expect(recovered).toMatchObject({ state: "waiting", requestedGeneration: state.requestedGeneration });
  expect(await reconcilePictureFiles(map.id, true, Date.now())).toEqual(recovered);
});
