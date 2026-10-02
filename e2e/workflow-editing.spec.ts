import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
import { test, expect, type Page, type Locator, type Request } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { FIXTURES_DIR, seedCsv, seedFile, trackConsole } from "./support";

/**
 * The canvas, editing: adding from the pane, loose sources, linking
 * through ports and the picker with the rules applied before the edit,
 * the panel's controls under the drawer's words, the name rule,
 * proposals and their discard, the preview, removal in its three states,
 * the keyboard, and the save states; and the aggregates/carry editor's
 * geometry at the panel's width. Every fixture is authored through the
 * API; every claim is checked against the recipe and layout reads, or
 * measured on the surface.
 */

const runId = Date.now().toString(36);
const stations = `ed_stations_${runId}`; // lon/lat CSV: points, CRS assumed
const cafes = `ed_cafes_${runId}`; // no geometry
const districts = `ed_districts_${runId}`; // polygons

type Json = Record<string, unknown>;
type Step = { id: string; ordinal: number; operation: string; parameters: Json; proposedParameters: Json | null; output: Json | null; latestAttempt: Json | null; reads: string[] };

async function api(page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<Json> {
  return page.evaluate(
    async ({ method, path, body, basis }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    },
    { method, path, body, basis },
  );
}
const newRecipe = async (page: Page, name: string) => ((await api(page, "POST", "/api/recipes", { name })).recipe as { id: string }).id;
const addStep = async (page: Page, id: string, operation: string, parameters: Json) =>
  ((await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps`, body: { operation, parameters } })).then(result => result.json)).step as { id: string }).id;
const readRecipe = async (page: Page, id: string) => (await api(page, "GET", `/api/recipes/${id}`)).recipe as Json & { steps: Step[] };
const readLayout = async (page: Page, id: string) => (await api(page, "GET", `/api/recipes/${id}/layout`)).layout as Json & { steps: Json; sources: Json };
const tableNames = async (page: Page) =>
  (await page.evaluate(async () => ((await (await fetch("/api/tables")).json()) as { name: string }[]).map((t) => t.name))).sort();
async function runAndWait(page: Page, id: string, stepId: string) {
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps/${stepId}/run` })).then(result => result.json);
  await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === stepId)?.output, { timeout: 30_000 }).not.toBeNull();
}
function watchWrites(page: Page): Request[] {
  const writes: Request[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && /\/api\//.test(r.url())) writes.push(r);
  });
  return writes;
}
async function settled(page: Page) {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.waitForTimeout(400);
}
const pane = (page: Page) => page.locator("[data-canvas-pane]");
/** A member by its exact name: a node's declared or produced output, a source's table. */
const member = (page: Page, name: string) => page.locator(`[data-node][data-name="${name}"]`).first();
const tileOf = (m: Locator) => m.locator("[data-v]").first();
const panel = (page: Page) => page.locator("[data-node-panel]");
const notice = (page: Page) => page.locator("[data-canvas-notice]");
const viewportTransform = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);

async function drag(page: Page, from: Locator, to: Locator | { x: number; y: number }) {
  const a = await from.boundingBox();
  if (!a) throw new Error("no drag origin");
  const b = "x" in to ? { x: to.x, y: to.y, width: 0, height: 0 } : await to.boundingBox();
  if (!b) throw new Error("no drag target");
  const x0 = a.x + a.width / 2;
  const y0 = a.y + a.height / 2;
  const x1 = b.x + b.width / 2;
  const y1 = b.y + b.height / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
  await page.mouse.up();
}
/** Select a member by its tile: the panel closes and the view fits first,
 * since a tile can sit under the floating pane or panel. */
async function selectTile(page: Page, text: string) {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit to view" }).click();
  await page.waitForTimeout(350);
  await tileOf(member(page, text)).click();
}
/** Every text the frame's whisper shows from now on, in order: a "Saved"
 * that flashes for a second is a fact the next assertion can read.
 *
 * Anchored on the whisper chip itself, not on the page's first polite
 * live region: the whisper used to be the only one on this page and the
 * header carried it, and an observer that finds its target by position
 * would sooner or later attach to somebody else's region or to a node
 * the move discarded. The chip's node is mounted for as long as the
 * canvas is and keeps its identity across every message, which is what
 * this observer needs. */
async function watchWhisper(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __whisper: string[]; __whisperOn?: boolean };
    w.__whisper = [];
    if (w.__whisperOn) return;
    const el = document.querySelector('[data-save-status="whisper"]');
    if (!el) throw new Error("no save status chip on the canvas to watch");
    w.__whisperOn = true;
    new MutationObserver(() => {
      const t = el.textContent?.trim() ?? "";
      if (t && w.__whisper[w.__whisper.length - 1] !== t) w.__whisper.push(t);
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  });
}
const whispered = (page: Page) => page.evaluate(() => (window as unknown as { __whisper: string[] }).__whisper ?? []);
const outPort = (m: Locator) => m.locator(".react-flow__handle.source").first();
const inPort = (m: Locator, port = "input") => m.locator(`.react-flow__handle.target[data-handleid="${port}"]`);

