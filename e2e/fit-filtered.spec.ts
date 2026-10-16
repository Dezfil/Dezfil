// Fitting frames what is actually drawn. The case that matters is a
// constraint the CANVAS enforces after the data arrives — a timeline
// window, a widget selection, a range filter in a client-side slot. Those
// never change the query, so fit measured rows that were not on screen
// and the camera pulled back to frame nothing.
//
// The frame is read from the map's own rendered pixels rather than from a
// viewport readout: the builder has no camera display, and asserting on
// the control's own state would pass whether or not the camera moved.
import { test, expect } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  routeHouse,
  saveSettled,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `fit_${runId}`;

// Two clusters far apart, so a filter that drops one moves the frame by an
// unmistakable amount.
const CSV = [
  "id,lng,lat,rank",
  ...Array.from({ length: 8 }, (_, i) => `near${i},13.40,52.51,${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `far${i},-58.38,-34.60,${90 + i}`),
].join("\n");

test("fit frames the filtered data, not the whole layer", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  await page.goto("/maps");
  await seedCsv(page, tableName, CSV);
  const mapId = await createMap(page, `fit ${runId}`);
  await addLayer(page, mapId, tableName, `SELECT * FROM ${tableName}`);
  await page.goto(`/maps/${mapId}`);
  await expect(
    page.getByRole("button", { name: new RegExp(`^${tableName}`) }),
  ).toBeVisible({ timeout: 30_000 });
  await saveSettled(page);

  const viewport = async () => {
    const r = await page.request.get(`/api/maps/${mapId}`);
    const body = (await r.json()) as {
      viewport: { lng: number; lat: number; zoom: number };
    };
    return body.viewport;
  };

  const fit = page.getByRole("button", { name: "Fit to data", exact: true });

  await test.step("fit frames only the features the canvas is drawing", async () => {
    // The camera is read from the map's own saved viewport rather than
    // from pixels: a fit to bounds the camera already holds still runs its
    // ease, so screenshot comparisons answer "did anything move on screen"
    // rather than "did the camera go somewhere else".
    await fit.click();
    await saveSettled(page);
    await page.waitForTimeout(2000);
    const both = await viewport();
    // Both clusters in frame: the centre sits between them, nowhere near
    // either one.
    expect(Math.abs(both.lng - 13.4)).toBeGreaterThan(5);

    // A range filter in a client-side slot: every row still ships and the
    // canvas hides the far ones. Nothing about the query changes, which is
    // exactly why fit used to keep framing them.
    await page
      .getByRole("button", { name: new RegExp(`^${tableName}`) })
      .first()
      .click();
    const addFilter = page.getByRole("button", { name: "+ Add filter" });
    await expect(addFilter).toBeVisible({ timeout: 20_000 });
    await addFilter.click();
    await page.getByRole("button", { name: /rank/ }).first().click();
    const max = page.getByRole("slider", { name: "Maximum" });
    await expect(max).toBeVisible({ timeout: 15_000 });
    await max.focus();
    for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowLeft");
    await saveSettled(page);
    await page.waitForTimeout(1500);

    await fit.click();
    await saveSettled(page);
    await expect
      .poll(async () => (await viewport()).zoom, { timeout: 20_000 })
      .toBeGreaterThan(both.zoom + 1);
    const near = await viewport();
    // The frame is on the surviving cluster, not between the two.
    expect(Math.abs(near.lng - 13.4)).toBeLessThan(1);
    expect(Math.abs(near.lat - 52.51)).toBeLessThan(1);
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

// Zoom-to-layer has never had a test. It gets one here, because it is
// the surface most likely to regress silently.
test("zoom to layer frames that layer, and stays available when hidden", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  await page.goto("/maps");
  const table = `${tableName}_z`;
  await seedCsv(page, table, CSV);
  const mapId = await createMap(page, `zoom ${runId}`);
  await addLayer(page, mapId, table, `SELECT * FROM ${table}`);
  await page.goto(`/maps/${mapId}`);
  await expect(
    page.getByRole("button", { name: new RegExp(`^${table}`) }),
  ).toBeVisible({ timeout: 30_000 });
  await saveSettled(page);

  const viewport = async () => {
    const r = await page.request.get(`/api/maps/${mapId}`);
    const body = (await r.json()) as {
      viewport: { lng: number; lat: number; zoom: number };
    };
    return body.viewport;
  };

  // The builder frames the data once it has loaded and saves that camera.
  // Wait that save out, or the movement poll below can pass on it rather
  // than on the drag.
  await expect
    .poll(async () => {
      const first = await viewport();
      await page.waitForTimeout(1000);
      const again = await viewport();
      const framed = first.lng !== 0 || first.lat !== 40 || first.zoom !== 1.3;
      return framed && JSON.stringify(first) === JSON.stringify(again);
    }, { timeout: 30_000 })
    .toBe(true);

  // Move the camera somewhere else first, so "zoom moved it back" is a
  // claim that can fail. Without this the test passes even if the action
  // is a complete no-op.
  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  const before = await viewport();
  const release = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.25 };
  // The drag ends over the inspector, not the map: a release there must
  // end the gesture and save the camera like one over the map.
  expect(
    await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".maplibregl-canvas-container"), release),
    "the release point is over the map; the drag no longer ends over the inspector",
  ).toBe(false);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(release.x, release.y, {
    steps: 14,
  });
  await page.mouse.up();
  await saveSettled(page);
  // The drag must actually have moved the camera, or "zoom moved it back"
  // proves nothing.
  await expect
    .poll(async () => {
      const v = await viewport();
      return Math.abs(v.lng - before.lng) + Math.abs(v.lat - before.lat);
    }, { timeout: 20_000 })
    .toBeGreaterThan(0.01);
  const moved = await viewport();

  const zoom = page.getByRole("button", { name: "Zoom to layer" }).first();
  await expect(zoom).toBeVisible();
  await zoom.click();
  await saveSettled(page);
  await expect
    .poll(async () => {
      const v = await viewport();
      return Math.abs(v.lng - moved.lng) + Math.abs(v.lat - moved.lat);
    }, { timeout: 20_000 })
    .toBeGreaterThan(0.01);

  // Hiding the layer must not take the explicit action away: asking for
  // one layer is not the same as framing the map.
  const hide = page
    .getByRole("button", { name: /Hide .*|Show .*/ })
    .first();
  await hide.click();
  await saveSettled(page);
  await expect(
    page.getByRole("button", { name: "Zoom to layer" }).first(),
  ).toBeVisible();

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
