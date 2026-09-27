import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import { createMap, patchMap, publishMap, routeHouse } from "./support";
import {
  coveredCamera, expectPaintedCamera, imageDefinition, openPreview,
  openRender, ordinary, startCameraBasemap, type Camera,
} from "./camera-bounds-support";

test.use({ viewport: { width: 1600, height: 1100 } });
let basemap: Awaited<ReturnType<typeof startCameraBasemap>>;
test.beforeAll(async () => { basemap = await startCameraBasemap(); });
test.afterAll(async () => { await basemap?.close(); });
test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || new URL(baseURL).port === "3000") throw new Error("requires an isolated DEZFIL_BASE_URL away from port 3000");
  await routeHouse(context);
});

const cameras: [string, Camera][] = [
  ["fractional", ordinary],
  ["pitch ceiling", { ...ordinary, pitch: 60 }],
  ["zoom ceiling", { ...ordinary, zoom: 24 }],
  ["north 85", { ...ordinary, lat: 85, pitch: 0, zoom: 10 }],
  ["south 85", { ...ordinary, lat: -85, pitch: 0, zoom: 10 }],
  ["north endpoint", { ...ordinary, lat: 85.051129, pitch: 0, zoom: 10 }],
  ["south endpoint", { ...ordinary, lat: -85.051129, pitch: 0, zoom: 10 }],
  ["fractional north pole", { ...ordinary, lat: 85.051129 }],
  ["fractional south pole", { ...ordinary, lat: -85.051129 }],
  ["low zoom", { ...ordinary, lat: 0, pitch: 0, zoom: 0 }],
];

for (const [name, camera] of cameras) {
  test(`four hosts paint the ${name} camera with only coverage adjustment`, async ({ page, context }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/maps");
    // No layers: an intentional fit-to-data opening would replace the
    // saved fixture and test a different contract.
    const id = await createMap(page, `camera bounds ${name}`);
    await patchMap(page, id, { viewport: camera,
      customBasemap: { url: basemap.url, name: "loopback basemap", force: true } });
    const token = await publishMap(page, id);
    await page.goto(`/maps/${id}`);
    await test.step("builder", async () => {
      const host = page.locator("[data-map-camera]");
      await expectPaintedCamera(host, camera);
      const actual = JSON.parse((await host.getAttribute("data-map-camera"))!);
      expect(actual.padding.top).toBe(62);
      expect(actual.padding.bottom).toBe(14);
      expect(actual.padding.left).toBeGreaterThan(actual.padding.right);
    });
    await test.step("preview", async () => { await openPreview(page); });
    await test.step("published reader", async () => {
      await page.goto(`/v/${token}`);
      await expectPaintedCamera(page.locator("[data-map-camera]"), camera);
    });
    await test.step("server render page", async () => {
      const render = await context.newPage();
      try {
        const host = await openRender(render, id, imageDefinition(camera));
        await expectPaintedCamera(host, camera);
        if (name.endsWith("endpoint")) {
          const actual = JSON.parse((await host.getAttribute("data-map-camera"))!);
          expect(actual.height).toBe(512);
          expect(actual.padding.top).toBe(0);
          expect(actual.padding.bottom).toBe(0);
          expect(actual.lat).toBeCloseTo(Math.sign(camera.lat) * 85.035941506574, 9);
        }
      } finally { await render.close(); }
    });
    expect(errors).toEqual([]);
  });
}

test("preview paints pitch 60 and zoom 24 in a matching opening space", async ({ page }) => {
  await page.goto("/maps");
  const id = await createMap(page, "exact preview ceiling");
  const camera = { ...ordinary, pitch: 60, zoom: 24 };
  await patchMap(page, id, { viewport: camera,
    customBasemap: { url: basemap.url, name: "loopback basemap", force: true } });
  // The ordinary S composition is 1440px wide at the opening 4:3 shape.
  // Fix the builder fixture to that width before mount: compensation is
  // exactly zero, so this tests the preview AT 24, not just near 24.
  await page.route(url => url.pathname === `/maps/${id}`, async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace("</head>",
      "<style>[data-drag-canvas]:not([data-export-composition]){width:1440px!important}</style></head>");
    await route.fulfill({ response, body: html });
  });
  await page.goto(`/maps/${id}`);
  await expectPaintedCamera(page.locator("[data-map-camera]"), camera);
  expect(await page.locator("[data-drag-canvas]").evaluate(el => el.clientWidth)).toBe(1440);
  const { host, requested } = await openPreview(page);
  expect(await host.evaluate(el => el.clientWidth)).toBe(1440);
  expect(requested.zoom).toBe(24);
  await expectPaintedCamera(host, camera);
});

test("unpadded 1024px render host raises zoom 0 to 1; the image API refuses that definition", async ({ page }) => {
  await page.goto("/maps");
  const id = await createMap(page, "tall coverage");
  await patchMap(page, id, { customBasemap: { url: basemap.url, name: "loopback basemap", force: true } });
  const camera = { ...ordinary, lat: 0, zoom: 0, pitch: 0 };
  const refused = await page.request.post(`/api/maps/${id}/export/image`, { data: { definition: imageDefinition(camera, 1024) } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error.message).toContain("viewport.zoom 0 is below 1.00");
  // Both render ingress roads refuse insufficient definition framing.
  // Exercise the shared host directly: a legal 512px definition in a
  // 1024px host, with test CSS in the document BEFORE React mounts it.
  await page.route(`**/render/${id}`, async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace("</head>",
      "<style>[data-export-composition]{height:1024px!important}</style></head>");
    await route.fulfill({ response, body: html });
  });
  const host = await openRender(page, id, imageDefinition(camera));
  await expectPaintedCamera(host, camera);
  const actual = JSON.parse((await host.getAttribute("data-map-camera"))!);
  expect(actual.height).toBe(1024);
  expect(actual.padding.top).toBe(0);
  expect(actual.padding.bottom).toBe(0);
  expect(actual.zoom).toBe(1);
});

