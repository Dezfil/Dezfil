import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
// Workflow folders on the Data page: each workflow with a current output
// is one folder among the tables, opening to its outputs. The fixtures
// are the API's own: two uploads, a workflow run twice over with a
// never-run node added after, a builder-origin tool, an empty workflow,
// a second workflow for the one-at-a-time rule, and two more for the
// identity rules. Serial: the later tests read what the first made and
// the deletion test spends it last.
import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAllowedConsoleError } from "./console-allowlist";
import { seedCsv, trackConsole } from "./support";

test.describe.configure({ mode: "serial" });

// The fixtures' names and ids travel to the later tests through a file:
// a worker restart after a failure (a missing baseline, say) would
// otherwise hand them a fresh, empty module.
const IDS_FILE = "test-results/data-folders-ids.json";
let runId = Date.now().toString(36);
const T = (tag: string) => `df_${runId}_${tag}`;
/** The captured workflow's name and its outputs' names are fixed, so the
 * pixel baselines hold from run to run; a rerun on a used data directory
 * clears them first. */
const FOLDER_NAME = "aaa folder";
const F = (tag: string) => `folder_${tag}`;
/** Every workflow's name is fixed too: a name in the UI face with a run
 * id in it would widen the list's first column by a pixel or two from
 * run to run and shift every column in the captures. */
const NAMES = { second: "zzz second", tool: "Tool", empty: "Empty one", ident: "Ident study", orphan: "Orphan study" };
let ids = { folder: "", second: "", tool: "", empty: "", ident: "", orphan: "", orphanStep: "" };
function saveIds() {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(IDS_FILE, JSON.stringify({ runId, ids }));
}
function loadIds() {
  if (ids.folder) return;
  const saved = JSON.parse(readFileSync(IDS_FILE, "utf8")) as { runId: string; ids: typeof ids };
  runId = saved.runId;
  ids = saved.ids;
}

type Json = Record<string, unknown>;

