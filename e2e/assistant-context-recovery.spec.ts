// Scripted provider only; the pane and assistant/resource routes are real. The response fault
// discards a fully drained response; actual TCP departure is separately
// established by departure-http.test.ts.
import { test, expect, type Page } from "@playwright/test";
import { addLayer, createMap, routeHouse, seedCsv } from "./support";
import { assistantProviderFixture } from "./assistant-provider-fixture";

const provider = assistantProviderFixture();
test.beforeAll(async () => { await provider.start(); });
test.afterAll(async () => { await provider.stop(); });
test.beforeEach(async ({ context }) => { provider.reset(); await routeHouse(context, { basemapStyleStub: true }); });
const pane = (page: Page) => page.locator("[data-assistant-pane]");
async function setup(page: Page) {
  await page.goto("/");
  const table = await seedCsv(page, `assistant_${Date.now()}`, "lon,lat,population\n13.4,52.5,100\n13.5,52.6,200\n");
  const mapId = await createMap(page, "Context map");
  const layerId = await addLayer(page, mapId, "Selected population", `SELECT * FROM "${table.name}"`);
  const otherId = await createMap(page, "Other map");
  await addLayer(page, otherId, "Other selection", `SELECT * FROM "${table.name}"`);
  await page.goto(`/maps/${mapId}?layer=${layerId}`);
  await page.locator("header").getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(pane(page).getByRole("textbox", { name: "Ask the assistant" })).toBeEnabled();
  return { mapId, layerId, table: table.name, otherId };
}
async function send(page: Page, text: string) {
  await pane(page).getByRole("textbox", { name: "Ask the assistant" }).fill(text);
  await pane(page).getByRole("button", { name: "Send", exact: true }).click();
}
async function reopen(page: Page) {
  await page.locator("header").getByRole("button", { name: "Close assistant", exact: true }).click();
  await expect(pane(page)).toHaveAttribute("data-open", "false");
  await page.locator("header").getByRole("button", { name: "Open assistant", exact: true }).click();
}
for (const width of [1440, 1000]) test.describe(`assistant at ${width}px`, () => {
  test.use({ viewport: { width, height: 1000 } });
  test("pane selection reaches real grounding and model input", async ({ page }) => {
    const fixture = await setup(page);
    provider.replies.push({ text: "The selected population layer is ready." });
    const submitted = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
    await send(page, "Explain this layer");
    const request = await submitted;
    expect(request.postDataJSON()).toMatchObject({ runId: expect.any(String), context: { page: "builder", mapId: fixture.mapId, selectedLayerId: fixture.layerId } });
    await expect.poll(() => provider.captures.length).toBe(1);
    const grounding = JSON.parse(String(provider.captures[0].input[0].content).split("Instance grounding (data):\n")[1]);
    expect(grounding.context).toEqual({ page: "builder", mapId: fixture.mapId, selectedLayerId: fixture.layerId });
    expect(grounding.map.layers.items[0]).toMatchObject({ id: fixture.layerId, mapId: fixture.mapId, sql: `SELECT * FROM "${fixture.table}"` });
    expect(grounding.map.layers.items.some((l: { mapId: string }) => l.mapId === fixture.otherId)).toBe(false);
    expect(grounding.catalogue.items.find((t: { name: string }) => t.name === fixture.table).columns).toEqual(expect.arrayContaining([expect.objectContaining({ name: "population" })]));
    await expect(pane(page).getByText("The selected population layer is ready.", { exact: true })).toHaveCount(1);
    await reopen(page);
    await expect(pane(page).getByText("The selected population layer is ready.", { exact: true })).toHaveCount(1);
  });
  test("8b/8d: unlisted duplicate-layer effect refreshes after a dropped response without replay", async ({ page }) => {
    const { mapId, layerId } = await setup(page);
    provider.replies.push({ calls: [{ name: "duplicate_layer", args: { id: layerId } }] }, { text: "The layer was copied." });
    let messages = 0; let runId = ""; const reads: string[] = [];
    page.on("request", (r) => { if (r.method() === "GET" && r.url().includes("/api/assistant/runs/")) reads.push(r.url()); });
    await page.route("**/api/assistant/messages", async (route) => {
      messages++; runId = route.request().postDataJSON().runId;
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      await response.body(); await route.abort("connectionreset");
    });
    await send(page, "Copy this layer");
    await expect(pane(page).getByText("The layer was copied.", { exact: true })).toBeVisible();
    const state = await (await page.request.get(`/api/maps/${mapId}`)).json();
    expect(state.layers).toHaveLength(2);
    const added = state.layers.find((l: { id: string }) => l.id !== layerId);
    await expect(page.locator(`[data-layer-select="${added.id}"]`)).toBeVisible();
    expect(messages).toBe(1); expect(provider.captures).toHaveLength(2);
    expect(reads.some((url) => url.endsWith(`/api/assistant/runs/${runId}`))).toBe(true);
  });
  test("8e/3f: dismissal keeps downloads and pending action; remount recovers the pending identity", async ({ page }) => {
    const { mapId, layerId } = await setup(page);
    provider.replies.push({ text: "Export ready. Publication needs confirmation.", calls: [
      { name: "export_layer_data", args: { id: layerId, format: "csv" } }, { name: "publish_map", args: { id: mapId } },
    ] }, { text: "Publication was declined." });
    await send(page, "Export this layer and publish the map");
    const confirm = pane(page).getByRole("group", { name: `Publish Context map (${mapId})?`, exact: true });
    await expect(confirm).toBeVisible();
    const open = await (await page.request.get("/api/assistant/pending")).json();
    const pending = open.pending.find((p: { args: { id?: string } }) => p.args.id === mapId);
    expect(pending).toBeTruthy();
    await expect(pane(page).getByRole("button", { name: /Download the CSV/ })).toBeVisible();
    await reopen(page);
    await expect(confirm).toBeVisible();
    await expect(pane(page).getByRole("button", { name: /Download the CSV/ })).toBeVisible();
    await page.reload();
    if (await pane(page).getAttribute("data-open") !== "true") await page.locator("header").getByRole("button", { name: "Open assistant", exact: true }).click();
    // Since the tab's locator recovers the parked run across the reload on
    // its own; the door is pressed only when the pane still offers it.
    const door = pane(page).getByRole("button", { name: /Recover pending action: Publish Context map/ });
    if (!(await confirm.count()) && (await door.count())) await door.click();
    await expect(confirm).toBeVisible();
    await expect(pane(page).getByRole("button", { name: /Download the CSV/ })).toBeVisible();
    const resolution = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await resolution).postDataJSON()).toEqual({ resolution: { pending: pending.id, approved: false } });
    await expect(pane(page).getByText(/Publication was declined\./)).toBeVisible();
    await reopen(page);
    await expect(pane(page).getByRole("button", { name: /Download the CSV/ })).toHaveCount(1);
    expect((await (await page.request.get(`/api/maps/${mapId}`)).json()).publishToken).toBeNull();
  });
});