/** A dry run refused with its reason: the 400 the browser logs is the
 * preview's own, never a server failure (those stay findings). */
const dryRunRefusal = (e: { text: string; url?: string }) => /status of 400/.test(e.text) && /\/api\/operations\/run$/.test(e.url ?? "");

async function seedAll(page: Page) {
  await page.goto("/workflows");
  await seedCsv(page, stations, "name,riders,lon,lat\nalex,10450,13.4133,52.5219\nhbf,22310,13.3696,52.5251\nzoo,9000,13.3327,52.5072\n");
  await seedCsv(page, cafes, "name,kind\nkranz,cafe\nsofia,cafe\n");
  await seedFile(page, `${districts}.geojson`, fs.readFileSync(path.join(FIXTURES_DIR, "districts.geojson")), "application/geo+json");
}

test("adding, sources, linking through ports and the picker, the controls, the name, the preview", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await seedAll(page);
  const id = await newRecipe(page, `Editing ${runId}`);
  await page.goto(`/workflows/${id}`);
  await settled(page);
  const writes = watchWrites(page);

  await test.step("a Tools click adds a never-run node with defaults, a free name and a kept position; no job", async () => {
    await pane(page).getByRole("tab", { name: /^Tools/ }).click();
    await pane(page).getByRole("button", { name: "Add Buffer" }).click();
    await expect(page.locator("[data-node][data-kind='node']")).toHaveCount(1);
    const recipe = await readRecipe(page, id);
    expect(recipe.steps).toHaveLength(1);
    expect(recipe.steps[0].operation).toBe("buffer");
    expect(recipe.steps[0].parameters.name).toBe("result_buffer");
    expect(recipe.steps[0].output).toBeNull();
    expect(recipe.steps[0].latestAttempt).toBeNull();
    await expect.poll(async () => Object.keys((await readLayout(page, id)).steps)).toContain(recipe.steps[0].id);
  });

  await test.step("a Tools row dragged onto the canvas lands where it was dropped; an unavailable tool cannot be added", async () => {
    const host = await page.locator("[data-workflow-canvas]").boundingBox();
    const at = { x: host!.x + host!.width * 0.7, y: host!.y + host!.height * 0.25 };
    await drag(page, pane(page).locator("[data-tool='buffer']"), at);
    await expect(page.locator("[data-node][data-kind='node']")).toHaveCount(2);
    const recipe = await readRecipe(page, id);
    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[1].parameters.name).toBe("result_buffer_2");
    const second = member(page, "result_buffer_2");
    const box = (await tileOf(second).boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - at.x)).toBeLessThan(90);
    expect(Math.abs(box.y + box.height / 2 - at.y)).toBeLessThan(90);
    const disabled = pane(page).locator("[data-tool][disabled]");
    if ((await disabled.count()) > 0) {
      await expect(disabled.first()).toBeDisabled();
      expect(await disabled.first().getAttribute("aria-label")).toMatch(/: .+/);
    }
  });

  await test.step("a Sources row adds one loose source; again adds nothing and centres", async () => {
    await pane(page).getByRole("tab", { name: /^Sources/ }).click();
    const before = await readRecipe(page, id);
    await pane(page).locator(`[data-table="${stations}"]`).click();
    await expect(member(page, stations)).toBeVisible();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect((await readLayout(page, id)).sources).toHaveProperty(stations);
    expect((await readRecipe(page, id)).steps).toEqual(before.steps);
    await page.getByRole("button", { name: "Zoom in" }).click();
    const t0 = await viewportTransform(page);
    await pane(page).getByRole("button", { name: `${stations}, on canvas: centre the view on it` }).click();
    await expect.poll(() => viewportTransform(page)).not.toBe(t0);
    await expect(page.locator("[data-node][data-kind='source']")).toHaveCount(1);
    await pane(page).locator(`[data-table="${cafes}"]`).click();
    await expect(member(page, cafes)).toBeVisible();
  });

  await test.step("with a compatible member selected a click adds beside it, pre-linked; with an incompatible one, not", async () => {
    await selectTile(page, stations);
    await pane(page).getByRole("tab", { name: /^Tools/ }).click();
    await pane(page).getByRole("button", { name: "Add Buffer" }).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.length).toBe(3);
    let recipe = await readRecipe(page, id);
    expect(recipe.steps[2].parameters).toMatchObject({ input: stations, name: `${stations}_buffer` });
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    // Then beside a compatible node: its output pre-set.
    await selectTile(page, `${stations}_buffer`);
    await pane(page).getByRole("button", { name: "Add Buffer" }).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.length).toBe(4);
    recipe = await readRecipe(page, id);
    expect(recipe.steps[3].parameters.input).toBe(`${stations}_buffer`);
    // An incompatible one: a no-geometry table into a buffer.
    await selectTile(page, cafes);
    await pane(page).getByRole("button", { name: "Add Buffer" }).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.length).toBe(5);
    recipe = await readRecipe(page, id);
    expect(recipe.steps[4].parameters.input).toBeUndefined();
  });

  await test.step("a port drag links when the rules allow, and is refused with the reason when they do not", async () => {
    // The panel closes so no port sits under it; Arrange lays the graph out in view.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(400);
    const target = member(page, "result_buffer");
    const before = await readRecipe(page, id);
    await drag(page, outPort(member(page, cafes)), inPort(target));
    await expect(notice(page)).toContainText("holds no geometry");
    expect((await readRecipe(page, id)).steps).toEqual(before.steps);
    await drag(page, outPort(member(page, stations)), inPort(target));
    await expect.poll(async () => (await readRecipe(page, id)).steps[0].parameters.input).toBe(stations);
    await expect(notice(page)).toContainText("Linked");
    // Its own output, and a cycle, are refused. A drop on the node that
    // started the drag also selects it, so the selection is cleared between
    // gestures to keep its panel off the other tiles.
    const buffered = member(page, `${stations}_buffer`);
    await drag(page, outPort(buffered), inPort(buffered));
    await expect(notice(page)).toContainText("its own output");
    await page.keyboard.press("Escape");
    const reader = member(page, `${stations}_buffer_buffer`);
    await drag(page, outPort(reader), inPort(buffered));
    await expect(notice(page)).toContainText("loop");
    await page.keyboard.press("Escape");
  });

  await test.step("moving a filled input to an accepted target moves it, to a refused one keeps it; detaching clears it; a node-body drop fills the first empty input", async () => {
    // Drag result_buffer's link off its port onto result_buffer_2's port: moved.
    await page.keyboard.press("Escape");
    await expect(page.locator(".react-flow__edge")).toHaveCount(3);
    const target1 = member(page, "result_buffer");
    const target2 = member(page, "result_buffer_2");
    await drag(page, inPort(target1), inPort(target2));
    await expect.poll(async () => (await readRecipe(page, id)).steps[1].parameters.input).toBe(stations);
    await expect.poll(async () => (await readRecipe(page, id)).steps[0].parameters.input).toBeUndefined();
    // Detach: drag the link off the port onto the free canvas.
    const host = (await page.locator("[data-workflow-canvas]").boundingBox())!;
    await drag(page, inPort(target2), { x: host.x + host.width * 0.8, y: host.y + host.height * 0.85 });
    await expect.poll(async () => (await readRecipe(page, id)).steps[1].parameters.input).toBeUndefined();
    // Node-body drop: from the source onto result_buffer's tile.
    await drag(page, outPort(member(page, stations)), tileOf(target1));
    await expect.poll(async () => (await readRecipe(page, id)).steps[0].parameters.input).toBe(stations);
  });

  await test.step("the picker sets the same input, lists compatible members first with the others' reasons, and accepts an unproduced probed output", async () => {
    // A SQL node: its output is probed, unproduced, and still accepted.
    const sqlId = await addStep(page, id, "sql_step", { sql: `SELECT name FROM ${stations}`, name: `${stations}_named` });
    await page.reload();
    await settled(page);
    await selectTile(page, "result_buffer_2");
    // The kit's picker: a combobox whose popover lists the groups.
    const picker = panel(page).getByRole("combobox", { name: "Features to buffer" });
    await expect(picker).toBeVisible();
    await picker.click();
    const pop = page.locator("[data-picker-pop]");
    await expect(pop).toBeVisible();
    const groups = await pop.locator("[data-picker-group]").evaluateAll((els) => els.map((g) => g.getAttribute("data-picker-group")));
    expect(groups[0]).toBe("canvas");
    await expect(pop.locator(`[data-picker-group="canvas"] [data-option="${stations}_named"]`)).toHaveCount(1);
    const refused = pop.locator(`[data-picker-group="refused"] [data-option="${cafes}"]`);
    await expect(refused).toHaveCount(1);
    expect(await refused.textContent()).toContain("holds no geometry");
    await pop.locator(`[data-option="${stations}_named"]`).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.parameters.name === "result_buffer_2")?.parameters.input).toBe(`${stations}_named`);
    // The columns of an unproduced input come after its run.
    await expect(panel(page).getByText(`Columns of ${stations}_named come after its node runs.`)).toBeVisible();
    void sqlId;
  });

  await test.step("linking an earlier reader to a later producer reorders the recipe", async () => {
    // result_buffer (ordinal 0) now reads the SQL node (last): it stands after it.
    const recipe = await readRecipe(page, id);
    const sqlStep = recipe.steps.find((s) => s.operation === "sql_step")!;
    const first = recipe.steps.find((s) => s.parameters.name === "result_buffer")!;
    expect(first.ordinal).toBeLessThan(sqlStep.ordinal);
    await selectTile(page, "result_buffer");
    await panel(page).getByRole("combobox", { name: "Features to buffer" }).click();
    await page.locator(`[data-picker-pop] [data-option="${stations}_named"]`).click();
    await expect.poll(async () => {
      const r = await readRecipe(page, id);
      const a = r.steps.find((s) => s.parameters.name === "result_buffer")!;
      const b = r.steps.find((s) => s.operation === "sql_step")!;
      return a.ordinal > b.ordinal;
    }).toBe(true);
    // Two unrelated nodes keep their relative order.
    const after = await readRecipe(page, id);
    const b1 = after.steps.find((s) => s.parameters.name === `${stations}_buffer`)!;
    const b2 = after.steps.find((s) => s.parameters.name === `${stations}_buffer_buffer`)!;
    expect(b1.ordinal).toBeLessThan(b2.ordinal);
  });

  await test.step("a parameter edit lands; an out-of-bounds number is refused in the drawer's words and not sent", async () => {
    await selectTile(page, `${stations}_buffer`);
    const distance = panel(page).getByRole("spinbutton", { name: /^distance/ });
    await distance.fill("500");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.parameters.name === `${stations}_buffer`)?.parameters.distance).toBe(500);
    const seen = writes.length;
    await distance.fill("-5");
    await expect(panel(page).getByText("A distance is more than 0 metres.")).toBeVisible();
    await page.waitForTimeout(700);
    expect(writes.slice(seen).filter((r) => /\/steps\//.test(r.url()))).toEqual([]);
    expect((await readRecipe(page, id)).steps.find((s) => s.parameters.name === `${stations}_buffer`)?.parameters.distance).toBe(500);
    await distance.fill("30000000");
    await expect(panel(page).getByText(/A distance is at most/)).toBeVisible();
    await distance.fill("250");
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.parameters.name === `${stations}_buffer`)?.parameters.distance).toBe(250);
  });

  await test.step("the name: blank, letterless, a table's, a sibling's and a post-normalization collision are refused naming the holder; a good one lands registered", async () => {
    const name = panel(page).getByRole("textbox", { name: "Dataset name" });
    const problem = panel(page).locator("[data-name-problem]");
    await name.fill("");
    await expect(problem).toHaveText("The result needs a name.");
    await name.fill("!!!");
    await expect(problem).toHaveText("That name has no letters or digits in it.");
    await name.fill(stations);
    await expect(problem).toContainText(`A table named “${stations}” already exists`);
    await name.fill("result_buffer");
    await expect(problem).toContainText("Another node of this workflow (Buffer) already declares \"result_buffer\"");
    await name.fill("Result Buffer");
    await expect(problem).toContainText("already declares \"result_buffer\"");
    await name.fill("My Buffer");
    await expect(panel(page).getByText("Registered as my_buffer.")).toBeVisible();
    await expect.poll(async () => (await readRecipe(page, id)).steps.some((s) => s.parameters.name === "my_buffer")).toBe(true);
    // The API refuses the same way.
    const stepId = (await readRecipe(page, id)).steps.find((s) => s.parameters.name === "my_buffer")!.id;
    for (const bad of ["", "!!!", stations, "Result Buffer"]) {
      const r = await page.evaluate(
        async ({ id, stepId, bad }) => {
          const res = await (async function readThenWriteWorkflowSetup() { const basis = await (await fetch(`/api/recipes/${id}`)).json(); return fetch(`/api/recipes/${id}/steps/${stepId}`, { method: "PATCH", headers: { "X-Edit-Revision": basis.editRevision, "content-type": "application/json" }, body: JSON.stringify({ parameters: { input: "x", distance: 1, name: bad } }) }); })();
          return { status: res.status, text: await res.text() };
        },
        { id, stepId, bad },
      );
      expect(r.status, bad).toBeGreaterThanOrEqual(400);
      expect(r.status, bad).toBeLessThan(500);
    }
  });

  await test.step("the preview: rows and class for a classified, a no-geometry and an undetermined result, the assumed-CRS warning; an incomplete node names what is missing; nothing changes", async () => {
    const tablesBefore = await tableNames(page);
    const recipeBefore = await readRecipe(page, id);
    const layoutBefore = await readLayout(page, id);
    // my_buffer reads the stations (CRS assumed): classified, warned.
    await selectTile(page, "my_buffer");
    await expect(panel(page).locator("[data-preview-line]")).toContainText("3 rows");
    await expect(panel(page).locator("[data-preview-line]")).toContainText(/polygon/i);
    await expect(panel(page).locator("[data-preview-warning]").first()).toContainText(/WGS84 was assumed/i);
    // The SQL node: a no-geometry result.
    await selectTile(page, `${stations}_named`);
    await expect(panel(page).locator("[data-preview-line]")).toContainText("no geometry");
    // Undetermined: spatial with no rows to classify.
    const sql = panel(page).getByLabel(/^sql/);
    await sql.fill(`SELECT * FROM ${stations} WHERE 1 = 0`);
    await expect(panel(page).locator("[data-preview-line]")).toContainText("class undetermined");
    await sql.fill(`SELECT name FROM ${stations}`);
    await expect(panel(page).locator("[data-preview-line]")).toContainText("no geometry");
    // An incomplete node: the cafés buffer has no input.
    const incomplete = (await readRecipe(page, id)).steps.find((s) => s.parameters.name === `${cafes}_buffer` || (s.operation === "buffer" && !s.parameters.input));
    if (incomplete) {
      await tileOf(member(page, String(incomplete.parameters.name))).click();
      await expect(panel(page).locator("[data-preview-blocked]")).toContainText("features to buffer");
      await expect(panel(page).locator("[data-preview-line]")).toHaveCount(0);
    }
    expect(await tableNames(page)).toEqual(tablesBefore);
    expect((await readRecipe(page, id)).steps.map((s) => [s.id, s.output, s.latestAttempt])).toEqual(recipeBefore.steps.map((s) => [s.id, s.output, s.latestAttempt]));
    expect(Object.keys((await readLayout(page, id)).steps).sort()).toEqual(Object.keys(layoutBefore.steps).sort());
  });

  // The name step refuses four bad names headlessly through the edit
  // operation; the browser logs each 400 as an error. Exactly those four
  // are the test's own; any other refusal on the wire is a finding.
  const refusals = consoleErrors.filter((e) => /status of 400/.test(e.text) && /\/steps\/[^/]+$/.test(e.url ?? ""));
  expect(refusals).toHaveLength(4);
  // A dry run the panel asks for can be refused (a 400 with its reason);
  // a server failure on that route stays a finding.
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !refusals.includes(e) && !dryRunRefusal(e));
  expect(unexpected).toEqual([]);
});

