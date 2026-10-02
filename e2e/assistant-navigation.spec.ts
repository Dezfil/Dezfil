import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
// The conversation across the three pages (answer to its: one shared
// conversation in the tab, carried by a pane every closed) and the parked
// builder action resolved elsewhere (item 9, 9d.iv; item 11, 11g): a
// completed builder turn present on /sql, the canvas and back; a /sql
// turn present on the canvas; a confirmation created on the builder
// present with its original words on both other pages after close and
// reopen; a turn in flight departed at navigation and recoverable on
// arrival with no work started; a parked builder run executing once on
// approval from /sql, one dispatch counted on the stream beside the map
// read. Navigation is by the rail's links, in the tab; a reload would be
// another tab's worth of state.
//
// Environment: the documented gate (isolated server, fresh data dir, the
// scripted provider on 3202). Run with DEZFIL_BASE_URL at the server.
import { test, expect, type Page } from "@playwright/test";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { addLayer, createMap, routeHouse, seedCsv } from "./support";

const runId = Date.now().toString(36);
const H = 900;
const PANE = "[data-assistant-pane]";

const provider = assistantProviderFixture();
test.beforeAll(async () => { await provider.start(); });
test.afterAll(async () => { await provider.stop(); });
test.beforeEach(async ({ context, page }) => {
  provider.reset();
  await routeHouse(context, { basemapStyleStub: true });
  // A parked action an earlier case left behind holds one of the eight
  // admission slots on the shared instance: abandon them before starting.
  await page.goto("/maps");
  const open = await api(page, "GET", "/api/assistant/pending") as { pending: { runId: string }[] };
  for (const p of open.pending) await api(page, "DELETE", `/api/assistant/runs/${p.runId}`).catch(() => undefined);
});

