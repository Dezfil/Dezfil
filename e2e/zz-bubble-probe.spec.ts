import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { addLayer, createMap, seedFile } from "./support";

test("probe undo bubble stranding", async ({ page }) => {
  test.setTimeout(120_000);
  const runId = Date.now().toString(36);
  const t = `zb_${runId}`;
  await page.goto("/maps");
  await seedFile(page, `${t}.geojson`, readFileSync(path.join(__dirname, "fixtures", "stations.geojson"), "utf8"), "application/geo+json");
  const mapId = await createMap(page, `zb ${runId}`);
  await addLayer(page, mapId, t, `SELECT * FROM ${t}`);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector("[data-map-layer]");
  // Make an undoable change: rename via opacity? use layer visibility eye.
  await page.locator("[data-layer-select]").first().click();
  const undo = page.getByRole("button", { name: "Undo" });
  // hover then click undo (as the journey effectively does), then idle.
  await undo.hover();
  await page.waitForTimeout(400);
  const during = await page.locator("[data-hint-bubble]").count();
  await undo.click();
  await page.waitForTimeout(800);
  const after = await page.locator("[data-hint-bubble]").count();
  const text = after ? await page.locator("[data-hint-bubble]").textContent() : null;
  console.log(JSON.stringify({ during, after, text }));
  expect(after).toBe(0);
});
