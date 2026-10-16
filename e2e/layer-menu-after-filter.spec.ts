// A layer row's menu opened after editing that layer's filter. The filter
// rows make the inspector tall, so the edit leaves the panel scrolled down
// and the row's own head, with its "Layer menu" button, above the visible
// part. Bringing the button into view and pressing it then lands in one
// frame, and the scroll that brought it there is delivered after the menu
// has opened. The menu closed on that scroll as if the page had moved
// under it, so the first press showed the menu for a frame and took it
// away again.
//
// No retries here: the first press must open a menu that stays.
import { test, expect } from "@playwright/test";
import { addLayer, createMap, routeHouse, saveSettled, seedCsv } from "./support";

const runId = Date.now().toString(36);
const table = `menu_filter_${runId}`;

const CSV = [
  "label,lon,lat,riders",
  ...Array.from({ length: 200 }, (_, i) => `Point ${i},${13.2 + (i % 20) * 0.004},${52.4 + Math.floor(i / 20) * 0.004},${i % 100}`),
].join("\n");

test("the layer menu opened after a filter edit stays open on the first press", async ({ page, context }) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/maps");
  await seedCsv(page, table, CSV);
  const mapId = await createMap(page, `Menu after filter ${runId}`);
  await addLayer(page, mapId, "Remaining", `SELECT * FROM "${table}" LIMIT 1`);
  const targetId = await addLayer(page, mapId, "Filtered", `SELECT * FROM "${table}"`);
  await page.goto(`/maps/${mapId}`);
  const row = page.locator("li[data-selected]").filter({ has: page.locator(`[data-layer-select="${targetId}"]`) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await saveSettled(page);

  await row.locator("[data-layer-select]").click();
  const addFilter = row.getByRole("button", { name: "+ Add filter", exact: true });
  await expect(addFilter).toBeVisible({ timeout: 20_000 });
  await addFilter.click();
  // The new filter's own save lands first: a bound typed before its answer
  // is put back to the column's range when that answer arrives.
  const added = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/layers/${targetId}`
    && r.request().postDataJSON()?.filters?.some((f: { field: string }) => f.field === "riders"));
  await row.getByRole("button", { name: /riders/ }).last().click();
  expect((await added).ok()).toBe(true);
  await saveSettled(page);
  const maximum = row.getByRole("spinbutton", { name: "riders maximum", exact: true });
  await expect(maximum).toHaveValue("99");
  const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/layers/${targetId}`
    && r.request().postDataJSON()?.filters?.some((f: { field: string; max: number }) => f.field === "riders" && f.max === 49));
  await maximum.fill("49");
  await maximum.blur();
  expect((await saved).ok()).toBe(true);
  await saveSettled(page);

  const menuButton = row.getByRole("button", { name: "Layer menu", exact: true });
  // The case's premise: the edit left the row's head scrolled out of view,
  // so pressing the button first scrolls it back in.
  const scrolledAway = await menuButton.evaluate((button) => {
    let panel = button.parentElement;
    while (panel && getComputedStyle(panel).overflowY !== "auto" && getComputedStyle(panel).overflowY !== "scroll") panel = panel.parentElement;
    return !!panel && button.getBoundingClientRect().bottom < panel.getBoundingClientRect().top;
  });
  expect(scrolledAway, "the filter edit no longer leaves the row's head out of view; the case measures nothing").toBe(true);

  await menuButton.click();
  // Long enough for every frame the press caused to have been delivered.
  await page.waitForTimeout(500);
  await expect(menuButton, "the menu closed by itself after opening").toHaveAttribute("aria-expanded", "true");
  await page.getByRole("menuitem", { name: "Delete layer", exact: true }).click();
  const deleted = page.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === `/api/layers/${targetId}`);
  await page.getByRole("menuitem", { name: "Confirm delete", exact: true }).click();
  expect((await deleted).ok()).toBe(true);
  await expect(page.locator(`[data-layer-select="${targetId}"]`)).toHaveCount(0);
});

test("an open layer menu still closes when its row scrolls away under it", async ({ page, context }) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/maps");
  await seedCsv(page, `${table}_s`, CSV);
  const mapId = await createMap(page, `Menu scroll ${runId}`);
  const targetId = await addLayer(page, mapId, "Scrolled", `SELECT * FROM "${table}_s"`);
  await page.goto(`/maps/${mapId}`);
  const row = page.locator("li[data-selected]").filter({ has: page.locator(`[data-layer-select="${targetId}"]`) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await saveSettled(page);
  // Select the layer so the panel under its row is tall enough to scroll.
  await row.locator("[data-layer-select]").click();
  await expect(row.getByRole("button", { name: "+ Add filter", exact: true })).toBeVisible({ timeout: 20_000 });

  const menuButton = row.getByRole("button", { name: "Layer menu", exact: true });
  await menuButton.click();
  await expect(page.getByRole("menuitem", { name: "Delete layer", exact: true })).toBeVisible();
  const moved = await menuButton.evaluate((button) => {
    let panel = button.parentElement;
    while (panel && getComputedStyle(panel).overflowY !== "auto" && getComputedStyle(panel).overflowY !== "scroll") panel = panel.parentElement;
    if (!panel || panel.scrollHeight <= panel.clientHeight) return false;
    panel.scrollTop += 120;
    return true;
  });
  expect(moved, "the panel cannot scroll; the case measures nothing").toBe(true);
  await expect(menuButton, "a menu left behind by its scrolled row stayed open").toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("menuitem", { name: "Delete layer", exact: true })).toHaveCount(0);
});
