// Deleting a table asks first, naming what reads it, from both ways in:
// the trash button on the table's page and on its card on the Data page.
// One table is read by two layers of a published map, a hidden layer of a
// draft map and a workflow step that never ran; a second table is read by
// nothing. The dialog's words are checked from both doors and against the
// documented read; Cancel and Escape delete nothing; a delete on the Data
// page moves focus to the next card's delete, then to the list's heading;
// and a fresh reader of the published map sees its layer fail.
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { browserApi, readThenWriteBrowserSetup } from "./edit-basis";
import { FIXTURES_DIR, addLayer, createMap, patchLayer, publishMap, routeHouse, seedCsv, trackConsole } from "./support";

const runId = Date.now().toString(36);
const read = `dt_${runId}_read`;
const none = `dt_${runId}_none`;
const ALPHA = `Alpha ${runId}`;
const BETA = `Beta ${runId}`;
const FLOW = `Flow ${runId}`;

const LIST = [
  new RegExp(`^${ALPHA}\\s*Layer “One”\\s*Published$`),
  new RegExp(`^${ALPHA}\\s*Layer “Two”\\s*Published$`),
  new RegExp(`^${BETA}\\s*Layer “Hidden”$`),
  new RegExp(`^${FLOW}\\s*Step 1 · SQL step$`),
];

async function expectReaders(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: `Delete ${read}` });
  await expect(dialog).toContainText(`Delete ${read}?`);
  await expect(dialog).toContainText("This deletes the table and its 12 rows. These read from it and will stop working:");
  await expect(dialog.locator("[data-table-readers] li")).toHaveText(LIST);
  await expect(dialog).toContainText("Published maps in this list can break for their readers.");
  await expect(dialog).not.toContainText("more in maps or workflows");
  await expect(dialog.getByRole("button", { name: "Delete table" })).toBeEnabled();
}

const tableExists = async (page: Page, name: string) => (await page.request.get(`/api/tables/${name}`)).status();

test("one dialog from both ways in names what reads the table, and deletes only when asked", async ({ page, context }) => {
  test.setTimeout(180_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  await page.goto("/data");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, read, csv);
  await seedCsv(page, none, csv);
  const alpha = await createMap(page, ALPHA);
  await addLayer(page, alpha, "One", `SELECT * FROM ${read}`);
  await addLayer(page, alpha, "Two", `SELECT * FROM ${read} LIMIT 5`);
  const token = await publishMap(page, alpha);
  const beta = await createMap(page, BETA);
  await patchLayer(page, await addLayer(page, beta, "Hidden", `SELECT * FROM ${read}`), { visible: false });
  const made = await browserApi(page, "POST", "/api/recipes", { name: FLOW });
  const flow = (made.json.recipe as { id: string }).id;
  const step = await readThenWriteBrowserSetup(page, `/api/recipes/${flow}`, () => ({
    method: "POST", path: `/api/recipes/${flow}/steps`,
    body: { operation: "sql_step", parameters: { sql: `SELECT * FROM ${read}`, name: `dt_${runId}_flow_out` } },
  }));
  expect(step.status).toBeLessThan(300);

  await test.step("the documented read answers what the dialog will show", async () => {
    const answer = await (await page.request.get(`/api/tables/${read}/readers`)).json();
    expect(answer.table).toMatchObject({ name: read, rowCount: 12 });
    expect(answer.unlisted).toBe(0);
    expect(answer.readers.map((r: { kind: string; map?: { name: string }; workflow?: { name: string } }) => `${r.kind}:${r.map?.name ?? r.workflow?.name}`))
      .toEqual([`layer:${ALPHA}`, `layer:${ALPHA}`, `layer:${BETA}`, `step:${FLOW}`]);
  });

  await test.step("from the table's page: the list word for word, and Cancel and Escape delete nothing", async () => {
    await page.goto(`/tables/${read}`);
    const trash = page.getByRole("button", { name: `Delete ${read}`, exact: true });
    await trash.click();
    await expectReaders(page);
    await page.getByRole("dialog", { name: `Delete ${read}` }).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trash).toBeFocused();
    await trash.click();
    await expect(page.getByRole("dialog", { name: `Delete ${read}` })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await tableExists(page, read)).toBe(200);

    await page.goto(`/tables/${none}`);
    await page.getByRole("button", { name: `Delete ${none}`, exact: true }).click();
    const quiet = page.getByRole("dialog", { name: `Delete ${none}` });
    await expect(quiet).toContainText("This deletes the table and its 12 rows. No map layer or workflow step reads from it.");
    await expect(quiet.locator("[data-table-readers]")).toHaveCount(0);
    await quiet.getByRole("button", { name: "Cancel" }).click();
    expect(await tableExists(page, none)).toBe(200);
  });

  await test.step("from the Data page: the same list, then each delete moves focus on", async () => {
    await page.goto("/data");
    await page.getByLabel("Sort tables").selectOption("name");
    await page.getByRole("textbox", { name: "Search data" }).fill(`dt_${runId}_`);
    const card = (name: string) => page.locator(`[data-table-card="${name}"]`);
    await expect(card(read)).toBeVisible();
    await expect(card(none)).toBeVisible();

    await card(read).hover();
    await card(read).getByRole("button", { name: `Delete ${read}`, exact: true }).click();
    await expectReaders(page);
    await page.getByRole("dialog", { name: `Delete ${read}` }).getByRole("button", { name: "Cancel" }).click();
    expect(await tableExists(page, read)).toBe(200);

    await card(none).hover();
    await card(none).getByRole("button", { name: `Delete ${none}`, exact: true }).click();
    await page.getByRole("dialog", { name: `Delete ${none}` }).getByRole("button", { name: "Delete table" }).click();
    await expect(card(none)).toHaveCount(0);
    await expect(card(read).getByRole("button", { name: `Delete ${read}`, exact: true })).toBeFocused();
    expect(await tableExists(page, none)).toBe(404);

    await card(read).getByRole("button", { name: `Delete ${read}`, exact: true }).click();
    await page.getByRole("dialog", { name: `Delete ${read}` }).getByRole("button", { name: "Delete table" }).click();
    await expect(card(read)).toHaveCount(0);
    await expect(page.locator("[data-list-heading] h1")).toBeFocused();
    expect(await tableExists(page, read)).toBe(404);
  });

  await test.step("what read it stays, and a fresh reader of the published map sees its layer fail", async () => {
    expect((await page.request.get(`/api/maps/${alpha}`)).status()).toBe(200);
    expect((await page.request.get(`/api/maps/${beta}`)).status()).toBe(200);
    expect((await page.request.get(`/api/recipes/${flow}`)).status()).toBe(200);
    expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
    await page.goto(`/v/${token}`);
    await expect(page.getByText("“One” unavailable")).toBeVisible({ timeout: 30_000 });
  });
});
