import { expect, test, type Locator } from "@playwright/test";
import { createMap, patchMap, routeHouse, seedFile } from "./support";

// The origin crosses both source-tile axes. A distant hole must survive a
// MiniMap pick: rendered tile fragments cannot stand in for this geometry.
const polygon = (side: number) => ({
  type: "Polygon",
  coordinates: [
    [[side < 0 ? -0.002 : 0, -0.002], [side < 0 ? 0 : 0.002, -0.002],
      [side < 0 ? 0 : 0.002, 0.002], [side < 0 ? -0.002 : 0, 0.002], [side < 0 ? -0.002 : 0, -0.002]],
    [[side * 0.001, 0.001], [side * 0.001, 0.0012],
      [side * 0.0012, 0.0012], [side * 0.0012, 0.001], [side * 0.001, 0.001]],
  ],
});
const features = [-1, 1].map(side => ({ type: "Feature",
  properties: { name: `${side < 0 ? "Left" : "Right"} polygon fixture` }, geometry: polygon(side),
}));
const fixture = JSON.stringify({ type: "FeatureCollection", features });

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || new URL(baseURL).port === "3000") throw new Error("requires an isolated test instance");
  await routeHouse(context, { basemapStyleStub: true });
});

test("MiniMap picks the original polygon across overscaled tile edges and an in-place theme change", async ({ page, context }, testInfo) => {
  await page.goto("/maps");
  const { name } = await seedFile(page, `pick_${Date.now()}.geojson`, fixture, "application/geo+json");
  const mapId = await createMap(page, "Compact polygon selection");
  const requests: unknown[] = [];
  await context.route("**/api/imports/osm/preview", async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { geojson: { type: "FeatureCollection", features: [] }, featureCount: 0, truncated: false, cap: 2000 } });
  });
  try {
    const loaded = await page.request.get(`/api/tables/${name}/features`);
    expect(loaded.status()).toBe(200);
    expect((await loaded.json()).geojson.features.map((feature: { geometry: unknown }) => feature.geometry))
      .toEqual(features.map(feature => feature.geometry));
    // The empty builder preserves its saved camera; the catalog inherits
    // zoom 20, above the GeoJSON source's maximum tile zoom of 18.
    await patchMap(page, mapId, { viewport: { lng: 0, lat: 0, zoom: 20, pitch: 0, bearing: 0 } });
    await page.goto(`/maps/${mapId}`);
    await expect.poll(async () => JSON.parse((await page.locator("[data-map-camera]").getAttribute("data-map-camera")) ?? "{}").zoom).toBe(20);
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add layer" });
    await dialog.getByText("OpenStreetMap", { exact: true }).click();
    await dialog.getByRole("radiogroup", { name: "Query area kind" }).getByRole("radio", { name: "Polygon", exact: true }).click();
    await dialog.getByRole("radiogroup", { name: "Polygon mode" }).getByRole("radio", { name: "Select from Layer", exact: true }).click();
    await expect(dialog.getByRole("button", { name: `Hide ${name}`, exact: true })).toBeVisible();
    const canvas = dialog.locator("canvas.maplibregl-canvas");
    await canvas.evaluate(el => { el.dataset.pickLifetime = "same-map"; });
    for (const theme of ["initial", "changed"] as const) {
      if (theme === "changed") {
        const style = page.waitForResponse(response => response.url().includes("tiles.openfreemap.org/styles/"));
        // The catalog is modal. Invoke the existing theme action to test
        // restyling this mounted map; ordinary theme clicks have their own flow.
        await page.getByRole("button", { name: "Switch between dark and light theme" }).evaluate((el: HTMLButtonElement) => el.click());
        await style;
        await expect(canvas).toHaveAttribute("data-pick-lifetime", "same-map");
      }
      const sides = theme === "initial" ? [-1, 1] : [1, -1];
      for (const side of sides) {
        const box = await canvas.boundingBox();
        if (!box) throw new Error("No compact map bounds");
        await expect(async () => {
          await canvas.click({ position: { x: box.width / 2 + side * 24, y: box.height / 2 + side * 24 } });
          await expect(dialog.getByText(`Selected a polygon from ${name}. Click another to change`)).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 5000 });
        const count = requests.length;
        await dialog.getByRole("button", { name: "Run Query", exact: true }).click();
        await expect.poll(() => requests.length).toBe(count + 1);
        expect(requests.at(-1)).toMatchObject({ geometry: polygon(side) });
      }
      // Pan across a boundary, query again, then return to the known origin.
      await canvas.focus();
      await canvas.press("ArrowRight");
      await page.waitForTimeout(400);
      const panSide = -sides[1];
      const box = (await canvas.boundingBox())!;
      await canvas.click({ position: { x: box.width / 2 - 100 + panSide * 24, y: box.height / 2 + panSide * 24 } });
      const count = requests.length;
      await dialog.getByRole("button", { name: "Run Query", exact: true }).click();
      await expect.poll(() => requests.length).toBe(count + 1);
      expect(requests.at(-1)).toMatchObject({ geometry: polygon(panSide) });
      await canvas.press("ArrowLeft");
      await page.waitForTimeout(400);
    }
    await testInfo.attach("selected-original-geometries", { body: JSON.stringify(requests), contentType: "application/json" });
  } finally {
    expect((await page.request.delete(`/api/maps/${mapId}`)).status()).toBe(204);
    expect((await page.request.delete(`/api/tables/${name}`)).status()).toBe(204);
  }
});