async function api(page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<Json> {
  return page.evaluate(
    async ({ method, path, body, basis }) => {
      const r = await fetch(path, {
        method,
        headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
      return text ? (JSON.parse(text) as Json) : {};
    },
    { method, path, body, basis },
  );
}

async function newRecipe(page: Page, name: string, origin?: "builder"): Promise<string> {
  const made = await api(page, "POST", "/api/recipes", origin ? { name, origin } : { name });
  return (made.recipe as { id: string }).id;
}

async function addSql(page: Page, id: string, sql: string, name: string): Promise<string> {
  const added = await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps`, body: { operation: "sql_step", parameters: { sql, name } } })).then(result => result.json);
  return (added.step as { id: string }).id;
}

/** Run everything and wait for the run to settle; then every step that
 * ran has an output. */
async function runAll(page: Page, id: string) {
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/runs` })).then(result => result.json);
  await expect
    .poll(
      async () => {
        const runs = (await api(page, "GET", `/api/recipes/${id}/runs`)).runs as { outcome: string | null }[];
        return runs.length > 0 && runs.every((r) => r.outcome !== null);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

const folderCard = (page: Page, id: string) => page.locator(`[data-folder-card="${id}"]`);
const activator = (page: Page, id: string) => folderCard(page, id).locator("[role='button']");
const pane = (page: Page, id: string) => page.locator(`[data-folder-pane="${id}"]`);
const folderRow = (page: Page, id: string) => page.locator(`[data-folder-row="${id}"]`);
const tableCard = (page: Page, name: string) => page.locator(`[data-table-card="${name}"]`);
const chip = (page: Page, label: string) => page.locator("[class*='filterChip']", { hasText: label });
const allChipCount = async (page: Page) => Number((await chip(page, "All").innerText()).replace(/\D/g, ""));
const box = async (loc: Locator) => (await loc.boundingBox())!;


/** The pane after the folder's row. A full-width grid item is always its
 * own row, so the pane's position is proved by its neighbour: the cell
 * just before the pane in document order sits on the folder's row and is
 * that row's last cell, with no room for another card to its right, and
 * the pane starts below that row. (The first cut compared every cell's
 * top and bottom with the pane's, which any full-width item satisfies
 * wherever it is placed.) */
async function expectPaneAtRowEnd(page: Page, id: string) {
  const g = await page.evaluate((id) => {
    const pane = document.querySelector(`[data-folder-pane="${id}"]`)!;
    const grid = pane.parentElement!;
    const cells = Array.from(grid.children).filter((el) => !el.matches("[data-folder-pane]"));
    const before = cells.filter((el) => el.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING);
    const prevCell = before[before.length - 1] as HTMLElement;
    const prev = prevCell.getBoundingClientRect();
    const folderCell = document.querySelector(`[data-folder-card="${id}"]`) as HTMLElement;
    const p = pane.getBoundingClientRect();
    // The rows compare layout positions: a card under the pointer lifts on
    // hover, and the folder was just clicked.
    return { prevTop: prevCell.offsetTop, prevRight: prev.right, prevBottom: prev.bottom, prevWidth: prev.width, folderTop: folderCell.offsetTop, gridRight: grid.getBoundingClientRect().right, paneTop: p.top };
  }, id);
  // On the folder's row…
  expect(Math.abs(g.prevTop - g.folderTop)).toBeLessThan(2);
  // …its last cell: no room for one more card to its right…
  expect(g.gridRight - g.prevRight).toBeLessThan(g.prevWidth);
  // …and the pane below that row.
  expect(g.paneTop).toBeGreaterThanOrEqual(g.prevBottom - 1);
}

/** The Data page in the grid view, whatever view the instance last kept
 * (the view preference persists). */
async function openData(page: Page) {
  await page.goto("/data");
  const grid = page.getByRole("button", { name: "Grid view" });
  await expect(grid).toBeVisible();
  await grid.click();
  await expect(grid).toHaveAttribute("data-on", "true");
}

/** The state words the Workflows list wears for a workflow. */
async function workflowsListState(page: Page, name: string): Promise<string> {
  await page.goto("/workflows");
  const card = page.locator("article", { hasText: name }).first();
  await expect(card).toBeVisible();
  return (await card.locator("[data-workflow-state]").innerText()).trim();
}

test("folders: the fold, the facts, opening, sorting, search, filters, identity", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await page.goto("/data");

  await test.step("fixtures by API", async () => {
    // A rerun on a used directory: the fixed-name fixtures go first.
    const recipes = (await api(page, "GET", "/api/recipes")).recipes as { id: string; name: string }[];
    const fixed = new Set([FOLDER_NAME, ...Object.values(NAMES)]);
    for (const r of recipes.filter((r) => fixed.has(r.name))) await readThenWriteBrowserSetup(page, `/api/recipes/${r.id}`, () => ({ method: "DELETE", path: `/api/recipes/${r.id}` })).then(result => result.json);
    const present = new Set(((await api(page, "GET", "/api/tables")) as unknown as { name: string }[]).map((t) => t.name));
    for (const name of [F("out_a"), F("out_b"), F("out_c"), F("base")].filter((n) => present.has(n))) {
      await api(page, "DELETE", `/api/tables/${name}`);
    }
    await seedCsv(page, F("base"), "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
    await seedCsv(page, T("plain"), "name,value\nonly,1\n");
    ids.folder = await newRecipe(page, FOLDER_NAME);
    // out_b before out_a: the step order is not the name order, so a
    // pane that ignored the sort would show.
    await addSql(page, ids.folder, `SELECT name FROM ${F("base")}`, F("out_b"));
    await addSql(page, ids.folder, `SELECT * FROM ${F("base")}`, F("out_a"));
    await runAll(page, ids.folder);
    // A never-run node beside the run ones.
    await addSql(page, ids.folder, `SELECT name FROM ${F("base")}`, F("out_c"));
    ids.second = await newRecipe(page, NAMES.second);
    await addSql(page, ids.second, `SELECT name FROM ${F("base")}`, T("second"));
    await runAll(page, ids.second);
    ids.tool = await newRecipe(page, NAMES.tool, "builder");
    await addSql(page, ids.tool, `SELECT name FROM ${F("base")}`, T("tool"));
    await runAll(page, ids.tool);
    ids.empty = await newRecipe(page, NAMES.empty);
    await addSql(page, ids.empty, `SELECT name FROM ${F("base")}`, T("never"));
    ids.ident = await newRecipe(page, NAMES.ident);
    await addSql(page, ids.ident, `SELECT name FROM ${F("base")}`, T("ident"));
    await runAll(page, ids.ident);
    ids.orphan = await newRecipe(page, NAMES.orphan);
    ids.orphanStep = await addSql(page, ids.orphan, `SELECT name FROM ${F("base")}`, T("orphan"));
    await runAll(page, ids.orphan);
    saveIds();
  });

  await test.step("a workflow with two outputs and a never-run node is one folder of two; a builder output stays loose; an empty workflow has no folder", async () => {
    await openData(page);
    await expect(folderCard(page, ids.folder)).toBeVisible();
    await expect(folderCard(page, ids.folder)).toContainText("2 outputs");
    await expect(tableCard(page, F("out_a"))).toHaveCount(0);
    await expect(tableCard(page, F("out_b"))).toHaveCount(0);
    await expect(tableCard(page, T("tool"))).toBeVisible();
    await expect(tableCard(page, T("tool"))).toContainText("Operation result");
    await expect(folderCard(page, ids.empty)).toHaveCount(0);
    await expect(folderCard(page, ids.tool)).toHaveCount(0);
    await page.getByRole("button", { name: "List view" }).click();
    await expect(folderRow(page, ids.folder)).toBeVisible();
    await expect(folderRow(page, ids.folder)).toContainText("2 outputs");
    await expect(page.locator(`[data-table-row="${F("out_a")}"]`)).toHaveCount(0);
    await page.getByRole("button", { name: "Grid view" }).click();
  });

  await test.step("the folder's facts, and the state words the Workflows list wears", async () => {
    const card = folderCard(page, ids.folder);
    await expect(card).toContainText(FOLDER_NAME);
    await expect(card.locator("[class*='chip']", { hasText: "Workflow" })).toBeVisible();
    const state = (await card.locator("[data-workflow-state]").innerText()).trim();
    expect(state).toBe("1 never run");
    // The size is the two outputs' sum: read them from the API and compare.
    const tables = (await api(page, "GET", "/api/tables")) as unknown as { name: string; sizeBytes: number; rowCount: number }[];
    const outs = tables.filter((t) => t.name === F("out_a") || t.name === F("out_b"));
    expect(outs).toHaveLength(2);
    const sum = outs.reduce((s, t) => s + t.sizeBytes, 0);
    await expect(card).toContainText(`${Math.round(sum / 1024)} KB`);
    await page.getByRole("button", { name: "List view" }).click();
    const row = folderRow(page, ids.folder);
    await expect(row.locator("td").nth(3)).toHaveText(String(outs.reduce((s, t) => s + t.rowCount, 0)));
    await expect(row.locator("td").nth(4)).toHaveText(`${Math.round(sum / 1024)} KB`);
    await page.getByRole("button", { name: "Grid view" }).click();
    expect(await workflowsListState(page, FOLDER_NAME)).toBe(state);
    await openData(page);
  });

  await test.step("opening by pointer and keys, one at a time, close, Escape, the pane at the row's end, the outputs' own navigation, Open workflow", async () => {
    await page.getByLabel("Sort tables").selectOption("name");
    const act = activator(page, ids.folder);
    await expect(act).toHaveAttribute("aria-expanded", "false");
    await act.click();
    await expect(act).toHaveAttribute("aria-expanded", "true");
    await expect(pane(page, ids.folder)).toBeVisible();
    await expect(pane(page, ids.folder).locator("[data-table-card]")).toHaveCount(2);
    expect(page.url()).toContain("/data");
    // The pane after the folder's row: every card before it in the grid
    // ends above it, every card after it starts below it (the row is
    // not split).
    await expectPaneAtRowEnd(page, ids.folder);
    // A second folder closes the first.
    await activator(page, ids.second).click();
    await expect(pane(page, ids.second)).toBeVisible();
    await expect(pane(page, ids.folder)).toHaveCount(0);
    await expect(act).toHaveAttribute("aria-expanded", "false");
    // The folder again closes it; the close closes it; Escape closes it.
    await activator(page, ids.second).click();
    await expect(pane(page, ids.second)).toHaveCount(0);
    await act.click();
    await pane(page, ids.folder).locator("[data-folder-close]").click();
    await expect(pane(page, ids.folder)).toHaveCount(0);
    await act.focus();
    await page.keyboard.press("Enter");
    await expect(pane(page, ids.folder)).toBeVisible();
    await pane(page, ids.folder).locator("[data-folder-close]").focus();
    await page.keyboard.press("Escape");
    await expect(pane(page, ids.folder)).toHaveCount(0);
    await act.focus();
    await page.keyboard.press(" ");
    await expect(pane(page, ids.folder)).toBeVisible();
    // Escape with focus on the card's activator closes it too.
    await act.focus();
    await page.keyboard.press("Escape");
    await expect(pane(page, ids.folder)).toHaveCount(0);
    await act.click();
    await expect(pane(page, ids.folder)).toBeVisible();
    // The view switch keeps it open; a filter that hides it closes it.
    await page.getByRole("button", { name: "List view" }).click();
    await expect(folderRow(page, ids.folder)).toHaveAttribute("data-open", "true");
    await expect(page.locator(`[data-table-row="${F("out_a")}"][data-nested]`)).toBeVisible();
    await expect(folderRow(page, ids.folder).locator("[data-folder-toggle]")).toHaveAttribute("aria-expanded", "true");
    // Escape with focus on an unfolded row closes the folder.
    await page.locator(`[data-table-row="${F("out_a")}"][data-nested]`).focus();
    await page.keyboard.press("Escape");
    await expect(folderRow(page, ids.folder)).not.toHaveAttribute("data-open", "true");
    await expect(page.locator("[data-table-row][data-nested]")).toHaveCount(0);
    await folderRow(page, ids.folder).locator("[data-folder-toggle]").click();
    await expect(folderRow(page, ids.folder)).toHaveAttribute("data-open", "true");
    await page.getByRole("button", { name: "Grid view" }).click();
    await expect(pane(page, ids.folder)).toBeVisible();
    // An Escape that closes an output's export menu inside the pane is
    // the menu's; the pane stays.
    const exportTrigger = pane(page, ids.folder).locator(`[data-table-card="${F("out_a")}"] [data-hint="Export this table"]`);
    await pane(page, ids.folder).locator(`[data-table-card="${F("out_a")}"]`).hover();
    await exportTrigger.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(pane(page, ids.folder)).toBeVisible();
    await chip(page, "Files").click();
    await expect(folderCard(page, ids.folder)).toHaveCount(0);
    await chip(page, "All").click();
    await expect(folderCard(page, ids.folder)).toBeVisible();
    await expect(pane(page, ids.folder)).toHaveCount(0);
    await expect(act).toHaveAttribute("aria-expanded", "false");
    // An output inside the pane opens its detail page; Open workflow opens the canvas.
    await act.click();
    await pane(page, ids.folder).locator(`[data-table-card="${F("out_a")}"] [role='link']`).click();
    await expect(page).toHaveURL(new RegExp(`/tables/${F("out_a")}$`));
    await page.goBack();
    await expect(folderCard(page, ids.folder)).toBeVisible();
    await folderCard(page, ids.folder).hover();
    await folderCard(page, ids.folder).locator("[data-open-workflow]").click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${ids.folder}$`));
    // The canvas keeps its own history; the page is reached afresh.
    await openData(page);
    await expect(folderCard(page, ids.folder)).toBeVisible();
    await activator(page, ids.folder).click();
    await pane(page, ids.folder).locator("[data-open-workflow]").click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${ids.folder}$`));
    await openData(page);
    await page.getByRole("button", { name: "List view" }).click();
    await expect(folderRow(page, ids.folder)).toBeVisible();
    await folderRow(page, ids.folder).hover();
    await folderRow(page, ids.folder).locator("[data-open-workflow]").click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${ids.folder}$`));
    await openData(page);
  });

  await test.step("sort keys over folders and tables; search by workflow name and by output name", async () => {
    // The tables land first and the folders fold in once the workflows
    // list answers: the order is read only once both folders are there.
    await expect(folderCard(page, ids.folder)).toBeVisible();
    await expect(folderCard(page, ids.second)).toBeVisible();
    const names = () =>
      page.locator("[data-table-card], [data-folder-card]").evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-table-card") ?? `folder:${el.getAttribute("data-folder-card")}`),
      );
    await page.getByLabel("Sort tables").selectOption("name");
    let order = await names();
    expect(order.indexOf(`folder:${ids.folder}`)).toBeLessThan(order.indexOf(F("base")));
    expect(order.indexOf(`folder:${ids.second}`)).toBeGreaterThan(order.indexOf(T("plain")));
    await page.getByLabel("Sort tables").selectOption("rows");
    order = await names();
    expect(order.indexOf(`folder:${ids.folder}`)).toBeLessThan(order.indexOf(F("base")));
    await page.getByLabel("Sort tables").selectOption("name");
    await activator(page, ids.folder).click();
    const inside = () => pane(page, ids.folder).locator("[data-table-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-table-card")));
    expect(await inside()).toEqual([F("out_a"), F("out_b")]);
    // By size: out_a holds the geometry (2 KB) and out_b a name column
    // (under 1 KB); by rows they tie and the fold's order stands.
    await page.getByLabel("Sort tables").selectOption("size");
    expect(await inside()).toEqual([F("out_a"), F("out_b")]);
    await page.getByLabel("Sort tables").selectOption("rows");
    expect(await inside()).toEqual([F("out_b"), F("out_a")]);
    await page.getByLabel("Sort tables").selectOption("name");
    const search = page.getByRole("textbox", { name: "Search data" });
    await search.fill(FOLDER_NAME);
    await expect(page.locator("[data-table-card]:not([data-folder-pane] [data-table-card])")).toHaveCount(0);
    await expect(folderCard(page, ids.folder)).toBeVisible();
    await expect(pane(page, ids.folder).locator("[data-table-card]")).toHaveCount(2);
    await search.fill(F("out_a"));
    await expect(folderCard(page, ids.folder)).toBeVisible();
    await expect(folderCard(page, ids.folder)).toContainText("2 outputs");
    await expect(pane(page, ids.folder).locator("[data-table-card]")).toHaveCount(1);
    await expect(pane(page, ids.folder).locator(`[data-table-card="${F("out_a")}"]`)).toBeVisible();
    await expect(folderCard(page, ids.second)).toHaveCount(0);
    await search.fill("");
  });

  await test.step("Results shows folders and loose results, no upload; Files shows uploads, no folder; the chips count tables", async () => {
    const all = await allChipCount(page);
    // The chips count tables, the folded outputs included: the tables
    // API's own count, which the folder's two outputs are part of.
    const apiCount = ((await api(page, "GET", "/api/tables")) as unknown as { name: string }[]).length;
    expect(all).toBe(apiCount);
    await chip(page, "Results").click();
    await expect(folderCard(page, ids.folder)).toBeVisible();
    await expect(tableCard(page, T("tool"))).toBeVisible();
    await expect(tableCard(page, F("base"))).toHaveCount(0);
    await chip(page, "Files").click();
    await expect(tableCard(page, F("base"))).toBeVisible();
    await expect(folderCard(page, ids.folder)).toHaveCount(0);
    await chip(page, "All").click();
    expect(await allChipCount(page)).toBe(all);
    await expect(chip(page, "All")).toContainText(String(all));
    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.locator("[class*='manifest']").first()).toContainText(`${apiCount} tables`);
    await page.getByRole("button", { name: "Grid view" }).click();
  });

  await test.step("membership by identity; a deleted node's output and a reused name stay loose", async () => {
    await expect(folderCard(page, ids.ident)).toBeVisible();
    await expect(folderCard(page, ids.orphan)).toBeVisible();
    await api(page, "DELETE", `/api/tables/${T("ident")}`);
    await seedCsv(page, T("ident"), "name,value\nreused,1\n");
    await readThenWriteBrowserSetup(page, `/api/recipes/${ids.orphan}`, () => ({ method: "DELETE", path: `/api/recipes/${ids.orphan}/steps/${ids.orphanStep}` })).then(result => result.json);
    await page.reload();
    await expect(tableCard(page, T("ident"))).toBeVisible();
    await expect(folderCard(page, ids.ident)).toHaveCount(0);
    await expect(tableCard(page, T("orphan"))).toBeVisible();
    await expect(folderCard(page, ids.orphan)).toHaveCount(0);
  });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text))).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test(`the folder card, its open state, the pane, the folder row and its unfolded rows match the ${theme} baseline`, async ({ page }) => {
    // The baselines are Darwin's, as the repository's other pixel
    // suites' are; the Linux post-merge gate runs the flows, not these.
    test.skip(process.platform !== "darwin", "pixel baselines are minted on Darwin");
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    loadIds();
    await openData(page);
    await page.getByLabel("Sort tables").selectOption("name");
    const card = folderCard(page, ids.folder);
    await expect(card).toBeVisible();
    // The pointer away from the cards, so none wears its hover.
    await page.mouse.move(2, 2);
    const when = card.locator("[class*='cardWhen']");
    // The card's curved motif gradient drifts sub-perceptually with the
    // rendering environment (shade-only deltas of at most 16 per channel,
    // zero layout change). The two motif-bearing captures take a
    // per-pixel tolerance calibrated to that measurement: 16/255 is about
    // 0.063 in pixelmatch's YIQ space, so 0.07 covers the drift with a
    // little headroom while a real palette step still fails (red-proven
    // against a seeded strip-tint change). Every other capture in this
    // file keeps exact color comparison.
    await expect(card).toHaveScreenshot(`folder-card-${theme}.png`, { animations: "disabled", mask: [when], threshold: 0.07 });
    await activator(page, ids.folder).click();
    await expect(pane(page, ids.folder)).toBeVisible();
    await page.mouse.move(2, 2);
    await expect(card).toHaveScreenshot(`folder-card-open-${theme}.png`, { animations: "disabled", mask: [when], threshold: 0.07 });
    await expect(pane(page, ids.folder)).toHaveScreenshot(`folder-pane-${theme}.png`, {
      animations: "disabled",
      mask: [pane(page, ids.folder).locator("[class*='cardWhen']")],
      threshold: 0,
    });
    await page.getByRole("button", { name: "List view" }).click();
    // The rows' capture is the table's own geometry, and a shared
    // instance's other rows widen its columns (px against the baseline's
    // on the whole-set run); narrow the list to this run's folder so the
    // columns are this content's alone.
    await page.getByLabel("Search data").fill(FOLDER_NAME);
    const row = folderRow(page, ids.folder);
    await expect(row).toHaveAttribute("data-open", "true");
    // The scroller keeps the grid's scroll; the rows are measured in view.
    await page.evaluate(() => document.querySelector("[class*='scroller']")!.scrollTo(0, 0));
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(2, 2);
    const rows = page.locator(`[data-folder-row="${ids.folder}"], [data-table-row][data-nested]`);
    await expect(rows).toHaveCount(3);
    const first = await box(rows.nth(0));
    const last = await box(rows.nth(2));
    // Both edges rounded the same way: a floor at the top and a ceiling
    // at the bottom let sub-pixel jitter flip the height by one (105
    // against 104 across two runs of the same content), which fails a
    // capture outright on its size.
    const top = Math.round(first.y);
    const bottom = Math.round(last.y + last.height);
    const clip = { x: Math.round(first.x), y: top, width: Math.round(first.width), height: bottom - top };
    // This clip capture's anti-aliased edges wobble run to run at exact
    // comparison: measured 98 px at deltas of at most 3 per channel on
    // the light theme (it passed one full run and failed the next while
    // nothing changed). It keeps exact color (threshold 0) with a count
    // bound at ~1.5x the measured wobble; the dark theme is the same
    // capture of the same content and carries the same bound.
    await expect(page).toHaveScreenshot(`folder-rows-open-${theme}.png`, {
      clip,
      animations: "disabled",
      mask: [rows.locator("td:nth-child(6)")],
      threshold: 0,
      maxDiffPixels: 150,
    });
    await row.locator("[data-folder-toggle]").click();
    await expect(row).not.toHaveAttribute("data-open", "true");
    await page.mouse.move(2, 2);
    // The collapsed row wobbles the same way, intermittently: measured
    // 46 counted pixels at deltas of at most 3 per channel on a run that
    // followed two clean ones (nothing changed between them). Same
    // class, its own measurement, same bound. The pane capture has
    // shown no wobble and stays fully exact.
    await expect(row).toHaveScreenshot(`folder-row-${theme}.png`, { animations: "disabled", mask: [row.locator("td:nth-child(6)")], threshold: 0, maxDiffPixels: 150 });
  });
}

test("the pane's placement holds at a narrower width", async ({ page }) => {
  loadIds();
  await page.setViewportSize({ width: 900, height: 800 });
  await openData(page);
  await page.getByLabel("Sort tables").selectOption("name");
  await activator(page, ids.folder).click();
  await expect(pane(page, ids.folder)).toBeVisible();
  await expectPaneAtRowEnd(page, ids.folder);
});

test("delete inside a folder updates its facts and state; the last deletion removes it", async ({ page }) => {
  loadIds();
  const consoleErrors = trackConsole(page);
  await openData(page);
  await page.getByLabel("Sort tables").selectOption("name");
  const all = await allChipCount(page);
  await activator(page, ids.folder).click();
  const inPane = (name: string) => pane(page, ids.folder).locator(`[data-table-card="${name}"]`);
  // The first deletion under an output-name search that narrows the pane
  // to that output: the deletion empties the folder out of the search,
  // which closes it, so clearing the search brings it back closed with
  // its one remaining output (found at review).
  const search = page.getByRole("textbox", { name: "Search data" });
  await search.fill(F("out_b"));
  await expect(pane(page, ids.folder).locator("[data-table-card]")).toHaveCount(1);
  await inPane(F("out_b")).hover();
  await inPane(F("out_b")).getByRole("button", { name: `Delete ${F("out_b")}` }).click();
  await inPane(F("out_b")).getByRole("button", { name: `Confirm deleting ${F("out_b")}` }).click();
  await expect(folderCard(page, ids.folder)).toHaveCount(0);
  await search.fill("");
  await expect(folderCard(page, ids.folder)).toBeVisible();
  await expect(activator(page, ids.folder)).toHaveAttribute("aria-expanded", "false");
  await expect(pane(page, ids.folder)).toHaveCount(0);
  await expect(folderCard(page, ids.folder)).toContainText("1 output");
  await expect(chip(page, "All")).toContainText(String(all - 1));
  // The state words follow the re-read in place, without a reload: the
  // deleted output makes its node one to run again.
  const stateChip = folderCard(page, ids.folder).locator("[data-workflow-state]");
  await expect(stateChip).not.toHaveText("1 never run");
  const state = (await stateChip.innerText()).trim();
  expect(await workflowsListState(page, FOLDER_NAME)).toBe(state);
  await openData(page);
  await page.getByLabel("Sort tables").selectOption("name");
  await activator(page, ids.folder).click();
  await inPane(F("out_a")).hover();
  await inPane(F("out_a")).getByRole("button", { name: `Delete ${F("out_a")}` }).click();
  await inPane(F("out_a")).getByRole("button", { name: `Confirm deleting ${F("out_a")}` }).click();
  await expect(folderCard(page, ids.folder)).toHaveCount(0);
  await expect(pane(page, ids.folder)).toHaveCount(0);
  await expect(chip(page, "All")).toContainText(String(all - 2));
  // The workflow remains.
  await expect(page.locator("article", { hasText: FOLDER_NAME })).toHaveCount(0);
  await page.goto("/workflows");
  await expect(page.locator("article", { hasText: FOLDER_NAME }).first()).toBeVisible();
  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text))).toEqual([]);
});

test("the tables never wait for the workflows: pending, failed with Retry, folded on success", async ({ page }) => {
  loadIds();
  let held: Route | null = null;
  await page.route("**/api/recipes?origin=workflow", (route) => {
    held = route;
  });
  await openData(page);
  await page.getByLabel("Sort tables").selectOption("name");
  // Flat while the read is pending: the second workflow's output is loose.
  await expect(tableCard(page, T("second"))).toBeVisible();
  await expect(folderCard(page, ids.second)).toHaveCount(0);
  await expect(page.locator("[data-workflows-note]")).toHaveCount(0);
  expect(held).not.toBeNull();
  await held!.continue();
  await expect(folderCard(page, ids.second)).toBeVisible();
  await expect(tableCard(page, T("second"))).toHaveCount(0);
  await page.unroute("**/api/recipes?origin=workflow");
  // A failed read: the flat page under the note; Retry folds.
  await page.route("**/api/recipes?origin=workflow", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "not now" } }) }),
  );
  await openData(page);
  await page.getByLabel("Sort tables").selectOption("name");
  await expect(tableCard(page, T("second"))).toBeVisible();
  const note = page.locator("[data-workflows-note]");
  await expect(note).toBeVisible();
  await expect(note).toContainText("The workflows couldn't be read, so every table shows on its own.");
  await page.unroute("**/api/recipes?origin=workflow");
  await note.getByRole("button", { name: "Try again" }).click();
  await expect(folderCard(page, ids.second)).toBeVisible();
  await expect(note).toHaveCount(0);
  await expect(tableCard(page, T("second"))).toHaveCount(0);
  // A re-read after a change that fails keeps the fold and says so, with
  // Retry (found at review): delete a loose table with the
  // recipes route failing.
  await page.route("**/api/recipes?origin=workflow", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "not now" } }) }),
  );
  const plain = tableCard(page, T("plain"));
  await plain.hover();
  await plain.getByRole("button", { name: `Delete ${T("plain")}` }).click();
  await plain.getByRole("button", { name: `Confirm deleting ${T("plain")}` }).click();
  await expect(plain).toHaveCount(0);
  const refreshNote = page.locator("[data-workflows-refresh-note]");
  await expect(refreshNote).toBeVisible();
  await expect(refreshNote).toContainText("The workflows couldn't be re-read after that change, so a folder may be behind.");
  await expect(folderCard(page, ids.second)).toBeVisible();
  await page.unroute("**/api/recipes?origin=workflow");
  await refreshNote.getByRole("button", { name: "Try again" }).click();
  await expect(refreshNote).toHaveCount(0);
  await expect(folderCard(page, ids.second)).toBeVisible();
});
