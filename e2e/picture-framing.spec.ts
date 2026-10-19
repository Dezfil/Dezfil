import { test, expect } from "@playwright/test";
import { addLayer, createMap, patchLayer, patchMap, routeHouse } from "./support";
import { expectPaintedCamera, startCameraBasemap } from "./camera-bounds-support";
import { readThenWriteRequestSetup } from "./edit-basis";
import { colourCentre, PICTURE_CAMERA, PICTURE_MARKS, pictureMarkSql } from "../test-support/picture-pixels";
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
let ground: Awaited<ReturnType<typeof startCameraBasemap>>;
test.beforeAll(async () => { ground = await startCameraBasemap(); });
test.afterAll(async () => { await ground.close(); });
for (const pitch of [0, 45]) test(`picture framing matches the real laptop builder at pitch ${pitch}`, async ({ page, context, baseURL }, info) => {
  if (!baseURL || new URL(baseURL).port === "3000") throw new Error("Use an isolated instance on a separate port.");
  await routeHouse(context);
  await page.goto("/maps");
  const id = await createMap(page, `Framing ${pitch}`);
  try {
    for (const mark of pictureMarkSql()) {
      const layer = await addLayer(page, id, mark.name, mark.sql);
      await patchLayer(page, layer, { style: mark.style });
    }
    const camera = { ...PICTURE_CAMERA, pitch };
    await patchMap(page, id, { viewport: camera, customBasemap: { url: ground.url, name: "Framing ground", force: true } });
    await page.goto(`/maps/${id}`);
    const host = page.locator("[data-map-camera]");
    const live = await expectPaintedCamera(host, camera);
    const size = await host.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
    const box = (await host.boundingBox())!;
    const visible = { width: size.width - live.padding.left - live.padding.right, height: size.height - live.padding.top - live.padding.bottom };
    expect(visible).toEqual({ width: 988, height: 824 });
    const screenshot = await page.screenshot();
    expect((await page.request.post(`/api/maps/${id}/picture/refresh`)).status()).toBe(202);
    let version = "";
    await expect(async () => {
      const response = await page.request.get("/api/maps");
      const row = (await response.json()).find((row: { id: string }) => row.id === id);
      expect(row.pictureState).toBe("current"); expect(row.hasThumbnail).toBe(true); version = row.pictureVersion;
    }).toPass({ timeout: 90000 });
    const response = await page.request.get(`/api/maps/${id}/thumbnail?theme=light&v=${version}`);
    expect(response.status()).toBe(200); const card = await response.body();
    const centre = { x: box.x + (size.width + live.padding.left - live.padding.right) / 2, y: box.y + (size.height + live.padding.top - live.padding.bottom) / 2 };
    const measurements = PICTURE_MARKS.map(mark => {
      const builder = colourCentre(screenshot, mark.colour), picture = colourCentre(card, mark.colour);
      const expected = { x: 346 + (builder.x - centre.x) * 692 / 990, y: 148 + (builder.y - centre.y) * 296 / 424 };
      return { colour: mark.colour, builder, picture, expected, error: Math.hypot(picture.x - expected.x, picture.y - expected.y) };
    });
    await info.attach(`builder-${pitch}`, { body: screenshot, contentType: "image/png" });
    await info.attach(`picture-${pitch}`, { body: card, contentType: "image/png" });
    await info.attach(`framing-${pitch}`, { body: JSON.stringify({ visible, camera, measurements }), contentType: "application/json" });
    for (const mark of measurements) expect(mark.error, `mark ${mark.colour.join(",")} after scale`).toBeLessThanOrEqual(4);
  } finally { await readThenWriteRequestSetup(page.request, `/api/maps/${id}`, () => ({ method: "DELETE" })); }
});