for (const [name, camera] of [
  ["north", { ...ordinary, lat: 85.051129 }],
  ["south", { ...ordinary, lat: -85.051129 }],
  ["zoom floor", { ...ordinary, lat: 0, zoom: 0, pitch: 0 }],
] as const) {
  test(`mounted builder preserves coverage on grow and shrink at ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/maps");
    const id = await createMap(page, `resize ${name}`);
    try {
      await patchMap(page, id, { viewport: camera,
        customBasemap: { url: basemap.url, name: "loopback basemap", force: true } });
      await page.goto(`/maps/${id}`);
      const host = page.locator("[data-map-camera]");
      let previous = await expectPaintedCamera(host, camera);
      const canvas = host.locator("canvas.maplibregl-canvas");
      await canvas.evaluate(el => { el.dataset.resizeProbe = "same-map"; });
      for (const height of [1400, 720]) {
        const oldHeight = previous.height;
        await page.setViewportSize({ width: 1280, height });
        await expect.poll(() => host.evaluate(el => el.clientHeight)).not.toBe(oldHeight);
        const resized = await expectPaintedCamera(host, previous);
        expect(resized.padding.top).toBe(62);
        expect(resized.padding.bottom).toBe(14);
        expect(resized.padding.left).toBeGreaterThan(resized.padding.right);
        await expect(canvas).toHaveAttribute("data-resize-probe", "same-map");
        previous = resized;
      }
    } finally {
      expect((await page.request.delete(`/api/maps/${id}`)).status()).toBe(204);
    }
  });
}

const legacy: [string, Partial<Camera>, Partial<Camera>][] = [
  ["pitch", { pitch: 85 }, { pitch: 60 }],
  ["north", { lat: 91 }, { lat: 85.051129 }],
  ["south", { lat: -91 }, { lat: -85.051129 }],
  ["high zoom", { zoom: 26 }, { zoom: 24 }],
  ["low zoom", { zoom: -3 }, { zoom: -2 }],
  ["combined north", { pitch: 85, lat: 91, zoom: 26 }, { pitch: 60, lat: 85.051129, zoom: 24 }],
  ["combined south", { pitch: 85, lat: -91, zoom: -3 }, { pitch: 60, lat: -85.051129, zoom: -2 }],
];

for (const [name, old, recovered] of legacy) {
  test(`legacy ${name} opens without rewriting raw camera or timestamps`, async ({ page, context }) => {
    const dir = process.env.DEZFIL_DATA_DIR;
    test.skip(!dir, "DEZFIL_DATA_DIR must point at the isolated server's data for raw legacy seeding");
    const patches: string[] = [];
    await page.goto("/maps");
    const id = await createMap(page, `legacy basemap ${name}`);
    const db = new Database(path.join(path.resolve(dir!), "metadata.sqlite"), { fileMustExist: true });
    try {
      await patchMap(page, id, { customBasemap: { url: basemap.url, name: "loopback basemap", force: true } });
      const raw = { ...ordinary, ...old };
      const effective = { ...ordinary, ...recovered };
      db.prepare("UPDATE maps SET view_lng=?, view_lat=?, view_zoom=?, view_pitch=?, view_bearing=?, updated_at='2000-01-01T00:00:00.000Z' WHERE id=?")
        .run(raw.lng, raw.lat, raw.zoom, raw.pitch, raw.bearing, id);
      const token = await publishMap(page, id);
      const stored = () => db.prepare("SELECT * FROM maps WHERE id=?").get(id);
      const before = stored();
      page.on("request", request => {
        if (request.method() === "PATCH" && new URL(request.url()).pathname === `/api/maps/${id}`) patches.push(request.postData() ?? "");
      });
      await page.goto(`/maps/${id}`);
      await expectPaintedCamera(page.locator("[data-map-camera]"), effective);
      expect(stored()).toEqual(before);
      expect(patches).toEqual([]);
      // Reader opening uses a distinct request path, before any preview
      // click; opening alone must leave both raw storage and dates intact.
      const reader = await context.newPage();
      try {
        await reader.goto(`/v/${token}`);
        await expectPaintedCamera(reader.locator("[data-map-camera]"), effective);
        expect(stored()).toEqual(before);
      } finally { await reader.close(); }
      const api = await page.request.get(`/api/maps/${id}`);
      expect((await api.json()).viewport).toEqual(effective);
      await openPreview(page);
      // Low legacy zoom requires legal image framing; recovery does not
      // waive the image road's independent zero/coverage floor.
      const framed = coveredCamera({ ...effective, zoom: Math.max(0, effective.zoom) }, 512);
      const exported = await page.request.post(`/api/maps/${id}/export/image`, {
        data: { definition: imageDefinition(framed) }, timeout: 120_000,
      });
      expect(exported.status(), exported.ok() ? "PNG export" : await exported.text()).toBe(200);
      const png = await exported.body();
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
      expect(stored()).toEqual(before);
    } finally { db.close(); }
  });
}
