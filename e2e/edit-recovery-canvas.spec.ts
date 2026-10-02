import { test, expect, type Page } from "@playwright/test";
import { routeHouse } from "./support";
import { readThenWriteRequestSetup } from "./edit-basis";
import { closeAll, createProject, invitePerson, runTag, share, type Person } from "./sharing-support";
const STALE = "This item has changed. Reload it before trying again.";
async function move(page: Page, id: string) {
  const tile = page.locator(`.react-flow__node[data-id="${id}"] [data-v="badge"]`);
  const box = await tile.boundingBox(); if (!box) throw new Error("Missing node");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 100, y + 70, { steps: 8 }); await page.mouse.up();
}
for (const change of ["parameters", "promotion"]) test(`canvas keeps a stale drag, parameters and note after ${change}`, async ({ browser, request, baseURL }) => {
  const people: Person[] = [];
  try {
    const tag = runTag();
    const ada = await invitePerson(browser, request, baseURL!, "Ada", tag), bo = await invitePerson(browser, request, baseURL!, "Bo", tag); people.push(ada, bo);
    const created = await ada.api.post("/api/recipes", { data: { name: `Canvas ${tag}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).recipe.id, path = `/api/recipes/${id}`;
    const added = await readThenWriteRequestSetup(ada.api, path, () => ({ method: "POST", path: `${path}/steps`, options: { data: { operation: "sql_step", parameters: { name: `output_${tag}`, sql: "SELECT 1 AS value" } } } }));
    expect(added.status()).toBe(201); const node = (await added.json()).step.id;
    const layout = { steps: { [node]: { x: 350, y: 180 } }, sources: {}, notes: [{ id: "note", x: 530, y: 180, w: 210, h: 120, color: "yellow", text: "Saved note" }] };
    expect((await readThenWriteRequestSetup(ada.api, path, () => ({ method: "PUT", path: `${path}/layout`, options: { data: layout } }))).status()).toBe(200);
    const project = await createProject(ada, `Project ${tag}`, { addRecipes: [id] }); await share(ada, project, bo, "editor");
    await routeHouse(ada.context, { basemapStyleStub: true }); await ada.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await ada.context.newPage(); await page.goto(`/workflows/${id}`);
    await expect(page.locator(`.react-flow__node[data-id="${node}"] [data-node]`)).toBeVisible();
    // A successful move first gives the local undo stack something to discard.
    await move(page, node); await expect(page.locator("[data-undo]")).toBeEnabled();
    await expect.poll(async () => (await (await ada.api.get(`${path}/layout`)).json()).layout.steps[node].x).not.toBe(350);
    if (change === "parameters") {
      expect((await readThenWriteRequestSetup(bo.api, path, () => ({ method: "PATCH", path: `${path}/steps/${node}`, options: { data: { parameters: { name: `output_${tag}`, sql: "SELECT 2 AS value" } } } }))).status()).toBe(200);
    } else {
      // Materialise once, then propose and run a replacement to exercise promotion.
      const start = async () => {
        const plan = await bo.api.post(`${path}/runs`, { data: { plan: true } }); expect(plan.status()).toBe(200);
        const started = await bo.api.post(`${path}/runs`, { data: {}, headers: { "X-Edit-Revision": (await plan.json()).editRevision } }); expect(started.status()).toBe(202);
        const run = (await started.json()).run.id;
        await expect.poll(async () => (await (await bo.api.get(`${path}/runs/${run}`)).json()).run.outcome, { timeout: 60_000 }).toBe("completed");
      };
      await start();
      await readThenWriteRequestSetup(bo.api, path, () => ({ method: "PATCH", path: `${path}/steps/${node}`, options: { data: { parameters: { name: `output_${tag}`, sql: "SELECT 2 AS value" } } } }));
      await start();
    }
    let writes = 0; page.on("request", r => { if (["PUT", "PATCH", "POST", "DELETE"].includes(r.method()) && r.url().includes(path)) writes++; });
    await move(page, node);
    const notice = page.locator("[data-stale-recovery]"); await expect(notice).toContainText(STALE);
    await expect(notice.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(page.getByText("unsaved position", { exact: true })).toBeVisible();
    await expect(page.locator(`[data-saved-position="${node}"]`)).toBeVisible();
    await page.locator(`.react-flow__node[data-id="${node}"] [data-node]`).click();
    const sql = page.locator('[data-node-panel] [data-param="sql"]');
    await sql.fill("SELECT 99 AS value"); await sql.press("Tab");
    await expect(page.locator("[data-node-panel] [data-unsaved]").first()).toBeVisible();
    await page.locator('[data-note-id="note"]').dblclick();
    await page.locator("[data-note-field]").fill("Private note draft"); await page.locator("[data-note-field]").press("Escape");
    await expect(page.locator('[data-note-id="note"] [data-unsaved]')).toBeVisible();
    const beforeReload = writes;
    await notice.getByRole("button", { name: "Reload", exact: true }).click();
    await notice.getByRole("button", { name: "Copy note text" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Private note draft");
    await page.route(`**${path}/layout`, r => r.request().method() === "GET" ? r.fulfill({ status: 503, json: { error: { message: "Reload unavailable" } } }) : r.continue());
    await notice.getByRole("button", { name: "Reload", exact: true }).click(); await expect(notice).toContainText("Reload unavailable");
    await expect(page.locator('[data-note-id="note"]')).toContainText("Private note draft");
    await test.info().attach(`canvas-stale-${change}`, { body: await page.screenshot(), contentType: "image/png" });
    await page.unroute(`**${path}/layout`);
    await notice.getByRole("button", { name: "Reload", exact: true }).click(); await expect(notice).toHaveCount(0);
    await expect(page.locator("[data-unsaved], [data-saved-position]")).toHaveCount(0);
    await expect(page.locator("[data-undo]")).toBeDisabled(); await expect(page.locator("[data-redo]")).toBeDisabled();
    expect(writes).toBe(beforeReload);
    await expect(page.locator('[data-note-id="note"]')).toContainText("Saved note");
  } finally { await closeAll(people); }
});