test("proposals and discard, unparseable SQL, removal in three states, the keyboard, the save states", async ({ page, context }) => {
  const consoleErrors = trackConsole(page);
  await seedAll(page);
  const id = await newRecipe(page, `States ${runId}`);
  const base = await addStep(page, id, "sql_step", { sql: `SELECT name, lon, lat FROM ${stations}`, name: `${stations}_base` });
  const reader = await addStep(page, id, "sql_step", { sql: `SELECT count(*) AS n FROM ${stations}_base`, name: `${stations}_count` });
  await runAndWait(page, id, base);
  await page.goto(`/workflows/${id}`);
  await settled(page);

  await test.step("an edit to a run node is a proposal with old and new in the panel; putting it back and Discard edit each clear it", async () => {
    const node = member(page, `${stations}_base`);
    await tileOf(node).click();
    const sql = panel(page).getByLabel(/^sql/);
    await sql.fill(`SELECT name FROM ${stations}`);
    await expect(node).toHaveAttribute("data-state", "edited");
    await expect(panel(page).locator("[data-callout='edited']")).toContainText("Edited. Run to apply.");
    await expect(panel(page).locator("[data-callout='edited']")).toContainText(`SELECT name, lon, lat FROM ${stations}`);
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === base)?.proposedParameters?.sql).toBe(`SELECT name FROM ${stations}`);
    expect((await readRecipe(page, id)).steps.find((s) => s.id === base)?.parameters.sql).toBe(`SELECT name, lon, lat FROM ${stations}`);
    // Back to the active definition: cleared.
    await sql.fill(`SELECT name, lon, lat FROM ${stations}`);
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === base)?.proposedParameters).toBeNull();
    await expect(node).not.toHaveAttribute("data-state", "edited");
    // Discard in one gesture.
    await sql.fill(`SELECT name FROM ${stations}`);
    await expect(panel(page).getByRole("button", { name: "Discard edit" })).toBeVisible();
    await panel(page).getByRole("button", { name: "Discard edit" }).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === base)?.proposedParameters).toBeNull();
    await expect(sql).toHaveValue(`SELECT name, lon, lat FROM ${stations}`);
  });

  await test.step("a changed input draws the proposed read beside the lineage; unparseable SQL is saved as typed with empty reads and the preview refuses it", async () => {
    const node = member(page, `${stations}_base`);
    await tileOf(node).click();
    const sql = panel(page).getByLabel(/^sql/);
    await sql.fill(`SELECT name FROM ${cafes}`);
    await expect(page.locator(".react-flow__edge [data-time='proposed']")).toHaveCount(1);
    await expect(page.locator(".react-flow__edge [data-time='lineage']")).toHaveCount(1);
    await sql.fill("SELEC nonsense FROM");
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === base)?.proposedParameters?.sql).toBe("SELEC nonsense FROM");
    expect((await readRecipe(page, id)).steps.find((s) => s.id === base)?.reads).toEqual([]);
    await expect(panel(page).locator("[data-preview-refusal]")).toBeVisible();
    await panel(page).getByRole("button", { name: "Discard edit" }).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === base)?.proposedParameters).toBeNull();
  });

  await test.step("Saving… then Saved; Couldn't save with Retry keeps the typed value; ten quick edits reload to the last", async () => {
    const node = member(page, `${stations}_count`);
    await tileOf(node).click();
    const sql = panel(page).getByLabel(/^sql/);
    await watchWhisper(page);
    await sql.fill(`SELECT count(*) AS total FROM ${stations}_base`);
    await expect.poll(() => whispered(page)).toContain("Saved");
    expect(await whispered(page)).toContain("Saving…");
    await context.setOffline(true);
    await sql.fill(`SELECT count(*) AS kept FROM ${stations}_base`);
    await expect(page.getByText(/Couldn.t save/)).toBeVisible();
    await expect(sql).toHaveValue(`SELECT count(*) AS kept FROM ${stations}_base`);
    await context.setOffline(false);
    await watchWhisper(page);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => whispered(page)).toContain("Saved");
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === reader)?.parameters.sql).toBe(`SELECT count(*) AS kept FROM ${stations}_base`);
    for (let i = 1; i <= 10; i++) await sql.fill(`SELECT count(*) AS n${i} FROM ${stations}_base`);
    await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === reader)?.parameters.sql, { timeout: 10_000 }).toBe(`SELECT count(*) AS n10 FROM ${stations}_base`);
    await page.reload();
    await settled(page);
    await selectTile(page, `${stations}_count`);
    await expect(panel(page).getByLabel(/^sql/)).toHaveValue(`SELECT count(*) AS n10 FROM ${stations}_base`);
  });

  // The centroid added below takes its name from the selected node's output.
  let centroidName = "";
  await test.step("a position write aborted after a node was added leaves one node; Retry keeps its position without a second", async () => {
    let aborted = 0;
    await page.route(`**/api/recipes/${id}/layout`, (route) => {
      if (route.request().method() === "PUT" && aborted === 0) {
        aborted += 1;
        return route.abort();
      }
      return route.continue();
    });
    await page.keyboard.press("Escape");
    await pane(page).getByRole("tab", { name: /^Tools/ }).click();
    await pane(page).getByRole("button", { name: "Add Centroid" }).click();
    await expect(page.getByText(/Couldn.t save/)).toBeVisible();
    await expect.poll(async () => (await readRecipe(page, id)).steps.filter((s) => s.operation === "centroid").length).toBe(1);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const recipe = await readRecipe(page, id);
    expect(recipe.steps.filter((s) => s.operation === "centroid")).toHaveLength(1);
    expect((await readLayout(page, id)).steps).toHaveProperty(recipe.steps.find((s) => s.operation === "centroid")!.id);
    await page.unroute(`**/api/recipes/${id}/layout`);
    centroidName = String(recipe.steps.find((s) => s.operation === "centroid")!.parameters.name);
  });

  await test.step("Delete asks on a node and does nothing while a field has focus; a loose source goes without asking, a read one says why", async () => {
    await selectTile(page, centroidName);
    await panel(page).getByLabel(/^sql|Dataset name/).first().focus();
    await page.keyboard.press("Delete");
    await expect(page.locator("[data-removal-dialog]")).toHaveCount(0);
    await selectTile(page, centroidName);
    await page.keyboard.press("Delete");
    await expect(page.locator("[data-removal-dialog]")).toBeVisible();
    await page.locator("[data-removal-dialog]").getByRole("button", { name: "Keep" }).click();
    await expect(page.locator("[data-removal-dialog]")).toHaveCount(0);
    expect((await readRecipe(page, id)).steps.some((s) => s.operation === "centroid")).toBe(true);
    // A read source: kept, with the reason.
    await selectTile(page, stations);
    await page.keyboard.press("Delete");
    await expect(notice(page)).toContainText(`${stations} stays: a node reads it.`);
    await expect(member(page, stations)).toBeVisible();
    // A loose source: gone without asking.
    await pane(page).getByRole("tab", { name: /^Sources/ }).click();
    await pane(page).locator(`[data-table="${cafes}"]`).click();
    await expect(member(page, cafes)).toBeVisible();
    await page.getByText("Saved", { exact: true }).waitFor();
    await selectTile(page, cafes);
    await page.keyboard.press("Delete");
    await expect(member(page, cafes)).toHaveCount(0);
    await expect.poll(async () => (await readLayout(page, id)).sources).not.toHaveProperty(cafes);
  });

  await test.step("removing a node whose dataset exists: the confirmation names the dataset and its readers; the dataset stays, the reader reads it as a source, the layout forgets it", async () => {
    await selectTile(page, `${stations}_base`);
    await panel(page).getByRole("button", { name: "Remove node" }).click();
    const dialog = page.locator("[data-removal-dialog]");
    await expect(dialog).toHaveAttribute("data-dataset-state", "exists");
    await expect(dialog).toContainText(`The dataset ${stations}_base stays. SQL step goes on reading it as a workspace table.`);
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await readRecipe(page, id)).steps.some((s) => s.id === base)).toBe(false);
    expect(await tableNames(page)).toContain(`${stations}_base`);
    await expect(page.locator(`[data-node][data-kind='source']`).filter({ hasText: `${stations}_base` })).toHaveCount(1);
    await expect.poll(async () => Object.keys((await readLayout(page, id)).steps)).not.toContain(base);
    await expect(page.locator("[data-flow-area]")).toBeFocused();
  });

  await test.step("a never-run node with a sibling reading its declared output, and a node whose dataset was deleted, are asked truthfully", async () => {
    const never = await addStep(page, id, "sql_step", { sql: `SELECT 1 AS one`, name: `${stations}_never` });
    await addStep(page, id, "sql_step", { sql: `SELECT * FROM ${stations}_never`, name: `${stations}_never_reader` });
    const gone = await addStep(page, id, "sql_step", { sql: `SELECT name FROM ${stations}`, name: `${stations}_gone` });
    await runAndWait(page, id, gone);
    await api(page, "DELETE", `/api/tables/${stations}_gone`);
    await page.reload();
    await settled(page);
    await selectTile(page, `${stations}_never`);
    await panel(page).getByRole("button", { name: "Remove node" }).click();
    let dialog = page.locator("[data-removal-dialog]");
    await expect(dialog).toHaveAttribute("data-dataset-state", "never");
    await expect(dialog).toContainText(`It has made no dataset. SQL step reads ${stations}_never and stays bound to a name nothing produces.`);
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.some((s) => s.id === never)).toBe(false);
    await selectTile(page, `${stations}_gone`);
    await panel(page).getByRole("button", { name: "Remove node" }).click();
    dialog = page.locator("[data-removal-dialog]");
    await expect(dialog).toHaveAttribute("data-dataset-state", "deleted");
    await expect(dialog).toContainText(`Its dataset ${stations}_gone was deleted, so nothing is kept.`);
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.some((s) => s.id === gone)).toBe(false);
  });

  // The failures this test induced (offline, an aborted layout write) are
  // the browser's own lines about them; anything else is a defect.
  const induced = (e: { text: string; url?: string }) =>
    /ERR_INTERNET_DISCONNECTED|ERR_FAILED|ERR_NETWORK_CHANGED/.test(e.text) && (e.url ?? "").includes(`/api/`);
  // The unparseable SQL this test types is refused by the dry run, by design.
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !induced(e) && !dryRunRefusal(e));
  expect(unexpected).toEqual([]);
});

