// The assistant on /sql (of for the layout, for the proposal): the door
// first in the header's left group, the work area giving up the pane's
// width when it docks, the sidebar's bound under the docked pane, the
// editor bar's and results bar's actions reachable at the breakpoint, the
// captured context in six states, proposals and Insert on both of D1's
// branches with undo, no run and no History card from Insert, the
// assistant's own query in the record and not in History, the cross-page
// proposal (D8), the chips, and the dismissal contract. Every geometry is
// read from rectangles; every context from the request the page sent.
//
// Environment: the documented gate (isolated server, fresh data dir, the
// scripted provider on 3202). Run with DEZFIL_BASE_URL at the server.
import { test, expect, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { addLayer, createMap, routeHouse, seedCsv, trackConsole } from "./support";

const runId = Date.now().toString(36);
const H = 900;
const HELPER = 354;
const GUTTER = 14;
const PANE_KEY = "dezfil:sql:pane-width";
const PANE = "[data-assistant-pane]";

const provider = assistantProviderFixture();
test.beforeAll(async () => { await provider.start(); });
test.afterAll(async () => { await provider.stop(); });
test.beforeEach(async ({ context }) => { provider.reset(); await routeHouse(context, { basemapStyleStub: true }); });

const door = (page: Page) => page.locator("header").getByRole("button", { name: /^(Open|Close) assistant$/ });
const pane = (page: Page) => page.locator(PANE);
const paneOpen = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "true");
const paneClosed = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "false");
const sidebar = (page: Page) => page.locator('aside[aria-label="Sources and history"]');
const divider = (page: Page) => page.getByRole("separator", { name: "Resize the tables pane" });
const work = (page: Page) => page.locator('section[aria-label="Editor"]').locator("..");
const editorCard = (page: Page) => page.locator('section[aria-label="Editor"]');
const proposals = (page: Page) => pane(page).locator("[data-proposal]");
const insertButtons = (page: Page) => pane(page).getByRole("button", { name: "Insert into editor", exact: true });
const historyCards = (page: Page) => page.locator("[data-history-card]");

