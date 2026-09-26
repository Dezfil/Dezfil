// The render page's half: the
// page declares the filters it applied from the map it read first,
// while each layer's data is read again by the layer render request. An
// edit landing between the two reads must never leave the image
// attributed to the earlier filters. Red-proven: without the binding
// the declaration carries the pre-edit filters while the data carries
// the edit.
import path from "node:path";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { FIXTURES_DIR, addLayer, createMap, routeHouse, seedCsv } from "./support";

const runId = Date.now().toString(36);
const definition = {
  viewport: { lng: 13.37, lat: 52.5, zoom: 10.5, pitch: 0, bearing: 0 },
  size: { width: 512, height: 320 },
  legend: { visible: true, corner: "bottom-left", size: "s" },
  widgets: [],
  widgetSize: "s",
  title: null,
  credit: { corner: "bottom-right", size: "s" },
  appearance: "light",
  mapScale: 1,
};

test("a filter edit landing between the map read and the layer render read is what the page declares", async ({ page, context }) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");
  const table = `bind_${runId}`;
  await seedCsv(page, table, readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8"));
  const mapId = await createMap(page, "State binding");
  const layerId = await addLayer(page, mapId, "stations", `SELECT * FROM "${table}"`);
  const filter = { field: "riders", kind: "range", min: 0, max: 20000 };

  const render = await context.newPage();
  let edited = false;
  // The edit lands after the page's map read and before its layer render
  // read: the render request is held while the filter is written.
  await render.route(`**/api/layers/${layerId}/render`, async (route) => {
    if (!edited) {
      edited = true;
      const r = await context.request.patch(`/api/layers/${layerId}`, { data: { filters: [filter] } });
      expect(r.ok()).toBe(true);
    }
    await route.continue();
  });
  await render.addInitScript((d) => {
    (window as unknown as Record<string, unknown>)["__DEZFIL_EXPORT_DEFINITION__"] = d;
  }, definition);
  await render.goto(`/render/${mapId}`);
  await expect(render.locator("[data-export-ready]")).toBeVisible({ timeout: 60_000 });
  expect(edited).toBe(true);
  const declared = JSON.parse((await render.locator("[data-export-root]").getAttribute("data-export-state"))!) as { layers: { id: string; filters: unknown[] }[] };
  expect(declared.layers.find((l) => l.id === layerId)?.filters).toEqual([filter]);
  await render.close();
});
