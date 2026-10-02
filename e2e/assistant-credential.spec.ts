import type { EditBasis } from "../src/lib/edit-basis";
// Without a model credential: on all three pages the door is present and
// the pane shows the status API's documented reason and nothing else, the
// words byte-identical across the pages and equal to the API's; with the
// status read failing, each page shows the reachability note and its retry.
//
// Environment: an isolated server booted WITHOUT any provider key. Run with
// DEZFIL_BASE_URL at that server. The reachability case fails the status
// read from the browser, so it holds on any instance.
import { test, expect, type Page } from "@playwright/test";
import { addLayer, createMap, routeHouse, seedCsv } from "./support";

const runId = Date.now().toString(36);
const PANE = "[data-assistant-pane]";
const door = (page: Page) => page.locator("header").getByRole("button", { name: /^(Open|Close) assistant$/ });
const pane = (page: Page) => page.locator(PANE);
type Json = Record<string, unknown>;
async function api(page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<Json> {
  return page.evaluate(async ({ method, path, body, basis }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }, { method, path, body, basis });
}
async function seedPages(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/maps");
  const table = `asst_cred_${runId}_${Math.random().toString(36).slice(2, 6)}`;
  await seedCsv(page, table, "name,lon,lat\nalpha,13.4,52.5\n");
  const mapId = await createMap(page, `cred ${runId}`);
  await addLayer(page, mapId, table, `SELECT * FROM ${table}`);
  const made = await api(page, "POST", "/api/recipes", { name: `cred workflow ${runId}` });
  const recipeId = (made.recipe as { id: string }).id;
  return [`/maps/${mapId}`, "/sql", `/workflows/${recipeId}`];
}
async function openOn(page: Page, path: string) {
  await page.goto(path);
  await expect(door(page)).toBeVisible();
  if ((await pane(page).getAttribute("data-open")) !== "true") await door(page).click();
  await expect(pane(page)).toHaveAttribute("data-open", "true");
}

test("with no key each page shows the door and the pane shows the API's reason with no input, chips or entry chips; the words are byte-identical", async ({ page, context }) => {
  await routeHouse(context, { basemapStyleStub: true });
  const status = await (await page.request.get("/api/assistant")).json() as { enabled: boolean; reason?: string };
  test.skip(status.enabled, "this case needs an instance booted without a model credential");
  expect(status.reason).toBeTruthy();
  const paths = await seedPages(page);
  const texts: string[] = [];
  for (const path of paths) {
    await openOn(page, path);
    const reason = pane(page).getByText(status.reason!, { exact: true });
    await expect(reason).toBeVisible();
    texts.push((await reason.textContent()) ?? "");
    await expect(pane(page).getByRole("textbox")).toHaveCount(0);
    await expect(pane(page).locator("[data-talking-about]")).toHaveCount(0);
    await expect(pane(page).locator("[data-entry-chips]")).toHaveCount(0);
    await expect(pane(page).getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  }
  expect(new Set(texts).size).toBe(1);
  expect(texts[0]).toBe(status.reason);
});

test("with the status read failing each page shows the reachability note and its retry", async ({ page, context }) => {
  await routeHouse(context, { basemapStyleStub: true });
  const paths = await seedPages(page);
  await page.route("**/api/assistant", (route) => route.abort("failed"));
  for (const path of paths) {
    await openOn(page, path);
    await expect(pane(page).getByText("The assistant couldn't be reached.", { exact: true })).toBeVisible();
    await expect(pane(page).getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  }
  // Retry with the status reachable again reads it.
  await page.unroute("**/api/assistant");
  await pane(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(pane(page).getByText("The assistant couldn't be reached.", { exact: true })).toHaveCount(0);
});