async function box(page: Page, locator: ReturnType<Page["locator"]>) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}
const right = (b: { x: number; width: number }) => b.x + b.width;

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
async function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}
async function runQuery(page: Page) {
  const done = page.waitForResponse((r) => r.url().endsWith("/api/query") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await done;
}
/** The next message the page sends: its request body. */
function nextMessage(page: Page) {
  return page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
}
async function send(page: Page, text: string) {
  const request = nextMessage(page);
  await pane(page).getByRole("textbox", { name: "Ask the assistant" }).fill(text);
  await pane(page).getByRole("button", { name: "Send", exact: true }).click();
  return (await request).postDataJSON() as { context?: Record<string, unknown> };
}
async function openSql(page: Page, width: number, table?: string) {
  await page.setViewportSize({ width, height: H });
  await page.goto("/sql");
  await expect(page.getByLabel("SQL editor")).toBeVisible();
  if (table) await expect(page.locator(`[data-name="${table}"]`)).toBeVisible({ timeout: 15_000 });
}
async function seedTable(page: Page) {
  await page.goto("/sql");
  const table = `asst_sql_${runId}_${Math.random().toString(36).slice(2, 6)}`;
  await seedCsv(page, table, "name,n,lon,lat\nalpha,1,13.4,52.5\nbeta,2,13.5,52.6\ngamma,3,13.6,52.7\n");
  return table;
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
async function ensureClosed(page: Page) {
  if ((await pane(page).getAttribute("data-open")) === "true") { await door(page).click(); await paneClosed(page); }
}

test.describe("2: the door on /sql", () => {
  test("2a-c: exactly one door, first in the header's left group, with the compact name", async ({ page }) => {
    const errors = trackConsole(page);
    await openSql(page, 1440);
    await expect(page.getByRole("button", { name: /^(Open|Close) assistant$/ })).toHaveCount(1);
    const names = await page.locator("#header-actions-left button, #header-actions-left a").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    expect(names[0]).toBe("Open assistant");
    await page.setViewportSize({ width: 1200, height: H });
    await expect(page.locator("#header-actions-left").getByRole("button", { name: "Open assistant", exact: true })).toHaveCount(1);
    expect(errors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
  });
});

test.describe("the work area, the split, the sidebar and the actions", () => {
  test("the work area's edge at 1440 and 1121, unmoved at 1100 and 1120; the split, the sidebar and its divider unmoved", async ({ page }) => {
    for (const [width, docks] of [[1440, true], [1121, true], [1120, false], [1100, false]] as const) {
      await openSql(page, width);
      await ensureClosed(page);
      const before = { work: await box(page, work(page)), editor: await box(page, editorCard(page)), side: await box(page, sidebar(page)), divider: await box(page, divider(page)) };
      expect(Math.round(right(before.work))).toBe(width - GUTTER);
      await door(page).click();
      await paneOpen(page);
      await expect(pane(page)).toHaveAttribute("data-overlay", docks ? "false" : "true");
      await page.waitForTimeout(150);
      const after = { work: await box(page, work(page)), editor: await box(page, editorCard(page)), side: await box(page, sidebar(page)), divider: await box(page, divider(page)) };
      expect(Math.round(right(after.work)), `work area right edge at ${width}`).toBe(width - GUTTER - (docks ? HELPER : 0));
      // The sidebar's bound under a docked pane: half of what the pane
      // leaves. At 1121 that is 335, under the default 342, so the default
      // sidebar narrows by seven pixels there; elsewhere the sidebar and
      // its divider are unmoved.
      const bound = docks ? Math.floor((width - 82 - HELPER - GUTTER) / 2) : Infinity;
      const expectedSide = Math.min(Math.round(before.side.width), bound);
      expect(Math.round(after.side.width), `sidebar at ${width}`).toBe(expectedSide);
      expect(Math.round(after.divider.x)).toBe(Math.round(before.divider.x) - (Math.round(before.side.width) - expectedSide));
      expect(Math.round(after.work.x)).toBe(Math.round(before.work.x) - (Math.round(before.side.width) - expectedSide));
      expect(Math.round(after.editor.height), "the editor/results split stays").toBe(Math.round(before.editor.height));
      const p = await box(page, pane(page));
      expect(Math.round(right(p))).toBe(width - GUTTER);
      if (!docks) expect(p.x).toBeLessThan(right(after.work));
      await door(page).click();
      await paneClosed(page);
    }
  });

  test("at 1121 a sidebar at its maximum remembered width clamps to the bound the pane leaves, returns when the pane closes, and the stored preference reads unchanged", async ({ page }) => {
    await openSql(page, 1121);
    await ensureClosed(page);
    await page.evaluate((key) => localStorage.setItem(key, "560"), PANE_KEY);
    await page.reload();
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    expect(Math.round((await box(page, sidebar(page))).width)).toBe(560);
    await door(page).click();
    await paneOpen(page);
    await expect.poll(async () => Math.round((await box(page, sidebar(page))).width)).toBe(Math.floor((1121 - 82 - HELPER - GUTTER) / 2));
    expect(Math.round(right(await box(page, work(page))))).toBe(1121 - GUTTER - HELPER);
    expect(await page.evaluate((key) => localStorage.getItem(key), PANE_KEY)).toBe("560");
    await door(page).click();
    await paneClosed(page);
    await expect.poll(async () => Math.round((await box(page, sidebar(page))).width)).toBe(560);
    expect(await page.evaluate((key) => localStorage.getItem(key), PANE_KEY)).toBe("560");
  });

  /** The editor bar's and results bar's actions at the breakpoint. At
   * 1121 the pane docks and the work area gives up its width: the actions
   * are read with the pane open. At 1120 the pane overlays the work area's
   * right end and covers what lies under it while open, so the actions
   * are read with the pane closed, where the work area is unmoved; the
   * cover is the overlay's own contract. */
  const ACTIONS = ["Run query", "Clear", "Add as map layer", "Download", "Save as dataset"] as const;
  async function actionsAt(page: Page, table: string, width: 1120 | 1121, remembered: string | null) {
    await openSql(page, width, table);
    await ensureClosed(page);
    await page.evaluate(({ key, value }) => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }, { key: PANE_KEY, value: remembered });
    await page.reload();
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    if (width === 1121) { await door(page).click(); await paneOpen(page); }
    // The whole table, geometry included, so every results action is offered.
    await typeSql(page, `SELECT * FROM ${table}`);
    await runQuery(page);
    await expect(page.getByRole("button", { name: "Add as map layer" })).toBeVisible();
    const reach: Record<string, boolean> = {};
    for (const name of ACTIONS) {
      const action = page.getByRole("button", { name, exact: true }).last();
      const b = await box(page, action);
      expect(b.x, `${name} starts inside the viewport at ${width}/${remembered}`).toBeGreaterThanOrEqual(0);
      expect(right(b), `${name} ends inside the viewport at ${width}/${remembered}`).toBeLessThanOrEqual(width);
      await expect(action).toBeEnabled();
      // Activatable: a pointer at its centre lands on it, not on the pane.
      reach[name] = await action.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at === el || el.contains(at);
      });
    }
    return reach;
  }
  const SIDEBARS = (width: number) => ["260", null, String(Math.floor(width / 2))];

  test("at 1120 and 1121 with the sidebar at its minimum, default and maximum remembered widths, Run, Clear, Add as map layer and Download are within the viewport and activatable; every action is at the minimum", async ({ page }) => {
    const table = await seedTable(page);
    for (const width of [1120, 1121] as const) {
      for (const remembered of SIDEBARS(width)) {
        const reach = await actionsAt(page, table, width, remembered);
        for (const name of ["Run query", "Clear", "Add as map layer", "Download"]) expect(reach[name], `a pointer reaches ${name} at ${width}/${remembered}`).toBe(true);
        if (width === 1120 || remembered === "260") expect(reach["Save as dataset"], `a pointer reaches Save as dataset at ${width}/${remembered}`).toBe(true);
        // Pressed: Download opens its menu, Run runs again, Clear clears.
        await page.getByRole("button", { name: "Download", exact: true }).click();
        await expect(page.getByRole("menu")).toBeVisible();
        await page.keyboard.press("Escape");
        await runQuery(page);
        await page.getByRole("button", { name: "Clear", exact: true }).last().click();
        expect(await editorText(page)).toBe("");
      }
    }
  });

  // Save as dataset at 1121 with the default and maximum sidebar widths:
  // the reachability clause there was waived in the field; the expected
  // failure that held it is retired.
});