test("from an empty workflow: a source, two nodes, a chain, a parameter and a name, reloaded as built, never run", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await seedAll(page);
  const id = await newRecipe(page, `Chain ${runId}`);
  await page.goto(`/workflows/${id}`);
  await settled(page);
  await pane(page).locator(`[data-table="${districts}"]`).click();
  await expect(member(page, districts)).toBeVisible();
  await selectTile(page, districts);
  await pane(page).getByRole("tab", { name: /^Tools/ }).click();
  await pane(page).getByRole("button", { name: "Add Centroid" }).click();
  await expect.poll(async () => (await readRecipe(page, id)).steps.length).toBe(1);
  await selectTile(page, `${districts}_centroid`);
  await pane(page).getByRole("button", { name: "Add Buffer" }).click();
  await expect.poll(async () => (await readRecipe(page, id)).steps.length).toBe(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  const buffer = member(page, `${districts}_centroid_buffer`);
  await tileOf(buffer).click();
  await panel(page).getByRole("spinbutton", { name: /^distance/ }).fill("120");
  await panel(page).getByRole("textbox", { name: "Dataset name" }).fill("District rings");
  await expect.poll(async () => (await readRecipe(page, id)).steps[1]?.parameters).toMatchObject({ distance: 120, name: "district_rings", input: `${districts}_centroid` });
  await page.reload();
  await settled(page);
  await expect(page.locator("[data-node][data-kind='node']")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(member(page, "district_rings")).toBeVisible();
  const recipe = await readRecipe(page, id);
  expect(recipe.steps.map((s) => s.operation)).toEqual(["centroid", "buffer"]);
  expect(recipe.steps.every((s) => s.latestAttempt === null && s.output === null)).toBe(true);
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

/** The aggregates/carry editor's geometry in the open panel: each
 * Remove button's own box, its word's box and line count (a Range over the
 * text: the button's height is fixed at 26px, so only the word shows a
 * wrap), the boxes of its row's controls, the add button, the content
 * column (the Parameters section, a stretched child of the body, is the
 * body's content box exactly) and every control in the body's sections.
 * Read from the surface, never from the stylesheet. */
async function editorGeometry(page: Page) {
  return panel(page).evaluate((aside) => {
    const box = (el: { getBoundingClientRect(): DOMRect }) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const rows = Array.from(aside.querySelectorAll('button[aria-label^="Remove value"]')).map((btn) => {
      const range = document.createRange();
      range.selectNodeContents(btn);
      const controls = Array.from(btn.parentElement!.querySelectorAll("select, input, button")).map(box);
      return { label: btn.getAttribute("aria-label") ?? "", box: box(btn), word: box(range), lines: range.getClientRects().length, controls };
    });
    const add = aside.querySelector("[data-carry-add]");
    const section = aside.querySelector('section[aria-label="Parameters"]');
    if (!add || !section) throw new Error("the value editor is not open in the panel");
    const controls = Array.from(aside.querySelectorAll("section :is(button, input, select, textarea)"))
      .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName, ...box(el) }))
      .filter((c) => c.width > 0 || c.height > 0);
    return { content: box(section), add: box(add), rows, controls };
  });
}

