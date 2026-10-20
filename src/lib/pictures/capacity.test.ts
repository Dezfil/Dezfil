import { afterAll, expect, it, vi } from "vitest";
import { isolatePictureData } from "@/lib/test-support/picture-data";
import { seedPictureCapacity } from "@/lib/test-support/picture-capacity";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { PictureService } from "./service";
import { pictureTarget, publishPicture } from "./publication";
import { sizedPicture } from "@/lib/test-support/picture-sizes";
import { getPictureState } from "./state";
import { renderLayer } from "@/lib/layer-render";
import { resetQueryInstance } from "@/lib/duckdb";
isolatePictureData();
afterAll(() => { vi.unstubAllEnvs(); resetQueryInstance(); closeMetadataDb(); });

const basemapUrl = "http://127.0.0.1:3582/style.json";

it.each(["missing", "mixed"] as const)("drains the %s capacity fixture, keeps current pictures and resumes once", async kind => {
  vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "2");
  const scope = testAccountScope(metadataDb(), kind), maps = await seedPictureCapacity(scope, kind, basemapUrl);
  for (const map of maps) {
    const target = pictureTarget(scope, map.id);
    expect(target.map.layers).toHaveLength(1);
    expect(target.map.layers[0]).toMatchObject({ visible: true, filters: [], viz: { type: "points" } });
    expect(target.map.viewport).toMatchObject({ lng: 13.4, lat: 52.5, zoom: 12 });
    expect(!!target.basemaps.dark).toBe(map.pair);
    if (!map.pair) expect(target.basemaps.light.url).toBe(basemapUrl);
  }
  const layer = pictureTarget(scope, maps[0].id).map.layers[0];
  expect(await renderLayer(scope, layer)).toMatchObject({ ok: true, mode: "inline", geojson: {
    features: [{ geometry: { type: "Point", coordinates: [13.4, 52.5] } }],
  } });
  const ids = new Set(maps.map(map => map.id)), launches: string[] = [];
  const make = () => new PictureService({ baseUrl: "http://fixture.test", available: () => true, now: () => Date.now() + 60000, run: async state => {
    expect(ids.has(state.mapId)).toBe(true);
    launches.push(state.mapId);
    const target = pictureTarget(scope, state.mapId);
    await publishPicture(scope, target, state.requestedGeneration, { light: sizedPicture("fixture"), ...(target.basemaps.dark ? { dark: sizedPicture("fixture") } : {}) }, NO_INPUTS);
  } });
  let service = make(); await service.look(); await service.queue.drain();
  const count = kind === "mixed" ? 200 : 300;
  for (let i = 1; i < count; i++) {
    if (i === count / 2) { service = make(); await service.look(); }
    else service.queue.tick();
    await service.queue.drain();
  }
  expect(new Set(launches).size).toBe(count);
  expect(launches).toHaveLength(count);
  expect(launches.slice(0, kind === "mixed" ? 100 : 300)).toEqual(maps.filter(map => map.group === "missing").reverse().map(map => map.id));
  if (kind === "mixed") {
    expect(new Set(launches.slice(0, 100))).toEqual(new Set(maps.filter(map => map.group === "missing").map(map => map.id)));
    expect(launches.slice(100)).toEqual(maps.filter(map => map.group === "old").reverse().map(map => map.id));
  }
  for (const map of maps) expect(getPictureState(map.id)).toMatchObject({ state: "current", requestedGeneration: 1, publishedGeneration: 1 });
  await make().look(); await service.queue.drain();
  expect(launches).toHaveLength(count);
});

it("an imagery address replacement changes freshness despite the stable proxy address", () => {
  const scope = testAccountScope(), map = createMap(scope, "Imagery");
  metadataDb().prepare("UPDATE maps SET basemap = 'satellite' WHERE id = ?").run(map.id);
  vi.stubEnv("DEZFIL_SATELLITE_URL", "https://tiles.example.test/first/{z}/{x}/{y}.png");
  const first = pictureTarget(scope, map.id);
  vi.stubEnv("DEZFIL_SATELLITE_URL", "https://tiles.example.test/second/{z}/{x}/{y}.png");
  const second = pictureTarget(scope, map.id);
  expect(second.basemaps.light.url).toBe(first.basemaps.light.url);
  expect(second.digest).not.toBe(first.digest);
});
