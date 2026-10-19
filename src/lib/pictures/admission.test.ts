import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterEach, expect, it } from "vitest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb } from "@/lib/metadata/db";
import { renderMapImage, type RenderDriver } from "@/lib/export/render-image";
import { cardDefinition } from "./card";
import { channel } from "node:diagnostics_channel";
isolatePictureData();
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
afterEach(() => { delete process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY; closeMetadataDb(); });
it("reports the background slot as released only once the browser has closed", async () => {
  const observations: unknown[] = [], observe = (event: unknown) => observations.push(event);
  const measurement = channel("dezfil.picture.measure");
  const closing = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  measurement.subscribe(observe);
  const render = renderMapImage(testAccountScope(), { mapId: "measured", background: true, budgetMs: 2000,
    definition: cardDefinition({ lng: 0, lat: 0, zoom: 1 }, "light"), credential: "fixture", baseUrl: "http://fixture.test",
    driver: { launch: async () => ({ render: async () => ({ png: new Uint8Array([1]) }),
      close: () => { closing.resolve(); return closed.promise; }, kill: () => {} }) },
  });
  try {
    await closing.promise;
    expect(observations).toEqual([expect.objectContaining({ kind: "admitted", background: true, mapId: "measured" })]);
    closed.resolve(); await render;
    expect(observations).toEqual([
      expect.objectContaining({ kind: "admitted", background: true, mapId: "measured" }),
      expect.objectContaining({ kind: "released", background: true, mapId: "measured" }),
    ]);
  } finally { closed.resolve(); await render; measurement.unsubscribe(observe); }
});
it("reserves a foreground slot and admits people ahead of waiting pictures", async () => {
  process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "2";
  const started: string[] = [], releases: (() => void)[] = [];
  const run = (name: string, background: boolean) => {
    const driver: RenderDriver = { launch: async () => {
      started.push(name);
      return { render: () => new Promise(resolve => releases.push(() => resolve({ png: new Uint8Array([1]) }))), close: async () => {}, kill: () => {} };
    } };
    return renderMapImage(testAccountScope(), { mapId: name, definition: cardDefinition({ lng: 0, lat: 0, zoom: 1 }, "light"), credential: "fixture", baseUrl: "http://fixture.test", driver, background, budgetMs: 2000 });
  };
  const a = run("picture-a", true); await tick();
  const b = run("picture-b", true); await tick();
  expect(started).toEqual(["picture-a"]);
  const person = run("person", false); await tick();
  expect(started).toEqual(["picture-a", "person"]);
  releases.shift()!(); await a; await tick();
  expect(started).toEqual(["picture-a", "person", "picture-b"]);
  for (const release of releases) release();
  await Promise.all([b, person]);
});
it("starts each picture budget only after admission", async () => {
  process.env.DEZFIL_EXPORT_RENDER_CONCURRENCY = "1";
  let release!: () => void;
  const scope = testAccountScope();
  const input = { mapId: "m", definition: cardDefinition({ lng: 0, lat: 0, zoom: 1 }, "light"), credential: "fixture", baseUrl: "http://fixture.test" };
  const first = renderMapImage(scope, { ...input, driver: { launch: async () => ({ render: () => new Promise(resolve => { release = () => resolve({ png: new Uint8Array([1]) }); }), close: async () => {}, kill: () => {} }) } });
  await tick();
  const second = renderMapImage(scope, { ...input, background: true, budgetMs: 30, driver: { launch: async () => ({ render: async () => ({ png: new Uint8Array([2]) }), close: async () => {}, kill: () => {} }) } });
  const observed = second.catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 60)); release(); await first;
  expect(await observed).toMatchObject({ png: new Uint8Array([2]) });
});
