// The SQL console: the workspace rebuilt as a console — a table browser
// that previews on activation, an editor with completion and a live Run
// button, results as a table and a map, keeping actions, the Data Explorer
// door, and per-browser history and draft. Environment: the documented
// gate (isolated server, fresh data dir); seeding is by API. Run via `npm
// run e2e:sqlconsole` with DEZFIL_BASE_URL at the server.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { consumeExpected, routeHouse, seedCsv, trackConsole } from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const spatial = `console_pts_${runId}`;
const plain = `console_plain_${runId}`;

async function typeSql(page: Page, sql: string) {
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(sql);
  await page.keyboard.press("Escape"); // close any completion popup
}

/** The document's text — the placeholder CodeMirror renders inside an
 * empty document is not the document. Lines are joined with newlines, as
 * the document has them. */
async function editorText(page: Page): Promise<string> {
  return page.locator(".cm-content").evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".cm-placeholder").forEach((n) => n.remove());
    const lines = Array.from(clone.querySelectorAll(".cm-line"));
    if (lines.length === 0) return clone.textContent ?? "";
    return lines.map((l) => l.textContent ?? "").join("\n");
  });
}

test.describe.configure({ mode: "serial" });

test("the SQL console end to end", async ({ page, context }) => {
  /** The preview bar's measured paint, compared against the result bar's. */
  const previewPaint: { bar: string | null } = { bar: null };
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  await test.step("seed: a spatial table and a non-spatial one", async () => {
    await page.goto("/maps");
    const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
    await seedCsv(page, spatial, csv);
    await seedCsv(page, plain, "category,n\na,1\nb,2\nc,3\n");
  });

  await test.step("a bare opening is empty, the pane and work area are there", async () => {
    await page.goto("/sql");
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    // The document itself is empty (the placeholder is not the document).
    expect(await editorText(page)).toBe("");
    // No chip wall, no page heading, no back-link.
    await expect(page.getByRole("heading", { name: "SQL", exact: true })).toHaveCount(0);
    // (The rail's own Data entry is the shell's, outside main.)
    await expect(page.locator("main").getByRole("link", { name: /^Data$|Open in Data/ })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Sources" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "History" })).toBeVisible();
    await expect(page.getByText("Nothing to show yet")).toBeVisible();
  });

  await test.step("search narrows by table name and by column name", async () => {
    const search = page.getByLabel("Search tables");
    await expect(page.locator(`[data-name="${spatial}"]`)).toBeVisible({ timeout: 15_000 });
    await search.fill(plain);
    await expect(page.locator(`[data-name="${plain}"]`)).toBeVisible();
    await expect(page.locator(`[data-name="${spatial}"]`)).toHaveCount(0);
    // A column found in no table name: "riders" lives only in the spatial table.
    await search.fill("riders");
    await expect(page.locator(`[data-name="${spatial}"]`)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`[data-name="${spatial}"]`).getByText("· riders")).toBeVisible();
    await search.fill("");
  });

  await test.step("activating a spatial table previews rows and a map; the editor stays untouched", async () => {
    const row = page.locator(`[data-name="${spatial}"]`);
    // The row's height does not change when its actions are revealed.
    const idle = (await row.boundingBox())!.height;
    await row.hover();
    await expect(row.getByRole("button", { name: "Open as SQL", exact: true })).toBeVisible();
    expect((await row.boundingBox())!.height).toBe(idle);
    // The action names itself in the application's hint (the name
    // without the table — the row is the table's name).
    await row.getByRole("button", { name: "Open as SQL", exact: true }).hover();
    await expect(page.locator("[data-hint-bubble]").getByText("Open as SQL", { exact: true })).toBeVisible({ timeout: 3_000 });
    await row.getByRole("button", { name: "Insert at the cursor", exact: true }).hover();
    await expect(page.locator("[data-hint-bubble]").getByText("Insert at the cursor", { exact: true })).toBeVisible({ timeout: 3_000 });
    await row.click();
    await expect(page.getByText("Preview", { exact: true })).toBeVisible();
    // The preview reads as one: the mode attribute, the filled mark (the
    // accent the Run button is painted in) and a tinted bar — measured,
    // and measured absent again once a result is shown (below).
    const results = page.getByRole("region", { name: "Results" });
    await expect(results).toHaveAttribute("data-mode", "preview");
    const paint = (el: Element) => getComputedStyle(el).backgroundColor;
    const accent = await page.getByRole("button", { name: "Run query" }).evaluate(paint);
    const mark = page.getByText("Preview", { exact: true });
    expect(await mark.evaluate(paint)).toBe(accent);
    const bar = results.locator("[data-mode='preview']").first();
    const previewBarPaint = await bar.evaluate(paint);
    expect(previewBarPaint).not.toBe("rgba(0, 0, 0, 0)");
    previewPaint.bar = previewBarPaint;
    // No column list unfolds: the columns are read in the preview — the pane
    // never shows a column name, the results grid does.
    await expect(page.getByRole("columnheader", { name: /riders/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("complementary", { name: "Sources and history" }).getByText("riders")).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "Hauptbahnhof" })).toBeVisible({ timeout: 15_000 });
    expect(await editorText(page)).toBe("");
    await expect(page.getByRole("tab", { name: "Map", exact: true })).toBeEnabled();
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    await expect(page.getByText(/features/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Table", exact: true }).click();
    // A second activation keeps the selection and the preview.
    await row.click();
    await expect(row).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Preview", { exact: true })).toBeVisible();
  });

  await test.step("a non-spatial table previews rows and says why Map is unavailable", async () => {
    await page.locator(`[data-name="${plain}"]`).click();
    await expect(page.getByRole("cell", { name: "a", exact: true })).toBeVisible({ timeout: 15_000 });
    const mapTab = page.getByRole("tab", { name: "Map", exact: true });
    await expect(mapTab).toBeDisabled();
    await expect(mapTab).toHaveAttribute("title", /no geometry/i);
    // The preview keeps no keeping actions.
    await expect(page.getByRole("button", { name: "Add to a map" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Open in Data/ })).toHaveCount(0);
    await expect(page.getByText("This table has no geometry column, so there is no map.")).toBeVisible();
  });

  await test.step("Open as SQL replaces and runs; undo brings the draft back; insert places the name", async () => {
    const row = page.locator(`[data-name="${spatial}"]`);
    await row.hover();
    await row.getByRole("button", { name: "Open as SQL", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText(`FROM ${spatial}`);
    await expect(page.getByText(/^\d+ rows|rows$/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("edited")).toHaveCount(0);
    // A result carries none of the preview treatment.
    const results = page.getByRole("region", { name: "Results" });
    await expect(results).not.toHaveAttribute("data-mode", /.+/);
    await expect(page.getByText("Preview", { exact: true })).toHaveCount(0);
    const resultBar = results.locator("div").first();
    const resultBarPaint = await resultBar.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(resultBarPaint).not.toBe(previewPaint.bar);
    // A second Open as SQL replaces the untouched seed.
    await page.locator(`[data-name="${plain}"]`).hover();
    await page.locator(`[data-name="${plain}"]`).getByRole("button", { name: "Open as SQL", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText(`FROM ${plain}`);
    expect(await editorText(page)).not.toContain(`FROM ${spatial}`);
    // Edit the draft; Open as SQL replaces it too — the editor holds
    // exactly the statement that ran — and undo restores the draft.
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" -- mine");
    await expect(page.getByText("edited")).toBeVisible();
    await page.locator(`[data-name="${spatial}"]`).hover();
    await page.locator(`[data-name="${spatial}"]`).getByRole("button", { name: "Open as SQL", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText(`FROM ${spatial}`);
    await expect(page.getByText(/^\d+ rows|rows$/).first()).toBeVisible({ timeout: 20_000 });
    let text = await editorText(page);
    expect(text).not.toContain("-- mine");
    expect(text.replace(/\s+/g, " ").trim()).toBe(`SELECT * FROM ${spatial} LIMIT 100;`);
    await expect(page.getByText("Added below your draft", { exact: false })).toHaveCount(0);
    await expect(page.getByText("edited")).toHaveCount(0);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+z");
    text = await editorText(page);
    expect(text).toContain("-- mine");
    // The insert action places the table's identifier at the cursor.
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("SELECT * FROM ");
    await page.locator(`[data-name="${plain}"]`).hover();
    await page.locator(`[data-name="${plain}"]`).getByRole("button", { name: "Insert at the cursor", exact: true }).click();
    expect(await editorText(page)).toContain(`SELECT * FROM "${plain}"`);
  });

  await test.step("completion offers tables after FROM, columns of a referenced table, and alias columns", async () => {
    await typeSql(page, "");
    await page.locator(".cm-content").click();
    await page.keyboard.type("SELECT * FROM cons");
    await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".cm-tooltip-autocomplete li").filter({ hasText: spatial })).toBeVisible();
    await page.keyboard.press("Escape");
    await typeSql(page, `SELECT ri FROM ${spatial}`);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+Space");
    await expect(page.locator(".cm-tooltip-autocomplete li").filter({ hasText: "riders" })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await typeSql(page, `SELECT s. FROM ${spatial} s`);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+Home");
    for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+Space");
    await expect(page.locator(".cm-tooltip-autocomplete li").filter({ hasText: "riders" })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
  });

  await test.step("run, run-selection, the edited mark, cancel of a held query, then a healthy run", async () => {
    await typeSql(page, `SELECT name, riders FROM ${spatial} ORDER BY riders DESC`);
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByRole("cell", { name: "Hauptbahnhof" })).toBeVisible({ timeout: 20_000 });
    // A selection runs alone and the button says so.
    await typeSql(page, `SELECT 1 AS one\n\nSELECT 2 AS two`);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Shift+Home");
    await expect(page.getByRole("button", { name: "Run selection" })).toBeVisible();
    await page.getByRole("button", { name: "Run selection" }).click();
    await expect(page.getByText("Ran the selection only.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("columnheader", { name: /two/ })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /one/ })).toHaveCount(0);
    // Hold a query, cancel it, and the next one answers normally.
    await typeSql(page, "SELECT count(*) FROM range(3000000000) WHERE range % 7 = 3");
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Cancelled.")).toBeVisible();
    await typeSql(page, "SELECT 42 AS answer");
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByRole("cell", { name: "42" })).toBeVisible({ timeout: 20_000 });
  });

  await test.step("a failing query shows its code, marks the token and line, and the mark clears on edit", async () => {
    await typeSql(page, `SELECT *\nFROM nope_table_${runId}`);
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByText("sql_error")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".cm-sqlError")).toHaveText(`nope_table_${runId}`);
    await expect(page.locator(".cm-sqlErrorGutter")).toHaveText("2");
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    await expect(page.locator(".cm-sqlError")).toHaveCount(0);
    await consumeExpected(consoleErrors, /\/api\/query/);
    // A parser error marks the position too.
    await typeSql(page, `SELECT name FROMM ${spatial}`);
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByText("sql_error")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".cm-sqlError")).toHaveText(spatial);
    await consumeExpected(consoleErrors, /\/api\/query/);
    // A selected fragment's error marks the token where it sits in the
    // document, not near the top.
    await typeSql(page, `SELECT 1 AS fine\n\nSELECT *\nFROM nope_sel_${runId}`);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Shift+Home");
    await expect(page.getByRole("button", { name: "Run selection" })).toBeVisible();
    await page.getByRole("button", { name: "Run selection" }).click();
    await expect(page.getByText("sql_error")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".cm-sqlError")).toHaveText(`nope_sel_${runId}`);
    await expect(page.locator(".cm-sqlErrorGutter")).toHaveText("4");
    await consumeExpected(consoleErrors, /\/api\/query/);
  });

  await test.step("results — meta, the map, the footer when cut, the cell peek with copy", async () => {
    await typeSql(page, `SELECT * FROM ${spatial}`);
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByRole("region", { name: "Results", exact: true }).getByText(/^[\d,]+ rows$/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    await expect(page.getByText(/features/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("geometry", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Table", exact: true }).click();
    await page.getByRole("cell", { name: "Hauptbahnhof" }).click();
    await expect(page.getByRole("dialog", { name: "Cell value" })).toContainText("Hauptbahnhof");
    await expect(page.getByRole("button", { name: /Copy/ })).toBeVisible();
    await page.keyboard.press("Escape");
    // A cut result says so in the footer.
    await typeSql(page, "SELECT range AS n FROM range(1500)");
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByText(/Showing the first 1,000 of 1,500 rows/)).toBeVisible({ timeout: 20_000 });
  });

  await test.step("save as dataset with the stored identifier shown; the table lands in the browser", async () => {
    await typeSql(page, `SELECT name, riders, geometry FROM ${spatial} WHERE riders > 1000`);
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByRole("cell", { name: "Hauptbahnhof" })).toBeVisible({ timeout: 20_000 });
    // The actions stay put while the save panel is open.
    const saveBtn = page.getByRole("button", { name: "Save as dataset" });
    const dlBefore = (await page.getByRole("button", { name: /Download/ }).boundingBox())!;
    await saveBtn.click();
    const panel = page.getByRole("group", { name: "Save as dataset" });
    await expect(panel).toBeVisible();
    const dlAfter = (await page.getByRole("button", { name: /Download/ }).boundingBox())!;
    expect(dlAfter.x).toBe(dlBefore.x);
    expect(dlAfter.y).toBe(dlBefore.y);
    // Escape closes it; reopening keeps the flow.
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await saveBtn.click();
    const nameField = page.getByLabel("Name for the new dataset");
    await nameField.fill(`Busy Stations ${runId}`);
    await expect(page.getByText(`stored as`)).toBeVisible();
    await expect(page.getByText(`busy_stations_${runId}`)).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Saved as/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("group", { name: "Save as dataset" })).toHaveCount(0);
    // …and it lands under the outputs group, the builder's own rule.
    await expect(
      page.locator(`[data-table-group="outputs"] [data-name="busy_stations_${runId}"]`),
    ).toBeVisible({ timeout: 30_000 });
  });

  await test.step("download carries every row of the executed SQL, in each format, after the draft diverged", async () => {
    // GeoJSON of the spatial result on screen: every feature, parsed.
    await page.getByRole("button", { name: /Download/ }).click();
    const menu = page.getByRole("menu", { name: "Download format" });
    await expect(menu.getByRole("menuitem", { name: /GeoJSON/ })).toBeEnabled();
    const geo = page.waitForEvent("download", { timeout: 30_000 });
    await menu.getByRole("menuitem", { name: /GeoJSON/ }).click();
    const geoFile = await geo;
    expect(geoFile.suggestedFilename()).toMatch(/\.geojson$/);
    const geoText = await readFile((await geoFile.path())!, "utf8");
    const parsed = JSON.parse(geoText) as { features: { properties: { name: string } }[] };
    expect(parsed.features.map((f) => f.properties.name)).toContain("Hauptbahnhof");
    // A result larger than the preview cap, then the draft is changed: the
    // CSV carries all 1,500 rows of the executed SQL, not the 1,000 shown
    // and not the new draft.
    await typeSql(page, "SELECT range AS n FROM range(1500)");
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByText(/first 1,000 of 1,500 rows/)).toBeVisible({ timeout: 20_000 });
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" -- changed after the run");
    await page.getByRole("button", { name: /Download/ }).click();
    const csv = page.waitForEvent("download", { timeout: 30_000 });
    await page.getByRole("menu", { name: "Download format" }).getByRole("menuitem", { name: /CSV/ }).click();
    const csvFile = await csv;
    expect(csvFile.suggestedFilename()).toMatch(/\.csv$/);
    const csvText = await readFile((await csvFile.path())!, "utf8");
    const lines = csvText.trim().split("\n");
    expect(lines[0]).toBe("n");
    expect(lines).toHaveLength(1501);
    // GeoParquet: a real parquet file (magic bytes at both ends).
    await page.getByRole("button", { name: /Download/ }).click();
    const pq = page.waitForEvent("download", { timeout: 30_000 });
    await page.getByRole("menu", { name: "Download format" }).getByRole("menuitem", { name: /GeoParquet/ }).click();
    const pqFile = await pq;
    const bytes = await readFile((await pqFile.path())!);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("PAR1");
    expect(bytes.subarray(bytes.length - 4).toString("latin1")).toBe("PAR1");
    // A non-spatial result cannot be GeoJSON, and the menu says so.
    await typeSql(page, `SELECT category FROM ${plain}`);
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByRole("cell", { name: "a", exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /Download/ }).click();
    await expect(page.getByRole("menu", { name: "Download format" }).getByRole("menuitem", { name: /GeoJSON/ })).toBeDisabled();
    await page.keyboard.press("Escape");
  });

  await test.step("history lists runs as cards, collapses repeats, runs again, removes", async () => {
    await page.getByRole("tab", { name: "History" }).click();
    const cards = page.locator("[data-history-card]");
    await expect(cards.first()).toBeVisible();
    const before = await cards.count();
    await expect(page.getByText("Today")).toBeVisible();
    // Run again from a card loads + runs.
    const first = cards.first();
    await first.hover();
    await first.getByRole("button", { name: "Run again" }).click();
    await expect(page.getByRole("region", { name: "Results", exact: true }).getByText(/^[\d,]+ rows$/)).toBeVisible({ timeout: 20_000 });
    // The repeated run collapsed into its card: no new card.
    await page.getByRole("tab", { name: "History" }).click();
    expect(await cards.count()).toBe(before);
    // Remove one.
    await cards.first().hover();
    await cards.first().getByRole("button", { name: "Remove from history" }).click();
    expect(await cards.count()).toBe(before - 1);
    await page.getByRole("tab", { name: "Sources" }).click();
  });

  await test.step("the draft survives a reload and says so; Clear forgets it", async () => {
    await typeSql(page, `SELECT 7 AS remembered_${runId}`);
    await page.waitForTimeout(600);
    await page.reload();
    await expect(page.locator(".cm-content")).toContainText(`remembered_${runId}`, { timeout: 15_000 });
    await expect(page.getByText("Restored your last draft.")).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).first().click();
    await expect(page.getByText("Restored your last draft.")).toHaveCount(0);
  });

  await test.step("the Data Explorer door selects and runs the table; it replaces a remembered draft", async () => {
    await typeSql(page, `SELECT 'keep me' AS mine_${runId}`);
    await page.waitForTimeout(600);
    await page.goto(`/sql?table=${spatial}`);
    await expect(page.getByText(`Opened from Data: ${spatial}.`, { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("cell", { name: "Hauptbahnhof" })).toBeVisible({ timeout: 20_000 });
    const text = await editorText(page);
    expect(text).not.toContain(`mine_${runId}`);
    expect(text.replace(/\s+/g, " ").trim()).toBe(`SELECT * FROM ${spatial} LIMIT 100;`);
    await expect(page.locator(`[data-name="${spatial}"]`)).toHaveAttribute("aria-pressed", "true");
    // Undo brings the remembered draft back even on a cold navigation,
    // where the editor may mount after the door fired.
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+z");
    expect(await editorText(page)).toContain(`mine_${runId}`);
  });

  await test.step("the pane and the editor split drag and survive a reload", async () => {
    const pane = page.getByRole("complementary", { name: "Sources and history" });
    const before = (await pane.boundingBox())!.width;
    const handle = page.getByRole("separator", { name: "Resize the tables pane" });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    const after = (await pane.boundingBox())!.width;
    expect(after).toBeGreaterThan(before + 40);
    await page.reload();
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    expect(Math.abs((await pane.boundingBox())!.width - after)).toBeLessThan(4);
    // The editor divider: an independent drag-and-reload.
    const editor = page.getByRole("region", { name: "Editor" });
    const hBefore = (await editor.boundingBox())!.height;
    const hHandle = page.getByRole("separator", { name: "Resize the editor" });
    const hb = (await hHandle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 60, { steps: 4 });
    await page.mouse.up();
    const hAfter = (await editor.boundingBox())!.height;
    expect(hAfter).toBeGreaterThan(hBefore + 30);
    await page.reload();
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    expect(Math.abs((await editor.boundingBox())!.height - hAfter)).toBeLessThan(4);
  });

  await test.step("the save panel stays whole at the results area's minimum height", async () => {
    // Drag the editor divider as far down as it goes: the results card is
    // at its minimum, and a panel positioned inside it would be clipped.
    const hHandle = page.getByRole("separator", { name: "Resize the editor" });
    const hb = (await hHandle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 900, { steps: 6 });
    await page.mouse.up();
    await typeSql(page, `SELECT name, riders FROM ${spatial} WHERE riders > 1000`);
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByRole("button", { name: "Save as dataset" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Save as dataset" }).click();
    const panel = page.getByRole("group", { name: "Save as dataset" });
    await expect(panel).toBeVisible();
    await page.getByLabel("Name for the new dataset").fill("Whole Panel");
    await expect(page.getByText("stored as")).toBeVisible();
    const save = panel.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeVisible();
    const box = (await save.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    // And it is really hittable where it is drawn, not under something.
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest("button")?.textContent ?? null;
    }, [box.x + box.width / 2, box.y + box.height / 2] as const);
    expect(hit).toBe("Save");
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