const door = (page: Page) => page.locator("header").getByRole("button", { name: /^(Open|Close) assistant$/ });
const pane = (page: Page) => page.locator(PANE);
const paneOpen = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "true");
const paneClosed = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "false");
type Json = Record<string, unknown>;
async function api(page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<Json> {
  return page.evaluate(async ({ method, path, body, basis }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }, { method, path, body, basis });
}
async function seed(page: Page) {
  await page.setViewportSize({ width: 1440, height: H });
  await page.goto("/maps");
  const table = `asst_nav_${runId}_${Math.random().toString(36).slice(2, 6)}`;
  await seedCsv(page, table, "name,lon,lat\nalpha,13.4,52.5\nbeta,13.5,52.6\n");
  const mapId = await createMap(page, `nav ${runId}`);
  const layerId = await addLayer(page, mapId, table, `SELECT * FROM ${table}`);
  const made = await api(page, "POST", "/api/recipes", { name: `nav workflow ${runId}` });
  const recipeId = (made.recipe as { id: string }).id;
  await readThenWriteBrowserSetup(page, `/api/recipes/${recipeId}`, () => ({ method: "POST", path: `/api/recipes/${recipeId}/steps`, body: { operation: "sql_step", parameters: { sql: `SELECT name FROM ${table}`, name: `${table}_one` } } })).then(result => result.json);
  return { mapId, layerId, recipeId, table };
}
async function onBuilder(page: Page, mapId: string) {
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector("[data-map-layer]");
}
/** Arriving on a page: the pane is closed on every page open, so the
 * row opens it by its door before reading
 * the conversation, which is what carries across the pages. */
async function openPane(page: Page) {
  if ((await pane(page).getAttribute("data-open")) !== "true") await door(page).click();
  await paneOpen(page);
}
async function ensureOpen(page: Page) {
  await openPane(page);
  await expect(pane(page).getByRole("textbox", { name: "Ask the assistant" })).toBeEnabled();
}
async function reopen(page: Page) {
  await door(page).click(); await paneClosed(page); await door(page).click(); await paneOpen(page);
}
async function send(page: Page, text: string) {
  await pane(page).getByRole("textbox", { name: "Ask the assistant" }).fill(text);
  await pane(page).getByRole("button", { name: "Send", exact: true }).click();
}
/** Same-tab navigation through the rail, never a reload. */
async function goSql(page: Page) { await page.getByRole("link", { name: "SQL", exact: true }).click(); await expect(page.getByLabel("SQL editor")).toBeVisible(); }
async function goCanvas(page: Page, recipeId: string) {
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await page.getByRole("link", { name: `nav workflow ${runId}` }).first().click();
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  expect(page.url()).toContain(`/workflows/${recipeId}`);
}
async function goBuilder(page: Page, mapId: string) {
  await page.getByRole("link", { name: "Maps", exact: true }).click();
  await page.getByRole("link", { name: `nav ${runId}` }).first().click();
  await page.waitForSelector("[data-map-layer]");
  expect(page.url()).toContain(`/maps/${mapId}`);
}

test("a completed builder turn is present on /sql, the canvas and back; a /sql turn is present on the canvas", async ({ page }) => {
  const { mapId, recipeId } = await seed(page);
  await onBuilder(page, mapId);
  await ensureOpen(page);
  provider.replies.push({ text: "Said on the builder." });
  await send(page, "From the builder");
  await expect(pane(page).getByText("Said on the builder.", { exact: true })).toBeVisible();
  await goSql(page);
  await openPane(page);
  await expect(pane(page).getByText("Said on the builder.", { exact: true })).toBeVisible();
  provider.replies.push({ text: "Said on sql." });
  await send(page, "From sql");
  await expect(pane(page).getByText("Said on sql.", { exact: true })).toBeVisible();
  await goCanvas(page, recipeId);
  await openPane(page);
  await expect(pane(page).getByText("Said on the builder.", { exact: true })).toBeVisible();
  await expect(pane(page).getByText("Said on sql.", { exact: true })).toBeVisible();
  // The chips change with the page while the conversation stays.
  await expect(pane(page).locator("[data-talking-about] [data-chip='workflow']")).toHaveCount(1);
  await goBuilder(page, mapId);
  await openPane(page);
  await expect(pane(page).getByText("Said on the builder.", { exact: true })).toBeVisible();
  await expect(pane(page).getByText("Said on sql.", { exact: true })).toBeVisible();
  await expect(pane(page).locator("[data-talking-about] [data-chip='map']")).toHaveCount(1);
});

test("11c, 9d.iv, 11g: a confirmation created on the builder keeps its words on /sql and the canvas after close and reopen there, and resolves from /sql once, one dispatch beside the map read", async ({ page }) => {
  const { mapId, recipeId } = await seed(page);
  await onBuilder(page, mapId);
  await ensureOpen(page);
  provider.replies.push({ text: "Publication needs confirmation.", calls: [{ name: "publish_map", args: { id: mapId } }] }, { text: "Published." });
  await send(page, "Publish the map");
  const words = `Publish nav ${runId} (${mapId})?`;
  const confirm = () => pane(page).getByRole("group", { name: words, exact: true });
  await expect(confirm()).toBeVisible();
  await expect(confirm().getByText("Anyone with the link can view its published data.", { exact: true })).toBeVisible();
  const open = await api(page, "GET", "/api/assistant/pending") as { pending: { id: string; runId: string; args: { id?: string } }[] };
  const ours = open.pending.find((p) => p.args.id === mapId);
  expect(ours).toBeTruthy();
  // /sql: present with its original words, after close and reopen.
  await goSql(page);
  await openPane(page);
  await expect(confirm()).toBeVisible();
  await reopen(page);
  await expect(confirm()).toBeVisible();
  // The canvas: the same.
  await goCanvas(page, recipeId);
  await openPane(page);
  await expect(confirm()).toBeVisible();
  await reopen(page);
  await expect(confirm()).toBeVisible();
  // Resolved from /sql: the resolution names the builder's pending id, the
  // stream carries exactly one publish dispatch, and the map is published.
  await goSql(page);
  await openPane(page);
  let dispatches = 0; let resolution: unknown = null;
  await page.route("**/api/assistant/messages", async (route) => {
    resolution = route.request().postDataJSON();
    const response = await route.fetch();
    const body = await response.text();
    dispatches += body.split("\n").filter((line) => line.includes('"type":"tool_call"') && line.includes('"publish_map"')).length;
    await route.fulfill({ response, body });
  });
  await confirm().getByRole("button", { name: "Confirm", exact: true }).click();
  // The turn's reply joins its two messages, so the last one is matched at the end of the text.
  await expect(pane(page).getByText(/Published\.$/)).toBeVisible();
  await page.unroute("**/api/assistant/messages");
  expect(resolution).toEqual({ resolution: { pending: ours!.id, approved: true } });
  expect(dispatches, "one publish dispatch on the resolution's stream").toBe(1);
  const map = await api(page, "GET", `/api/maps/${mapId}`) as { publishToken: string | null };
  expect(map.publishToken).toEqual(expect.any(String));
  const after = await api(page, "GET", "/api/assistant/pending") as { pending: { id: string }[] };
  expect(after.pending.some((p) => p.id === ours!.id)).toBe(false);
  expect(provider.captures).toHaveLength(2);
});

test("9d.iv bis: a builder-parked mutation of the workflow or a table, approved on the canvas or on /sql, refreshes that page's data", async ({ page }) => {
  // the two hosts dropped the refresh
  // notification a resolved inherited mutation carries, leaving a removed
  // node on the canvas and a deleted table in the /sql sidebar.
  const { mapId, recipeId, table } = await seed(page);
  const recipe = await api(page, "GET", `/api/recipes/${recipeId}`) as { recipe: { steps: { id: string }[] } };
  const stepId = recipe.recipe.steps[0].id;
  await onBuilder(page, mapId);
  await ensureOpen(page);
  // A builder run parks at removing the workflow's node.
  provider.replies.push({ text: "Removal needs confirmation.", calls: [{ name: "remove_recipe_step", args: { id: recipeId, stepId } }] }, { text: "Removed." });
  await send(page, "Remove the node");
  const removal = () => pane(page).getByRole("group", { name: /^Remove / });
  await expect(removal()).toBeVisible();
  await goCanvas(page, recipeId);
  await openPane(page);
  const stepTile = page.locator("[data-node]").filter({ hasText: `${table}_one` });
  await expect(stepTile).toHaveCount(1);
  await removal().getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(pane(page).getByText(/Removed\.$/)).toBeVisible();
  // The step leaves; its input table, referenced by nothing else, leaves with it.
  await expect(stepTile, "the removed node leaves the canvas").toHaveCount(0, { timeout: 10_000 });
  // A builder run parks at deleting the table; approved on /sql, the row leaves.
  await goBuilder(page, mapId);
  await openPane(page);
  provider.replies.push({ text: "Deletion needs confirmation.", calls: [{ name: "delete_table", args: { name: table } }] }, { text: "Deleted." });
  await send(page, "Delete the table");
  const deletion = () => pane(page).getByRole("group", { name: /^Delete / });
  await expect(deletion()).toBeVisible();
  await goSql(page);
  await openPane(page);
  await expect(page.locator(`[data-name="${table}"]`)).toBeVisible({ timeout: 15_000 });
  await deletion().getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(pane(page).getByText(/Deleted\.$/)).toBeVisible();
  await expect(page.locator(`[data-name="${table}"]`), "the deleted table leaves the sidebar").toHaveCount(0, { timeout: 10_000 });
});

test("a turn in flight at navigation is departed, shown as recoverable on arrival, and its recovery starts no work", async ({ page }) => {
  const { mapId } = await seed(page);
  await onBuilder(page, mapId);
  await ensureOpen(page);
  provider.replies.push({ text: "A slow answer.", holdMs: 8000 });
  const started = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
  await send(page, "Take your time");
  await started;
  await expect.poll(() => provider.captures.length).toBe(1);
  let messages = 0; const reads: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/assistant/messages")) messages += 1; if (r.method() === "GET" && r.url().includes("/api/assistant/runs/")) reads.push(r.url()); });
  await goSql(page);
  await openPane(page);
  // Arrival: the turn is shown as departed or recoverable, never restarted.
  await expect(pane(page).getByText(/Check request outcome|The request stopped|still settling/)).toBeVisible({ timeout: 15_000 });
  const recover = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
  if (await recover.count()) await recover.click();
  await page.waitForTimeout(9000);
  expect(messages, "no new message after navigation").toBe(0);
  expect(provider.captures.length, "no new provider exchange").toBe(1);
  expect(reads.length, "recovery reads the run").toBeGreaterThanOrEqual(1);
  await expect(pane(page).getByRole("textbox", { name: "Ask the assistant" })).toBeEnabled();
});
