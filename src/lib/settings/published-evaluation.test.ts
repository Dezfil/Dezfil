import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { activateSettingsStore, writeStoredSettings } from "./store";
import { testAccountScope } from "@/lib/test-support/accounts";
import * as engine from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { getPublishedView, publishMap, resetPublishCache } from "@/lib/publish/publish-service";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); activateSettingsStore(f.db); resetPublishCache(); });
afterEach(() => { resetPublishCache(); engine.resetQueryInstance(); vi.useRealTimers(); f.close(); });

it("keeps a cached published result until freshness expires, then evaluates under the changed stored query deadline", async () => {
  const scope = testAccountScope(f.db, "admin"), map = createMap(scope, "Deadline map");
  const revision = () => ({ expectedRevision: readDocumentRevision({ kind: "map", id: map.id })!.editRevision });
  await createLayer(scope, map.id, { name: "Point", sql: "SELECT ST_Point(1, 2) AS geom" }, revision());
  const { token } = publishMap(scope, map.id, {}, revision());
  writeStoredSettings({ queryTimeoutS: 60 }, f.db);
  const now = Date.now(), cached = await getPublishedView(token, now);
  expect(cached?.layers[0].render).toMatchObject({ ok: true, featureCount: 1 });

  const held = Promise.withResolvers<Awaited<ReturnType<typeof engine.connectQueryInstance>>>();
  const connect = vi.spyOn(engine, "connectQueryInstance").mockReturnValue(held.promise);
  writeStoredSettings({ queryTimeoutS: 5 }, f.db);
  expect(await getPublishedView(token, now + 29_999)).toBe(cached);
  expect(connect).not.toHaveBeenCalled();

  vi.useFakeTimers();
  const pending = getPublishedView(token, now + 30_000);
  let settled = false;
  const markSettled = () => { settled = true; };
  void pending.then(markSettled, markSettled);
  try {
    await vi.advanceTimersByTimeAsync(4999);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    const fresh = await pending;
    expect(fresh).not.toBe(cached);
    expect(fresh?.layers[0].render).toMatchObject({ ok: false, error: { code: "query_timeout" } });
    expect(cached?.layers[0].render.ok).toBe(true);
  } finally {
    held.reject(new Error("Fixture acquisition released")); await pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
  }
});
