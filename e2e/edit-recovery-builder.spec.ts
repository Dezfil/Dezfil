import { test, expect } from "@playwright/test";
import { routeHouse } from "./support";
import { readThenWriteRequestSetup } from "./edit-basis";
import { closeAll, createProject, invitePerson, runTag, share, type Person } from "./sharing-support";

const STALE = "This item has changed. Reload it before trying again.";
for (const sameAccount of [true, false]) test(`builder keeps refused SQL and legend until explicit reload (${sameAccount ? "two tabs" : "two people"})`, async ({ browser, request, baseURL }) => {
  const people: Person[] = [];
  try {
    const tag = runTag();
    const ada = await invitePerson(browser, request, baseURL!, "Ada", tag); people.push(ada);
    const bo = sameAccount ? ada : await invitePerson(browser, request, baseURL!, "Bo", tag);
    if (!sameAccount) people.push(bo);
    const made = await ada.api.post("/api/maps", { data: { name: `Harbour ${tag}` } }); expect(made.status()).toBe(201);
    const map = await made.json(), mapPath = `/api/maps/${map.id}`;
    const created = await readThenWriteRequestSetup(ada.api, mapPath, () => ({ method: "POST", path: `${mapPath}/layers`, options: { data: { name: "Berths", sql: "SELECT ST_Point(13, 52) AS geometry" } } }));
    expect(created.status()).toBe(201); const layer = await created.json();
    const project = await createProject(ada, `Project ${tag}`, { addMaps: [map.id] });
    if (!sameAccount) await share(ada, project, bo, "editor");
    await routeHouse(ada.context, { basemapStyleStub: true });
    if (!sameAccount) await routeHouse(bo.context, { basemapStyleStub: true });
    await ada.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await ada.context.newPage(), other = await bo.context.newPage();
    await page.goto(`/maps/${map.id}`); await other.goto(`/maps/${map.id}`);
    const row = page.locator("li", { hasText: "Berths" });
    const otherRow = other.locator("li", { hasText: "Berths" });
    await expect(row.getByRole("button", { name: "Layer menu", exact: true })).toBeVisible();
    await expect(otherRow.getByRole("button", { name: "Layer menu", exact: true })).toBeVisible();
    const changed = await readThenWriteRequestSetup(bo.api, mapPath, () => ({ method: "PATCH", options: { data: { name: "Accepted elsewhere" } } }));
    expect(changed.status()).toBe(200);
    let writes = 0;
    page.on("request", req => { if (req.method() === "PATCH" && req.url().includes(`/api/layers/${layer.id}`)) writes++; });
    await row.getByRole("button", { name: "Layer menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit source" }).click();
    const sql = "SELECT ST_Point(14, 53) AS geometry";
    const editor = page.getByRole("textbox", { name: "Layer SQL query" });
    await editor.fill(sql); await page.getByRole("button", { name: "Update layer", exact: true }).click();
    await expect(page.getByText(STALE).first()).toBeVisible();
    await expect(editor).toHaveText(sql);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("tab", { name: "Legend", exact: true }).click();
    await page.getByRole("textbox", { name: "Legend title, Berths" }).fill("Draft legend");
    await page.getByRole("textbox", { name: "Legend title, Berths" }).press("Tab");
    const notice = page.locator("[data-stale-recovery]");
    await expect(page.locator("[data-unsaved]").first()).toBeVisible();
    expect(writes).toBe(1);
    await notice.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(notice).toContainText("Reload discards your unsaved values. Copy what you want to keep first.");
    await notice.getByRole("button", { name: "Copy SQL" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(sql);
    await notice.getByRole("button", { name: "Copy legend title" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Draft legend");
    await page.route(`**${mapPath}`, route => route.request().method() === "GET" ? route.fulfill({ status: 503, json: { error: { message: "Reload unavailable" } } }) : route.continue());
    await notice.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(notice.getByRole("alert")).toContainText("Reload unavailable");
    await expect(page.getByRole("textbox", { name: "Legend title, Berths" })).toHaveValue("Draft legend");
    await test.info().attach("builder-stale", { body: await page.screenshot(), contentType: "image/png" });
    await page.unroute(`**${mapPath}`);
    // A cancelled departure leaves the refused draft in the same editor.
    const dialog = page.waitForEvent("dialog");
    await page.locator('a[href="/maps"]').first().click({ noWaitAfter: true });
    const warning = await dialog; expect(warning.type()).toBe("beforeunload"); await warning.dismiss();
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(page.locator("[data-unsaved]")).toHaveCount(0);
    expect(writes).toBe(1);
    const durable = await (await ada.api.get(mapPath)).json();
    expect(durable.layers[0].sql).toBe(layer.sql); expect(durable.layers[0].legendTitle).toBeNull();
    await expect(page.locator("#header-crumb-slot")).toContainText("Accepted elsewhere");
    if (!sameAccount) {
      await expect(page.locator("[data-last-changed]")).toContainText("Bo ·");
      await expect(page.getByRole("button", { name: /^Undo/ })).toHaveAttribute("aria-label", /Bo/);
    }
    // A deliberate new edit uses the newly loaded document and lands once.
    await page.getByRole("tab", { name: "Legend", exact: true }).click();
    await page.getByRole("textbox", { name: "Legend title, Berths" }).fill("Reapplied");
    await page.getByRole("textbox", { name: "Legend title, Berths" }).press("Tab");
    await expect.poll(async () => (await (await ada.api.get(mapPath)).json()).layers[0].legendTitle).toBe("Reapplied");
    expect(writes).toBe(2);
    // Retirement clears this editor, including a second refused draft.
    await readThenWriteRequestSetup(bo.api, mapPath, () => ({ method: "PATCH", options: { data: { name: "Later" } } }));
    await page.getByRole("textbox", { name: "Legend title, Berths" }).fill("Private draft");
    await page.getByRole("textbox", { name: "Legend title, Berths" }).press("Tab");
    await expect(notice).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("dezfil:account-changed")));
    await expect(page.getByRole("textbox", { name: "Legend title, Berths" })).toHaveCount(0);
  } finally { await closeAll(people); }
});
