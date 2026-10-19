import { afterAll, afterEach, expect, it } from "vitest";
import { erasureLedger } from "../../../test-support/account-erasure-ledger";
import { getPictureState, requestPicture, settlePicture } from "./state";
const f = erasureLedger();
f.db.prepare("DELETE FROM map_pictures").run();
afterAll(() => f.dispose());
afterEach(() => f.db.prepare("DELETE FROM map_pictures").run());
it("persists retries and generations without editing the document", () => {
  const before = f.db.prepare("SELECT * FROM maps WHERE id = ?").get("target-in-target");
  const requested = requestPicture("target-in-target", "digest", 100, false, f.db);
  expect(requested.requestedGeneration).toBe(1);
  settlePicture("target-in-target", 1, { state: "failed", attemptCount: 2, nextAttemptAt: 60100 }, f.db);
  expect(getPictureState("target-in-target", f.db)).toMatchObject({ state: "failed", nextAttemptAt: 60100, attemptCount: 2 });
  expect(requestPicture("target-in-target", "digest", 500, false, f.db).requestedGeneration).toBe(1);
  expect(requestPicture("target-in-target", "digest", 600, true, f.db)).toMatchObject({ requestedGeneration: 2, drawingChangedAt: 100, attemptCount: 0, state: "waiting" });
  expect(settlePicture("target-in-target", 1, { state: "current", publishedGeneration: 1 }, f.db)).toBe(false);
  expect(f.db.prepare("SELECT * FROM maps WHERE id = ?").get("target-in-target")).toEqual(before);
});
it("map deletion cascades and a late result cannot recreate the row", () => {
  requestPicture("target-in-target-near", "digest", 100, false, f.db);
  f.db.prepare("DELETE FROM maps WHERE id = ?").run("target-in-target-near");
  expect(getPictureState("target-in-target-near", f.db)).toBeNull();
  expect(settlePicture("target-in-target-near", 1, { state: "current" }, f.db)).toBe(false);
});
