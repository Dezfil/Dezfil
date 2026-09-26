import { test, expect, type Locator, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { seedCsv, trackConsole } from "./support";

/**
 * The canvas editing round: the input picker's groups from independent
 * fixtures, its keyboard path and its proposal; the lock refusing each
 * edit path while navigation, reading and the runs stay, the recipe and
 * layout byte-equivalent after; copy and paste on the same canvas, into
 * a second workflow (a producer, a table, a missing source), a source's
 * no-op, a note's paste, foreign text, an unavailable and an unknown
 * operation, a denied clipboard, a failed layout write, a locked paste;
 * the picker's pixel capture; the stack beside the tiles (seven buttons
 * at, nine Undo and Redo). Seen red once against the shipped surface
 * (the record names the run). The server-side facts are read from the
 * recipe and layout operations, never from the surface.
 */

const runId = Date.now().toString(36);
const points = `er_points_${runId}`;
const polys = `er_polys_${runId}`;
const flat = `er_flat_${runId}`;
const MISSING = `vanished_${runId}`;
const LOCK = "Canvas locked. Unlock to edit.";

type Json = Record<string, unknown>;
type Step = Json & { id: string; operation: string; parameters: Json; proposedParameters: Json | null; output: Json | null; reads: string[]; ordinal: number };

async function api(page: Page, method: string, path: string, body?: unknown): Promise<Json> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
      return text ? (JSON.parse(text) as Json) : {};
    },
    { method, path, body },
  );
}
const newRecipe = async (page: Page, name: string) => ((await api(page, "POST", "/api/recipes", { name })).recipe as { id: string }).id;
const addStep = async (page: Page, id: string, operation: string, parameters: Json) =>
  ((await api(page, "POST", `/api/recipes/${id}/steps`, { operation, parameters })).step as { id: string }).id;
const readRecipe = async (page: Page, id: string) => (await api(page, "GET", `/api/recipes/${id}`)).recipe as Json & { steps: Step[] };
const readLayout = async (page: Page, id: string) =>
  (await api(page, "GET", `/api/recipes/${id}/layout`)).layout as Json & { steps: Record<string, { x: number; y: number }>; sources: Json; notes: Json[] };
const stepNamed = (r: { steps: Step[] }, name: string) => r.steps.find((s) => (s.proposedParameters ?? s.parameters).name === name) ?? null;

async function settled(page: Page) {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.waitForTimeout(500);
}
const member = (page: Page, name: string) => page.locator(`[data-node][data-name="${name}"]`).first();
const tileOf = (m: Locator) => m.locator("[data-v]").first();
const panel = (page: Page) => page.locator("[data-node-panel]");
const notice = (page: Page) => page.locator("[data-canvas-notice]");
const picker = (page: Page, label = "Features to buffer") => panel(page).getByRole("combobox", { name: label });
const pop = (page: Page) => page.locator("[data-picker-pop]");
const option = (page: Page, name: string) => pop(page).locator(`[data-option="${name}"]`);
const host = (page: Page) => page.locator("[data-workflow-canvas]");
const lockBtn = (page: Page) => page.getByRole("button", { name: /^(Lock|Unlock) canvas$/ });
const clipboardText = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const setClipboard = (page: Page, text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);
const box = async (loc: Locator) => {
  const b = await loc.boundingBox();
  if (!b) throw new Error("no box");
  return b;
};
/** A click near the tile's top-left corner: a pasted copy stands 24 by 24
 * down-right of its original and covers the original's centre. */
async function selectTile(page: Page, name: string) {
  await tileOf(member(page, name)).click({ position: { x: 10, y: 10 } });
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(300);
}
/** The editing requests the app sends: what a locked canvas must not send.
 * A run's requests are not edits (runs stay). */
function watchMutations(page: Page): { method: string; url: string }[] {
  const seen: { method: string; url: string }[] = [];
  page.on("request", (r) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(r.method()) && r.url().includes("/api/recipes/") && !/\/runs(\/|\?|$)/.test(r.url())) seen.push({ method: r.method(), url: r.url() });
  });
  return seen;
}
/** Run the named Buffer and what follows it (the unnamed Buffer and the one
 * reading a vanished table cannot run): the Buffer then holds a last run. */
