import { readThenWriteRequestSetup } from "./edit-basis";
import { expect, test } from "@playwright/test";
import { alignmentPoint, alignmentPositionError, alignmentStats, startAlignmentBasemap } from "../scripts/map-alignment-fixture.mjs";
import { addLayer, createMap, patchLayer, patchMap, routeHouse, seedCsv } from "./support";
import { expectPaintedCamera, imageDefinition } from "./camera-bounds-support";

test.use({ viewport: { width: 1600, height: 1100 } });
let basemap: Awaited<ReturnType<typeof startAlignmentBasemap>>;
test.beforeAll(async () => { basemap = await startAlignmentBasemap(); });
test.afterAll(async () => { await basemap.close(); });

function expectAligned(png: Buffer) {
  const stats = alignmentStats(png);
  expect(stats.data.count, "data landmark pixels").toBeGreaterThan(15);
  expect(stats.ground.count, "basemap landmark pixels").toBeGreaterThan(40);
  expect(Math.abs(stats.ground.x! - stats.data.x!), "ground/data horizontal alignment").toBeLessThan(1.5);
  expect(Math.abs(stats.ground.y! - stats.data.y!), "ground/data vertical alignment").toBeLessThan(1.5);
  return stats;
}

for (const [pole, sign] of [["north", 1], ["south", -1]] as const) {
  test(`padded ${pole} camera keeps both thumbnail grounds and exported data aligned`, async ({ page, context, baseURL }, testInfo) => {
    if (!baseURL || new URL(baseURL).port === "3000") throw new Error("requires an isolated test instance");
    await routeHouse(context);
    await context.route("https://tiles.openfreemap.org/**", async route => {
      const theme = route.request().url().includes("/dark") ? "dark" : "light";
      const response = await route.fetch({ url: `${basemap.url}/${pole}-${theme}.json` });
      await route.fulfill({ response });
    });
    await page.goto("/maps");
    const [lng, lat] = alignmentPoint(sign);
    const { name } = await seedCsv(page, `alignment_${pole}_${Date.now()}`, `name,lon,lat\nlandmark,${lng},${lat}\n`);
    const id = await createMap(page, `Alignment ${pole}`);
    try {
      const layer = await addLayer(page, id, "landmark", `SELECT * FROM "${name}"`);
      await patchLayer(page, layer, { style: {
        fill: { type: "constant", color: { r: 26, g: 93, b: 74, a: 1 } },
        stroke: { r: 26, g: 93, b: 74, a: 1 },
        fillOpacity: 1, strokeWidth: 0, strokeOpacity: 0, pointRadius: 12, opacity: 1,
      } });
      await patchMap(page, id, { viewport: { lng, lat, zoom: 10, pitch: 0, bearing: 0 } });
      await page.goto(`/maps/${id}`);
      await expect(page.getByText("1 features", { exact: true }).first()).toBeVisible();
      await expect(page.locator("[data-status-zoom]")).toHaveText("15.00");
      // Move after the builder's deliberate fit-to-data, through its real
      // coordinate search and zoom controls. No private renderer access.
      const camera = { lng, lat: sign * 85.051129, zoom: 10, pitch: 0, bearing: 0 };
      await page.getByPlaceholder("Search map & places").fill(`${camera.lat}, ${lng}`);
      await page.getByRole("option").filter({ hasText: "as latitude, longitude" }).click();
      await expect(page.locator("[data-status-zoom]")).toHaveText("14.00");
      await page.keyboard.press("Escape");
      for (const zoom of [13, 12, 11, 10]) {
        await page.getByRole("button", { name: "Zoom out", exact: true }).click();
        await expect(page.locator("[data-status-zoom]")).toHaveText(`${zoom}.00`);
      }
      const painted = await expectPaintedCamera(page.locator("[data-map-camera]"), camera);
      expect(painted.padding.top).toBe(62);
      expect(painted.padding.bottom).toBe(14);
      expect(painted.padding.left).toBeGreaterThan(painted.padding.right);
      const width = await page.locator("[data-map-camera]").evaluate(el => el.clientWidth);
      const northing = (latitude: number) => 0.5 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / (2 * Math.PI);
      const world = 512 * 2 ** painted.zoom;
      const pointFraction = {
        x: ((lng - painted.lng) / 360 * world + (width + painted.padding.left - painted.padding.right) / 2) / width,
        y: ((northing(lat) - northing(painted.lat)) * world + (painted.height + painted.padding.top - painted.padding.bottom) / 2) / painted.height,
      };
      // Camera-only saves do not schedule a new card-image cycle. A real
      // map edit does, so trigger one after this camera has settled.
      await page.getByTitle(`Rename Alignment ${pole}`, { exact: true }).click();
      await page.getByRole("textbox", { name: "Map name", exact: true }).fill(`Alignment ${pole} captured`);
      const saved = page.waitForResponse(response => response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/maps/${id}`
        && response.request().postDataJSON()?.name === `Alignment ${pole} captured`);
      await page.getByRole("textbox", { name: "Map name", exact: true }).press("Enter");
      expect((await saved).ok()).toBe(true);
      const expectedGround = { light: [240, 230, 200], dark: [26, 42, 58] };
      for (const theme of ["light", "dark"] as const) {
        let bytes: Buffer = Buffer.alloc(0);
        // The independent geographic projection rejects a stale image
        // from the builder's earlier fit-to-data camera.
        await expect(async () => {
          const response = await page.request.get(`/api/maps/${id}/thumbnail?theme=${theme}`);
          expect(response.status()).toBe(200);
          bytes = await response.body();
          const stats = expectAligned(bytes);
          expect(Math.abs(stats.data.x! / stats.width - pointFraction.x)).toBeLessThan(0.004);
          expect(Math.abs(stats.data.y! / stats.height - pointFraction.y)).toBeLessThan(0.004);
          expect(stats.corner).toEqual(expectedGround[theme]);
        }).toPass({ timeout: 60_000 });
        await testInfo.attach(`${pole}-${theme}-thumbnail`, { body: bytes, contentType: "image/png" });
        await testInfo.attach(`${pole}-${theme}-alignment`, { body: JSON.stringify(alignmentStats(bytes)), contentType: "application/json" });
      }
      await expect(page.locator("[data-offscreen-ground]")).toHaveCount(0);
      // The server browser receives its own loopback style, independent of
      // Playwright routing. Both renderers must paint the same coordinate.
      await patchMap(page, id, { customBasemap: { url: `${basemap.url}/${pole}-light.json`, name: "Alignment", force: true } });
      const response = await page.request.post(`/api/maps/${id}/export/image`, {
        data: { definition: imageDefinition(camera) }, timeout: 120_000,
      });
      expect(response.status(), response.ok() ? "PNG export" : await response.text()).toBe(200);
      const bytes = await response.body();
      const stats = expectAligned(bytes);
      expect(stats.width).toBe(512);
      expect(stats.height).toBe(512);
      expect(alignmentPositionError(stats, sign), "absolute geographic position of exported landmarks").toBeLessThan(1.5);
      await testInfo.attach(`${pole}-server-export`, { body: bytes, contentType: "image/png" });
    } finally {
      expect((await readThenWriteRequestSetup(page.request, `/api/maps/${id}`, () => ({ method: "DELETE" }))).status()).toBe(204);
      expect((await page.request.delete(`/api/tables/${name}`)).status()).toBe(204);
    }
  });
}
