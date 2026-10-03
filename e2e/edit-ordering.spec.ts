import { test, expect } from "@playwright/test";
import { routeHouse } from "./support";
import { readThenWriteRequestSetup } from "./edit-basis";

// Delay the SQL response at the actual browser boundary. The other layer's
// slider previews immediately, but its request must use the accepted result.
test("a slow SQL save holds another layer's style without losing its preview", async ({ page, context, request }) => {
  await routeHouse(context, { basemapStyleStub: true });
  const created = await request.post("/api/maps", { data: { name: "Ordered saves" } }); expect(created.status()).toBe(201);
  const map = await created.json(), path = `/api/maps/${map.id}`;
  const layers: { id: string; name: string }[] = [];
  for (const name of ["Slow", "Slider"]) {
    const added = await readThenWriteRequestSetup(request, path, () => ({ method: "POST", path: `${path}/layers`, options: { data: { name, sql: "SELECT ST_Point(13, 52) AS geometry" } } }));
    expect(added.status()).toBe(201); layers.push(await added.json());
  }
  let release!: () => void, responseReady!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { responseReady = resolve; });
  let sqlMs = 0, acceptedRevision = "", sqlReturned = 0, styleStarted = 0;
  const styles: { revision?: string; opacity: number }[] = [];
  await page.route(`**/api/layers/${layers[0].id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    const started = Date.now(), response = await route.fetch();
    expect(response.status()).toBe(200); sqlMs = Date.now() - started;
    acceptedRevision = (await response.json()).editRevision; responseReady();
    await hold; sqlReturned = Date.now(); await route.fulfill({ response });
  });
  await page.route(`**/api/layers/${layers[1].id}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    styleStarted = Date.now(); styles.push({ revision: route.request().headers()["x-edit-revision"], opacity: route.request().postDataJSON().style.opacity });
    await route.continue();
  });
  await page.goto(`/maps/${map.id}`);
  const slowRow = page.locator("li", { hasText: "Slow" });
  await slowRow.getByRole("button", { name: "Layer menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit source" }).click();
  await page.getByRole("textbox", { name: "Layer SQL query" }).fill("SELECT ST_Point(14, 53) AS geometry");
  await page.getByRole("button", { name: "Update layer", exact: true }).click(); await ready;
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(`[data-layer-select="${layers[1].id}"]`).click();
  const slider = page.getByRole("slider", { name: "Layer opacity" });
  const intentAt = Date.now();
  await slider.focus(); await slider.press("Home"); await slider.press("ArrowRight"); await slider.press("Tab");
  const preview = Number(await slider.inputValue());
  expect(preview).toBe(0.05);
  expect(styles).toEqual([]);
  await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
  release();
  await expect.poll(() => styles.length).toBeGreaterThan(0);
  expect(styles[0].revision).toBe(acceptedRevision);
  expect(styleStarted).toBeGreaterThanOrEqual(sqlReturned);
  await expect(page.locator("[data-stale-recovery]")).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(path)).json()).layers.find((l: { id: string }) => l.id === layers[1].id).style.opacity).toBe(styles.at(-1)!.opacity);
  await test.info().attach("ordered-save-delay", { body: JSON.stringify({ sqlRequestMs: sqlMs, styleQueueWaitMs: styleStarted - intentAt }), contentType: "application/json" });
});