async function runOnce(page: Page, id: string, from: string) {
  await api(page, "POST", `/api/recipes/${id}/runs`, { fromStepId: from });
  await expect.poll(async () => (await readRecipe(page, id)).steps.find((s) => s.id === from)?.output ?? null, { timeout: 40_000 }).not.toBeNull();
  await page.waitForTimeout(400);
}
/** A point on the canvas background near the fraction asked for. */
async function paneAt(page: Page, fx: number, fy: number) {
  const area = (await page.locator("[data-flow-area]").boundingBox())!;
  const candidates: { x: number; y: number }[] = [];
  for (let dy = 0; dy <= 0.5; dy += 0.05) for (let dx = 0; dx <= 0.5; dx += 0.05) candidates.push({ x: area.x + area.width * Math.min(0.95, fx + dx), y: area.y + area.height * Math.min(0.85, fy + dy) });
  const found = await page.evaluate((points) => points.find((p) => document.elementFromPoint(p.x, p.y)?.classList.contains("react-flow__pane")) ?? null, candidates);
  if (!found) throw new Error("no background point found");
  return found;
}

/** The fixtures: points and polygons in the workspace, a table without
 * geometry, and a workflow whose Buffer reads the points, whose Filter
 * rows reads the Buffer (so the Buffer's picker sees a loop), whose
 * second Buffer has no name (an unnamed output), and whose third names a
 * table that does not exist (a missing source). */
