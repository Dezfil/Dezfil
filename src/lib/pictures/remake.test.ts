import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, beforeEach, expect, it } from "vitest";
import { createMap } from "@/lib/map-service";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { asFirstRecipe, sizedPicture } from "@/lib/test-support/picture-sizes";
import { getPictureState, listPictureStates, requestPicture, requestRemake, type PictureState } from "./state";
import { rememberBindings } from "./bindings";
import { insertLayer } from "@/lib/metadata/maps";
import { defaultStyle } from "@/lib/style/defaults";
import { randomUUID } from "node:crypto";
import { PictureService } from "./service";
import { pictureTarget, publishPicture } from "./publication";
import { onCurrentFormula } from "./digest";
isolatePictureData();
const scope = testAccountScope();
afterAll(closeMetadataDb);
beforeEach(() => metadataDb().exec("DELETE FROM maps"));

const earlier = Date.now() - 3600000;
/** A map with a published picture (sized by this recipe, sized by the
 * first, or bare, as an earlier server wrote it) whose row the earlier
 * code wrote with the first formula. */
async function earlierRow(name: string, picture: "sized" | "first" | "bare" | "none", row: Partial<{ state: string; attempts: number; nextAttemptAt: number; digest: string; drawingChangedAt: number }> = {}) {
  const map = createMap(scope, name);
  const target = pictureTarget(scope, map.id);
  const state = requestPicture(map.id, target.digest, earlier);
  if (picture !== "none") {
    await publishPicture(scope, target, state.requestedGeneration, picture === "bare"
      ? { light: Buffer.from("light"), dark: Buffer.from("dark") }
      : { light: sizedPicture("light"), dark: sizedPicture("dark") }, NO_INPUTS);
    if (picture === "first") asFirstRecipe(map.id);
  }
  const first = row.digest ?? target.firstFormulaDigest;
  metadataDb().prepare(`UPDATE map_pictures SET digest = ?, published_digest = CASE WHEN published_digest IS NULL THEN NULL ELSE ? END,
    state = COALESCE(?, state), attempt_count = COALESCE(?, attempt_count), next_attempt_at = COALESCE(?, next_attempt_at),
    drawing_changed_at = COALESCE(?, drawing_changed_at) WHERE map_id = ?`)
    .run(first, first, row.state ?? null, row.attempts ?? null, row.nextAttemptAt ?? null, row.drawingChangedAt ?? null, map.id);
  return { id: map.id, target, before: getPictureState(map.id)! };
}
const unchangedBut = (before: PictureState, fields: Partial<PictureState>) => ({ ...before, ...fields });

it("moves every row to the current formula keeping its times and attempts, and re-makes current pictures without sizes or by an earlier recipe, last", async () => {
  const now = Date.now(), later = now + 7 * 86400000;
  const sized = await earlierRow("Current, sized", "sized");
  // Its drawing changed most recently of all: only the re-make rule puts it last.
  const unsized = await earlierRow("Current, without sizes", "bare", { drawingChangedAt: now - 1000 });
  const first = await earlierRow("Current, first recipe", "first", { drawingChangedAt: now - 2000 });
  const stale = await earlierRow("Changed since", "sized", { digest: "0".repeat(64) });
  const pending = await earlierRow("Pending retry", "none", { attempts: 2, nextAttemptAt: later });
  const failed = await earlierRow("Failed", "bare", { state: "failed", attempts: 3, nextAttemptAt: later });
  const unsupported = await earlierRow("Unsupported", "bare", { state: "unsupported" });
  const launches: string[] = [];
  const service = new PictureService({ baseUrl: "http://fixture.test", now: () => now, available: () => true, run: async state => { launches.push(state.mapId); } });
  await service.look(); await service.queue.drain();

  const state = (id: string) => getPictureState(id)!;
  expect(state(sized.id)).toEqual(unchangedBut(sized.before, { digest: sized.target.digest, publishedDigest: sized.target.digest }));
  for (const outdated of [unsized, first]) {
    expect(state(outdated.id)).toEqual(unchangedBut(outdated.before, {
      digest: outdated.target.digest, publishedDigest: outdated.target.digest, state: "waiting",
      requestedGeneration: outdated.before.requestedGeneration + 1, requestedAt: now, nextAttemptAt: now,
    }));
  }
  // A row that no longer matches is the real change it is: a new drawing time, the ordinary order.
  expect(state(stale.id)).toMatchObject({ digest: stale.target.digest, publishedDigest: "0".repeat(64), state: "waiting",
    requestedGeneration: stale.before.requestedGeneration + 1, drawingChangedAt: now });
  expect(state(pending.id)).toEqual(unchangedBut(pending.before, { digest: pending.target.digest }));
  expect(state(failed.id)).toEqual(unchangedBut(failed.before, { digest: failed.target.digest, publishedDigest: failed.target.digest }));
  expect(state(unsupported.id)).toEqual(unchangedBut(unsupported.before, { digest: unsupported.target.digest, publishedDigest: unsupported.target.digest }));
  for (const row of listPictureStates()) expect(onCurrentFormula(row.digest)).toBe(true);

  const order = listPictureStates().map(row => row.mapId);
  expect(new Set(order.slice(-2))).toEqual(new Set([unsized.id, first.id]));
  expect(order.indexOf(stale.id)).toBeLessThan(order.indexOf(pending.id));
  // One background render at a time: the first launched is a re-make.
  expect(launches).toHaveLength(1);
  expect([unsized.id, first.id]).toContain(launches[0]);

  // A second start-up finds nothing to move and nothing more to re-make.
  const settled = listPictureStates();
  await new PictureService({ baseUrl: "http://fixture.test", now: () => now + 1000, available: () => true, run: async () => {} }).look();
  expect(listPictureStates()).toEqual(settled);

  // The re-made sets keep sizes by this recipe, so later looks leave them
  // alone, across a restart; a real change then moves the row into the
  // ordinary order.
  for (const outdated of [unsized, first]) {
    const remade = state(outdated.id);
    await publishPicture(scope, pictureTarget(scope, outdated.id), remade.requestedGeneration, { light: sizedPicture("light"), dark: sizedPicture("dark") }, NO_INPUTS);
  }
  for (const at of [now + 2000, now + 2500]) {
    await new PictureService({ baseUrl: "http://fixture.test", now: () => at, available: () => true, run: async () => {} }).look();
    for (const outdated of [unsized, first]) {
      const remade = state(outdated.id);
      expect(remade).toMatchObject({ state: "current", requestedGeneration: outdated.before.requestedGeneration + 1, publishedGeneration: outdated.before.requestedGeneration + 1 });
    }
  }
  requestPicture(unsized.id, "v2:changed", now + 3000);
  expect(listPictureStates()[0].mapId).toBe(unsized.id);
});

