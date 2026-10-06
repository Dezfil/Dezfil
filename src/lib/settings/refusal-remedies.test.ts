import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { expectSettingRemedy } from "../../../test-support/setting-remedy";
import { activateSettingsStore, writeStoredSettings } from "./store";
import { assertOsmAreaWithinBudget } from "@/lib/osm/import";
import { assertAreaWithinBudget } from "@/lib/overture/import";
import { laneSettled, resetLane, submit } from "@/lib/operations/lane";
import { testAccountScope } from "@/lib/test-support/accounts";
import * as engine from "@/lib/duckdb";
import { boundedEvaluation } from "@/lib/query/bounded";
import { renderMapImage } from "@/lib/export/render-image";
import { initialDefinition } from "@/lib/export/image-definition";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); activateSettingsStore(f.db); });
afterEach(() => { resetLane(); vi.useRealTimers(); f.close(); });

it.each([false, true])("keeps area refusal codes and gives remedies with locked=%s", locked => {
  writeStoredSettings({ osmMaxKm2: 1, overtureMaxKm2: 1 }, f.db);
  if (locked) { vi.stubEnv("DEZFIL_OSM_MAX_KM2", "1"); vi.stubEnv("DEZFIL_OVERTURE_MAX_KM2", "1"); }
  for (const [run, label, variable] of [
    [() => assertOsmAreaWithinBudget([0, 0, 10, 10]), "OpenStreetMap area", "DEZFIL_OSM_MAX_KM2"],
    [() => assertAreaWithinBudget("places", [0, 0, 10, 10]), "Overture area", "DEZFIL_OVERTURE_MAX_KM2"],
  ] as const) {
    let error: unknown; try { run(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "area_too_large", status: 413 });
    expectSettingRemedy((error as Error).message, label, variable, locked);
  }
});

it.each([false, true])("keeps the queue refusal and gives its remedy with locked=%s", async locked => {
  writeStoredSettings({ operationConcurrency: 1, operationQueueMax: 1 }, f.db);
  if (locked) vi.stubEnv("DEZFIL_OPERATION_QUEUE_MAX", "1");
  const held = Promise.withResolvers<void>();
  submit("active", () => held.promise); submit("waiting", async () => {});
  try {
    let error: unknown; try { submit("overflow", async () => {}); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "operation_queue_full", status: 503 });
    expectSettingRemedy((error as Error).message, "Operation runs waiting", "DEZFIL_OPERATION_QUEUE_MAX", locked);
  } finally { held.resolve(); await laneSettled(); }
});

it.each([false, true])("keeps query_timeout and gives its remedy with locked=%s", async locked => {
  writeStoredSettings({ queryTimeoutS: 5 }, f.db);
  if (locked) vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", "5");
  const held = Promise.withResolvers<Awaited<ReturnType<typeof engine.connectQueryInstance>>>();
  vi.spyOn(engine, "connectQueryInstance").mockReturnValueOnce(held.promise);
  vi.useFakeTimers();
  const pending = boundedEvaluation(async () => {}, { scope: testAccountScope(f.db, "admin") }).catch(error => error);
  try {
    await vi.advanceTimersByTimeAsync(5001);
    const error = await pending;
    expect(error).toMatchObject({ code: "query_timeout", status: 408 });
    expectSettingRemedy(error.message, "Query time limit", "DEZFIL_QUERY_TIMEOUT_S", locked);
  } finally { held.reject(new Error("Acquisition ended")); await vi.advanceTimersByTimeAsync(0); }
});

it.each([false, true])("keeps render_timeout and gives its remedy with locked=%s", async locked => {
  writeStoredSettings({ exportRenderTimeoutS: 10 }, f.db);
  if (locked) vi.stubEnv("DEZFIL_EXPORT_RENDER_TIMEOUT_S", "10");
  vi.useFakeTimers();
  const held = Promise.withResolvers<{ png: Uint8Array }>();
  const pending = renderMapImage(testAccountScope(f.db, "admin"), {
    mapId: "image", baseUrl: "http://instance.test", credential: "fixture",
    definition: initialDefinition({ appearance: "light", camera: { lng: 0, lat: 0, zoom: 2 }, canvasWidth: 800,
      legendPresent: false, legendCorner: null, visibleWidgetIds: [], basemapLayers: null }, { width: 800, scale: 1 }),
    driver: { launch: async () => ({ render: () => held.promise, close: async () => {}, kill: () => {} }) },
  }).catch(error => error);
  try {
    await vi.advanceTimersByTimeAsync(10_001);
    const error = await pending;
    expect(error).toMatchObject({ code: "render_timeout", status: 408 });
    expectSettingRemedy(error.message, "Time limit per image", "DEZFIL_EXPORT_RENDER_TIMEOUT_S", locked);
  } finally { held.resolve({ png: new Uint8Array([1]) }); await vi.advanceTimersByTimeAsync(0); }
});
