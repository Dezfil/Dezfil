import { expect, test } from "@playwright/test";
import { createMap, routeHouse, seedFile, trackConsole } from "./support";
import { isAllowedConsoleError } from "./console-allowlist";

const runId = Date.now().toString(36);

test("an empty spatial upload is unknown geometry across Data, SQL, Add layer, and the canvas", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/data");
  const seeded = await seedFile(
    page,
    `empty_surface_${runId}.geojson`,
    JSON.stringify({ type: "FeatureCollection", features: [] }),
    "application/geo+json",
  );

  await page.reload();
  // The view preference is workspace-global: ask for the grid.
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  const card = page.locator(`[data-table-card='${seeded.name}']`);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Geometry");
  await card.click();
  await page.waitForURL(`/tables/${seeded.name}`);
  await expect(page.getByText("Geometry", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to a map" })).toBeEnabled();

  const detail = await page.evaluate(async (name) => {
    const r = await fetch(`/api/tables/${encodeURIComponent(name)}`);
    return (await r.json()) as {
      geometryColumn: string | null;
      geometryType: string | null;
      columns: { name: string; type: string }[];
    };
  }, seeded.name);
  expect(detail.geometryColumn).toBe("geom");
  expect(detail.geometryType).toBeNull();
  expect(detail.columns.find((column) => column.name === "geom")?.type).toContain(
    "GEOMETRY",
  );

  await page.goto(`/sql?table=${encodeURIComponent(seeded.name)}`);
  const consoleRow = page.locator(`[data-name='${seeded.name}']`);
  await expect(consoleRow).toBeVisible();
  await expect(consoleRow).not.toHaveAttribute("data-nonspatial", "true");

  const mapId = await createMap(page, `Empty surface ${runId}`);
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add layer" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Tables" }).click();
  const catalogRow = dialog.getByRole("button", { name: seeded.name });
  await expect(catalogRow).not.toHaveAttribute("data-nonspatial", "true");
  await catalogRow.click();
  await expect(dialog.getByText("No geometry column.")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Add layer", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Add layer", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('li[data-selected="true"]')).toContainText(seeded.name);

  const recipeId = await page.evaluate(async (name) => {
    const r = await fetch("/api/recipes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return ((await r.json()) as { recipe: { id: string } }).recipe.id;
  }, `Empty canvas ${runId}`);
  await page.goto(`/workflows/${recipeId}`);
  const pane = page.locator("[data-canvas-pane]");
  await pane.getByRole("searchbox", { name: "Search sources" }).fill(seeded.name);
  const sourceRow = pane.locator(`[data-table='${seeded.name}']`);
  await expect(sourceRow).toBeVisible();
  await expect(sourceRow.locator("[data-kind]")).toHaveAttribute(
    "data-kind",
    "spatial",
  );

  expect(
    consoleErrors.filter((entry) => !isAllowedConsoleError(entry.text, entry.url)),
  ).toEqual([]);
});