async function camera(host: Locator): Promise<{ lng: number; lat: number; zoom: number; width: number; height: number }> {
  return JSON.parse((await host.getAttribute("data-preview-camera")) ?? "{}");
}

test("SQL preview hover crosses overscaled tile edges after each theme remount", async ({ page }, testInfo) => {
  await page.goto("/data");
  const { name } = await seedFile(page, `hover_${Date.now()}.geojson`, fixture, "application/geo+json");
  const observed = [];
  try {
    await page.goto("/sql");
    await page.locator(".cm-content").fill(`SELECT * FROM "${name}"`);
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByRole("cell", { name: "Left polygon fixture" })).toBeVisible();
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    const host = page.locator("[data-preview-map]");
    const canvas = host.locator("canvas.maplibregl-canvas");
    const tooltip = page.getByRole("region", { name: "Results" }).getByRole("status");
    for (let theme = 0; theme < 3; theme++) {
      if (theme) {
        const epoch = Number(await host.getAttribute("data-features-landed"));
        await page.getByRole("button", { name: "Switch between dark and light theme" }).click();
        await expect.poll(async () => Number(await host.getAttribute("data-features-landed"))).toBeGreaterThan(epoch);
      }
      await expect.poll(async () => (await camera(host)).zoom).toBeCloseTo(13, 4);
      await canvas.focus();
      for (let zoom = 14; zoom <= 20; zoom++) {
        await canvas.press("Equal");
        await expect.poll(async () => (await camera(host)).zoom).toBeCloseTo(zoom, 4);
      }
      for (const pan of [false, true]) {
        if (pan) {
          await canvas.press("ArrowRight");
          await page.waitForTimeout(400);
        }
        const live = await camera(host);
        expect(live.zoom).toBeCloseTo(20, 4);
        observed.push(live);
        const box = (await canvas.boundingBox())!;
        const northing = (lat: number) => 0.5 - Math.asinh(Math.tan(lat * Math.PI / 180)) / (2 * Math.PI);
        for (const side of [-1, 1]) {
          await page.mouse.move(1, 1);
          await expect(tooltip).toHaveCount(0);
          const lng = side * 0.000015, lat = side * 0.000015;
          const world = 512 * 2 ** live.zoom;
          const x = live.width / 2 + (lng - live.lng) / 360 * world;
          const y = live.height / 2 + (northing(lat) - northing(live.lat)) * world;
          expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(live.width);
          expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(live.height);
          await page.mouse.move(box.x + x, box.y + y);
          await expect(tooltip).toContainText(`${side < 0 ? "Left" : "Right"} polygon fixture`);
        }
      }
      await expect(canvas).toHaveCount(1);
    }
    await testInfo.attach("overscaled-hover-cameras", { body: JSON.stringify(observed), contentType: "application/json" });
  } finally {
    expect((await page.request.delete(`/api/tables/${name}`)).status()).toBe(204);
  }
});
