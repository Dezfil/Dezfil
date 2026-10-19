import { afterAll, beforeEach, expect, it } from "vitest";
import { erasureLedger } from "../../../test-support/account-erasure-ledger";
import { requestPicture, getPictureState, settlePicture } from "./state";
import { PictureQueue } from "./queue";
const f = erasureLedger(); f.db.exec("DELETE FROM map_pictures");
afterAll(() => f.dispose());
beforeEach(() => f.db.exec("DELETE FROM map_pictures"));
it("ten saves coalesce behind the quiet period and a late completion cannot settle a newer generation", async () => {
  let now = 0, launches = 0;
  const map = "target-in-target";
  let finish!: () => void;
  const queue = new PictureQueue({ db: f.db, now: () => now, available: () => true, building: () => false, capacity: () => 1,
    run: async state => { launches++; await new Promise<void>(resolve => { finish = resolve; }); settlePicture(map, state.requestedGeneration, { state: "current", publishedGeneration: state.requestedGeneration }, f.db); } });
  for (let i = 0; i < 10; i++) { requestPicture(map, `drawing-${i}`, now, false, f.db); queue.tick(); now += 1000; }
  expect(launches).toBe(0);
  now = 14000; queue.tick(); expect(launches).toBe(1);
  requestPicture(map, "newest", now, false, f.db); now += 5000; queue.tick(); expect(launches).toBe(1);
  finish(); await queue.drain();
  expect(getPictureState(map, f.db)?.state).toBe("waiting");
  queue.tick(); expect(launches).toBe(2); finish(); await queue.drain();
  expect(getPictureState(map, f.db)?.state).toBe("current");
});
it("persists retry deadlines across queue replacement and waits for building tiles", async () => {
  const map = "target-in-target-near";
  let now = 0, builds = true, launches = 0;
  requestPicture(map, "drawing", now, false, f.db);
  const make = () => new PictureQueue({ db: f.db, now: () => now, available: () => true, building: () => builds, capacity: () => 1, run: async () => { launches++; throw new Error("failed"); } });
  let queue = make(); now = 5000; queue.tick(); await queue.drain(); expect(launches).toBe(0);
  builds = false; queue.tick(); await queue.drain(); expect(launches).toBe(1);
  expect(getPictureState(map, f.db)).toMatchObject({ attemptCount: 1, nextAttemptAt: 65000, state: "failed" });
  queue = make(); now = 64999; queue.tick(); expect(launches).toBe(1);
  now++; queue.tick(); await queue.drain(); expect(launches).toBe(2);
  now += 600000; queue.tick(); await queue.drain(); expect(launches).toBe(3);
  expect(getPictureState(map, f.db)?.nextAttemptAt).toBe(now + 3600000);
  now++; queue.tick(); expect(launches).toBe(3);
});

it("an absent renderer changes waiting rows once and leaves repeated ticks read only", async () => {
  const map = "target-in-target";
  requestPicture(map, "drawing", 0, false, f.db);
  let launches = 0;
  const queue = new PictureQueue({ db: f.db, now: () => 5000, available: () => false, building: () => false, capacity: () => 1, run: async () => { launches++; } });
  queue.tick();
  const writes = () => (f.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const before = writes();
  for (let i = 0; i < 3600; i++) queue.tick();
  await queue.drain();
  expect(getPictureState(map, f.db)?.state).toBe("unavailable");
  expect(writes()).toBe(before);
  expect(launches).toBe(0);
});
