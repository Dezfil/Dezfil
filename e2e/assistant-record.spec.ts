import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
// The retained record, its recovery and the confirmation card (3): the
// record's lines and their inspection after a turn settles, entries
// surviving navigation among the three pages and a reload during a live
// run, the /sql reload keeping the proposal's originating draft for
// Insert's comparison on both of D1's branches, and the settled
// confirmation entries. Resources are read independently through the API;
// provider calls are counted at the scripted fixture, so recovery is seen
// to start nothing.
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
  await page.goto("/maps");
  const open = await api(page, "GET", "/api/assistant/pending") as { pending: { runId: string }[] };
  for (const p of open.pending) await api(page, "DELETE", `/api/assistant/runs/${p.runId}`).catch(() => undefined);
});

const door = (page: Page) => page.locator("header").getByRole("button", { name: /^(Open|Close) assistant$/ });
const pane = (page: Page) => page.locator(PANE);
const paneOpen = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "true");
const entries = (page: Page) => pane(page).locator("[data-record-entry]");
const entryFor = (page: Page, tool: string) => pane(page).locator(`[data-record-entry][data-tool="${tool}"]`);
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
  const table = `asst_rec_${runId}_${Math.random().toString(36).slice(2, 6)}`;
  await seedCsv(page, table, "name,lon,lat\nalpha,13.4,52.5\nbeta,13.5,52.6\n");
  const mapId = await createMap(page, `rec ${runId}`);
  const layerId = await addLayer(page, mapId, "Parks", `SELECT * FROM ${table}`);
  const made = await api(page, "POST", "/api/recipes", { name: `rec workflow ${runId}` });
  const recipeId = (made.recipe as { id: string }).id;
  await api(page, "POST", `/api/recipes/${recipeId}/steps`, { operation: "sql_step", parameters: { sql: `SELECT name FROM ${table}`, name: `${table}_one` } });
  return { mapId, layerId, recipeId, table };
}
async function onBuilder(page: Page, mapId: string) {
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector("[data-map-layer]");
}
/** Arriving on a page: the pane is closed on every page open, so the
 * row opens it by its door first. */
async function openPane(page: Page) {
  if ((await pane(page).getAttribute("data-open")) !== "true") await door(page).click();
  await paneOpen(page);
}
async function ensureOpen(page: Page) {
  await openPane(page);
  await expect(pane(page).getByRole("textbox", { name: "Ask the assistant" })).toBeEnabled();
}
async function send(page: Page, text: string) {
  await pane(page).getByRole("textbox", { name: "Ask the assistant" }).fill(text);
  await pane(page).getByRole("button", { name: "Send", exact: true }).click();
}
async function goSql(page: Page) { await page.getByRole("link", { name: "SQL", exact: true }).click(); await expect(page.getByLabel("SQL editor")).toBeVisible(); }
async function goCanvas(page: Page, recipeId: string) {
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await page.getByRole("link", { name: `rec workflow ${runId}` }).first().click();
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  expect(page.url()).toContain(`/workflows/${recipeId}`);
}
async function goBuilder(page: Page, mapId: string) {
  await page.getByRole("link", { name: "Maps", exact: true }).click();
  await page.getByRole("link", { name: `rec ${runId}` }).first().click();
  await page.waitForSelector("[data-map-layer]");
  expect(page.url()).toContain(`/maps/${mapId}`);
}
/** After a reload the pane recovers the run once on mount; while the
 * server settles the departed run the pane offers the outcome check. */
async function settleAfterReload(page: Page) {
  await openPane(page);
  await expect.poll(async () => {
    const check = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
    if (await check.count()) await check.click();
    return entries(page).count();
  }, { timeout: 15_000 }).toBeGreaterThan(0);
}
async function typeSql(page: Page, sql: string) {
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(sql);
  await page.keyboard.press("Escape");
}
async function editorText(page: Page): Promise<string> {
  return page.locator(".cm-content").evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".cm-placeholder").forEach((n) => n.remove());
    const lines = Array.from(clone.querySelectorAll(".cm-line"));
    return lines.length === 0 ? (clone.textContent ?? "") : lines.map((l) => l.textContent ?? "").join("\n");
  });
}