/** Three facts, as a field round saw them broken: Remove whole, on
 * one line, at its word's width; the add row clear below every value row
 * (a row's extent counts its word, which a fixed-height button lets run
 * onto what stands below); nothing past the panel's content box. Soft, so
 * a failure names every broken fact of the panel at once. */
function expectEditorWhole(g: Awaited<ReturnType<typeof editorGeometry>>, where: string) {
  expect.soft(g.rows, `${where}: two value rows`).toHaveLength(2);
  g.rows.forEach((row, i) => {
    const at = `${where}: ${row.label}`;
    expect.soft(row.box.width, `${at} is ${row.box.width.toFixed(1)}px wide`).toBeGreaterThanOrEqual(48);
    expect.soft(row.lines, `${at}'s word runs over ${row.lines} line boxes`).toBe(1);
    expect.soft(row.word.height, `${at}'s word is ${row.word.height.toFixed(1)}px tall`).toBeLessThanOrEqual(32);
    const rowBottom = Math.max(row.word.bottom, ...row.controls.map((c) => c.bottom));
    expect.soft(g.add.top, `${at}: the row reaches ${rowBottom.toFixed(1)}px and Add a value starts at ${g.add.top.toFixed(1)}px`).toBeGreaterThanOrEqual(rowBottom - 0.5);
    const next = g.rows[i + 1];
    if (next) {
      const nextTop = Math.min(...next.controls.map((c) => c.top));
      expect.soft(row.word.bottom, `${at}'s word reaches ${row.word.bottom.toFixed(1)}px and the next row starts at ${nextTop.toFixed(1)}px`).toBeLessThanOrEqual(nextTop + 0.5);
    }
  });
  for (const c of g.controls) {
    expect.soft(c.right, `${where}: ${c.name} ends at ${c.right.toFixed(1)}px, the content box at ${g.content.right.toFixed(1)}px`).toBeLessThanOrEqual(g.content.right + 0.5);
  }
}

