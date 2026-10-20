import { test, expect, type Page } from "@playwright/test";
import { addLayer, createMap, patchMap, routeHouse } from "./support";
import { expectPaintedCamera, paintedCamera, startCameraBasemap } from "./camera-bounds-support";
import { readThenWriteRequestSetup } from "./edit-basis";

/**
 * A map opens at its saved view, which is what its card picture shows. One
 * made through the API and never framed still has the starting view, no
 * view of its own: its first opening frames its data, and that framing is
 * saved as its view.
 */
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
let ground: Awaited<ReturnType<typeof startCameraBasemap>>;
test.beforeAll(async () => { ground = await startCameraBasemap(); });
test.afterAll(async () => { await ground.close(); });

/** Two points about 15 km apart near Lagos, far from the starting view. */
const MARKS = [[3.35, 6.45], [3.45, 6.55]] as const;

async function mapWithMarks(page: Page, name: string) {
  const id = await createMap(page, name);
  for (const [i, [lng, lat]] of MARKS.entries()) await addLayer(page, id, `Mark ${i}`, `SELECT ST_Point(${lng}, ${lat}) AS geom`);
  await patchMap(page, id, { customBasemap: { url: ground.url, name: "Opening ground", force: true } });
  return id;
}
const savedView = async (page: Page, id: string) => (await (await page.request.get(`/api/maps/${id}`)).json()).viewport;

test("a map with no view of its own opens framed to its data and keeps that view", async ({ page, context, baseURL }) => {
  if (!baseURL || new URL(baseURL).port === "3000") throw new Error("Use an isolated instance on a separate port.");
  await routeHouse(context);
  await page.goto("/maps");
  const id = await mapWithMarks(page, "Opening without a view");
  try {
    const start = await savedView(page, id);
    await page.goto(`/maps/${id}`);
    const host = page.locator("[data-map-camera]");
    await expect.poll(async () => (await paintedCamera(host)).zoom, { timeout: 20000 }).toBeGreaterThan(start.zoom + 5);
    // The camera the framing settles on, and the view saved from it.
    await expect.poll(async () => {
      const [live, saved] = [await paintedCamera(host), await savedView(page, id)];
      return Math.max(Math.abs(saved.lng - live.lng), Math.abs(saved.lat - live.lat), Math.abs(saved.zoom - live.zoom));
    }, { message: "the framing is saved as the map's view", timeout: 20000 }).toBeLessThan(1e-6);
    const framed = await paintedCamera(host);
    expect(Math.abs(framed.lng - 3.4)).toBeLessThan(0.05);
    expect(Math.abs(framed.lat - 6.5)).toBeLessThan(0.05);
    expect(framed.zoom).toBeGreaterThan(start.zoom + 5);
  } finally { await readThenWriteRequestSetup(page.request, `/api/maps/${id}`, () => ({ method: "DELETE" })); }
});

test("a map with a view of its own opens there, on every visit", async ({ page, context, baseURL }) => {
  if (!baseURL || new URL(baseURL).port === "3000") throw new Error("Use an isolated instance on a separate port.");
  await routeHouse(context);
  await page.goto("/maps");
  const id = await mapWithMarks(page, "Opening at its view");
  try {
    // A wide view over the Gulf of Guinea: the marks are in it, but the
    // map is not framed to them.
    const camera = { lng: 2, lat: 4, zoom: 5, pitch: 0, bearing: 0 };
    await patchMap(page, id, { viewport: camera });
    for (const visit of [1, 2]) {
      await page.goto(`/maps/${id}`);
      await expect(page.getByText("1 features", { exact: true }).first(), `visit ${visit}`).toBeVisible();
      await expectPaintedCamera(page.locator("[data-map-camera]"), camera);
    }
    expect(await savedView(page, id)).toEqual(camera);
  } finally { await readThenWriteRequestSetup(page.request, `/api/maps/${id}`, () => ({ method: "DELETE" })); }
});