test.describe("1: the record after a turn", () => {
  test("a read, a mutation and a refusal stay under the turn in order; the inspection holds the SQL, the inputs and the identifier, never the line", async ({ page }) => {
    const { mapId, layerId, table } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    const sql = `SELECT count(*) AS n FROM ${table}`;
    provider.replies.push(
      { calls: [{ name: "run_sql", args: { sql } }, { name: "update_layer", args: { id: layerId, name: "Parks renamed" } }, { name: "teleport_map", args: { id: mapId } }] },
      { text: "Counted, renamed, and one thing I could not do." },
    );
    await send(page, "Count, rename, teleport");
    await expect(pane(page).getByText("Counted, renamed, and one thing I could not do.", { exact: true })).toBeVisible();
    // After settlement the entries are under the turn, in order, once each.
    await expect(entries(page)).toHaveCount(3);
    await expect(entries(page).nth(0)).toHaveAttribute("data-tool", "run_sql");
    await expect(entries(page).nth(1)).toHaveAttribute("data-tool", "update_layer");
    await expect(entries(page).nth(2)).toHaveAttribute("data-tool", "teleport_map");
    await expect(entries(page).nth(0)).toHaveAttribute("data-status", "succeeded");
    await expect(entries(page).nth(1)).toHaveAttribute("data-status", "succeeded");
    await expect(entries(page).nth(2)).toHaveAttribute("data-status", "refused");
    await expect(entries(page).nth(0).getByRole("button")).toContainText("Ran a query");
    await expect(entries(page).nth(1).getByRole("button")).toContainText("Updated the layer Parks renamed");
    await expect(entries(page).nth(2).getByRole("button")).toContainText("Unknown tool: teleport_map");
    // The identifier is not on any line.
    for (const name of ["run_sql", "update_layer"]) await expect(pane(page).locator("[data-record-entry] button", { hasText: name })).toHaveCount(0);
    // The query's inspection: exactly the submitted SQL, then the identifier.
    await entries(page).nth(0).getByRole("button").click();
    await expect(entries(page).nth(0).locator("[data-sql]")).toHaveText(sql);
    await expect(entries(page).nth(0).locator("[data-tool-id]")).toHaveText("run_sql");
    await expect(entries(page).nth(0).locator("[data-inputs]")).toHaveCount(0);
    // The rename's inspection: no SQL, the retained inputs, the history line.
    await entries(page).nth(1).getByRole("button").click();
    await expect(entries(page).nth(1).locator("[data-sql]")).toHaveCount(0);
    await expect(entries(page).nth(1).locator("[data-inputs]")).toContainText("Parks renamed");
    await expect(entries(page).nth(1).locator("[data-history]")).toContainText(`Map ${mapId}, change group`);
    await expect(entries(page).nth(1).locator("[data-tool-id]")).toHaveText("update_layer");
    // The elapsed time is on the settled lines.
    await expect(entries(page).nth(0).locator("button")).toContainText(/\d+(\.\d+)? s/);
    // Read independently: the layer was renamed exactly once.
    const layer = await api(page, "GET", `/api/layers/${layerId}`);
    expect(layer.name).toBe("Parks renamed");
    expect(provider.captures).toHaveLength(2);
  });
});