test.describe("the captured context and the chips", () => {
  test("the message carries the exact draft, selection and execution in six states, and the chips agree with the page", async ({ page }) => {
    const table = await seedTable(page);
    await openSql(page, 1440, table);
    await ensureOpen(page);
    const chips = () => pane(page).locator("[data-talking-about] [data-chip]");
    // Before any run: no execution; the draft chip alone.
    provider.replies.push({ text: "One." });
    let body = await send(page, "Explain");
    expect(body.context).toEqual({ page: "sql", draft: "", selection: null, lastExecution: null });
    await expect(chips()).toHaveCount(1);
    await expect(chips().first()).toHaveText(/Draft.*empty/);
    // A preview before any run leaves none.
    await page.locator(`[data-name="${table}"]`).click();
    await expect(page.getByRole("tablist", { name: "Result view" })).toBeVisible();
    provider.replies.push({ text: "Two." });
    body = await send(page, "Explain");
    expect((body.context as { lastExecution: unknown }).lastExecution).toBeNull();
    await expect(chips()).toHaveCount(1);
    // A typed draft, a selection and a run.
    const sql = `SELECT name, n FROM ${table} ORDER BY n`;
    await typeSql(page, sql);
    await runQuery(page);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+a");
    provider.replies.push({ text: "Three." });
    body = await send(page, "Explain");
    expect(body.context).toMatchObject({ page: "sql", draft: sql, selection: sql, lastExecution: { sql, result: { totalRows: 3, returnedRows: 3, truncated: false, columns: [{ name: "name" }, { name: "n" }] } } });
    const summary = (body.context as { lastExecution: { result: { elapsedMs: number } } }).lastExecution.result;
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
    await expect(chips()).toHaveCount(2);
    await expect(chips().nth(1)).toHaveText(/Last result3 rows · \d+\.\d s/);
    // The chip's rows equal the page's own count in the results bar.
    await expect(page.locator('section[aria-label="Results"]')).toContainText("3");
    // A preview and a draft edit after a success leave the pair intact.
    await page.locator(`[data-name="${table}"]`).click();
    await typeSql(page, sql + " DESC");
    provider.replies.push({ text: "Four." });
    body = await send(page, "Explain");
    expect(body.context).toMatchObject({ draft: sql + " DESC", lastExecution: { sql } });
    await expect(chips().nth(1)).toHaveText(/3 rows/);
    // A failed query: that SQL with its coded error; the chip in the failure tone.
    await typeSql(page, "SELECT absent FROM nowhere");
    await runQuery(page);
    provider.replies.push({ text: "Five." });
    body = await send(page, "Explain");
    expect(body.context).toMatchObject({ lastExecution: { sql: "SELECT absent FROM nowhere", error: { code: expect.any(String) } } });
    const error = (body.context as { lastExecution: { error: { code: string; message: string } } }).lastExecution.error;
    expect(error.code.length).toBeGreaterThan(0);
    await expect(chips().nth(1)).toHaveAttribute("data-tone", "bad");
    await expect(chips().nth(1)).toContainText("Error:");
    // A preview and an edit after an error leave the pair intact.
    await page.locator(`[data-name="${table}"]`).click();
    await typeSql(page, "SELECT 1");
    provider.replies.push({ text: "Six." });
    body = await send(page, "Explain");
    expect(body.context).toMatchObject({ draft: "SELECT 1", lastExecution: { sql: "SELECT absent FROM nowhere", error: { code: error.code, message: error.message } } });
    await expect(chips().nth(1)).toHaveAttribute("data-tone", "bad");
  });

  test("6b bis: a query whose transport fails leaves the next message carrying that SQL with the coded error, never the earlier success", async ({ page }) => {
    // the fetch failure showed the internal
    // error in the results pane but left the snapshot at the earlier
    // success, so the assistant heard a stale pair.
    const table = await seedTable(page);
    await openSql(page, 1440, table);
    await ensureOpen(page);
    const good = `SELECT name FROM ${table}`;
    await typeSql(page, good);
    await runQuery(page);
    await page.route("**/api/query", (route) => route.abort("failed"));
    const bad = `SELECT n FROM ${table}`;
    await typeSql(page, bad);
    await page.getByRole("button", { name: "Run query", exact: true }).click();
    await expect(page.locator('section[aria-label="Results"]')).toContainText("Could not reach the server.");
    await page.unroute("**/api/query");
    provider.replies.push({ text: "Noted." });
    const body = await send(page, "What happened?");
    expect(body.context).toMatchObject({ draft: bad, lastExecution: { sql: bad, error: { code: "internal", message: "Could not reach the server." } } });
    await expect(pane(page).locator("[data-talking-about] [data-chip='execution']")).toHaveAttribute("data-tone", "bad");
  });

  test("the edited mark on the chip exactly when the page shows it; no chip is focusable or activatable", async ({ page }) => {
    const table = await seedTable(page);
    await openSql(page, 1440, table);
    await ensureOpen(page);
    const chip = pane(page).locator("[data-talking-about] [data-chip='draft']");
    const mark = page.locator('section[aria-label="Editor"]').getByText("edited", { exact: true });
    // Open as SQL seeds the draft: not edited, as the page says.
    const row = page.locator(`[data-name="${table}"]`);
    await row.hover();
    await row.getByRole("button", { name: "Open as SQL", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText("LIMIT 100");
    await expect(mark).toHaveCount(0);
    await expect(chip).not.toContainText("edited");
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" -- more");
    await expect(mark).toHaveCount(1);
    await expect(chip).toContainText("edited");
    // Not a control: not in the tab order, and a click changes nothing.
    expect(await chip.evaluate((el) => (el as HTMLElement).tabIndex)).toBeLessThan(0);
    expect(await chip.evaluate((el) => el.closest("button, a, [role='button']") !== null)).toBe(false);
    const before = await chip.textContent();
    await chip.click();
    expect(await chip.textContent()).toBe(before);
    await expect(page.locator(".cm-content")).toContainText("-- more");
  });
});

test.describe("6c to 6g: proposals and Insert", () => {
  test("zero, one and two completed blocks; comments and semicolons stay one block; a streaming block shows no action until it completes", async ({ page }) => {
    const table = await seedTable(page);
    await openSql(page, 1440, table);
    await ensureOpen(page);
    provider.replies.push({ text: "No code here." });
    await send(page, "Talk");
    await expect(pane(page).getByText("No code here.", { exact: true })).toBeVisible();
    await expect(proposals(page)).toHaveCount(0);
    provider.replies.push({ text: "One:\n```sql\nSELECT 1;\n```" });
    await send(page, "One");
    await expect(proposals(page)).toHaveCount(1);
    const exact = "-- keep; this\nSELECT ';' AS s,\n       count(*) AS n\nFROM " + table + ";";
    provider.replies.push({ text: "Two:\n```sql\n" + exact + "\n```\nand\n```SQL\nSELECT 2;\n```" });
    await send(page, "Two");
    await expect(proposals(page)).toHaveCount(3);
    await expect(proposals(page).nth(1).locator("pre")).toHaveText(exact);
    await expect(insertButtons(page)).toHaveCount(3);
    // A held completion: the block arrives, its fence closed in the same
    // delta, but the reply is still streaming, so no action yet; the
    // action appears once the reply completes.
    provider.replies.push({ text: "Held:\n```sql\nSELECT 3;\n```", holdMs: 2500 });
    const request = nextMessage(page);
    await pane(page).getByRole("textbox", { name: "Ask the assistant" }).fill("Held");
    await pane(page).getByRole("button", { name: "Send", exact: true }).click();
    await request;
    await expect(pane(page).getByText("SELECT 3;", { exact: true })).toBeVisible();
    expect(await proposals(page).count(), "no action while the reply streams").toBe(3);
    await expect(proposals(page)).toHaveCount(4, { timeout: 10_000 });
  });

  test("Insert into an unchanged draft replaces it, undo restores it, and nothing runs or enters History", async ({ page }) => {
    const table = await seedTable(page);
    await openSql(page, 1440, table);
    await ensureOpen(page);
    const original = `SELECT name FROM ${table}`;
    await typeSql(page, original);
    await runQuery(page);
    await page.getByRole("tab", { name: "History" }).click();
    await expect(historyCards(page)).toHaveCount(1);
    const resultsBefore = await page.locator('section[aria-label="Results"]').textContent();
    const proposal = `SELECT n FROM ${table} WHERE n > 1`;
    provider.replies.push({ text: "Try:\n```sql\n" + proposal + "\n```" });
    await send(page, "Propose");
    await expect(insertButtons(page)).toHaveCount(1);
    const queries: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/query")) queries.push(r.url()); });
    await insertButtons(page).click();
    expect(await editorText(page)).toBe(proposal);
    await expect(pane(page).getByRole("button", { name: "In the editor", exact: true })).toHaveCount(1);
    await expect(pane(page).getByText("Your draft changed since this was proposed", { exact: false })).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(queries).toEqual([]);
    await expect(historyCards(page)).toHaveCount(1);
    expect(await page.locator('section[aria-label="Results"]').textContent()).toBe(resultsBefore);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+z");
    expect(await editorText(page)).toBe(original);
  });

  test("after a manual edit, Open as SQL and a History load since the request, Insert preserves the draft, appends selected, notes, and undo restores", async ({ page }) => {
    const table = await seedTable(page);
    await openSql(page, 1440, table);
    await ensureOpen(page);
    const proposal = `SELECT n FROM ${table} WHERE n > 1`;
    const note = "Your draft changed since this was proposed, so it was added below it.";
    const cases: { name: string; change: () => Promise<string> }[] = [
      { name: "manual edit", change: async () => { await page.locator(".cm-content").click(); await page.keyboard.press("End"); await page.keyboard.type(" -- edited"); return editorText(page); } },
      { name: "Open as SQL", change: async () => { const row = page.locator(`[data-name="${table}"]`); await row.hover(); await row.getByRole("button", { name: "Open as SQL", exact: true }).click(); await expect(page.locator(".cm-content")).toContainText("LIMIT 100"); return editorText(page); } },
      { name: "History load", change: async () => { await page.getByRole("tab", { name: "History" }).click(); await historyCards(page).first().click(); await page.getByRole("tab", { name: "Sources" }).click(); return editorText(page); } },
    ];
    // A run so History has a card to load.
    await typeSql(page, `SELECT name FROM ${table} ORDER BY name`);
    await runQuery(page);
    for (const [i, c] of cases.entries()) {
      await typeSql(page, `SELECT ${i} AS request`);
      provider.replies.push({ text: `${c.name}:\n\`\`\`sql\n${proposal}\n\`\`\`` });
      await send(page, c.name);
      await expect(insertButtons(page)).toHaveCount(1);
      const changed = await c.change();
      expect(changed).not.toBe(`SELECT ${i} AS request`);
      await insertButtons(page).click();
      const after = await editorText(page);
      expect(after.startsWith(changed), `${c.name}: the current draft is preserved`).toBe(true);
      expect(after.endsWith(proposal)).toBe(true);
      expect(after).toBe(changed + (changed.endsWith("\n") ? "\n" : "\n\n") + proposal);
      expect(await selectedText(page), `${c.name}: the appended proposal is selected`).toBe(proposal);
      // Every appended insert keeps its note and its mark in the transcript.
      await expect(pane(page).getByText(note, { exact: true })).toHaveCount(i + 1);
      await expect(pane(page).getByRole("button", { name: "In the editor", exact: true })).toHaveCount(i + 1);
      await page.locator(".cm-content").click();
      await page.keyboard.press("ControlOrMeta+z");
      expect(await editorText(page), `${c.name}: undo restores the draft`).toBe(changed);
      // The next case starts clean: the block's mark stays in the transcript.
      await expect(pane(page).getByRole("button", { name: "In the editor", exact: true })).toHaveCount(i + 1);
    }
  });

  test("the assistant's own query appears in the action record and adds no History card", async ({ page }) => {
    const table = await seedTable(page);
    await openSql(page, 1440, table);
    await ensureOpen(page);
    await page.getByRole("tab", { name: "History" }).click();
    await expect(historyCards(page)).toHaveCount(0);
    // The reply after the query is held, so the turn's action record is
    // read while the turn is live (the record's card after the turn is
    // piece 3's).
    provider.replies.push({ calls: [{ name: "run_sql", args: { sql: `SELECT count(*) AS n FROM ${table}` } }] }, { text: "Three rows.", holdMs: 4000 });
    const request = nextMessage(page);
    await pane(page).getByRole("textbox", { name: "Ask the assistant" }).fill("How many rows?");
    await pane(page).getByRole("button", { name: "Send", exact: true }).click();
    await request;
    // Since the record's line carries the recorded words and the SQL sits
    // in its inspection (page 02 section 2 A).
    const record = pane(page).locator("[data-record-entry][data-tool='run_sql']");
    await expect(record).toHaveCount(1);
    await expect(record).toHaveAttribute("data-status", "succeeded");
    await record.getByRole("button").click();
    await expect(record.locator("[data-sql]")).toHaveText(`SELECT count(*) AS n FROM ${table}`);
    await expect(pane(page).getByText("Three rows.", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(historyCards(page)).toHaveCount(0);
    await expect(proposals(page)).toHaveCount(0);
  });

  test("a builder-context SQL block has no action on the builder or on /sql after navigation; a /sql proposal compares with its request's draft after leaving and returning, and after recovery", async ({ page }) => {
    const table = await seedTable(page);
    const mapId = await createMap(page, `sql-origin ${runId}`);
    await addLayer(page, mapId, table, `SELECT * FROM ${table}`);
    await page.setViewportSize({ width: 1440, height: H });
    await page.goto(`/maps/${mapId}`);
    await page.waitForSelector("[data-map-layer]");
    await ensureOpen(page);
    provider.replies.push({ text: "From the builder:\n```sql\nSELECT 'builder';\n```" });
    await send(page, "Show SQL");
    await expect(pane(page).getByText("SELECT 'builder';", { exact: true })).toBeVisible();
    await expect(proposals(page)).toHaveCount(0);
    await expect(insertButtons(page)).toHaveCount(0);
    // Same tab, client-side: the conversation comes along; the block stays
    // text. The pane opens closed on arrival, so the row opens it by its door.
    await page.getByRole("link", { name: "SQL", exact: true }).click();
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    await openPane(page);
    await expect(pane(page).getByText("SELECT 'builder';", { exact: true })).toBeVisible();
    await expect(insertButtons(page)).toHaveCount(0);
    // A /sql proposal, then away and back: Insert still compares with the
    // draft its request carried.
    const origin = `SELECT name FROM ${table}`;
    await typeSql(page, origin);
    const proposal = `SELECT n FROM ${table}`;
    provider.replies.push({ text: "From sql:\n```sql\n" + proposal + "\n```" });
    await send(page, "Propose");
    await expect(insertButtons(page)).toHaveCount(1);
    await page.getByRole("link", { name: "Maps", exact: true }).click();
    await expect(page).toHaveURL(/\/maps$/);
    await page.getByRole("link", { name: "SQL", exact: true }).click();
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    await openPane(page);
    await expect(insertButtons(page)).toHaveCount(1);
    expect(await editorText(page)).toBe(origin);
    await insertButtons(page).click();
    expect(await editorText(page), "an unchanged draft is replaced").toBe(proposal);
    await expect(pane(page).getByText("Your draft changed since this was proposed", { exact: false })).toHaveCount(0);
    // After an in-tab recovery: the response is dropped after the body,
    // the pane recovers the turn from the run's receipt, and the proposal
    // keeps its request's draft (D8): the draft has moved since, so it appends.
    await typeSql(page, origin + " ORDER BY name");
    provider.replies.push({ text: "Recovered:\n```sql\n" + proposal + " DESC\n```" });
    await page.route("**/api/assistant/messages", async (route) => {
      const response = await route.fetch(); await response.body(); await route.abort("connectionreset");
    });
    await pane(page).getByRole("textbox", { name: "Ask the assistant" }).fill("Propose again");
    await pane(page).getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane(page).getByText(proposal + " DESC", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.unroute("**/api/assistant/messages");
    await expect(insertButtons(page)).toHaveCount(1);
    await typeSql(page, origin + " ORDER BY n");
    await insertButtons(page).click();
    const after = await editorText(page);
    expect(after).toBe(origin + " ORDER BY n\n\n" + proposal + " DESC");
    await expect(pane(page).getByText("Your draft changed since this was proposed", { exact: false })).toHaveCount(1);
  });
});

test.describe("11: dismissal on /sql", () => {
  test("the close control, the door and Escape from inside close it with focus on the door; an editor click, chrome clicks and Escape from outside leave it open", async ({ page }) => {
    await openSql(page, 1440);
    await ensureOpen(page);
    await pane(page).locator('[aria-label="Close assistant"]').click();
    await paneClosed(page);
    await door(page).click();
    await paneOpen(page);
    await door(page).click();
    await paneClosed(page);
    await door(page).click();
    await paneOpen(page);
    await pane(page).getByRole("textbox", { name: "Ask the assistant" }).focus();
    await page.keyboard.press("Escape");
    await paneClosed(page);
    await expect(door(page)).toBeFocused();
    await door(page).click();
    await paneOpen(page);
    await page.locator(".cm-content").click();
    await paneOpen(page);
    const rail = await box(page, page.locator('nav[aria-label="Product navigation"]'));
    await page.mouse.click(rail.x + 27, rail.y + rail.height * 0.55);
    await paneOpen(page);
    await page.getByRole("tab", { name: "History" }).click();
    await paneOpen(page);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await paneOpen(page);
  });
});

test.describe("download doors on /sql", () => {
  test("a layer-download door whose preparation fails shows the coordinator's failure and its Retry in the pane", async ({ page }) => {
    const table = await seedTable(page);
    const mapId = await createMap(page, `sql-download ${runId}`);
    const layerId = await addLayer(page, mapId, table, `SELECT * FROM ${table}`);
    await openSql(page, 1440, table);
    await ensureOpen(page);
    // The export is read-only, so the /sql policy admits it; the pane gets its door.
    provider.replies.push({ calls: [{ name: "export_layer_data", args: { id: layerId, format: "csv" } }] }, { text: "Ready to download." });
    await send(page, "Export the layer");
    const door = pane(page).getByRole("button", { name: /Download the CSV/ });
    await expect(door).toBeVisible();
    // The preparation fails with a coded error.
    await page.route(`**/api/layers/${layerId}/export/csv?**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("__ui_prepare") !== "1") { await route.continue(); return; }
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { code: "sql_error", message: "seeded failure" } }) });
    });
    await door.click();
    const note = pane(page).locator(`[data-layer-download-failed="${layerId}:csv"]`);
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(note.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(door).toBeEnabled();
  });
});
