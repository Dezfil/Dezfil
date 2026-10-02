import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
import { test, expect, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { seedCsv, trackConsole } from "./support";

/**
 * The results band's Data, Map and Provenance tabs and Add to a map: the
 * selection and the lead, the facts, the grid, the map and its readout, the
 * provenance, the state table, the notes, the actions from the band and the
 * panel, the reads' failures and Retry, a deleted output and a reclaimed
 * name, the over-cap and all-null maps, the run in flight. The oracle for
 * every server-derived fact is the API's own answer — the inspection, the
 * features read, the listing, the recipe, the map — captured independently
 * of the band.
 */

const runId = Date.now().toString(36);
const stations = `rb_stations_${runId}`;
const counts = `rb_counts_${runId}`;

type Json = Record<string, unknown>;
type Inspection = { id: string; name: string; rowCount: number; crsAssumed: boolean; geometryColumn: string | null; columns: { name: string; type: string }[]; preview: Json[]; sourceParams: Json | null; inputs: { name: string; missing: boolean }[] | null; importedAt: string | null };
type Features = { ok: boolean; featureCount?: number; totalCount?: number; sampled?: boolean; geometryType?: string | null };
type Run = { id: string; outcome: string | null; members: { stepId: string; state: string }[] };

// The engine's own endless statement (its cascade tests hold the lane with it).
const ENDLESS = "SELECT count(*) AS n FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";

async function api(page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<{ status: number; json: Json }> {
  return page.evaluate(
    async ({ method, path, body, basis }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    { method, path, body, basis },
  );
}
const ok = async (page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<Json> => {
  const r = await api(page, method, path, body, basis);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
};
const made: string[] = [];
const newRecipe = async (page: Page, name: string) => {
  const id = ((await ok(page, "POST", "/api/recipes", { name })).recipe as { id: string }).id;
  made.push(id);
  return id;
};
const addSql = async (page: Page, id: string, sql: string, name: string) =>
  ((await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps`, body: { operation: "sql_step", parameters: { sql, name } } })).then(result => result.json)).step as { id: string }).id;
const inspect = async (page: Page, name: string) => (await ok(page, "GET", `/api/tables/${encodeURIComponent(name)}`)) as unknown as Inspection;
const features = async (page: Page, name: string) => (await ok(page, "GET", `/api/tables/${encodeURIComponent(name)}/features?sample=1`)) as unknown as Features;
const listRuns = async (page: Page, id: string) => (await ok(page, "GET", `/api/recipes/${id}/runs`)).runs as Run[];
const runAll = async (page: Page, id: string) => {
  const run = (await ok(page, "POST", `/api/recipes/${id}/runs`, {})).run as Run;
  await expect.poll(async () => (await listRuns(page, id)).find((r) => r.id === run.id)?.outcome, { timeout: 60_000 }).not.toBeNull();
  return run.id;
};
const runOne = async (page: Page, id: string, stepId: string) => {
  const run = (await ok(page, "POST", `/api/recipes/${id}/steps/${stepId}/run`, {})).run as Run;
  await expect.poll(async () => (await listRuns(page, id)).find((r) => r.id === run.id)?.outcome, { timeout: 60_000 }).not.toBeNull();
  return run.id;
};
const propose = async (page: Page, id: string, stepId: string, parameters: Json) => readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "PATCH", path: `/api/recipes/${id}/steps/${stepId}`, body: { parameters } })).then(result => result.json);

async function settled(page: Page) {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.waitForTimeout(400);
}
const member = (page: Page, name: string) => page.locator(`[data-node][data-name="${name}"]`).first();
const band = (page: Page) => page.locator("[data-results-band]");
const tab = (page: Page, name: "Messages" | "Data" | "Map" | "Provenance") => page.getByRole("tab", { name: name === "Messages" ? /^Messages/ : name });
const lead = (page: Page) => page.locator("[data-band-lead]");
// A selection changes from one member to the next, never by deselecting
// first: deselecting falls the band to Messages and that fallback persists, which the deselect
// steps test on their own. The stage
// stack's box once spanned the canvas's top strip with a panel open and
// swallowed a click on a tile under it (closed, whose fit also keeps the
// first column clear of the stack): after Fit the canvas is panned down
// only if a tile still lies under the stack's column.
async function bringTilesClear(page: Page) {
  await page.getByRole("button", { name: "Fit to view" }).click();
  await page.waitForTimeout(300);
  const bar = await band(page).boundingBox();
  const stage = await page.locator("[data-canvas-stage]").boundingBox();
  if (!bar || !stage) throw new Error("no band or stage");
  let top = Infinity;
  for (const tile of await page.locator("[data-node]").all()) {
    const b = await tile.boundingBox();
    if (b && b.x < stage.x + stage.width && b.x + b.width > stage.x) top = Math.min(top, b.y);
  }
  const shift = top !== Infinity ? Math.max(0, Math.ceil(stage.y + stage.height + 12 - top)) : 0;
  if (shift === 0) return;
  // The drag starts in the gap just above the band's column, where no tile
  // is laid out after a fit (the fit keeps the band's reserve clear).
  const x = bar.x + bar.width * 0.5;
  const y = bar.y - 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = Math.max(3, Math.ceil(shift / 40));
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, y + (shift * i) / steps);
  await page.mouse.up();
  await page.waitForTimeout(200);
}
async function selectNode(page: Page, name: string) {
  await bringTilesClear(page);
  await member(page, name).locator("[data-v]").first().click();
  await expect(page.locator("[data-node-panel]")).toBeVisible();
  await expect(lead(page).locator("b")).toHaveText(name);
}
async function selectSource(page: Page, name: string) {
  await bringTilesClear(page);
  await page.locator(`.react-flow__node[aria-label="${name}, source table"]`).first().click();
  await expect(page.locator("[data-source-panel]")).toHaveAttribute("aria-label", `${name}, source`);
}
test.afterEach(async ({ page }) => {
  for (const id of made.splice(0)) {
    const runs = await api(page, "GET", `/api/recipes/${id}/runs`);
    for (const run of ((runs.json.runs as Run[] | undefined) ?? []).filter((r) => r.outcome === null)) {
      await api(page, "POST", `/api/recipes/${id}/runs/${run.id}/cancel`);
    }
  }
});

async function seed(page: Page) {
  await page.goto("/workflows");
  await seedCsv(page, stations, "name,riders,lon,lat\nalex,10450,13.4133,52.5219\nhbf,22310,13.3696,52.5251\nzoo,9000,13.3327,52.5072\n");
  await seedCsv(page, counts, "name,riders\nalex,10450\nhbf,22310\n");
}

test("the selection, the lead and facts, the grid, the map, the provenance, the states, the actions from the band and the panel", async ({ page, context }) => {
  const consoleErrors = trackConsole(page);
  // Copy writes the clipboard: the browser must allow it, then the test reads it back.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seed(page);
  const id = await newRecipe(page, `Results ${runId}`);
  const a = await addSql(page, id, `SELECT * FROM ${stations}`, `rb_a_${runId}`);
  const b = await addSql(page, id, `SELECT name, riders FROM rb_a_${runId}`, `rb_b_${runId}`);
  await runAll(page, id);
  const aName = `rb_a_${runId}`;
  const bName = `rb_b_${runId}`;
  await page.goto(`/workflows/${id}`);
  await settled(page);

  await test.step("nothing selected: the three tabs are unavailable and say why, Messages is shown, the lead reads the sentence", async () => {
    await expect(band(page)).toHaveAttribute("data-band-shown", "messages");
    for (const t of ["Data", "Map", "Provenance"] as const) {
      await expect(tab(page, t)).toBeDisabled();
      await expect(tab(page, t)).toHaveAttribute("title", "Select a node or a table to see its data");
    }
    await expect(lead(page)).toHaveText("Select a node or a table to see its data");
    await expect(page.locator("[data-band-actions]")).toHaveCount(0);
  });

  await test.step("a produced node: the lead names it and its dataset, the facts equal the inspection, the band stays collapsed", async () => {
    await expect(band(page)).toHaveAttribute("data-collapsed", "true");
    await selectNode(page, aName);
    const t = await inspect(page, aName);
    await expect(lead(page)).toContainText("SQL step");
    await expect(lead(page).locator("b")).toHaveText(aName);
    await expect(page.locator("[data-band-facts]")).toHaveAttribute("data-rows", String(t.rowCount));
    await expect(page.locator("[data-band-facts]")).toHaveAttribute("data-columns", String(t.columns.length));
    await expect(band(page)).toHaveAttribute("data-collapsed", "true");
  });

  await test.step("Data: the grid's columns and rows equal the inspection's, the geometry column marked, no footer; a cell revealed and copied by pointer and by keyboard", async () => {
    await tab(page, "Data").click();
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    await expect(band(page)).toHaveAttribute("data-band-shown", "data");
    const t = await inspect(page, aName);
    const grid = page.locator("[data-band-data] table");
    await expect(grid).toBeVisible();
    await expect(grid.locator("thead th").filter({ hasNotText: /^$/ })).toHaveCount(t.columns.length);
    const headers = await grid.locator("thead th").allInnerTexts();
    expect(headers.slice(1).map((h) => h.split("\n")[0])).toEqual(t.columns.map((c) => c.name));
    await expect(grid.locator("tbody tr")).toHaveCount(t.preview.length);
    expect(t.rowCount).toBe(t.preview.length);
    await expect(grid.locator(`thead th[data-geom]`)).toHaveText(new RegExp(`^${t.geometryColumn}`));
    await expect(page.locator("[data-band-data] [class*='gridFoot']")).toHaveCount(0);
    const first = grid.locator("tbody tr").first();
    const nameCell = first.locator("td").nth(1);
    await nameCell.click();
    const peek = page.getByRole("dialog", { name: "Cell value" });
    await expect(peek).toBeVisible();
    await expect(peek.locator("pre")).toHaveText(String(t.preview[0][t.columns[0].name]));
    await peek.getByRole("button", { name: "Copy" }).click();
    await expect(peek.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(String(t.preview[0][t.columns[0].name]));
    // By keyboard alone: Escape closes the pointer's peek and returns focus to
    // its cell; Tab reaches the next cell; Enter reveals it and Copy takes
    // focus; Enter copies; Escape closes and the cell has focus again.
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Cell value" })).toHaveCount(0);
    await expect(nameCell).toBeFocused();
    await page.keyboard.press("Tab");
    const ridersCell = first.locator("td").nth(2);
    await expect(ridersCell).toBeFocused();
    await page.keyboard.press("Enter");
    const peek2 = page.getByRole("dialog", { name: "Cell value" });
    await expect(peek2).toBeVisible();
    await expect(peek2.locator("pre")).toHaveText(String(t.preview[0][t.columns[1].name]));
    await expect(peek2.getByRole("button", { name: "Copy" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(peek2.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(String(t.preview[0][t.columns[1].name]));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Cell value" })).toHaveCount(0);
    await expect(ridersCell).toBeFocused();
  });

  await test.step("Map: the features drawn, the readout equals the features read, WGS84 assumed", async () => {
    await tab(page, "Map").click();
    const f = await features(page, aName);
    const t = await inspect(page, aName);
    expect(f.ok).toBe(true);
    const readout = page.locator("[data-band-readout]");
    await expect(readout).toBeVisible({ timeout: 30_000 });
    await expect(readout).toHaveAttribute("data-drawn", String(f.featureCount));
    await expect(readout).toContainText(`${f.featureCount} features`);
    await expect(readout).toContainText(f.geometryType ?? "");
    expect(t.crsAssumed).toBe(true);
    await expect(readout).toContainText("WGS84 assumed");
  });

  await test.step("Provenance: the operation, the run time, the inputs and the SQL byte for byte, the assumption", async () => {
    await tab(page, "Provenance").click();
    const t = await inspect(page, aName);
    const prov = page.locator("[data-band-provenance='derived']");
    await expect(prov).toBeVisible();
    await expect(prov.locator("[data-band-operation]")).toHaveText("SQL step");
    await expect(prov.locator("[data-ran-at]")).toHaveAttribute("data-ran-at", String(t.sourceParams!.ranAt));
    await expect(prov.locator("[data-band-input]")).toHaveCount(t.inputs!.length);
    await expect(prov.locator("[data-band-input]").first()).toHaveAttribute("data-band-input", t.inputs![0].name);
    expect(await prov.locator("[data-band-input]").first().getAttribute("data-resolution")).toBeNull();
    expect(await prov.locator("[data-band-sql]").innerText()).toBe(String(t.sourceParams!.sql));
    await expect(prov.locator("[data-band-assumed]")).toHaveText("Coordinates assumed WGS84: an input had no declared coordinate system.");
  });

  await test.step("a non-spatial node: the tab survives the selection, Map is unavailable with the reason and falls to Data, Add to a map is unavailable in both places", async () => {
    await selectNode(page, bName);
    await expect(band(page)).toHaveAttribute("data-band-shown", "provenance");
    await expect(page.locator("[data-band-provenance='derived'] [data-band-input]").first()).toHaveAttribute("data-band-input", aName);
    const t = await inspect(page, bName);
    expect(t.geometryColumn).toBeNull();
    await expect(tab(page, "Map")).toBeDisabled();
    await expect(tab(page, "Map")).toHaveAttribute("title", "No geometry in this dataset, so there is nothing to map.");
    // a clickable tab shows the pointer and an unavailable one keeps the
    // arrow (one convention), measured with the band open: collapsed, the
    // whole bar is the opener and every tab says so.
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    const cursorOf = (name: "Data" | "Map") => tab(page, name).evaluate((el) => getComputedStyle(el).cursor);
    expect(await cursorOf("Data"), "an enabled tab's cursor").toBe("pointer");
    expect(await cursorOf("Map"), "a disabled tab's cursor").toBe("default");
    const add = page.locator("[data-band-add-to-map]");
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute("title", "No geometry: a table, not a layer.");
    const panelAdd = page.locator("[data-node-panel] [data-add-to-map]");
    await expect(panelAdd).toBeDisabled();
    await expect(page.locator("[data-node-panel] [data-output-actions]")).toContainText("No geometry: a table, not a layer.");
    // Map chosen for the spatial node, then the non-spatial one selected: it falls to Data.
    await selectNode(page, aName);
    await tab(page, "Map").click();
    await selectNode(page, bName);
    await expect(band(page)).toHaveAttribute("data-band-shown", "data");
    await expect(page.locator("[data-band-data] table tbody tr")).toHaveCount(t.preview.length);
  });

  await test.step("deselecting falls to Messages; a selected source shows its rows, its imported provenance and its actions", async () => {
    await page.keyboard.press("Escape");
    await expect(band(page)).toHaveAttribute("data-band-shown", "messages");
    await expect(lead(page)).toHaveText("Select a node or a table to see its data");
    await selectSource(page, stations);
    await expect(lead(page).locator("svg")).toHaveCount(1);
    await expect(lead(page).locator("b")).toHaveText(stations);
    await tab(page, "Data").click();
    const t = await inspect(page, stations);
    await expect(page.locator("[data-band-data] table tbody tr")).toHaveCount(t.preview.length);
    await tab(page, "Provenance").click();
    const prov = page.locator("[data-band-provenance='imported']");
    await expect(prov).toContainText(`Uploaded as ${stations}.csv`);
    await expect(prov.locator("[data-produced-at]")).toHaveAttribute("data-produced-at", String(t.importedAt));
    await expect(prov).not.toContainText("Refresh");
    await expect(page.locator("[data-band-add-to-map]")).toBeEnabled();
    await expect(page.locator("[data-band-open-explorer]")).toHaveAttribute("href", `/tables/${encodeURIComponent(stations)}`);
  });

  await test.step("a never-run node: No output yet on Data, Map and Provenance unavailable, no facts, no actions, starting on Provenance", async () => {
    const cName = `rb_c_${runId}`;
    await addSql(page, id, "SELECT 1 AS x", cName);
    await page.reload();
    await settled(page);
    await selectSource(page, stations);
    await tab(page, "Provenance").click();
    await selectNode(page, cName);
    await expect(band(page)).toHaveAttribute("data-band-shown", "data");
    await expect(page.locator("[data-band-status='unproduced']")).toContainText("No output yet");
    await expect(page.locator("[data-band-status='unproduced']")).toContainText("Run the node to see its rows here.");
    await expect(tab(page, "Map")).toBeDisabled();
    await expect(tab(page, "Provenance")).toBeDisabled();
    await expect(tab(page, "Provenance")).toHaveAttribute("title", "Nothing has run yet");
    await expect(page.locator("[data-band-facts]")).toHaveCount(0);
    await expect(page.locator("[data-band-actions]")).toHaveCount(0);
    await expect(page.locator("[data-node-panel] [data-add-to-map]")).toHaveCount(0);
  });

  await test.step("a node both stale and edited shows both notes; one whose latest run failed shows the failure note over the previous rows", async () => {
    // Re-running a alone makes b stale; a proposal on b makes it edited.
    await runOne(page, id, a);
    await propose(page, id, b, { sql: `SELECT name FROM rb_a_${runId}`, name: bName });
    await page.reload();
    await settled(page);
    await selectNode(page, bName);
    await tab(page, "Data").click();
    const recipe = (await ok(page, "GET", `/api/recipes/${id}`)).recipe as { steps: { id: string; conditions: string[]; proposedParameters: Json | null }[] };
    const stepB = recipe.steps.find((s) => s.id === b)!;
    expect(stepB.conditions).toContain("stale");
    expect(stepB.proposedParameters).not.toBeNull();
    const notes = page.locator("[data-band-notes]");
    await expect(notes).toContainText("An input changed since this ran. Run again to refresh it.");
    await expect(notes).toContainText("This output was built with the last successful run's parameters, not the pending edit.");
    // A failing edit run: the previous rows stand with the failure note.
    await propose(page, id, b, { sql: "SELECT CAST('x' AS INTEGER) AS boom", name: bName });
    await runOne(page, id, b);
    const after = (await ok(page, "GET", `/api/recipes/${id}`)).recipe as { steps: { id: string; latestAttempt: { state: string } | null }[] };
    expect(after.steps.find((s) => s.id === b)!.latestAttempt?.state).toBe("failed");
    await page.reload();
    await settled(page);
    await selectNode(page, bName);
    await tab(page, "Data").click();
    await expect(page.locator("[data-band-notes]")).toContainText("The latest run failed. This is the previous output, still in the workspace.");
    const t = await inspect(page, bName);
    await expect(page.locator("[data-band-data] table tbody tr")).toHaveCount(t.preview.length);
  });

  await test.step("after a re-run succeeds the grid shows the new rows without a reload", async () => {
    await selectNode(page, aName);
    await tab(page, "Data").click();
    await expect(page.locator("[data-band-data] table tbody tr")).toHaveCount(3);
    await propose(page, id, a, { sql: `SELECT * FROM ${stations} WHERE riders > 9500`, name: aName });
    // The panel's own Run again lands the run through the canvas's runner, which renews the reads.
    await page.locator("[data-node-panel]").getByRole("button", { name: "Run again" }).click();
    await expect(page.locator("[data-band-data] table tbody tr")).toHaveCount(2, { timeout: 60_000 });
    await expect.poll(async () => (await inspect(page, aName)).rowCount).toBe(2);
  });

  await test.step("Add to a map from the band lands a layer reading the dataset by name and opens the builder; nothing of the recipe changes; the same from the panel", async () => {
    const before = {
      recipe: await ok(page, "GET", `/api/recipes/${id}`),
      layout: await ok(page, "GET", `/api/recipes/${id}/layout`),
      runs: await ok(page, "GET", `/api/recipes/${id}/runs`),
      jobs: await ok(page, "GET", "/api/operations/runs"),
    };
    await selectNode(page, aName);
    await tab(page, "Data").click();
    await expect(page.locator("[data-band-open-explorer]")).toHaveAttribute("href", `/tables/${encodeURIComponent(aName)}`);
    await page.locator("[data-band-add-to-map]").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /New map/ }).click();
    await page.waitForURL(/\/maps\/[^/?]+\?layer=/, { timeout: 30_000 });
    const mapId = new URL(page.url()).pathname.split("/").pop()!;
    const map = (await ok(page, "GET", `/api/maps/${mapId}`)) as { layers: { sql: string; name: string }[] };
    expect(map.layers).toHaveLength(1);
    expect(map.layers[0].sql).toBe(`SELECT * FROM ${aName}`);
    expect(map.layers[0].sql).not.toContain(stations);
    const after = {
      recipe: await ok(page, "GET", `/api/recipes/${id}`),
      layout: await ok(page, "GET", `/api/recipes/${id}/layout`),
      runs: await ok(page, "GET", `/api/recipes/${id}/runs`),
      jobs: await ok(page, "GET", "/api/operations/runs"),
    };
    expect(after).toEqual(before);
    // From the panel: the second dialog binds its own subject.
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await selectNode(page, aName);
    await page.locator("[data-node-panel] [data-add-to-map]").click();
    const second = page.getByRole("dialog");
    await expect(second).toBeVisible();
    await expect(second.getByRole("textbox").first()).toHaveValue(aName);
    await second.getByRole("button", { name: /New map/ }).click();
    await page.waitForURL(/\/maps\/[^/?]+\?layer=/, { timeout: 30_000 });
    const mapId2 = new URL(page.url()).pathname.split("/").pop()!;
    expect(mapId2).not.toBe(mapId);
    const map2 = (await ok(page, "GET", `/api/maps/${mapId2}`)) as { layers: { sql: string }[] };
    expect(map2.layers[0].sql).toBe(`SELECT * FROM ${aName}`);
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

test("the over-cap and all-null maps, a failed read with Retry, a deleted output and a reclaimed name", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await seed(page);
  const big = `rb_big_${runId}`;
  const rows = ["name,lon,lat"];
  for (let i = 0; i < 2100; i++) rows.push(i % 21 === 0 ? `r${i},,` : `r${i},${13 + (i % 100) / 1000},${52 + (i % 50) / 1000}`);
  await seedCsv(page, big, rows.join("\n") + "\n");
  const id = await newRecipe(page, `Results maps ${runId}`);
  const nullsName = `rb_nulls_${runId}`;
  const dName = `rb_d_${runId}`;
  const n = await addSql(page, id, `SELECT name, NULL::GEOMETRY AS geometry FROM ${stations}`, nullsName);
  const d = await addSql(page, id, `SELECT * FROM ${stations}`, dName);
  void n;
  void d;
  await runAll(page, id);
  await page.goto(`/workflows/${id}`);
  await settled(page);

  await test.step("a table over the render cap with rows lacking geometry: the readout's drawn count is the features read's, its row count the table's", async () => {
    const listing = (await ok(page, "GET", "/api/tables")) as unknown as { name: string; rowCount: number }[];
    const row = listing.find((t) => t.name === big)!;
    const f = await features(page, big);
    expect(f.ok).toBe(true);
    expect(f.sampled).toBe(true);
    expect(row.rowCount).toBe(2100);
    expect(f.featureCount).toBe(2000);
    expect(f.totalCount).toBe(row.rowCount);
    // The loose source placed from the pane: the band reads it by name.
    await page.locator("[data-canvas-pane]").getByRole("tab", { name: /^Sources/ }).click();
    await page.locator("[data-canvas-pane]").getByRole("searchbox", { name: "Search sources" }).fill(big);
    await page.locator("[data-canvas-pane]").getByRole("button", { name: new RegExp(`^Add ${big}`) }).click();
    await selectSource(page, big);
    await tab(page, "Map").click();
    const readout = page.locator("[data-band-readout]");
    await expect(readout).toBeVisible({ timeout: 60_000 });
    await expect(readout).toHaveAttribute("data-drawn", String(f.featureCount));
    await expect(readout).toHaveAttribute("data-rows", String(row.rowCount));
    await expect(readout).toContainText(`${f.featureCount!.toLocaleString("en-US")} features drawn, of ${row.rowCount.toLocaleString("en-US")} rows`);
  });

  await test.step("a spatial dataset whose geometries are all null: the empty map with a readout of zero, never a refusal", async () => {
    const t = await inspect(page, nullsName);
    expect(t.geometryColumn).toBe("geometry");
    expect(t.columns.find((column) => column.name === "geometry")?.type).toContain("GEOMETRY");
    await selectNode(page, nullsName);
    const f = await features(page, nullsName);
    expect(f.ok).toBe(true);
    expect(f.featureCount).toBe(0);
    await tab(page, "Map").click();
    const readout = page.locator("[data-band-readout]");
    await expect(readout).toBeVisible({ timeout: 30_000 });
    await expect(readout).toHaveAttribute("data-drawn", "0");
    await expect(readout).toContainText("0 features");
    await expect(page.locator("[data-band-map]")).not.toContainText("nothing to map");
  });

  await test.step("a failed inspection read shows Retry in Data and Provenance; a failed features read in Map; Retry reads again", async () => {
    let fail = true;
    await page.route(`**/api/tables/${dName}`, async (route) => {
      if (fail) return route.abort();
      return route.continue();
    });
    await selectNode(page, dName);
    await tab(page, "Data").click();
    await expect(page.locator("[data-band-read-failed]")).toBeVisible();
    await expect(page.locator("[data-band-facts]")).toHaveCount(0);
    await tab(page, "Provenance").click();
    await expect(page.locator("[data-band-read-failed]")).toBeVisible();
    fail = false;
    await page.locator("[data-band-read-failed]").getByRole("button", { name: "Retry" }).click();
    await expect(page.locator("[data-band-provenance='derived']")).toBeVisible();
    await page.unroute(`**/api/tables/${dName}`);
    let failFeatures = true;
    await page.route(`**/api/tables/${dName}/features**`, async (route) => {
      if (failFeatures) return route.abort();
      return route.continue();
    });
    await tab(page, "Map").click();
    await expect(page.locator("[data-band-map] [data-band-read-failed]")).toBeVisible();
    failFeatures = false;
    await page.locator("[data-band-map] [data-band-read-failed]").getByRole("button", { name: "Retry" }).click();
    await expect(page.locator("[data-band-readout]")).toBeVisible({ timeout: 30_000 });
    await page.unroute(`**/api/tables/${dName}/features**`);
  });

  await test.step("a deleted output, then a table registered under the same name: the deleted state on every tab, the action absent in both places, nothing of the replacement read", async () => {
    const before = await inspect(page, dName);
    await ok(page, "DELETE", `/api/tables/${encodeURIComponent(dName)}`);
    // Selected again: a change of selection, the renewal the criterion names.
    await selectNode(page, nullsName);
    await selectNode(page, dName);
    await expect(band(page)).toHaveAttribute("data-band-shown", "data");
    await expect(page.locator("[data-band-status='deleted']")).toContainText("This dataset no longer exists.");
    await expect(tab(page, "Map")).toBeDisabled();
    await expect(tab(page, "Provenance")).toBeDisabled();
    await expect(page.locator("[data-band-actions]")).toHaveCount(0);
    await expect(page.locator("[data-node-panel] [data-add-to-map]")).toHaveCount(0);
    // A stranger takes the name.
    const replacement = await seedCsv(page, dName, "name,lon,lat\nstranger,1,1\n");
    expect(replacement.name).toBe(dName);
    const stranger = await inspect(page, dName);
    expect(stranger.id).not.toBe(before.id);
    await selectNode(page, `rb_nulls_${runId}`);
    await selectNode(page, dName);
    await expect(page.locator("[data-band-status='deleted']")).toContainText("This dataset no longer exists.");
    await expect(page.locator("[data-band-data] table")).toHaveCount(0);
    await expect(page.locator("[data-band-facts]")).toHaveCount(0);
    await expect(tab(page, "Map")).toBeDisabled();
    await expect(page.locator("[data-band-actions]")).toHaveCount(0);
    await expect(page.locator("[data-node-panel] [data-add-to-map]")).toHaveCount(0);
    await expect(page.locator("[data-band-lead]")).not.toContainText("stranger");
  });

  // The reads this test cuts on purpose, and the deleted dataset's own 404,
  // log as resource errors: induced, not defects.
  const induced = (url: string) => url.includes(`/api/tables/${dName}`);
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !induced(e.url ?? ""));
  expect(unexpected).toEqual([]);
});

test("the run in flight: the previous rows with the note while the member waits, Add to a map available, the new rows the moment it succeeds while a later member runs", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await seed(page);

  await test.step("a member waiting behind a slow one: the previous output with the note, the action available", async () => {
    const id = await newRecipe(page, `Results wait ${runId}`);
    await addSql(page, id, ENDLESS, `rb_slow_${runId}`);
    const q = await addSql(page, id, `SELECT * FROM ${stations}`, `rb_q_${runId}`);
    await runOne(page, id, q);
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await selectNode(page, `rb_q_${runId}`);
    await tab(page, "Data").click();
    await expect(page.locator("[data-band-data] table tbody tr")).toHaveCount(3);
    // Started on the canvas: a run started headlessly is met on open or reload, not mid-session.
    await page.locator("[data-run-action='run-all']").click();
    await page.locator("[data-run-confirm] [data-confirm-run]").click();
    await expect(page.locator("[data-band-notes]")).toContainText("A run is in flight. This is the output as it stands.", { timeout: 15_000 });
    // Not yet admitted, or admitted and queued behind the lane: both are the member's own wait.
    await expect(member(page, `rb_q_${runId}`)).toHaveAttribute("data-state", /waiting|queued/);
    await expect(page.locator("[data-band-data] table tbody tr")).toHaveCount(3);
    await expect(page.locator("[data-band-add-to-map]")).toBeEnabled();
    await expect(page.locator("[data-node-panel] [data-add-to-map]")).toBeEnabled();
    const run = (await listRuns(page, id)).find((r) => r.outcome === null)!;
    await ok(page, "POST", `/api/recipes/${id}/runs/${run.id}/cancel`);
    await expect.poll(async () => (await listRuns(page, id)).find((r) => r.id === run.id)?.outcome, { timeout: 60_000 }).toBe("cancelled");
  });

  await test.step("a member that succeeds while a later one runs: the new rows show and the note goes at once", async () => {
    const id = await newRecipe(page, `Results settle ${runId}`);
    const q = await addSql(page, id, `SELECT * FROM ${stations}`, `rb_r_${runId}`);
    await addSql(page, id, `SELECT count(*) AS n FROM range(200000) a, range(200000) b, (SELECT 1 FROM rb_r_${runId} LIMIT 1) c WHERE (a.range * b.range) % 7 = 3`, `rb_after_${runId}`);
    await runOne(page, id, q);
    await propose(page, id, q, { sql: `SELECT * FROM ${stations} WHERE riders > 9500`, name: `rb_r_${runId}` });
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await selectNode(page, `rb_r_${runId}`);
    await tab(page, "Data").click();
    await expect(page.locator("[data-band-data] table tbody tr")).toHaveCount(3);
    await page.locator("[data-run-action='run-all']").click();
    await page.locator("[data-run-confirm] [data-confirm-run]").click();
    await expect(page.locator("[data-band-data] table tbody tr")).toHaveCount(2, { timeout: 60_000 });
    await expect(page.locator("[data-band-notes]")).toHaveCount(0);
    await expect(member(page, `rb_after_${runId}`)).toHaveAttribute("data-state", /running|queued/);
    await expect(page.locator("[data-run-dock]")).toHaveAttribute("data-run-dock", "running");
    const run = (await listRuns(page, id)).find((r) => r.outcome === null)!;
    expect(run.members.find((m) => m.stepId === q)?.state).toBe("succeeded");
    await ok(page, "POST", `/api/recipes/${id}/runs/${run.id}/cancel`);
    await expect.poll(async () => (await listRuns(page, id)).find((r) => r.id === run.id)?.outcome, { timeout: 60_000 }).not.toBeNull();
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});