test.describe("2: recovery and retention", () => {
  test("a turn's entries are present on /sql, the canvas and back with the same subjects and outcomes", async ({ page }) => {
    const { mapId, layerId, recipeId } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Travelled" } }] }, { text: "Renamed." });
    await send(page, "Rename the layer");
    await expect(pane(page).getByText("Renamed.", { exact: true })).toBeVisible();
    await expect(entryFor(page, "update_layer").getByRole("button")).toContainText("Updated the layer Travelled");
    for (const go of [() => goSql(page), () => goCanvas(page, recipeId), () => goBuilder(page, mapId)]) {
      await go();
      await openPane(page);
      await expect(entries(page)).toHaveCount(1);
      await expect(entryFor(page, "update_layer")).toHaveAttribute("data-status", "succeeded");
      await expect(entryFor(page, "update_layer").getByRole("button")).toContainText("Updated the layer Travelled");
    }
    expect(provider.captures).toHaveLength(2);
  });

  test("a reload during a live builder run recovers the turn's entries with the resource changed once and no further provider call", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    provider.replies.push(
      { calls: [{ name: "update_layer", args: { id: layerId, name: "Renamed before the reload" } }] },
      { text: "Renamed, and now I am thinking about the next step for a while.", holdMs: 8000 },
    );
    await send(page, "Rename the layer, then think");
    // The rename landed and the model is still talking when the page reloads.
    await expect(entryFor(page, "update_layer")).toHaveAttribute("data-status", "succeeded");
    await expect.poll(() => provider.captures.length).toBe(2);
    await page.reload();
    await page.waitForSelector("[data-map-layer]");
    await settleAfterReload(page);
    await expect(entries(page)).toHaveCount(1);
    await expect(entryFor(page, "update_layer").getByRole("button")).toContainText("Updated the layer Renamed before the reload");
    await expect(pane(page).getByText("Rename the layer, then think", { exact: true })).toBeVisible();
    // Nothing was dispatched or asked again: the fixture saw no third request,
    // and the layer carries its one rename.
    await page.waitForTimeout(500);
    expect(provider.captures).toHaveLength(2);
    expect((await api(page, "GET", `/api/layers/${layerId}`)).name).toBe("Renamed before the reload");
    // The tab's state is cleared once the run settled.
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("dezfil.assistant.active"))).toBeNull();
  });

  test("a /sql reload during a live run keeps the proposal's originating draft, so Insert still replaces an unchanged draft and appends to an edited one", async ({ page }) => {
    const { table } = await seed(page);
    await page.goto("/sql");
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    await ensureOpen(page);
    const proposal = `SELECT name FROM ${table} WHERE name = 'beta'`;
    for (const branch of ["replace", "append"] as const) {
      const draft = `SELECT ${branch === "replace" ? 1 : 2} AS before_${branch}`;
      await typeSql(page, draft);
      provider.replies.push({ text: `Try this (${branch}):\n\`\`\`sql\n${proposal}\n\`\`\`\nStill thinking about ${branch}.`, holdMs: 8000 });
      await send(page, `Propose (${branch})`);
      // The reply is live: the block shows as text with no action yet.
      await expect(pane(page).getByText(`Still thinking about ${branch}.`, { exact: false })).toBeVisible();
      await expect(pane(page).getByRole("button", { name: "Insert into editor", exact: true })).toHaveCount(0);
      await page.reload();
      await expect(page.getByLabel("SQL editor")).toBeVisible();
      await openPane(page);
      await expect.poll(async () => {
        const check = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
        if (await check.count()) await check.click();
        return pane(page).getByRole("button", { name: "Insert into editor", exact: true }).count();
      }, { timeout: 15_000 }).toBeGreaterThan(0);
      // The originating message came back with the turn.
      await expect(pane(page).getByText(`Propose (${branch})`, { exact: true })).toBeVisible();
      expect(await editorText(page)).toBe(draft);
      if (branch === "append") { await page.locator(".cm-content").click(); await page.keyboard.press("End"); await page.keyboard.type(" -- edited"); }
      await pane(page).getByRole("button", { name: "Insert into editor", exact: true }).last().click();
      const after = await editorText(page);
      if (branch === "replace") expect(after).toBe(proposal);
      else expect(after).toBe(`${draft} -- edited\n\n${proposal}`);
      await expect(pane(page).getByText("Your draft changed since this was proposed", { exact: false })).toHaveCount(branch === "replace" ? 0 : 1);
      await expect(pane(page).getByRole("button", { name: "In the editor", exact: true })).toHaveCount(1);
      // The recovered turn's record holds no product entry: a proposal is text.
      await expect(entries(page)).toHaveCount(0);
    }
    expect(provider.captures).toHaveLength(2);
  });
});