async function seedWorkflow(page: Page, tag: string) {
  await page.goto("/workflows");
  await seedCsv(page, points, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n").catch(() => undefined);
  await seedCsv(page, polys, "name,wkt\na,\"POLYGON((13.3 52.5,13.5 52.5,13.5 52.6,13.3 52.6,13.3 52.5))\"\n").catch(() => undefined);
  await seedCsv(page, flat, "name,value\na,1\nb,2\n").catch(() => undefined);
  const id = await newRecipe(page, `Editing round ${tag} ${runId}`);
  const buf = await addStep(page, id, "buffer", { input: points, distance: 100, name: `${points}_buffer_${tag}` });
  await addStep(page, id, "filter_rows", { input: `${points}_buffer_${tag}`, column: "name", op: "is_not_null", name: `${points}_filtered_${tag}` });
  await addStep(page, id, "buffer", { input: points, distance: 50 });
  await addStep(page, id, "buffer", { input: MISSING, distance: 50, name: `${points}_gone_${tag}` });
  return { id, buf, bufName: `${points}_buffer_${tag}`, filtered: `${points}_filtered_${tag}` };
}

test("the picker: groups from fixtures, the keyboard path, a choice that stays a proposal, a source tile for a workspace table", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  const w = await seedWorkflow(page, "pk");
  // A run first, so a later choice is a proposal (the node holds a last run).
  await runOnce(page, w.id, w.buf);
  await page.goto(`/workflows/${w.id}`);
  await settled(page);
  await selectTile(page, w.bufName);

  await test.step("closed: glyph, name and fact; the accepted kinds as glyphs; no sentence", async () => {
    const trigger = picker(page);
    await expect(trigger).toHaveAttribute("data-value", points);
    await expect(trigger).toContainText(points);
    await expect(trigger).toContainText("2 rows");
    await expect(panel(page).locator('[data-accepts="point line polygon"]')).toHaveCount(1);
    await expect(panel(page).getByText(/Accepts point, line, polygon\./)).toHaveCount(0);
    // The SQL node has no picker: every named input has one (the filter's too).
    await expect(panel(page).getByRole("combobox")).toHaveCount(1);
  });

  await test.step("open: the three groups in order, the refusals with their words, the target's own output absent", async () => {
    await picker(page).click();
    await expect(pop(page)).toBeVisible();
    const groups = await pop(page).locator("[data-picker-group]").evaluateAll((els) => els.map((e) => e.getAttribute("data-picker-group")));
    expect(groups).toEqual(["canvas", "tables", "refused"]);
    await expect(option(page, points)).toHaveAttribute("data-on", "true");
    expect(await option(page, points).getAttribute("data-refused")).toBeNull();
    await expect(pop(page).locator(`[data-picker-group="tables"] [data-option="${polys}"]`)).toHaveCount(1);
    const refused = pop(page).locator('[data-picker-group="refused"]');
    await expect(refused.locator(`[data-option="${w.filtered}"]`)).toContainText(/would make a loop/i);
    await expect(refused.locator(`[data-option="${MISSING}"]`)).toContainText(/does not exist/);
    await expect(refused.locator(`[data-option="${flat}"]`)).toContainText(/no geometry/);
    await expect(refused.locator("li[role='option']").filter({ hasText: "not named" })).toHaveCount(1);
    await expect(option(page, w.bufName)).toHaveCount(0);
    await expect(pop(page).locator("[role='option']").first()).toContainText("not set");
    // Search filters every group and says when nothing matches.
    await pop(page).getByRole("textbox").fill("zzz-nothing");
    await expect(pop(page)).toContainText("No source matches");
    await pop(page).getByRole("textbox").fill(polys.slice(3, 12));
    await expect(option(page, polys)).toHaveCount(1);
    await expect(option(page, points)).toHaveCount(0);
  });

  await test.step("the keyboard: Escape closes and returns focus; arrows reach a refused row and its reason; Enter chooses", async () => {
    await page.keyboard.press("Escape");
    await expect(pop(page)).toHaveCount(0);
    await expect(picker(page)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(pop(page)).toBeVisible();
    const active = () => pop(page).locator("[role='option'][data-active]");
    await expect(active()).toContainText("not set");
    // Walk to the last row: a refused one, with its reason exposed as its description.
    await page.keyboard.press("End");
    await expect(active()).toHaveAttribute("data-refused", "true");
    const describedBy = await active().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).not.toBeEmpty();
    // Enter on a refused row chooses nothing; on the polygons it chooses.
    await page.keyboard.press("Enter");
    await expect(pop(page)).toBeVisible();
    await pop(page).getByRole("textbox").fill(polys);
    await page.keyboard.press("ArrowDown");
    await expect(active()).toHaveAttribute("data-option", polys);
    await page.keyboard.press("Enter");
    await expect(pop(page)).toHaveCount(0);
    await expect(picker(page)).toBeFocused();
  });

  await test.step("the choice is a proposal on a run node, and the workspace table's source tile appears", async () => {
    await expect.poll(async () => stepNamed(await readRecipe(page, w.id), w.bufName)?.proposedParameters?.input ?? null).toBe(polys);
    expect(stepNamed(await readRecipe(page, w.id), w.bufName)!.parameters.input).toBe(points);
    await expect(panel(page).locator('[data-callout="edited"]')).toBeVisible();
    await expect(page.locator(`[data-node][data-kind="source"][data-name="${polys}"]`)).toHaveCount(1);
    await expect(picker(page)).toHaveAttribute("data-value", polys);
    // Detach stays beside a set value.
    await expect(panel(page).getByRole("button", { name: "Detach Features to buffer" })).toBeVisible();
  });

  await test.step("a locked node's picker closes and cannot change", async () => {
    await picker(page).click();
    await expect(pop(page)).toBeVisible();
    await lockBtn(page).click();
    await expect(pop(page)).toHaveCount(0);
    await expect(picker(page)).toBeDisabled();
    await lockBtn(page).click();
    await expect(picker(page)).toBeEnabled();
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

test("the lock: each edit path refused with the reason, navigation and runs kept, the recipe and layout unchanged", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  const w = await seedWorkflow(page, "lk");
  await page.goto(`/workflows/${w.id}`);
  await settled(page);
  // A note to try editing while locked.
  await page.locator("[data-note-tool]").click();
  const at = await paneAt(page, 0.5, 0.72);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator("[data-note-field]")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const recipeBefore = await readRecipe(page, w.id);
  const layoutBefore = await readLayout(page, w.id);
  const mutations = watchMutations(page);

  await test.step("the seventh button and the pill", async () => {
    await expect(lockBtn(page)).toHaveAttribute("aria-pressed", "false");
    await lockBtn(page).click();
    await expect(page.getByRole("button", { name: "Unlock canvas" })).toHaveAttribute("aria-pressed", "true");
    await expect(host(page)).toHaveAttribute("data-locked", "true");
    await expect(page.locator("[data-lock-pill]")).toContainText("Canvas locked");
    await expect(page.locator("[data-lock-pill] [data-unlock]")).toBeVisible();
    // The sentence reads on screen as written: the space before the unlock
    // action is rendered, not lost between the pill's flex items (read
    // "until youunlock.").
    await expect(page.locator("[data-lock-pill]")).toHaveText(/until you unlock\./, { useInnerText: true });
  });

  await test.step("blocked: drag, ports, pane, note tool, Arrange, delete, panel edits, note edit, paste", async () => {
    // A drag on a tile moves nothing: the node's own place (its transform
    // in flow units) stays; the hand may pan the canvas under the pointer.
    const tile = tileOf(member(page, w.bufName));
    const wrapper = page.locator(`.react-flow__node[data-id="${w.buf}"]`);
    const placeBefore = await wrapper.evaluate((el) => (el as HTMLElement).style.transform);
    const before = await box(tile);
    await tile.hover();
    await page.mouse.down();
    await page.mouse.move(before.x + 120, before.y + 90, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await wrapper.evaluate((el) => (el as HTMLElement).style.transform)).toBe(placeBefore);
    await expect(page.locator(".react-flow__handle:visible")).toHaveCount(0);
    const pane = page.locator("[data-canvas-pane]");
    await expect(pane.locator("[data-pane-locked]")).toHaveText(LOCK);
    await expect(pane.getByRole("button", { name: `Add ${polys} to the canvas: ${LOCK}` })).toBeDisabled();
    await expect(pane.getByRole("button", { name: `Add data: ${LOCK}` })).toBeDisabled();
    await pane.getByRole("tab", { name: /^Tools/ }).click();
    await expect(pane.getByRole("button", { name: `Add Buffer: ${LOCK}` })).toBeDisabled();
    await expect(page.getByRole("button", { name: `Add a note: ${LOCK}` })).toBeDisabled();
    await expect(page.getByRole("button", { name: `Arrange by dependency: ${LOCK}` })).toBeDisabled();
    // The panel reads; its fieldsets are inert with the reason; removal and Discard withheld.
    await selectTile(page, w.bufName);
    await expect(panel(page).locator("[data-lock-reason]")).toHaveText(LOCK);
    // The fieldsets are disabled (a control inside reads so; Playwright does not read a fieldset's
    // own flag).
    await expect(panel(page).locator("fieldset[data-inert]").first()).toHaveAttribute("disabled", "");
    await expect(panel(page).getByRole("spinbutton", { name: /^distance/i })).toBeDisabled();
    await expect(picker(page)).toBeDisabled();
    await expect(panel(page).locator("[data-remove-withheld]")).toHaveText(LOCK);
    await expect(panel(page).getByRole("button", { name: "Remove node" })).toHaveCount(0);
    // Delete by key on the selected node: refused with the reason.
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("Delete");
    await expect(notice(page)).toContainText(LOCK);
    // N and the note: no editor, no menu, no colour.
    await page.keyboard.press("n");
    await expect(host(page)).not.toHaveAttribute("data-mode", "note");
    const note = page.locator("[data-note]").first();
    await note.dblclick();
    await expect(page.locator("[data-note-field]")).toHaveCount(0);
    await page.mouse.click((await box(note)).x + 30, (await box(note)).y + 60);
    await expect(page.locator("[data-note-menu]")).toHaveCount(0);
    // Paste adds nothing and says the reason.
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect(notice(page)).toContainText(LOCK);
  });

  await test.step("kept: selection and reading, zoom, fit, the view toggle, the minimap, the runs", async () => {
    // The zoom is read from the viewport itself: the readout under the stack
    // was removed on a field-round ruling.
    const zoomOf = () => page.locator(".react-flow__viewport").evaluate((el) => /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? "1");
    const z0 = await zoomOf();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(zoomOf).not.toBe(z0);
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.getByRole("button", { name: "Framed view" }).click();
    await expect(host(page)).toHaveAttribute("data-view", "framed");
    await page.getByRole("button", { name: "Fill the screen" }).click();
    await expect(host(page)).toHaveAttribute("data-view", "full");
    await expect(page.locator("[data-minimap]")).toHaveCount(1);
    // Selecting a tile still opens its panel to read (the note took the selection above).
    await selectTile(page, w.bufName);
    await expect(panel(page)).toBeVisible();
    await page.getByRole("button", { name: "Run all" }).click();
    const confirm = page.locator("[data-run-confirm]");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("nothing was sent; the recipe and the layout read byte-equivalent", async () => {
    expect(mutations).toEqual([]);
    const recipeAfter = await readRecipe(page, w.id);
    const layoutAfter = await readLayout(page, w.id);
    expect(recipeAfter.steps.map((s) => [s.id, s.parameters, s.proposedParameters])).toEqual(recipeBefore.steps.map((s) => [s.id, s.parameters, s.proposedParameters]));
    expect(layoutAfter.steps).toEqual(layoutBefore.steps);
    expect(layoutAfter.notes).toEqual(layoutBefore.notes);
  });

  await test.step("the pill's unlock; a reload starts unlocked", async () => {
    await page.locator("[data-lock-pill] [data-unlock]").click();
    await expect(host(page)).not.toHaveAttribute("data-locked", "true");
    await lockBtn(page).click();
    await expect(host(page)).toHaveAttribute("data-locked", "true");
    await page.reload();
    await settled(page);
    await expect(host(page)).not.toHaveAttribute("data-locked", "true");
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

test("copy and paste: the item against the recipe, the diagonal, a second workflow, a source, a note, foreign and refused items, a locked paste", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const consoleErrors = trackConsole(page);
  const w = await seedWorkflow(page, "cp");
  await page.goto(`/workflows/${w.id}`);
  await settled(page);

  await test.step("copy writes the item the recipe read agrees with", async () => {
    await selectTile(page, w.bufName);
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+c");
    await expect(notice(page)).toContainText("Copied Buffer");
    const raw = await clipboardText(page);
    const parsed = JSON.parse(raw) as Json;
    const step = stepNamed(await readRecipe(page, w.id), w.bufName)!;
    expect(parsed["dezfil-canvas-item"]).toBe(1);
    expect(parsed.kind).toBe("node");
    expect(parsed.operation).toBe("buffer");
    expect(parsed.parameters).toEqual(step.parameters);
    expect(Object.keys(parsed).sort()).toEqual(["kind", "operation", "parameters", "dezfil-canvas-item"]);
  });

  let firstPaste = "";
  await test.step("paste: same operation and values, a fresh name, never run, 24 by 24 from the original, selected; a second one a step further", async () => {
    const before = await readRecipe(page, w.id);
    const original = stepNamed(before, w.bufName)!;
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(before.steps.length + 1);
    const after = await readRecipe(page, w.id);
    const pasted = after.steps.find((s) => !before.steps.some((b) => b.id === s.id))!;
    firstPaste = pasted.parameters.name as string;
    expect(pasted.operation).toBe("buffer");
    expect(firstPaste).toBe(`${points}_buffer`);
    expect({ ...pasted.parameters, name: original.parameters.name }).toEqual(original.parameters);
    expect(pasted.output).toBeNull();
    expect(pasted.proposedParameters).toBeNull();
    expect(pasted.reads).toContain(points);
    await expect(notice(page)).toContainText(`Pasted Buffer as ${firstPaste}`);
    await expect.poll(async () => {
      const l = await readLayout(page, w.id);
      const o = l.steps[original.id];
      const p = l.steps[pasted.id];
      return o && p ? [p.x - o.x, p.y - o.y] : null;
    }).toEqual([24, 24]);
    await expect(member(page, firstPaste)).toHaveAttribute("data-sel", "true");
    await expect(member(page, firstPaste).locator(".react-flow__handle.target").first()).toHaveClass(/on|react-flow__handle/);
    // A second paste, a step further down the diagonal, with the next name:
    // this time with the selected node's own wrapper holding focus, the
    // case whose paste event targets the document (the smoke's crash).
    await page.locator(".react-flow__node.selected").first().focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(before.steps.length + 2);
    const second = (await readRecipe(page, w.id)).steps.find((s) => s.parameters.name === `${points}_buffer_2`)!;
    expect(second).toBeTruthy();
    await expect.poll(async () => {
      const l = await readLayout(page, w.id);
      const o = l.steps[original.id];
      const p = l.steps[second.id];
      return o && p ? [p.x - o.x, p.y - o.y] : null;
    }).toEqual([48, 48]);
    await expect(member(page, `${points}_buffer_2`)).toHaveAttribute("data-sel", "true");
  });

  await test.step("a second workflow: a producer of the name, a workspace table, a missing source", async () => {
    const w2 = await newRecipe(page, `Editing round target ${runId}`);
    // A producer of the Buffer's output name, unrun: the pasted Filter rows reads it.
    await addStep(page, w2, "buffer", { input: points, distance: 5, name: w.bufName });
    await page.goto(`/workflows/${w.id}`);
    await settled(page);
    await selectTile(page, w.filtered);
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+c");
    await expect(notice(page)).toContainText("Copied Filter rows");
    await page.goto(`/workflows/${w2}`);
    await settled(page);
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => (await readRecipe(page, w2)).steps.length).toBe(2);
    const filtered = (await readRecipe(page, w2)).steps.find((s) => s.operation === "filter_rows")!;
    expect(filtered.parameters.input).toBe(w.bufName);
    // The producer here answers to the name: no missing source for it, a member instead.
    await expect(page.locator(`[data-node][data-kind="node"][data-name="${w.bufName}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-node][data-kind="source"][data-name="${w.bufName}"]`)).toHaveCount(0);
    // A workspace table: the first Buffer pasted here reads the points table as a source tile.
    await page.goto(`/workflows/${w.id}`);
    await settled(page);
    await selectTile(page, w.bufName);
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+c");
    await page.goto(`/workflows/${w2}`);
    await settled(page);
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => (await readRecipe(page, w2)).steps.length).toBe(3);
    await expect(page.locator(`[data-node][data-kind="source"][data-name="${points}"]`)).toHaveCount(1);
    // A missing source: the node that names the vanished table pastes with the dashed tile.
    await page.goto(`/workflows/${w.id}`);
    await settled(page);
    await selectTile(page, `${points}_gone_cp`);
    await expect(panel(page)).toContainText(MISSING);
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+c");
    // The copy's system write is asynchronous and the page's own memory of
    // it dies with the page: wait for the copy's notice, which the hook
    // says only once the write has settled, before navigating away — as
    // this test's earlier copies do. Without it the next page pasted the
    // clipboard's earlier text.
    await expect(notice(page)).toContainText("Copied Buffer");
    await page.goto(`/workflows/${w2}`);
    await settled(page);
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => (await readRecipe(page, w2)).steps.length).toBe(4);
    await expect(page.locator(`[data-node][data-kind="source"][data-missing][data-name="${MISSING}"]`)).toHaveCount(1);
  });

  await test.step("a source copies nothing and invalidates the earlier item; a note pastes as its Duplicate", async () => {
    await page.goto(`/workflows/${w.id}`);
    await settled(page);
    const steps = (await readRecipe(page, w.id)).steps.length;
    await tileOf(page.locator(`[data-node][data-kind="source"][data-name="${points}"]`)).click();
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+c");
    await expect(notice(page)).toContainText("on the canvas once");
    expect(await clipboardText(page)).toBe(points);
    await page.keyboard.press("ControlOrMeta+v");
    await page.waitForTimeout(600);
    expect((await readRecipe(page, w.id)).steps.length).toBe(steps);
    await expect(page.locator(`[data-node][data-kind="source"][data-name="${points}"]`)).toHaveCount(1);
    // A note.
    await page.locator("[data-note-tool]").click();
    const at = await paneAt(page, 0.5, 0.72);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator("[data-note-field]")).toBeFocused();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const notesBefore = (await readLayout(page, w.id)).notes as { id: string; x: number; y: number; text: string; color: string }[];
    expect(notesBefore.length).toBe(1);
    await page.keyboard.press("ControlOrMeta+c");
    await expect(notice(page)).toContainText("Copied the note");
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => ((await readLayout(page, w.id)).notes as unknown[]).length).toBe(2);
    const notesAfter = (await readLayout(page, w.id)).notes as { id: string; x: number; y: number; text: string; color: string }[];
    const copy = notesAfter.find((n) => n.id !== notesBefore[0].id)!;
    expect([copy.x - notesBefore[0].x, copy.y - notesBefore[0].y, copy.text, copy.color]).toEqual([32, 32, notesBefore[0].text, notesBefore[0].color]);
  });

  await test.step("foreign text, an unavailable and an unknown operation add nothing, each with its reason", async () => {
    const steps = (await readRecipe(page, w.id)).steps.length;
    await setClipboard(page, "SELECT 1");
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+v");
    await page.waitForTimeout(500);
    expect((await readRecipe(page, w.id)).steps.length).toBe(steps);
    await setClipboard(page, JSON.stringify({ "dezfil-canvas-item": 1, kind: "node", operation: "isochrone", parameters: { input: points, name: "iso_x" } }));
    await page.keyboard.press("ControlOrMeta+v");
    await expect(notice(page)).toContainText(/Isochrone/);
    expect((await readRecipe(page, w.id)).steps.length).toBe(steps);
    await setClipboard(page, JSON.stringify({ "dezfil-canvas-item": 1, kind: "node", operation: "teleport", parameters: { name: "tp_x" } }));
    await page.keyboard.press("ControlOrMeta+v");
    await expect(notice(page)).toHaveAttribute("data-tone", "bad");
    expect((await readRecipe(page, w.id)).steps.length).toBe(steps);
  });

  await test.step("a failed layout write leaves one node and Retry stores its position once", async () => {
    const steps = (await readRecipe(page, w.id)).steps.length;
    await selectTile(page, w.bufName);
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+c");
    await expect(notice(page)).toContainText("Copied Buffer");
    expect(JSON.parse(await clipboardText(page)).operation).toBe("buffer");
    await page.route("**/api/recipes/*/layout", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(steps + 1);
    const retry = page.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible({ timeout: 10_000 });
    await page.unroute("**/api/recipes/*/layout");
    // The whisper re-renders as its state settles; the click goes to the button as it stands.
    await page.evaluate(() => (Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Retry") as HTMLElement | undefined)?.click());
    await page.waitForTimeout(800);
    expect((await readRecipe(page, w.id)).steps.length).toBe(steps + 1);
    const pasted = (await readRecipe(page, w.id)).steps[steps];
    await expect.poll(async () => (await readLayout(page, w.id)).steps[pasted.id] ?? null).not.toBeNull();
  });

  await test.step("a locked paste reports the lock and changes nothing", async () => {
    const steps = (await readRecipe(page, w.id)).steps.length;
    await lockBtn(page).click();
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect(notice(page)).toContainText(LOCK);
    await page.waitForTimeout(400);
    expect((await readRecipe(page, w.id)).steps.length).toBe(steps);
    await lockBtn(page).click();
  });

  // This test induces three: the add operation's 400 for the unknown tool, the layout write it
  // aborted, and the panel's dry run refused for the node that names a vanished table.
  const induced = (e: { text: string; url?: string }) =>
    (/status of 400/.test(e.text) && /\/steps$/.test(e.url ?? "")) ||
    (/ERR_FAILED/.test(e.text) && /\/layout$/.test(e.url ?? "")) ||
    (/status of 40[04]/.test(e.text) && /\/api\/operations\/run$/.test(e.url ?? ""));
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !induced(e));
  expect(unexpected).toEqual([]);
});

test("a denied clipboard: copy keeps a page-local item with its notice, paste uses it on this canvas", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")), readText: () => Promise.reject(new Error("denied")) }, configurable: true });
    // The copy event's own write is refused too, as an origin that withholds the clipboard refuses
    // it.
    document.addEventListener("copy", (e) => e.stopImmediatePropagation(), true);
  });
  const w = await seedWorkflow(page, "dn");
  await page.goto(`/workflows/${w.id}`);
  await settled(page);
  await selectTile(page, w.bufName);
  await page.locator("[data-flow-area]").focus();
  await page.keyboard.press("ControlOrMeta+c");
  await expect(notice(page)).toContainText("withheld");
  const steps = (await readRecipe(page, w.id)).steps.length;
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(steps + 1);
});

test("the stack, eight buttons since the pair moved to the header and the minimap's toggle joined, stays a column beside the tiles", async ({ page }) => {
  const w = await seedWorkflow(page, "st");
  await page.goto(`/workflows/${w.id}`);
  await settled(page);
  await selectTile(page, w.bufName);
  const stack = await box(page.locator("[data-canvas-stage]"));
  expect(stack.width).toBeLessThan(60);
  // Seven at; nine with Undo and Redo; eight since the pair moved to the
  // header and the minimap gained a toggle.
  await expect(page.locator("[data-canvas-stage] button")).toHaveCount(8);
  // A tile beside the stack, at the stack's own height, opens its panel on a click.
  const tile = member(page, w.filtered);
  const t = await box(tileOf(tile));
  expect(t.x).toBeGreaterThan(stack.x + stack.width);
  await tileOf(tile).click();
  await expect(panel(page)).toContainText("Filter rows");
});

for (const theme of ["light", "dark"] as const) {
  test(`the open picker with a refused row matches the ${theme} baseline`, async ({ page }) => {
    test.skip(process.platform !== "darwin", "pixel baselines are darwin-generated; no baseline exists for this platform");
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    // Fixed names, so the capture carries nothing run-scoped: the tables
    // survive from an earlier run (the upload's refusal is ignored) and
    // an unrun declaration is no reservation across workflows.
    await page.goto("/workflows");
    // Uploaded once: an upload under a taken name would mint pk_points_2 and change the rows.
    const have = new Set(((await api(page, "GET", "/api/tables")) as unknown as { name: string }[]).map((t) => t.name));
    if (!have.has("pk_points")) await seedCsv(page, "pk_points", "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
    if (!have.has("pk_flat")) await seedCsv(page, "pk_flat", "name,value\na,1\n");
    const id = await newRecipe(page, `Picker capture ${theme} ${runId}`);
    await addStep(page, id, "buffer", { input: "pk_points", distance: 100, name: "pk_points_buffer" });
    await addStep(page, id, "filter_rows", { input: "pk_points_buffer", column: "name", op: "is_not_null", name: "pk_points_filtered" });
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await selectTile(page, "pk_points_buffer");
    await picker(page).click();
    await expect(pop(page)).toBeVisible();
    await pop(page).getByRole("textbox").fill("pk_points");
    await expect(option(page, "pk_points_filtered")).toHaveAttribute("data-refused", "true");
    await page.waitForTimeout(300);
    // The popover's own box, not a page clip around it: the clip's
    // rounded margin sampled the canvas beneath, whose tiles and
    // sub-pixel offsets differ from run to run; the element capture holds
    // the picker's dress and nothing else. Re-minted with this change.
    await expect(pop(page)).toHaveScreenshot(`picker-open-${theme}.png`, { animations: "disabled", threshold: 0 });
  });
}
