import { afterAll, expect, it } from "vitest";
import { erasureLedger } from "../../../test-support/account-erasure-ledger";
import { initializePicture, adoptPicture } from "./migration";
import { listPictureStates, requestPicture } from "./state";
const f = erasureLedger();
f.db.exec("DELETE FROM map_pictures");
afterAll(() => f.dispose());
it("orders old pictures after missing ones using edit time and does not migrate twice", () => {
  initializePicture("target-in-target", "a", true, 300, f.db);
  initializePicture("target-in-target-near", "b", false, 100, f.db);
  initializePicture("target-near-in-target", "c", true, 200, f.db);
  expect(listPictureStates(f.db).map(s => s.mapId)).toEqual(["target-in-target-near", "target-in-target", "target-near-in-target"]);
  expect(initializePicture("target-in-target", "a", true, 999, f.db).drawingChangedAt).toBe(300);
});
it("adopts an inherited picture until its drawing changes", () => {
  const state = adoptPicture("target-near-in-target-near", "inherited", 500, f.db);
  expect(state).toMatchObject({ state: "current", producer: "inherited", requestedGeneration: 1, publishedGeneration: 1 });
  expect(requestPicture(state.mapId, "inherited", 600, false, f.db)).toEqual(state);
  expect(requestPicture(state.mapId, "edited", 700, false, f.db)).toMatchObject({ state: "waiting", requestedGeneration: 2, publishedGeneration: 1 });
});