test.describe("4: the confirmation card and the settled entries", () => {
  const card = (page: Page) => pane(page).locator("[data-confirmation]");

  test("the card's words with no sending sentence, the input disabled and Stop in the slot while it waits; approval's real outcome; a decline after completed work; a parked turn ended by Stop; settled entries without controls", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    // Approval whose action fails: the layer is deleted by hand while the gate waits.
    provider.replies.push({ calls: [{ name: "delete_layer", args: { id: layerId } }] }, { text: "It was already gone." });
    await send(page, "Delete the layer");
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText(`Delete Parks (${layerId})?`);
    await expect(card(page)).toContainText("This removes the layer and its bound widgets.");
    // No sending sentence on the card;
    // while it waits the input is disabled with "Working…" and the
    // control in Send's slot reads Stop.
    expect(await card(page).innerText()).not.toMatch(/sending another message/i);
    await expect(card(page).getByRole("button")).toHaveCount(2);
    expect(await card(page).innerText()).not.toContain("delete_layer");
    await expect(pane(page).getByRole("textbox", { name: "Ask the assistant" })).toHaveAttribute("placeholder", "Working…");
    await expect(pane(page).getByRole("textbox", { name: "Ask the assistant" })).toBeDisabled();
    await expect(pane(page).getByRole("button", { name: "Stop", exact: true })).toHaveCount(1);
    await expect(pane(page).getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    await api(page, "DELETE", `/api/layers/${layerId}`);
    await card(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(pane(page).getByText("It was already gone.", { exact: true })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    const approved = entryFor(page, "delete_layer");
    await expect(approved).toHaveAttribute("data-status", "refused");
    await expect(approved.getByRole("button")).toContainText(`No layer with id ${layerId}.`);
    await approved.getByRole("button").click();
    await expect(approved.locator("[data-decision='approved']")).toHaveText("Confirmed by you.");
    await expect(approved.locator("[data-tool-id]")).toHaveText("delete_layer");
    // A decline after completed earlier work: the rename stands, the decline is scoped to the publish.
    provider.replies.push({ calls: [{ name: "update_map", args: { id: mapId, name: "Renamed before the gate" } }, { name: "publish_map", args: { id: mapId } }] }, { text: "Left unpublished." });
    await send(page, "Rename, then publish");
    await expect(card(page)).toContainText(`Publish Renamed before the gate (${mapId})?`);
    await card(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(pane(page).getByText("Left unpublished.", { exact: true })).toBeVisible();
    const declined = entryFor(page, "publish_map");
    await expect(declined).toHaveAttribute("data-status", "refused");
    await expect(declined.getByRole("button")).toContainText(`Publish Renamed before the gate (${mapId})`);
    await expect(declined.getByRole("button")).toContainText("You cancelled it, so this was not done.");
    expect(await pane(page).innerText()).not.toMatch(/nothing changed/i);
    const map = await api(page, "GET", `/api/maps/${mapId}`);
    expect(map.name).toBe("Renamed before the gate");
    expect(map.publishToken).toBeNull();
    // A parked turn ended by Stop (3i, the n place of the pane's
    // supersession): the documented abandonment settles the run, the gate's
    // entry says the request was stopped, nothing was published, no
    // provider call followed, and the input is back.
    provider.replies.push({ calls: [{ name: "publish_map", args: { id: mapId } }] });
    await send(page, "Publish it now");
    await expect(card(page)).toBeVisible();
    const capturesBefore = provider.captures.length;
    const abandonment = page.waitForRequest((r) => r.method() === "DELETE" && r.url().includes("/api/assistant/runs/"));
    await pane(page).getByRole("button", { name: "Stop", exact: true }).click();
    await abandonment;
    await expect(card(page)).toHaveCount(0);
    const stopped = pane(page).locator("[data-record-entry][data-tool='publish_map'][data-status='refused']").last();
    await expect(stopped.getByRole("button")).toContainText("You stopped the request, so this was not done.");
    await expect(pane(page).getByRole("textbox", { name: "Ask the assistant" })).toBeEnabled();
    await page.waitForTimeout(300);
    expect(provider.captures.length, "no provider call after the stop").toBe(capturesBefore);
    expect((await api(page, "GET", `/api/maps/${mapId}`)).publishToken).toBeNull();
    // Settled entries offer no controls beyond their expander.
    for (const entry of await entries(page).all()) {
      await expect(entry.getByRole("button")).toHaveCount(1);
      await expect(entry.getByRole("button")).toHaveAttribute("aria-expanded", /true|false/);
    }
    await expect(pane(page).getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0);
    await expect(pane(page).getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  });
});

test.describe("2 and 3: recovery cases, the interleaved edit, and the words the pane uses", () => {
  const card = (page: Page) => pane(page).locator("[data-confirmation]");
  const TRANSPORT = /\b(GET|POST|PATCH|PUT|DELETE)\b|\/api\/|\bHTTP \d{3}\b|status \d{3}/;

  test("a dropped stream and a navigation during execution each recover their entries with one change and no further provider call", async ({ page }) => {
    const { mapId, layerId, recipeId } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    // 2b: the response is drained and then dropped before the client reads it.
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Dropped stream" } }] }, { text: "Renamed after the drop." });
    await page.route("**/api/assistant/messages", async (route) => {
      const response = await route.fetch(); await response.body(); await route.abort("connectionreset");
    }, { times: 1 });
    await send(page, "Rename the layer");
    await expect(entryFor(page, "update_layer").first()).toHaveAttribute("data-status", "succeeded", { timeout: 15_000 });
    await expect(entryFor(page, "update_layer").first().getByRole("button")).toContainText("Updated the layer Dropped stream");
    expect((await api(page, "GET", `/api/layers/${layerId}`)).name).toBe("Dropped stream");
    await page.waitForTimeout(400);
    expect(provider.captures).toHaveLength(2);
    // 2c: the next turn is departed by navigating to the canvas while the reply is held.
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Departed by navigation" } }] }, { text: "Still thinking after the rename.", holdMs: 8000 });
    await send(page, "Rename it again, then think");
    await expect(pane(page).locator(`[data-record-entry][data-tool="update_layer"][data-status="succeeded"]`)).toHaveCount(2, { timeout: 15_000 });
    await expect.poll(() => provider.captures.length).toBe(4);
    await goCanvas(page, recipeId);
    await openPane(page);
    await expect.poll(async () => {
      const check = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
      if (await check.count()) await check.click();
      return pane(page).locator(`[data-record-entry][data-tool="update_layer"]`).count();
    }, { timeout: 15_000 }).toBe(2);
    await expect(pane(page).locator(`[data-record-entry][data-tool="update_layer"]`).last().getByRole("button")).toContainText("Updated the layer Departed by navigation");
    expect((await api(page, "GET", `/api/layers/${layerId}`)).name).toBe("Departed by navigation");
    await page.waitForTimeout(400);
    expect(provider.captures).toHaveLength(4);
  });

  test("a lost approval response recovers the approved action once; a gone run clears the tab's state; the manual edit during the pause splits undo", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    provider.replies.push({ calls: [{ name: "update_map", args: { id: mapId, name: "First" } }, { name: "publish_map", args: { id: mapId } }] }, { calls: [{ name: "update_map", args: { id: mapId, name: "Second" } }] }, { text: "Renamed, published, renamed." });
    await send(page, "Rename, publish, rename");
    await expect(card(page)).toBeVisible();
    // The manual edit while the gate waits, through the map's own route.
    await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "PATCH", path: `/api/maps/${mapId}`, body: { name: "Manual" } }));
    // The approval's response is lost after the server has it.
    await page.route("**/api/assistant/messages", async (route) => {
      const response = await route.fetch(); await response.body(); await route.abort("connectionreset");
    }, { times: 1 });
    await card(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(pane(page).getByText("Renamed, published, renamed.", { exact: true })).toBeVisible({ timeout: 15_000 });
    const entriesNow = pane(page).locator("[data-record-entry]");
    await expect(entriesNow).toHaveCount(3);
    await expect(entriesNow.nth(0).getByRole("button")).toContainText("Updated the map First");
    await expect(entriesNow.nth(1)).toHaveAttribute("data-tool", "publish_map");
    await expect(entriesNow.nth(1)).toHaveAttribute("data-status", "succeeded");
    await expect(entriesNow.nth(2).getByRole("button")).toContainText("Updated the map Second");
    const map = await api(page, "GET", `/api/maps/${mapId}`);
    expect(map.name).toBe("Second");
    expect(map.publishToken).toEqual(expect.any(String));
    expect(provider.captures).toHaveLength(3);
    // 3f: undo walks Second, Manual, First; the record's order is unchanged.
    const name = async () => (await api(page, "GET", `/api/maps/${mapId}`)).name;
    await api(page, "POST", `/api/maps/${mapId}/undo`); expect(await name()).toBe("Manual");
    await api(page, "POST", `/api/maps/${mapId}/undo`); expect(await name()).toBe("First");
    await api(page, "POST", `/api/maps/${mapId}/redo`); expect(await name()).toBe("Manual");
    await expect(entriesNow.nth(0).getByRole("button")).toContainText("Updated the map First");
    // 2g: the tab's state is cleared after settlement, and a locator to a gone run clears on its 404.
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("dezfil.assistant.active"))).toBeNull();
    await page.evaluate(() => sessionStorage.setItem("dezfil.assistant.active", JSON.stringify({ id: "00000000-0000-4000-8000-000000000000", message: "Gone", origin: { page: "builder" } })));
    await page.reload();
    await page.waitForSelector("[data-map-layer]");
    await openPane(page);
    await expect(pane(page).getByText("This request is no longer available. It will not be repeated.", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("dezfil.assistant.active"))).toBeNull();
    expect(provider.captures).toHaveLength(3);
  });

  test("a stream error, an action refusal with a SQL error, an HTTP failure at capacity and a recovery error each read for a person, the SQL text intact", async ({ page }) => {
    const { mapId, table } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    // 4h: an action refusal whose text is the engine's own.
    provider.replies.push({ calls: [{ name: "run_sql", args: { sql: `SELECT missing_column FROM ${table}` } }] }, { text: "That column does not exist." });
    await send(page, "Count the missing column");
    await expect(pane(page).getByText("That column does not exist.", { exact: true })).toBeVisible();
    const refused = entryFor(page, "run_sql");
    await expect(refused).toHaveAttribute("data-status", "refused");
    const refusal = await refused.getByRole("button").innerText();
    expect(refusal).toMatch(/missing_column/);
    expect(refusal).not.toMatch(TRANSPORT);
    // 4g stream: the fixture has no reply left, so the provider fails mid-run.
    await send(page, "Say something with no script");
    const note = pane(page).locator("[role='alert'], [data-error-note]").first();
    await expect(pane(page).getByText(/provider|model/i).first()).toBeVisible({ timeout: 15_000 });
    const paneText = await pane(page).innerText();
    expect(paneText).not.toMatch(TRANSPORT);
    void note;
    // 4g HTTP and 4j: capacity by reservations, then by a parked gate.
    const reserved: string[] = [];
    for (let i = 0; i < 8; i++) { try { reserved.push((await api(page, "POST", "/api/assistant/runs")).id as string); } catch { break; } }
    provider.replies.push({ text: "Never sent." });
    await send(page, "One more");
    await expect(pane(page).getByText("The assistant is at capacity", { exact: false })).toBeVisible({ timeout: 15_000 });
    expect(await pane(page).innerText()).toMatch(/Wait for one to finish/);
    expect(await pane(page).innerText()).not.toMatch(TRANSPORT);
    for (const id of reserved) await api(page, "DELETE", `/api/assistant/runs/${id}`).catch(() => undefined);
    // The reply queued for the refused message never left the fixture: clear it before the next turn.
    provider.replies.length = 0;
    // Capacity with a pending action to recover: a gate parked by another
    // client through the API (the pane cannot send while its own card
    // waits), the pane reloaded so it lists it, then the rest filled with
    // reservations.
    provider.replies.push({ calls: [{ name: "publish_map", args: { id: mapId } }] });
    const parkedRun = (await api(page, "POST", "/api/assistant/runs")).id as string;
    // The exchange streams NDJSON; the stream ends when the run parks.
    await page.evaluate(async (runId) => { const r = await fetch("/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, message: "Publish it" }) }); await r.text(); }, parkedRun);
    await page.reload();
    await page.waitForSelector("[data-map-layer]");
    await ensureOpen(page);
    await expect(pane(page).getByRole("button", { name: /^Recover pending action:/ })).toHaveCount(1);
    const filled: string[] = [];
    for (let i = 0; i < 8; i++) { try { filled.push((await api(page, "POST", "/api/assistant/runs")).id as string); } catch { break; } }
    // A new message hits capacity: the pane names the recovery it can offer.
    await send(page, "Never mind, another thing");
    await expect(pane(page).getByText("The assistant is at capacity", { exact: false })).toBeVisible({ timeout: 15_000 });
    expect(await pane(page).innerText()).toMatch(/Recover a pending action below, or abandon it/);
    expect(await pane(page).innerText()).not.toMatch(TRANSPORT);
    for (const id of [...filled, parkedRun]) await api(page, "DELETE", `/api/assistant/runs/${id}`).catch(() => undefined);
    provider.replies.length = 0;
  });
});

// The record's long line: the collapsed line keeps its one-line cut and
// carries the whole sentence as pointer text; opening it shows the
// sentence entire above what the inspection already held, and only when
// the line had to cut. Whether it had to cut is measured from the
// rendered line's own overflow at the pane's shipped width, with a
// control that does not overflow, so the measurement is shown able to
// report both answers.
const LONG_SUBJECT = "Dynamic park perimeters of the eastern district, 2026 survey";
const MARKDOWN_SUBJECT = "**Dynamic** _park_ [east](x) `2026`";

/** The line's own words and whether they overflow. The sentence is supplied
 * by the caller, never read back out of the entry the pane produced. */
async function lineMetrics(page: Page, tool: string, sentence: string) {
  return entryFor(page, tool).last().locator("button").evaluate((el, sentence) => {
    const words = Array.from(el.querySelectorAll("span")).filter((s) => s.children.length === 0 && (s.textContent ?? "") === sentence);
    if (words.length !== 1) return { found: words.length, cut: null as boolean | null, height: null as number | null };
    const w = words[0];
    // Whole pixels cannot see a fractional clip, so the helper measures
    // the words' laid-out width against their box, as the pane does.
    const span = document.createRange();
    span.selectNodeContents(w);
    const painted = span.getBoundingClientRect().width - w.getBoundingClientRect().width;
    return { found: 1, cut: painted > 0.05 || w.scrollWidth > w.clientWidth, height: Math.round(el.getBoundingClientRect().height) };
  }, sentence);
}

test.describe("5: the record's long line", () => {
  test("a, b, c, d: a cut line stays one line and opens with the whole sentence above the inputs; a fitting line shows no ellipsis and repeats nothing; the pointer text carries both", async ({ page }) => {
    const { mapId, layerId, table } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    const sql = `SELECT count(*) AS n FROM ${table}`;
    provider.replies.push(
      { calls: [{ name: "update_layer", args: { id: layerId, name: LONG_SUBJECT } }, { name: "run_sql", args: { sql } }] },
      { text: "Renamed and counted." },
    );
    await send(page, "Rename it long, then count");
    await expect(pane(page).getByText("Renamed and counted.", { exact: true })).toBeVisible();
    const longSentence = `Updated the layer ${LONG_SUBJECT}`;
    const shortSentence = "Ran a query";
    // a: the long line overflows, the short control does not, and the two
    // rows are the same height, so the cut line did not grow.
    const long = await lineMetrics(page, "update_layer", longSentence);
    const short = await lineMetrics(page, "run_sql", shortSentence);
    expect(long.found).toBe(1);
    expect(short.found).toBe(1);
    expect(long.cut).toBe(true);
    expect(short.cut).toBe(false);
    expect(long.height).toBe(short.height);
    // The mark, the elapsed time and the expander are still on the cut line.
    const cutLine = entryFor(page, "update_layer").last().getByRole("button");
    await expect(entryFor(page, "update_layer").last().locator("button span[aria-label]")).toHaveAttribute("aria-label", "done");
    await expect(cutLine).toContainText(/\d+(\.\d+)? s/);
    await expect(cutLine).toHaveAttribute("aria-expanded", "false");
    // d in the browser: the pointer text carries the whole sentence, cut or not.
    await expect(cutLine).toHaveAttribute("title", longSentence);
    await expect(entryFor(page, "run_sql").last().getByRole("button")).toHaveAttribute("title", shortSentence);
    // b: the expansion opens with the whole sentence, above what it held.
    await cutLine.click();
    const inspection = entryFor(page, "update_layer").last().locator("[data-inspection]");
    await expect(inspection.locator("[data-sentence]")).toHaveText(longSentence);
    expect(await inspection.evaluate((el) => el.firstElementChild?.hasAttribute("data-sentence") ?? false)).toBe(true);
    await expect(inspection.locator("[data-inputs]")).toContainText(LONG_SUBJECT);
    await expect(inspection.locator("[data-history]")).toContainText(`Map ${mapId}, change group`);
    await expect(inspection.locator("[data-tool-id]")).toHaveText("update_layer");
    // c: the fitting line repeats nothing, and keeps its own inspection.
    await entryFor(page, "run_sql").last().getByRole("button").click();
    await expect(entryFor(page, "run_sql").last().locator("[data-inspection] [data-sentence]")).toHaveCount(0);
    await expect(entryFor(page, "run_sql").last().locator("[data-sql]")).toHaveText(sql);
    expect(provider.captures).toHaveLength(2);
  });

  test("a (one pixel): words over their slot by a single pixel are cut, and the expansion shows the sentence", async ({ page }) => {
    // `scrollWidth` and `clientWidth` are
    // rounded to whole pixels, so a line one pixel over its slot reads as
    // equal while the browser paints the ellipsis. The oracle is the
    // pane's own answer, not the helper's arithmetic: the row appears.
    const { mapId, table } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    provider.replies.push(
      { calls: [{ name: "run_sql", args: { sql: `SELECT count(*) AS n FROM ${table}` } }] },
      { text: "Counted." },
    );
    await send(page, "Count them");
    await expect(pane(page).getByText("Counted.", { exact: true })).toBeVisible();
    const line = entryFor(page, "run_sql").last();
    // The words fit as they stand, then their slot is narrowed by exactly
    // one pixel, which is a painted clip and nothing more.
    const squeezed = await line.locator("button").evaluate((el) => {
      const words = Array.from(el.querySelectorAll("span")).find((s) => s.children.length === 0 && (s.textContent ?? "") === "Ran a query");
      if (!words) return { over: null as number | null, painted: null as number | null };
      const span = document.createRange();
      span.selectNodeContents(words);
      const natural = span.getBoundingClientRect().width;
      (words as HTMLElement).style.maxWidth = `${natural - 0.6}px`;
      return { over: words.scrollWidth - words.clientWidth, painted: natural - words.getBoundingClientRect().width };
    });
    // A real painted clip that whole pixels cannot see.
    expect(squeezed.painted).toBeGreaterThan(0.25);
    expect(squeezed.over).toBeLessThanOrEqual(1);
    await line.getByRole("button").click();
    await expect(line.locator("[data-inspection] [data-sentence]")).toHaveText("Ran a query");
  });

  test("f: markdown characters in a subject's name stay literal on the line, in the sentence row and in the pointer text", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    provider.replies.push(
      { calls: [{ name: "update_layer", args: { id: layerId, name: MARKDOWN_SUBJECT } }] },
      { text: "Renamed." },
    );
    await send(page, "Rename it with markdown");
    await expect(pane(page).getByText("Renamed.", { exact: true })).toBeVisible();
    const sentence = `Updated the layer ${MARKDOWN_SUBJECT}`;
    const line = entryFor(page, "update_layer").last().getByRole("button");
    expect(await line.innerText()).toContain(MARKDOWN_SUBJECT);
    await expect(line).toHaveAttribute("title", sentence);
    await line.click();
    const inspection = entryFor(page, "update_layer").last().locator("[data-inspection]");
    await expect(inspection.locator("[data-sentence]")).toHaveText(sentence);
    // Nothing was interpreted: no emphasis, no link, no code element.
    const html = await entryFor(page, "update_layer").last().innerHTML();
    for (const tag of ["<strong", "<em", "<a ", "<code"]) expect(html).not.toContain(tag);
  });

  test("e: the sentence is there for an action settled inside a running turn, for the settled turn, and after recovery, with nothing further started", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    await ensureOpen(page);
    provider.replies.push(
      { calls: [{ name: "update_layer", args: { id: layerId, name: LONG_SUBJECT } }] },
      { text: "Renamed, and now I am thinking about the next step for a while.", holdMs: 8000 },
    );
    const sentence = `Updated the layer ${LONG_SUBJECT}`;
    await send(page, "Rename the layer, then think");
    // Live: the outcome has landed while the turn still runs.
    await expect(entryFor(page, "update_layer")).toHaveAttribute("data-status", "succeeded");
    await expect(entryFor(page, "update_layer").getByRole("button")).toHaveAttribute("title", sentence);
    await entryFor(page, "update_layer").getByRole("button").click();
    await expect(entryFor(page, "update_layer").locator("[data-inspection] [data-sentence]")).toHaveText(sentence);
    // Settled: the same turn, done.
    await expect(pane(page).getByText("Renamed, and now I am thinking about the next step for a while.", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(entryFor(page, "update_layer").getByRole("button")).toHaveAttribute("title", sentence);
    await expect(entryFor(page, "update_layer").locator("[data-inspection] [data-sentence]")).toHaveText(sentence);
    // Recovered: the turn rebuilt through the documented reads.
    await page.reload();
    await page.waitForSelector("[data-map-layer]");
    await settleAfterReload(page);
    await expect(entryFor(page, "update_layer").getByRole("button")).toHaveAttribute("title", sentence);
    await entryFor(page, "update_layer").getByRole("button").click();
    await expect(entryFor(page, "update_layer").locator("[data-inspection] [data-sentence]")).toHaveText(sentence);
    // Nothing further was dispatched or asked: the fixture saw two requests
    // and the layer carries its one rename.
    await page.waitForTimeout(500);
    expect(provider.captures).toHaveLength(2);
    expect((await api(page, "GET", `/api/layers/${layerId}`)).name).toBe(LONG_SUBJECT);
  });
});