test("the aggregates and carry editors keep Remove whole on one line at the panel's width, the add row clear below, nothing sideways", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await seedAll(page);
  const id = await newRecipe(page, `Aggregates ${runId}`);
  // A hand-authored test workflow: a summary with two
  // aggregates (count needs no column), and a join carrying two values,
  // one of them named. The panel's column is 28px narrower than the
  // drawer's and inherits anywhere-wrapping.
  await addStep(page, id, "group_summarize", { input: stations, group_by: ["name"], aggregates: [{ aggregate: "count" }, { aggregate: "mean", field: "riders" }], name: `${stations}_summary` });
  await addStep(page, id, "spatial_join", { left: districts, right: stations, predicate: "intersects", carry: [{ aggregate: "count" }, { aggregate: "mean", field: "riders", as: "m" }], name: `${districts}_join` });
  await page.goto(`/workflows/${id}`);
  await settled(page);

  await test.step("the summary's aggregates: one select beside Remove", async () => {
    await selectTile(page, `${stations}_summary`);
    await expect(panel(page).locator('button[aria-label^="Remove value"]')).toHaveCount(2);
    expectEditorWhole(await editorGeometry(page), "Group & summarize");
  });

  await test.step("the join's carried values: three controls beside Remove", async () => {
    await selectTile(page, `${districts}_join`);
    await expect(panel(page).locator('button[aria-label^="Remove value"]')).toHaveCount(2);
    await expect(panel(page).getByRole("textbox", { name: "Call value 2" })).toHaveValue("m");
    expectEditorWhole(await editorGeometry(page), "Spatial join");
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !dryRunRefusal(e));
  expect(unexpected).toEqual([]);
});