it("an edit the picture ignores, arriving before the first look, finds its row moved and not changed", async () => {
  const row = await earlierRow("Renamed before the look", "bare");
  const now = Date.now();
  const service = new PictureService({ baseUrl: "http://fixture.test", now: () => now, available: () => true, run: async () => {} });
  await service.request(row.id);
  expect(getPictureState(row.id)).toEqual(unchangedBut(row.before, { digest: row.target.digest, publishedDigest: row.target.digest }));
});

it("a duplicate's adoption keeps a set by this recipe current and re-makes one without sizes or by the first recipe at once", async () => {
  const launches: string[] = [];
  const now = Date.now();
  const service = new PictureService({ baseUrl: "http://fixture.test", now: () => now, available: () => true, run: async state => { launches.push(state.mapId); } });
  const { copyThumbnail } = await import("@/lib/map-thumbnails");
  for (const [name, picture] of [["Sized source", "sized"], ["Bare source", "bare"], ["First recipe source", "first"]] as const) {
    const source = await earlierRow(name, picture);
    const copy = createMap(scope, `${name} copy`);
    await copyThumbnail(scope, source.id, copy.id);
    await service.adopt(copy.id); await service.queue.drain();
    expect(getPictureState(copy.id)).toMatchObject(picture === "sized"
      ? { state: "current", producer: "inherited", requestedGeneration: 1 }
      : { state: "waiting", producer: "inherited", requestedGeneration: 2, publishedGeneration: 1 });
    expect(launches.includes(copy.id)).toBe(picture !== "sized");
    // Out of the queue, so the next copy's re-make is the one launched.
    metadataDb().prepare("DELETE FROM maps WHERE id = ?").run(copy.id);
  }
});

it("a look reuses a row's stored bindings across the formula move, evaluating no layer again", async () => {
  const map = createMap(scope, "Stored bindings");
  // A layer that cannot evaluate now: evaluating it again would mark the
  // bindings unresolved and request a new generation.
  insertLayer({ id: randomUUID(), mapId: map.id, name: "Gone", sql: "SELECT * FROM no_such_table", style: defaultStyle("POINT", 0), visible: true,
    tooltip: null, popup: null, publishedFields: null, inLegend: true, viz: { type: "points" }, filters: [], legendTitle: null, legendLabels: null,
    legendAttrs: null, ordinal: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const target = pictureTarget(scope, map.id);
  const state = requestPicture(map.id, target.digest, earlier);
  await publishPicture(scope, target, state.requestedGeneration, { light: sizedPicture("light"), dark: sizedPicture("dark") }, NO_INPUTS);
  rememberBindings(map.id, NO_INPUTS, true);
  metadataDb().prepare("UPDATE map_pictures SET digest = ?, published_digest = ? WHERE map_id = ?").run(target.firstFormulaDigest, target.firstFormulaDigest, map.id);
  const before = getPictureState(map.id)!;
  await new PictureService({ baseUrl: "http://fixture.test", now: () => Date.now(), available: () => true, run: async () => {} }).look();
  expect(getPictureState(map.id)).toEqual(unchangedBut(before, { digest: target.digest, publishedDigest: target.digest }));
});

it("asks a re-make only of a current row", () => {
  const map = createMap(scope, "Only current");
  for (const state of ["waiting", "failed", "unsupported", "unavailable"]) {
    requestPicture(map.id, `v2:${state}`, earlier);
    metadataDb().prepare("UPDATE map_pictures SET state = ?, attempt_count = 2 WHERE map_id = ?").run(state, map.id);
    const before = getPictureState(map.id);
    expect(requestRemake(map.id, Date.now())).toEqual(before);
  }
});
