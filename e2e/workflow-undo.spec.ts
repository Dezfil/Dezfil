import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
import { test, expect, type Locator, type Page, type Request } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { seedCsv, trackConsole } from "./support";

/**
 * Undo and redo on the canvas: the stack's nine buttons in the
 * reference's order with the count pin; every layout step and every
 * recipe step undone and redone against the
 * layout and recipe reads, Arrange first, one layout write per layout
 * undo; the pending work, run boundary and refusals; the
 * chord in each editable control and after a stage button; the lock;
 * the session and the API. The oracle for every stored fact is the
 * layout read and the recipe read, captured independently of the canvas;
 * the record's own contents are never the oracle. *No write* is the
 * absence of a request, counted independently. Seen red once against the
 * shipped surface (the record names the run): the buttons absent, the
 * chord doing nothing.
 */

const runId = Date.now().toString(36);
const points = `ud_points_${runId}`;
const polys = `ud_polys_${runId}`;
const flat = `ud_flat_${runId}`;
const LOCK = "Canvas locked. Unlock to edit.";
const NEW_TEXT = "---\nlabel: note\n---\n";
// The engine's own endless statement (the runs journey holds the lane with it).
const ENDLESS = "SELECT count(*) AS n FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";

type Json = Record<string, unknown>;
type Step = Json & { id: string; operation: string; ordinal: number; parameters: Json; proposedParameters: Json | null; output: Json | null; latestAttempt: Json | null; lastSuccessAt: string | null; reads: string[] };
type Note = { id: string; x: number; y: number; w: number; h: number; color: string; text: string };
type Position = { x: number; y: number };
type Layout = { steps: Record<string, Position>; sources: Record<string, Position>; notes: Note[]; updatedAt: string | null };
type Recipe = Json & { steps: Step[]; updatedAt: string };
type Run = { id: string; outcome: string | null; members: { stepId: string; state: string }[] };

async function api(page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<Json> {
  return page.evaluate(
    async ({ method, path, body, basis }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
      return text ? (JSON.parse(text) as Json) : {};
    },
    { method, path, body, basis },
  );
}
const made: string[] = [];
const newRecipe = async (page: Page, name: string) => {
  const id = ((await api(page, "POST", "/api/recipes", { name })).recipe as { id: string }).id;
  made.push(id);
  return id;
};
const addStep = async (page: Page, id: string, operation: string, parameters: Json) =>
  ((await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps`, body: { operation, parameters } })).then(result => result.json)).step as { id: string }).id;
const readRecipe = async (page: Page, id: string) => (await api(page, "GET", `/api/recipes/${id}`)).recipe as Recipe;
const readLayout = async (page: Page, id: string) => (await api(page, "GET", `/api/recipes/${id}/layout`)).layout as Layout;
const putLayout = (page: Page, id: string, layout: Partial<Layout>) => readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "PUT", path: `/api/recipes/${id}/layout`, body: { steps: {}, sources: {}, notes: [], ...layout } })).then(result => result.json);
const stepById = (r: Recipe, id: string) => r.steps.find((s) => s.id === id) ?? null;
/** The positions of a read: what a layout undo restores, field for field. */
const positionsOf = (l: Layout) => ({ steps: l.steps, sources: l.sources });
/** A node's definition and proposal state: what a recipe undo restores. */
const definitionOf = (s: Step | null) => (s ? { parameters: s.parameters, proposedParameters: s.proposedParameters } : null);
const tableNames = async (page: Page) => (await page.evaluate(async () => ((await (await fetch("/api/tables")).json()) as { name: string }[]).map((t) => t.name))).sort();
/** How many runs the workflow has, read independently of the canvas. */
const runCount = async (page: Page, id: string) => (((await api(page, "GET", `/api/recipes/${id}/runs`)).runs as Run[]) ?? []).length;
/**
 * A run started from the canvas, waited out the way an undo waits for it:
 * the server has finished every run, and the canvas has let go of the one
 * it followed, which is when a member stops being unsettled. The dock is
 * never the signal on its own — it keeps the word *ended* from the run
 * before this one, so a fixed pause after it is a pause and nothing more,
 * and the press that followed was refused with the run's reason instead.
 */
async function runSettled(page: Page, id: string, before: number) {
  await expect
    .poll(
      async () => {
        const runs = ((await api(page, "GET", `/api/recipes/${id}/runs`)).runs as Run[]) ?? [];
        if (runs.length <= before || runs.some((r) => r.outcome === null)) return false;
        // The server is done; the canvas is done when its own post-run
        // reads have landed and the overlay has lifted.
        const phase = await page.locator("[data-run-chrome]").getAttribute("data-phase");
        const dock = await page.locator("[data-run-dock]").getAttribute("data-run-dock");
        return phase === "idle" && dock === "ended";
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}
async function runAndWait(page: Page, id: string, stepId: string) {
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps/${stepId}/run` })).then(result => result.json);
  await expect.poll(async () => stepById(await readRecipe(page, id), stepId)?.output ?? null, { timeout: 40_000 }).not.toBeNull();
  await page.waitForTimeout(400);
}
// A run in flight must not hold the lane for what follows: every recipe made here is cancelled
// after.
test.afterEach(async ({ page }) => {
  for (const id of made.splice(0)) {
    const runs = ((await api(page, "GET", `/api/recipes/${id}/runs`).catch(() => ({}) as Json)).runs as Run[] | undefined) ?? [];
    for (const run of runs.filter((r) => r.outcome === null)) await api(page, "POST", `/api/recipes/${id}/runs/${run.id}/cancel`).catch(() => undefined);
  }
});

async function settled(page: Page) {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.waitForTimeout(500);
}
const host = (page: Page) => page.locator("[data-workflow-canvas]");
const stage = (page: Page) => page.locator("[data-canvas-stage]");
// The pair lives in the workspace header beside the theme toggle, after
// a field round, as the builder's.
const undoBtn = (page: Page) => page.locator("#header-actions-left [data-undo]");
const redoBtn = (page: Page) => page.locator("#header-actions-left [data-redo]");
const lockBtn = (page: Page) => page.getByRole("button", { name: /^(Lock|Unlock) canvas$/ });
const member = (page: Page, name: string) => page.locator(`[data-node][data-name="${name}"]`).first();
const tileOf = (m: Locator) => m.locator("[data-v]").first();
const wrapper = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const panel = (page: Page) => page.locator("[data-node-panel]");
const notice = (page: Page) => page.locator("[data-canvas-notice]");
const pane = (page: Page) => page.locator("[data-canvas-pane]");
const flowArea = (page: Page) => page.locator("[data-flow-area]");
const noteEl = (page: Page, id: string) => page.locator(`[data-note][data-note-id="${id}"]`);
const noteNode = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="note:${id}"]`);
const menu = (page: Page) => page.locator("[data-note-menu]");
const viewportTransform = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);
const zoomOf = async (page: Page) => Number(await page.locator(".react-flow__viewport").evaluate((el) => /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? "1"));
const box = async (loc: Locator) => {
  const b = await loc.boundingBox();
  if (!b) throw new Error("no box");
  return b;
};
/** A press of Undo or Redo by its button; the chord has its own steps. */
const undo = (page: Page) => undoBtn(page).click();
const redo = (page: Page) => redoBtn(page).click();
/** Select a member by its tile: the selection cleared and the view fitted first, since a tile can sit under the pane or a panel. */
async function selectTile(page: Page, name: string) {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit to view" }).click();
  await page.waitForTimeout(350);
  await tileOf(member(page, name)).click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(250);
}
/** Select a member by keyboard, as the arrow keys need: its wrapper focused, Enter. */
async function selectByKey(page: Page, id: string) {
  await page.keyboard.press("Escape");
  await wrapper(page, id).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
}
/** A drag by an offset in screen pixels, from a locator's centre, in steps. */
async function dragBy(page: Page, from: Locator, dx: number, dy: number) {
  const a = await box(from);
  const x0 = a.x + a.width / 2;
  const y0 = a.y + a.height / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + Math.sign(dx || 1) * 2, y0);
  for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + (dx * i) / 8, y0 + (dy * i) / 8);
  await page.mouse.up();
}
/** A drag of a member's tile by an offset. The panel a click or an
 * earlier drag opened covers the canvas's right, and the raw pointer
 * lands on whatever is on top: the selection is cleared first, so the
 * tile is the element under the pointer. (The red run found the second
 * of two drags landing on the first node's open panel.) */
async function dragMember(page: Page, name: string, dx: number, dy: number) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const from = await tilePoint(page, name);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(dx || 1) * 2, from.y);
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await page.mouse.up();
}

/** A point on a member's tile where that tile is on top. The minimap
 * stands over the canvas's bottom right from six members on, and the raw
 * pointer lands on whatever is there: the drag would pan the minimap
 * instead of moving the tile. The same rule as clickNote, for a tile. */
async function tilePoint(page: Page, name: string) {
  const b = await box(tileOf(member(page, name)));
  const candidates: { x: number; y: number }[] = [];
  for (let gy = 0.2; gy <= 0.8; gy += 0.2) for (let gx = 0.2; gx <= 0.8; gx += 0.2) candidates.push({ x: b.x + b.width * gx, y: b.y + b.height * gy });
  const found = await page.evaluate(
    ({ pts, name }) => pts.find((p) => document.elementFromPoint(p.x, p.y)?.closest("[data-node]")?.getAttribute("data-name") === name) ?? null,
    { pts: candidates, name },
  );
  if (!found) throw new Error(`no spot on ${name}'s tile is clear`);
  return found;
}
/** A drag from one locator's centre to another's (a port to a port). */
async function dragTo(page: Page, from: Locator, to: Locator) {
  const a = await box(from);
  const b = await box(to);
  await dragBy(page, from, b.x + b.width / 2 - (a.x + a.width / 2), b.y + b.height / 2 - (a.y + a.height / 2));
}
const outPort = (m: Locator) => m.locator(".react-flow__handle.source").first();
const inPort = (m: Locator, port = "input") => m.locator(`.react-flow__handle.target[data-handleid="${port}"]`);
/** A point on the canvas's background near the fraction asked for (the notes journey's rule). */
async function paneAt(page: Page, fx: number, fy: number) {
  const area = (await flowArea(page).boundingBox())!;
  const candidates: { x: number; y: number }[] = [];
  for (let dy = 0; dy <= 0.5; dy += 0.05) for (let dx = 0; dx <= 0.5; dx += 0.05) candidates.push({ x: area.x + area.width * Math.min(0.95, fx + dx), y: area.y + area.height * Math.min(0.85, fy + dy) });
  const found = await page.evaluate((pts) => pts.find((p) => document.elementFromPoint(p.x, p.y)?.classList.contains("react-flow__pane")) ?? null, candidates);
  if (!found) throw new Error("no background point found");
  return found;
}
/** A point on a note's resize handle where the handle itself is on top.
 * A tile drawn over the note's right edge takes the raw pointer, and the
 * drag then moves that tile instead of resizing the note: the same rule
 * as clickNote below, along the handle. */
async function handlePoint(page: Page, handle: Locator) {
  const b = await box(handle);
  const candidates: { x: number; y: number }[] = [];
  for (let g = 0.5; g >= 0.05; g -= 0.05) candidates.push({ x: b.x + b.width / 2, y: b.y + b.height * g });
  for (let g = 0.55; g <= 0.95; g += 0.05) candidates.push({ x: b.x + b.width / 2, y: b.y + b.height * g });
  const found = await page.evaluate((pts) => pts.find((p) => document.elementFromPoint(p.x, p.y)?.classList.contains("react-flow__resize-control")) ?? null, candidates);
  if (!found) throw new Error("no spot on the resize handle is clear");
  return found;
}
/** A click on a note where the note is on top (the notes journey's rule). */
async function clickNote(page: Page, id: string) {
  const b = await box(noteEl(page, id));
  const candidates: { x: number; y: number }[] = [];
  for (let gy = 0.15; gy <= 0.9; gy += 0.15) for (let gx = 0.15; gx <= 0.9; gx += 0.15) candidates.push({ x: b.x + b.width * gx, y: b.y + b.height * gy });
  const found = await page.evaluate(
    ({ pts, id }) => pts.find((p) => document.elementFromPoint(p.x, p.y)?.closest("[data-note]")?.getAttribute("data-note-id") === id) ?? null,
    { pts: candidates, id },
  );
  if (!found) throw new Error(`no spot on note ${id} is clear`);
  await page.mouse.click(found.x, found.y);
  await page.waitForTimeout(200);
}
/** Every layout write the page makes from now on, with what it carried. */
function watchLayoutWrites(page: Page): { body: { steps: Record<string, Position> } }[] {
  const writes: { body: { steps: Record<string, Position> } }[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && /\/layout$/.test(r.url())) writes.push({ body: JSON.parse(r.postData() ?? "{}") as { steps: Record<string, Position> } });
  });
  return writes;
}
/** Every editing request the page makes from now on (a run's are not edits). */
function watchMutations(page: Page): Request[] {
  const seen: Request[] = [];
  page.on("request", (r) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(r.method()) && r.url().includes("/api/recipes/") && !/\/runs(\/|\?|$)/.test(r.url())) seen.push(r);
  });
  return seen;
}
/** Another workflow opened the way the product opens one: the rail's
 * link, then the card in the list, both client-side. */
async function openFromList(page: Page, name: string) {
  await page.locator('nav[aria-label="Product navigation"]').getByRole("link", { name: "Workflows" }).click();
  const search = page.getByLabel("Search workflows");
  await expect(search).toBeVisible();
  await search.fill(name);
  await page.getByRole("link", { name: `Open ${name}` }).click();
  await settled(page);
}
/** The save status chip on the canvas's stage: where the record's
 * whisper stands now, and the scope every assertion below reads it in —
 * a page-wide text match would pass with the status in the wrong place. */
const statusChip = (page: Page) => page.locator('[data-save-status="whisper"]');
const retryBtn = (page: Page) => statusChip(page).getByRole("button", { name: "Retry" });
/** The whisper re-renders as its state settles; the click goes to the button as it stands. */
const clickRetry = (page: Page) => page.evaluate(() => (Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Retry") as HTMLElement | undefined)?.click());

/** The fixtures: points, polygons and a table without geometry; a workflow
 * whose Buffer reads the points and whose Filter rows reads the Buffer,
 * both never run, laid out with two notes and the flat table as a loose
 * source: members, notes and a loose source. */
async function seedWorkflow(page: Page, tag: string) {
  await page.goto("/workflows");
  await seedCsv(page, points, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\nhbf,13.37,52.53\n").catch(() => undefined);
  await seedCsv(page, polys, "name,wkt\na,\"POLYGON((13.3 52.5,13.5 52.5,13.5 52.6,13.3 52.6,13.3 52.5))\"\n").catch(() => undefined);
  await seedCsv(page, flat, "name,value\na,1\nb,2\n").catch(() => undefined);
  const id = await newRecipe(page, `Undo ${tag} ${runId}`);
  const bufName = `${points}_buffer_${tag}`;
  const filtName = `${points}_filtered_${tag}`;
  const buf = await addStep(page, id, "buffer", { input: points, distance: 100, name: bufName });
  const filt = await addStep(page, id, "filter_rows", { input: bufName, column: "name", op: "is_not_null", name: filtName });
  const notes: Note[] = [
    { id: `na_${tag}`, x: 48, y: 280, w: 176, h: 96, color: "yellow", text: "---\nlabel: first\n---\nThe first note." },
    { id: `nb_${tag}`, x: 288, y: 280, w: 176, h: 96, color: "green", text: "---\nlabel: second\n---\nThe second note." },
  ];
  await putLayout(page, id, {
    steps: { [buf]: { x: 288, y: 40 }, [filt]: { x: 528, y: 40 } },
    sources: { [points]: { x: 48, y: 40 }, [flat]: { x: 48, y: 160 } },
    notes,
  });
  return { id, buf, filt, bufName, filtName, notes };
}

test("the header: Undo and Redo beside the theme toggle, dimmed at rest, their hints with both platforms' keys; the stack and the minimap's six-member rule", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  const w = await seedWorkflow(page, "st");
  await page.goto(`/workflows/${w.id}`);
  await settled(page);
  const buttons = stage(page).locator("button");
  await expect(buttons).toHaveCount(8);
  expect(await buttons.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual([
    "Zoom in",
    "Zoom out",
    "Fit to view",
    "Framed view",
    "Arrange by dependency",
    "Add a note",
    "Show minimap",
    "Lock canvas",
  ]);
  // The zoom readout was removed and the pair moved to the header, and the
  // minimap's toggle took the note tool's other side, all on field-round
  // words: eight buttons and nothing else.
  const tail = await stage(page).evaluate((el) => Array.from(el.children).slice(-2).map((c) => c.getAttribute("aria-label") ?? c.tagName));
  expect(tail).toEqual(["Show minimap", "Lock canvas"]);
  expect(await stage(page).evaluate((el) => el.children.length)).toBe(8);
  // No stored choice: four members keep it hidden, then two more nodes
  // cross six-member threshold and make the same control offer Hide.
  const fifthName = `${points}_fifth_st`;
  await addStep(page, w.id, "filter_rows", { input: w.filtName, column: "name", op: "is_not_null", name: fifthName });
  await addStep(page, w.id, "filter_rows", { input: fifthName, column: "name", op: "is_not_null", name: `${points}_sixth_st` });
  await page.reload();
  await settled(page);
  await expect(page.getByRole("button", { name: "Hide minimap" })).toBeVisible();
  await expect(page.locator("[data-minimap]")).toBeVisible();
  // The pair stands in the header's left slot, before the theme toggle, as
  // the builder's; the assistant's door follows them.
  const order = await page.locator("#header-actions-left").evaluate((el) => Array.from(el.querySelectorAll("button")).map((b) => b.getAttribute("aria-label")));
  expect(order).toEqual(["Undo", "Redo", "Open assistant"]);
  await expect(undoBtn(page)).toHaveAttribute("data-hint", "Undo (⌘Z / Ctrl+Z)");
  await expect(redoBtn(page)).toHaveAttribute("data-hint", "Redo (⇧⌘Z / Ctrl+Y)");
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();
  // The stack is still a column beside the tiles: the second nine pin.
  const st = await box(stage(page));
  expect(st.width).toBeLessThan(60);
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

test("layout steps: Arrange, a drag, arrow runs, every note step, a source, Arrange with a node added and one removed headlessly, and what is no step", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const consoleErrors = trackConsole(page);
  const w = await seedWorkflow(page, "ly");
  await page.goto(`/workflows/${w.id}`);
  await settled(page);
  const writes = watchLayoutWrites(page);

  const before = await readLayout(page, w.id);
  await test.step("the oracle: Arrange moves the members and leaves the notes; the read before is kept independently", async () => {
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf]).not.toEqual(before.steps[w.buf]);
    const arranged = await readLayout(page, w.id);
    expect(arranged.notes).toEqual(before.notes);
    expect(Object.keys(arranged.steps).sort()).toEqual(Object.keys(before.steps).sort());
    await page.waitForTimeout(700);
  });

  let arranged: Layout;
  await test.step("Arrange undone: every position equals the read before, the notes unchanged, in one layout write, the view fitted; redone, the arranged read again", async () => {
    arranged = await readLayout(page, w.id);
    const seen = writes.length;
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Arrange");
    await expect.poll(async () => positionsOf(await readLayout(page, w.id))).toEqual(positionsOf(before));
    expect((await readLayout(page, w.id)).notes).toEqual(before.notes);
    expect(writes.length - seen).toBe(1);
    // The view fits: what Fit to view would make of the same layout.
    await page.waitForTimeout(700);
    const afterUndo = await viewportTransform(page);
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(500);
    expect(await viewportTransform(page)).toBe(afterUndo);
    await redo(page);
    await expect(notice(page)).toContainText("Redone: Arrange");
    await expect.poll(async () => positionsOf(await readLayout(page, w.id))).toEqual(positionsOf(arranged));
    await page.waitForTimeout(700);
  });

  await test.step("a drag undone lands where it was and redone where it went; a single tile's undo holds the view", async () => {
    await page.keyboard.press("Escape");
    const start = (await readLayout(page, w.id)).steps[w.buf];
    await dragMember(page, w.bufName, 120, 64);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf]).not.toEqual(start);
    const dragged = (await readLayout(page, w.id)).steps[w.buf];
    const view = await viewportTransform(page);
    const seen = writes.length;
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer moved");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf]).toEqual(start);
    expect(writes.length - seen).toBe(1);
    expect(await viewportTransform(page)).toBe(view);
    await redo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf]).toEqual(dragged);
    expect(await viewportTransform(page)).toBe(view);
    await undo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf]).toEqual(start);
  });

  await test.step("five arrow presses on one member are one step; two members moved in turn take two; a pointer press between two runs splits them; a press with nothing to take between two runs does not", async () => {
    const x0 = (await readLayout(page, w.id)).steps[w.buf].x;
    const y0 = (await readLayout(page, w.id)).steps[w.buf].y;
    await selectByKey(page, w.buf);
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].x).toBe(x0 + 40);
    await undo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].x).toBe(x0);
    // Two members in turn: two steps, the later member's first.
    const fx = (await readLayout(page, w.id)).steps[w.filt].x;
    await selectByKey(page, w.buf);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].x).toBe(x0 + 16);
    await selectByKey(page, w.filt);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.filt].x).toBe(fx + 16);
    await undo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.filt].x).toBe(fx);
    expect((await readLayout(page, w.id)).steps[w.buf].x).toBe(x0 + 16);
    await undo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].x).toBe(x0);
    // A pointer press on the member between two runs: two steps.
    await selectByKey(page, w.buf);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].y).toBe(y0 + 16);
    await tileOf(member(page, w.bufName)).click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].y).toBe(y0 + 32);
    await undo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].y).toBe(y0 + 16);
    await undo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].y).toBe(y0);
    // A press with nothing on its side between two runs is no step and
    // no boundary: the run after it folds into the run
    // before, and one undo takes the whole run back. The fresh run has
    // forgotten the redo side, so the chord's redo takes nothing; the
    // chord rather than the button, so focus stays on the member.
    await selectByKey(page, w.buf);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].x).toBe(x0 + 16);
    await page.keyboard.press("Shift+ControlOrMeta+z");
    await expect(notice(page)).toHaveText("Nothing to redo");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].x).toBe(x0 + 32);
    await undo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf].x).toBe(x0);
    await page.keyboard.press("Escape");
  });

  await test.step("the notes: placed and typed take two undos; moved, resized, recoloured, edited, duplicated, pasted and removed each undone and redone against the read", async () => {
    const notesOf = async () => (await readLayout(page, w.id)).notes;
    const seeded = await notesOf();
    // Placed, then typed into: two steps.
    await page.locator("[data-note-tool]").click();
    await page.keyboard.press("Enter");
    const field = page.locator("[data-note-field]");
    await expect(field).toBeFocused();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await notesOf()).length).toBe(seeded.length + 1);
    const placed = (await notesOf()).find((n) => !seeded.some((s) => s.id === n.id))!;
    expect(placed.text).toContain("hello");
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note edited");
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.text).toBe(NEW_TEXT);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note placed");
    await expect.poll(async () => (await notesOf()).length).toBe(seeded.length);
    await redo(page);
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.text).toBe(NEW_TEXT);
    await redo(page);
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.text).toBe(placed.text);
    // Moved by a key.
    await clickNote(page, placed.id);
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.x).toBe(placed.x + 8);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note moved");
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.x).toBe(placed.x);
    await redo(page);
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.x).toBe(placed.x + 8);
    // Resized by the east handle.
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(350);
    await clickNote(page, placed.id);
    const zoom = await zoomOf(page);
    const grip = await handlePoint(page, noteNode(page, placed.id).locator(".react-flow__resize-control.line.right"));
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 2, grip.y);
    for (let i = 1; i <= 6; i++) await page.mouse.move(grip.x + (64 * zoom * i) / 6, grip.y);
    await page.mouse.up();
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.w).toBe(placed.w + 64);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note resized");
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.w).toBe(placed.w);
    await redo(page);
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.w).toBe(placed.w + 64);
    // Recoloured.
    await clickNote(page, placed.id);
    await menu(page).locator("[data-note-swatch='blue']").click();
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.color).toBe("blue");
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note recoloured");
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.color).toBe("yellow");
    await redo(page);
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.color).toBe("blue");
    // Edited in place.
    const typed = (await notesOf()).find((n) => n.id === placed.id)!.text;
    await clickNote(page, placed.id);
    await menu(page).locator("[data-note-edit]").click();
    await expect(page.locator("[data-note-field]")).toBeFocused();
    await page.keyboard.type(" more");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.text).toBe(`${typed} more`);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note edited");
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.text).toBe(typed);
    await redo(page);
    await expect.poll(async () => (await notesOf()).find((n) => n.id === placed.id)?.text).toBe(`${typed} more`);
    // Duplicated: the copy goes and comes back as itself.
    await clickNote(page, placed.id);
    const beforeDup = await notesOf();
    await menu(page).locator("[data-note-duplicate]").click();
    await expect.poll(async () => (await notesOf()).length).toBe(beforeDup.length + 1);
    const copy = (await notesOf()).find((n) => !beforeDup.some((b) => b.id === n.id))!;
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note duplicated");
    await expect.poll(async () => (await notesOf()).map((n) => n.id)).not.toContain(copy.id);
    await redo(page);
    await expect.poll(async () => (await notesOf()).find((n) => n.id === copy.id)).toEqual(copy);
    // Pasted: the paste goes.
    await clickNote(page, placed.id);
    await page.keyboard.press("ControlOrMeta+c");
    await expect(notice(page)).toContainText("Copied the note");
    const beforePaste = await notesOf();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => (await notesOf()).length).toBe(beforePaste.length + 1);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note pasted");
    await expect.poll(async () => (await notesOf()).length).toBe(beforePaste.length);
    expect(await notesOf()).toEqual(beforePaste);
    // Removed: back with its identity, text, colour, size and place in the order.
    const first = (await notesOf())[0];
    expect(first.id).toBe(w.notes[0].id);
    await clickNote(page, first.id);
    await page.keyboard.press("Delete");
    await expect(notice(page)).toContainText("Note removed.");
    await expect.poll(async () => (await notesOf()).map((n) => n.id)).not.toContain(first.id);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note removed");
    await expect.poll(async () => (await notesOf())[0]).toEqual(first);
    await redo(page);
    await expect.poll(async () => (await notesOf()).map((n) => n.id)).not.toContain(first.id);
    await undo(page);
    await expect.poll(async () => (await notesOf())[0]).toEqual(first);
  });

  await test.step("a source placed then undone is out of the read; one removed then undone is back at its position", async () => {
    await page.keyboard.press("Escape");
    await pane(page).getByRole("tab", { name: /^Sources/ }).click();
    await pane(page).locator(`[data-table="${polys}"]`).click();
    await expect.poll(async () => (await readLayout(page, w.id)).sources).toHaveProperty(polys);
    await expect(member(page, polys)).toBeVisible();
    await undo(page);
    await expect(notice(page)).toContainText(`Undone: ${polys} placed`);
    await expect.poll(async () => (await readLayout(page, w.id)).sources).not.toHaveProperty(polys);
    await expect(member(page, polys)).toHaveCount(0);
    await redo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).sources).toHaveProperty(polys);
    await expect(member(page, polys)).toBeVisible();
    await undo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).sources).not.toHaveProperty(polys);
    // The loose flat table removed, then back where it stood.
    const at = (await readLayout(page, w.id)).sources[flat];
    await selectTile(page, flat);
    await page.keyboard.press("Delete");
    await expect(member(page, flat)).toHaveCount(0);
    await expect.poll(async () => (await readLayout(page, w.id)).sources).not.toHaveProperty(flat);
    await undo(page);
    await expect(notice(page)).toContainText(`Undone: ${flat} removed`);
    await expect.poll(async () => (await readLayout(page, w.id)).sources[flat] ?? null).toEqual(at);
    await expect(member(page, flat)).toBeVisible();
  });

  await test.step("a source removed, undone, then redone at once before the undo's write is answered: gone from the read again, the step taken rather than dropped (the window before the echo)", async () => {
    await page.keyboard.press("Escape");
    // The undo's write is held: until it lands the source it brings back
    // is in no read and no graph, so its spot must be on the screen the
    // record reads, as a source placed from the pane is, or the redo
    // pressed inside that window finds nothing of the step left and drops
    // it, and the source then appears (found at review).
    let puts = 0;
    await page.route(`**/api/recipes/${w.id}/layout`, async (route) => {
      if (route.request().method() === "PUT") {
        puts += 1;
        // The first PUT is the removal's, the second the undo's.
        if (puts === 2) await new Promise((r) => setTimeout(r, 2500));
      }
      await route.continue().catch(() => undefined);
    });
    const at = (await readLayout(page, w.id)).sources[flat];
    await selectTile(page, flat);
    await page.keyboard.press("Delete");
    await expect(member(page, flat)).toHaveCount(0);
    await expect.poll(async () => (await readLayout(page, w.id)).sources).not.toHaveProperty(flat);
    await undo(page);
    await expect(notice(page)).toContainText(`Undone: ${flat} removed`);
    await redo(page);
    await expect(notice(page)).toContainText(`Redone: ${flat} removed`);
    // The redo's write queues behind the held one and goes when it lands.
    await expect.poll(async () => (await readLayout(page, w.id)).sources, { timeout: 20_000 }).not.toHaveProperty(flat);
    await expect(member(page, flat)).toHaveCount(0);
    await page.unroute(`**/api/recipes/${w.id}/layout`);
    // And back once more, so the fixture stands as the next step expects.
    await undo(page);
    await expect(notice(page)).toContainText(`Undone: ${flat} removed`);
    await expect.poll(async () => (await readLayout(page, w.id)).sources[flat] ?? null).toEqual(at);
    await expect(member(page, flat)).toBeVisible();
  });

  await test.step("Arrange, a node added, two undos: the node gone and every position back; Arrange, a node removed headlessly, one undo: not resurrected, the others return", async () => {
    await page.keyboard.press("Escape");
    // Off the dependency arrangement first: every step above ended where
    // Arrange had already put the tiles, and an Arrange that moves
    // nothing is no step. The drag is a step of its own,
    // below the two this check takes back.
    const wasAt = (await readLayout(page, w.id)).steps[w.buf];
    await dragMember(page, w.bufName, 0, 96);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf]).not.toEqual(wasAt);
    await page.waitForTimeout(700);
    const start = await readLayout(page, w.id);
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf]).not.toEqual(start.steps[w.buf]);
    await page.waitForTimeout(700);
    await pane(page).getByRole("tab", { name: /^Tools/ }).click();
    await pane(page).getByRole("button", { name: "Add Buffer" }).click();
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(3);
    const added = (await readRecipe(page, w.id)).steps[2].id;
    await expect.poll(async () => (await readLayout(page, w.id)).steps).toHaveProperty(added);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer added");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(2);
    await expect(page.locator("[data-removal-dialog]")).toHaveCount(0);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Arrange");
    await expect.poll(async () => positionsOf(await readLayout(page, w.id))).toEqual(positionsOf(start));
    expect((await readLayout(page, w.id)).notes).toEqual(start.notes);
    await page.waitForTimeout(700);
    // Arrange, then the reader removed headlessly: the undo leaves it out.
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf]).not.toEqual(start.steps[w.buf]);
    await page.waitForTimeout(700);
    await readThenWriteBrowserSetup(page, `/api/recipes/${w.id}`, () => ({ method: "DELETE", path: `/api/recipes/${w.id}/steps/${w.filt}` })).then(result => result.json);
    // Nothing pushes a headless recipe change to an open canvas, so the
    // tile stands until a read: the undo writes the screen back, and the
    // layout read, pruned to the recipe, holds no position for the node
    // that is gone.
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Arrange");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[w.buf]).toEqual(start.steps[w.buf]);
    const after = await readLayout(page, w.id);
    expect(after.sources).toEqual(start.sources);
    expect(after.steps).not.toHaveProperty(w.filt);
    expect((await readRecipe(page, w.id)).steps.map((s) => s.id)).toEqual([w.buf]);
    await page.waitForTimeout(700);
  });

  await test.step("a source placed and undone before its write is answered still leaves the read without it (the window before the echo)", async () => {
    await page.keyboard.press("Escape");
    // The layout's first answer is held: until it lands the source is in
    // no read and in no graph, and its spot lives only in the canvas's
    // own placements. That window is what an undo pressed at once falls
    // into, and the record must read the same screen the user placed.
    let held = 0;
    await page.route(`**/api/recipes/${w.id}/layout`, async (route) => {
      if (route.request().method() === "PUT") {
        held += 1;
        if (held === 1) await new Promise((r) => setTimeout(r, 3000));
      }
      // A write that the page has since given up on is already handled;
      // the hold is the point here, not the bookkeeping.
      await route.continue().catch(() => undefined);
    });
    await pane(page).getByRole("tab", { name: /^Sources/ }).click();
    await pane(page).locator(`[data-table="${polys}"]`).click();
    await expect(undoBtn(page)).toBeEnabled();
    await undo(page);
    await expect(notice(page)).toContainText(`Undone: ${polys} placed`);
    // The write the undo made queues behind the held one and goes when it
    // lands; the route stays installed until nothing is waiting on it.
    await expect.poll(async () => (await readLayout(page, w.id)).sources, { timeout: 20_000 }).not.toHaveProperty(polys);
    await expect(member(page, polys)).toHaveCount(0);
    await page.unroute(`**/api/recipes/${w.id}/layout`);
  });

  await test.step("fit, zoom, pan, the toggle, selection and a panel make no step: the buttons stay dimmed, the press says Nothing to undo, no write", async () => {
    await page.reload();
    await settled(page);
    const mutations = watchMutations(page);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.getByRole("button", { name: "Framed view" }).click();
    await expect(host(page)).toHaveAttribute("data-view", "framed");
    await page.getByRole("button", { name: "Fill the screen" }).click();
    await expect(host(page)).toHaveAttribute("data-view", "full");
    const at = await paneAt(page, 0.55, 0.6);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 60, at.y + 30, { steps: 6 });
    await page.mouse.up();
    await selectTile(page, w.bufName);
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(undoBtn(page)).toBeDisabled();
    await expect(redoBtn(page)).toBeDisabled();
    await flowArea(page).focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(notice(page)).toHaveText("Nothing to undo");
    await page.keyboard.press("Shift+ControlOrMeta+z");
    await expect(notice(page)).toHaveText("Nothing to redo");
    await page.waitForTimeout(500);
    expect(mutations).toEqual([]);
    // The watcher's positive control: the same watcher, still listening,
    // sees a write when one is made. Without this the three empty
    // assertions above and in the pending-work step could pass on a watcher that can catch
    // nothing at all.
    await dragMember(page, w.bufName, 48, 0);
    await expect.poll(() => mutations.filter((r) => r.method() === "PUT" && /\/layout$/.test(r.url())).length).toBeGreaterThan(0);
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

test("recipe steps, adds and edits: a node from the pane, pre-linked and pasted; a link made, moved and detached; a slow parameter, a name, the picker; a run node's proposal and Discard edit", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const consoleErrors = trackConsole(page);
  const w = await seedWorkflow(page, "re");
  // A reader with no input yet: what a link made fills.
  const freeName = `${points}_free_re`;
  const free = await addStep(page, w.id, "buffer", { distance: 50, name: freeName });
  await putLayout(page, w.id, { ...(await readLayout(page, w.id)), steps: { ...(await readLayout(page, w.id)).steps, [free]: { x: 288, y: 180 } } });
  await page.goto(`/workflows/${w.id}`);
  await settled(page);

  await test.step("the oracle: three never-run nodes, the free one without an input, each placed by the layout", async () => {
    const r = await readRecipe(page, w.id);
    expect(r.steps.map((s) => s.id)).toEqual([w.buf, w.filt, free]);
    expect(stepById(r, free)!.parameters.input).toBeUndefined();
    expect(r.steps.every((s) => s.output === null)).toBe(true);
    expect(Object.keys((await readLayout(page, w.id)).steps).sort()).toEqual([w.buf, w.filt, free].sort());
  });

  await test.step("a node added from the pane, one pre-linked, one pasted: each undone leaves the reads without a confirmation; redone, back with a fresh identity", async () => {
    const cycle = async (added: Step, label: string) => {
      await expect.poll(async () => (await readLayout(page, w.id)).steps).toHaveProperty(added.id);
      await undo(page);
      await expect(notice(page)).toContainText(`Undone: Buffer ${label}`);
      await expect.poll(async () => stepById(await readRecipe(page, w.id), added.id)).toBeNull();
      await expect(page.locator("[data-removal-dialog]")).toHaveCount(0);
      await expect.poll(async () => (await readLayout(page, w.id)).steps).not.toHaveProperty(added.id);
      await redo(page);
      await expect(notice(page)).toContainText(`Redone: Buffer ${label}`);
      await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(4);
      const back = (await readRecipe(page, w.id)).steps.find((s) => ![w.buf, w.filt, free].includes(s.id))!;
      expect(back.id).not.toBe(added.id);
      expect(back.operation).toBe("buffer");
      expect(back.parameters).toEqual(added.parameters);
      expect(back.output).toBeNull();
      await expect.poll(async () => (await readLayout(page, w.id)).steps).toHaveProperty(back.id);
      await undo(page);
      await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(3);
    };
    await page.keyboard.press("Escape");
    await pane(page).getByRole("tab", { name: /^Tools/ }).click();
    await pane(page).getByRole("button", { name: "Add Buffer" }).click();
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(4);
    await cycle((await readRecipe(page, w.id)).steps[3], "added");
    // Pre-linked: the source selected, the first input pre-set.
    await selectTile(page, points);
    await pane(page).getByRole("button", { name: "Add Buffer" }).click();
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(4);
    const linked = (await readRecipe(page, w.id)).steps[3];
    expect(linked.parameters.input).toBe(points);
    await cycle(linked, "added");
    // Pasted.
    await selectTile(page, w.bufName);
    await flowArea(page).focus();
    await page.keyboard.press("ControlOrMeta+c");
    await expect(notice(page)).toContainText("Copied Buffer");
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(4);
    await cycle((await readRecipe(page, w.id)).steps[3], "pasted");
  });

  await test.step("a link made, one detached, one moved: each undone equals the read before, redone the read after; a moved link's second half cut leaves both links and says so", async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(400);
    const beforeLink = definitionOf(stepById(await readRecipe(page, w.id), free));
    await dragTo(page, outPort(member(page, points)), inPort(member(page, freeName)));
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.input).toBe(points);
    const afterLink = definitionOf(stepById(await readRecipe(page, w.id), free));
    await undo(page);
    await expect(notice(page)).toContainText("Undone: link to Buffer");
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(beforeLink);
    await redo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(afterLink);
    // Detached from the panel.
    await selectTile(page, freeName);
    await panel(page).getByRole("button", { name: "Detach Features to buffer" }).click();
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.input).toBeUndefined();
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer detached");
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(afterLink);
    await redo(page);
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.input).toBeUndefined();
    await undo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(afterLink);
    // Moved: the free node's link dragged onto the filter's port.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(400);
    const filtBefore = definitionOf(stepById(await readRecipe(page, w.id), w.filt));
    await dragTo(page, inPort(member(page, freeName)), inPort(member(page, w.filtName)));
    await expect.poll(async () => stepById(await readRecipe(page, w.id), w.filt)?.parameters.input).toBe(points);
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.input).toBeUndefined();
    const filtAfter = definitionOf(stepById(await readRecipe(page, w.id), w.filt));
    const freeAfter = definitionOf(stepById(await readRecipe(page, w.id), free));
    await undo(page);
    await expect(notice(page)).toContainText("Undone: link moved to Filter rows");
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), w.filt))).toEqual(filtBefore);
    expect(definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(afterLink);
    await redo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), w.filt))).toEqual(filtAfter);
    expect(definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(freeAfter);
    // The second half cut: the holder's link is back, the taker keeps its own, and the notice says
    // so.
    await page.route(`**/api/recipes/${w.id}/steps/${w.filt}`, (route) => (route.request().method() === "PATCH" ? route.abort() : route.continue()));
    await undo(page);
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.input).toBe(points);
    expect(stepById(await readRecipe(page, w.id), w.filt)?.parameters.input).toBe(points);
    await expect(notice(page)).toHaveAttribute("data-tone", "bad");
    await expect(notice(page)).toContainText("Filter rows");
    await expect(retryBtn(page)).toBeVisible({ timeout: 10_000 });
    await page.unroute(`**/api/recipes/${w.id}/steps/${w.filt}`);
    await clickRetry(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), w.filt))).toEqual(filtBefore);
  });

  await test.step("a parameter typed slowly in one focus session is one step; a name edited; an input chosen in the picker: each undone and redone", async () => {
    await selectTile(page, freeName);
    const distance = panel(page).getByRole("spinbutton", { name: /^distance/ });
    const before = definitionOf(stepById(await readRecipe(page, w.id), free));
    await distance.click();
    await distance.press("ControlOrMeta+a");
    await page.keyboard.type("1");
    await page.waitForTimeout(650);
    await page.keyboard.type("5");
    await page.waitForTimeout(650);
    await page.keyboard.type("0");
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.distance).toBe(150);
    const typed = definitionOf(stepById(await readRecipe(page, w.id), free));
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer edited");
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(before);
    await redo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(typed);
    // A field left and returned to is a second focus session, so the two
    // runs are two steps and two undos.
    await distance.click();
    await distance.press("ControlOrMeta+a");
    await page.keyboard.type("200");
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.distance).toBe(200);
    const firstRun = definitionOf(stepById(await readRecipe(page, w.id), free));
    // Focus leaves the field by the keyboard and comes back to it: no
    // pointer press, so nothing but the blur ends the first session.
    await distance.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(distance).toBeFocused();
    await distance.press("ControlOrMeta+a");
    await page.keyboard.type("250");
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.distance).toBe(250);
    await undo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(firstRun);
    await undo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(typed);
    // The name.
    const name = panel(page).getByRole("textbox", { name: "Dataset name" });
    await name.fill("Free rings");
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.name).toBe("free_rings");
    const renamed = definitionOf(stepById(await readRecipe(page, w.id), free));
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer renamed");
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(typed);
    await redo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(renamed);
    await undo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(typed);
    // The picker.
    await panel(page).getByRole("combobox", { name: "Features to buffer" }).click();
    await page.locator(`[data-picker-pop] [data-option="${polys}"]`).click();
    await expect.poll(async () => stepById(await readRecipe(page, w.id), free)?.parameters.input).toBe(polys);
    const picked = definitionOf(stepById(await readRecipe(page, w.id), free));
    await undo(page);
    await expect(notice(page)).toContainText("Undone: link to Buffer");
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(typed);
    await redo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), free))).toEqual(picked);
  });

  await test.step("on a node that has run: an edit undone lands as the proposal it had or none; Discard edit undone puts the proposal back", async () => {
    await runAndWait(page, w.id, w.buf);
    await page.reload();
    await settled(page);
    await selectTile(page, w.bufName);
    const before = definitionOf(stepById(await readRecipe(page, w.id), w.buf));
    expect(before!.proposedParameters).toBeNull();
    await panel(page).getByRole("spinbutton", { name: /^distance/ }).fill("200");
    await expect.poll(async () => stepById(await readRecipe(page, w.id), w.buf)?.proposedParameters?.distance).toBe(200);
    const proposed = definitionOf(stepById(await readRecipe(page, w.id), w.buf));
    expect(proposed!.parameters.distance).toBe(100);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer edited");
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), w.buf))).toEqual(before);
    await redo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), w.buf))).toEqual(proposed);
    await panel(page).getByRole("button", { name: "Discard edit" }).click();
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), w.buf))).toEqual(before);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer edit discarded");
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), w.buf))).toEqual(proposed);
    await redo(page);
    await expect.poll(async () => definitionOf(stepById(await readRecipe(page, w.id), w.buf))).toEqual(before);
  });

  // The dry run refuses the free node's preview while it has no input, and
  // the cut edit is the test's own; nothing else on the wire is expected.
  const induced = (e: { text: string; url?: string }) =>
    (/status of 400/.test(e.text) && /\/api\/operations\/run$/.test(e.url ?? "")) || (/ERR_FAILED/.test(e.text) && /\/steps\//.test(e.url ?? ""));
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !induced(e));
  expect(unexpected).toEqual([]);
});

test("recipe steps, removals: a never-run node back in its place with its readers' edges, the order's write cut, a produced node refused, a deleted dataset's node back to run again, the record following the node that came back", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  const w = await seedWorkflow(page, "rm");
  await page.goto(`/workflows/${w.id}`);
  await settled(page);
  const edgesInto = (id: string) => page.locator(`.react-flow__edge[data-id$="->${id}:input:0"]`);
  const edgesFrom = (id: string) => page.locator(`.react-flow__edge[data-id^="${id}->"]`);
  const removeNode = async (name: string) => {
    await selectTile(page, name);
    await panel(page).getByRole("button", { name: "Remove node" }).click();
    const dialog = page.locator("[data-removal-dialog]");
    await expect(dialog).toBeVisible();
    const state = await dialog.getAttribute("data-dataset-state");
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toHaveCount(0);
    return state;
  };

  await test.step("the oracle: the Buffer stands first, read by the filter, both never run, one edge each way", async () => {
    const r = await readRecipe(page, w.id);
    expect(r.steps.map((s) => [s.id, s.ordinal])).toEqual([
      [w.buf, 0],
      [w.filt, 1],
    ]);
    await expect(edgesFrom(w.buf)).toHaveCount(1);
    await expect(edgesInto(w.buf)).toHaveCount(1);
  });

  let current = w.buf;
  await test.step("a never-run node removed then undone: its operation, definition, named inputs, name, position and place in the order back, a fresh identity, its readers' edges drawn again", async () => {
    const before = stepById(await readRecipe(page, w.id), w.buf)!;
    const at = (await readLayout(page, w.id)).steps[w.buf];
    expect(await removeNode(w.bufName)).toBe("never");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.map((s) => s.id)).toEqual([w.filt]);
    await expect(edgesInto(w.filt)).toHaveCount(1);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer removed");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(2);
    const back = (await readRecipe(page, w.id)).steps.find((s) => s.id !== w.filt)!;
    expect(back.id).not.toBe(w.buf);
    expect(back.operation).toBe("buffer");
    expect(back.parameters).toEqual(before.parameters);
    expect(back.ordinal).toBe(0);
    expect(back.output).toBeNull();
    expect(back.latestAttempt).toBeNull();
    await expect.poll(async () => (await readLayout(page, w.id)).steps[back.id] ?? null).toEqual(at);
    await expect(edgesFrom(back.id)).toHaveCount(1);
    await expect(edgesInto(back.id)).toHaveCount(1);
    current = back.id;
  });

  await test.step("with the order's write cut, no node is in the read and the notice says why; the next press brings it back", async () => {
    expect(await removeNode(w.bufName)).toBe("never");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.map((s) => s.id)).toEqual([w.filt]);
    await page.route(`**/api/recipes/${w.id}/steps/*/move`, (route) => route.abort());
    await undo(page);
    await expect(notice(page)).toHaveAttribute("data-tone", "bad", { timeout: 15_000 });
    await expect(notice(page)).toContainText("Not undone");
    await page.waitForTimeout(600);
    expect((await readRecipe(page, w.id)).steps.map((s) => s.id)).toEqual([w.filt]);
    await page.unroute(`**/api/recipes/${w.id}/steps/*/move`);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer removed");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(2);
    const back = (await readRecipe(page, w.id)).steps.find((s) => s.id !== w.filt)!;
    expect(back.ordinal).toBe(0);
    current = back.id;
  });

  await test.step("a produced node removed then undone: refused with the name rule's reason, the read unchanged, the dataset still listed", async () => {
    await runAndWait(page, w.id, current);
    await page.reload();
    await settled(page);
    expect(await removeNode(w.bufName)).toBe("exists");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.map((s) => s.id)).toEqual([w.filt]);
    expect(await tableNames(page)).toContain(w.bufName);
    await undo(page);
    await expect(notice(page)).toContainText("Not undone");
    await expect(notice(page)).toContainText("already exists");
    await page.waitForTimeout(500);
    expect((await readRecipe(page, w.id)).steps.map((s) => s.id)).toEqual([w.filt]);
    expect(await tableNames(page)).toContain(w.bufName);
    // The step is dropped: nothing older stands in this page's record.
    await expect(undoBtn(page)).toBeDisabled();
  });

  await test.step("a node whose dataset was deleted, removed then undone: back, never run, the notice saying it must run again", async () => {
    const restored = await addStep(page, w.id, "buffer", { input: points, distance: 100, name: `${w.bufName}_again` });
    await readThenWriteBrowserSetup(page, `/api/recipes/${w.id}`, () => ({ method: "POST", path: `/api/recipes/${w.id}/steps/${restored}/move`, body: { ordinal: 0 } })).then(result => result.json);
    await runAndWait(page, w.id, restored);
    await api(page, "DELETE", `/api/tables/${w.bufName}_again`);
    await page.reload();
    await settled(page);
    expect(await removeNode(`${w.bufName}_again`)).toBe("deleted");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.map((s) => s.id)).toEqual([w.filt]);
    await undo(page);
    await expect(notice(page)).toContainText("run again");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(2);
    const back = (await readRecipe(page, w.id)).steps.find((s) => s.id !== w.filt)!;
    expect(back.id).not.toBe(restored);
    expect(back.output).toBeNull();
    expect(back.lastSuccessAt).toBeNull();
    expect(back.parameters.name).toBe(`${w.bufName}_again`);
    current = back.id;
  });

  await test.step("after a removal is undone, the undo of an earlier move moves the node that came back; redo of the removal removes it", async () => {
    await page.reload();
    await settled(page);
    const start = (await readLayout(page, w.id)).steps[current];
    await dragMember(page, `${w.bufName}_again`, 96, 48);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[current]).not.toEqual(start);
    const dragged = (await readLayout(page, w.id)).steps[current];
    expect(await removeNode(`${w.bufName}_again`)).toBe("never");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.map((s) => s.id)).toEqual([w.filt]);
    await undo(page);
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.length).toBe(2);
    const back = (await readRecipe(page, w.id)).steps.find((s) => s.id !== w.filt)!;
    await expect.poll(async () => (await readLayout(page, w.id)).steps[back.id] ?? null).toEqual(dragged);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer moved");
    await expect.poll(async () => (await readLayout(page, w.id)).steps[back.id] ?? null).toEqual(start);
    await redo(page);
    await expect.poll(async () => (await readLayout(page, w.id)).steps[back.id] ?? null).toEqual(dragged);
    await redo(page);
    await expect(notice(page)).toContainText("Redone: Buffer removed");
    await expect.poll(async () => (await readRecipe(page, w.id)).steps.map((s) => s.id)).toEqual([w.filt]);
    await expect(page.locator("[data-removal-dialog]")).toHaveCount(0);
  });

  // The cut order write and the refused restoration are the test's own; the
  // filter's dry run is refused while its producer is gone.
  const induced = (e: { text: string; url?: string }) =>
    (/ERR_FAILED/.test(e.text) && /\/move$/.test(e.url ?? "")) ||
    (/status of 400/.test(e.text) && /\/steps$/.test(e.url ?? "")) ||
    (/status of 400/.test(e.text) && /\/api\/operations\/run$/.test(e.url ?? ""));
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !induced(e));
  expect(unexpected).toEqual([]);
});

test("pending work, runs and refusals: an unsent value, an invalid one, a save on the wire; the run boundary member by member; an unsettled member; a node run since; the cut routes and Retry; last write wins", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await page.goto("/workflows");
  await seedCsv(page, points, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\nhbf,13.37,52.53\n").catch(() => undefined);
  const id = await newRecipe(page, `Undo runs ${runId}`);
  const bufName = `${points}_buffer_ru`;
  const buf = await addStep(page, id, "buffer", { input: points, distance: 100, name: bufName });
  const fast = await addStep(page, id, "sql_step", { sql: `SELECT name FROM ${points}`, name: `${points}_fast` });
  const slow = await addStep(page, id, "sql_step", { sql: `${ENDLESS} AND EXISTS (SELECT 1 FROM ${points}_fast)`, name: `${points}_slow` });
  const after = await addStep(page, id, "sql_step", { sql: `SELECT * FROM ${points}_slow`, name: `${points}_after` });
  // A statement that parses and names an existing table but fails when run (failing fixture).
  const bad = await addStep(page, id, "sql_step", { sql: `SELECT CAST(name AS INTEGER) AS n FROM ${points}`, name: `${points}_bad` });
  const other = await addStep(page, id, "sql_step", { sql: `SELECT name FROM ${points}`, name: `${points}_other` });
  // A written layout before the canvas opens: a workflow with none holds
  // no position for any node, and a check whose oracle is *the position
  // before* would then compare one absence with another.
  await putLayout(page, id, {
    steps: Object.fromEntries([buf, fast, slow, after, bad, other].map((s, i) => [s, { x: 288 + 240 * (i % 3), y: 40 + 176 * Math.floor(i / 3) }])),
    sources: { [points]: { x: 48, y: 40 } },
  });
  await page.goto(`/workflows/${id}`);
  await settled(page);
  const sqlOf = async (stepId: string) => stepById(await readRecipe(page, id), stepId)?.parameters.sql;
  /** What the panel shows on a node that has run: an edit there is a
   * proposal, so the active parameters alone would answer the same
   * before and after it. */
  const liveSqlOf = async (stepId: string) => {
    const step = stepById(await readRecipe(page, id), stepId);
    return ((step?.proposedParameters ?? step?.parameters) as Json | undefined)?.sql;
  };
  const distanceOf = async () => stepById(await readRecipe(page, id), buf)?.parameters.distance;
  const dock = page.locator("[data-run-dock]");

  await test.step("the oracle: six never-run nodes, the endless statement among them, each reachable by its tile", async () => {
    expect((await readRecipe(page, id)).steps.map((s) => s.id)).toEqual([buf, fast, slow, after, bad, other]);
    await expect(page.locator("[data-node][data-kind='node']")).toHaveCount(6);
  });

  await test.step("Undo with a valid value typed and unsent lands it and takes it back; with an invalid value refused with the field's reason, the value kept, the record intact", async () => {
    await selectTile(page, bufName);
    const distance = panel(page).getByRole("spinbutton", { name: /^distance/ });
    await distance.fill("150");
    await expect.poll(distanceOf).toBe(150);
    await distance.fill("175");
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer edited");
    await expect.poll(distanceOf).toBe(150);
    await expect(distance).toHaveValue("150");
    await distance.fill("-5");
    await expect(panel(page).getByText("A distance is more than 0 metres.")).toBeVisible();
    await undo(page);
    await expect(notice(page)).toContainText("Not undone: Fix the distance first");
    await expect(distance).toHaveValue("-5");
    expect(await distanceOf()).toBe(150);
    await expect(undoBtn(page)).toBeEnabled();
    await distance.fill("150");
    await page.waitForTimeout(600);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer edited");
    await expect.poll(distanceOf).toBe(100);
  });

  await test.step("pressed with a layout save on the wire: the undo's write lands after it", async () => {
    await page.keyboard.press("Escape");
    const start = (await readLayout(page, id)).steps[buf];
    const bodies: Position[] = [];
    let held = 0;
    await page.route(`**/api/recipes/${id}/layout`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      bodies.push((JSON.parse(route.request().postData() ?? "{}") as { steps: Record<string, Position> }).steps[buf]);
      if (held === 0) {
        held += 1;
        await new Promise((r) => setTimeout(r, 500));
      }
      return route.continue();
    });
    await dragMember(page, bufName, 80, 40);
    await page.waitForTimeout(120);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer moved");
    // The held write lands first and the undo's goes after it; the read
    // is the position before the drag only once both have landed, and it
    // reads that way before either does, so the writes are waited for.
    await expect.poll(() => bodies.length, { timeout: 10_000 }).toBe(2);
    await expect.poll(async () => (await readLayout(page, id)).steps[buf], { timeout: 10_000 }).toEqual(start);
    await page.unroute(`**/api/recipes/${id}/layout`);
    expect(bodies[0]).not.toEqual(start);
    expect(bodies[1]).toEqual(start);
  });

  await test.step("a parameter edit, then a run of that node writing its dataset: its step gone, the next undo takes the step before; the run failing keeps it; another node's run leaves it; a layout step survives any run", async () => {
    // The step before: the fast node dragged.
    const start = (await readLayout(page, id)).steps[fast];
    await dragMember(page, `${points}_fast`, 0, 64);
    await expect.poll(async () => (await readLayout(page, id)).steps[fast]).not.toEqual(start);
    await selectTile(page, `${points}_fast`);
    await panel(page).getByLabel(/^sql/).fill(`SELECT name AS n FROM ${points}`);
    await expect.poll(() => sqlOf(fast)).toBe(`SELECT name AS n FROM ${points}`);
    const runsBefore = await runCount(page, id);
    await panel(page).locator("[data-run-node]").click();
    await runSettled(page, id, runsBefore);
    await expect.poll(async () => stepById(await readRecipe(page, id), fast)?.output ?? null).not.toBeNull();
    await undo(page);
    await expect(notice(page)).toContainText("Undone: SQL step moved");
    await expect.poll(async () => (await readLayout(page, id)).steps[fast]).toEqual(start);
    expect(await sqlOf(fast)).toBe(`SELECT name AS n FROM ${points}`);
    // The failing run keeps the edit's step.
    await selectTile(page, `${points}_bad`);
    await panel(page).getByLabel(/^sql/).fill(`SELECT CAST(name AS INTEGER) AS m FROM ${points}`);
    await expect.poll(() => sqlOf(bad)).toBe(`SELECT CAST(name AS INTEGER) AS m FROM ${points}`);
    const badBefore = await runCount(page, id);
    await panel(page).locator("[data-run-node]").click();
    await runSettled(page, id, badBefore);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: SQL step edited");
    await expect.poll(() => sqlOf(bad)).toBe(`SELECT CAST(name AS INTEGER) AS n FROM ${points}`);
    // Another node's run leaves it.
    await selectTile(page, `${points}_other`);
    await panel(page).getByLabel(/^sql/).fill(`SELECT name AS o FROM ${points}`);
    await expect.poll(() => sqlOf(other)).toBe(`SELECT name AS o FROM ${points}`);
    await selectTile(page, `${points}_fast`);
    const againBefore = await runCount(page, id);
    await panel(page).locator("[data-run-node]").click();
    await runSettled(page, id, againBefore);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: SQL step edited");
    await expect.poll(() => sqlOf(other)).toBe(`SELECT name FROM ${points}`);
    // A layout step survives any run.
    await page.keyboard.press("Escape");
    const otherAt = (await readLayout(page, id)).steps[other];
    await dragMember(page, `${points}_other`, 0, 64);
    await expect.poll(async () => (await readLayout(page, id)).steps[other]).not.toEqual(otherAt);
    await selectTile(page, `${points}_other`);
    const otherBefore = await runCount(page, id);
    await panel(page).locator("[data-run-node]").click();
    await runSettled(page, id, otherBefore);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: SQL step moved");
    await expect.poll(async () => (await readLayout(page, id)).steps[other]).toEqual(otherAt);
  });

  await test.step("the step undone while its node is an unsettled member: refused with the run's reason, kept, and undone once the member settles without writing", async () => {
    await selectTile(page, `${points}_after`);
    await panel(page).getByLabel(/^sql/).fill(`SELECT * FROM ${points}_slow WHERE 1 = 1`);
    await expect.poll(() => sqlOf(after)).toBe(`SELECT * FROM ${points}_slow WHERE 1 = 1`);
    await selectTile(page, `${points}_fast`);
    const cancelBefore = await runCount(page, id);
    await panel(page).locator("[data-run-from]").click();
    await page.locator("[data-run-confirm] [data-confirm-run]").click();
    await expect(dock).toHaveAttribute("data-run-dock", "running");
    await expect(member(page, `${points}_after`)).toHaveAttribute("data-state", /waiting|queued/, { timeout: 20_000 });
    await undo(page);
    await expect(notice(page)).toContainText("Not undone");
    await expect(notice(page)).toContainText(/waiting|queued|running/);
    expect(await sqlOf(after)).toBe(`SELECT * FROM ${points}_slow WHERE 1 = 1`);
    await expect(undoBtn(page)).toBeEnabled();
    await page.locator("[data-run-action='cancel']").click();
    await runSettled(page, id, cancelBefore);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: SQL step edited");
    await expect.poll(() => sqlOf(after)).toBe(`SELECT * FROM ${points}_slow`);
  });

  await test.step("a headless run of an added node, then the add's undo: refused, the step dropped, the node stays", async () => {
    await page.reload();
    await settled(page);
    await selectTile(page, points);
    await pane(page).getByRole("tab", { name: /^Tools/ }).click();
    await pane(page).getByRole("button", { name: "Add Buffer" }).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.length).toBe(7);
    const added = (await readRecipe(page, id)).steps[6];
    expect(added.parameters.input).toBe(points);
    // The tool's own distance is empty until the panel fills it, and an
    // empty one refuses the run: it is set headlessly, so the add stays
    // the record's newest step.
    await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "PATCH", path: `/api/recipes/${id}/steps/${added.id}`, body: { parameters: { ...added.parameters, distance: 100 } } })).then(result => result.json);
    await runAndWait(page, id, added.id);
    await undo(page);
    await expect(notice(page)).toContainText("Not undone");
    await expect(notice(page)).toContainText("run");
    await page.waitForTimeout(500);
    expect(stepById(await readRecipe(page, id), added.id)).not.toBeNull();
    await expect(undoBtn(page)).toBeDisabled();
  });

  await test.step("the layout route cut: the screen keeps the undone state, Couldn't save with Retry, Retry writes it; the step route cut: the step kept, Retry applies it; a removal's undo answered but lost: Retry leaves one node", async () => {
    await page.keyboard.press("Escape");
    const start = (await readLayout(page, id)).steps[buf];
    const placeBefore = await wrapper(page, buf).evaluate((el) => (el as HTMLElement).style.transform);
    await dragMember(page, bufName, 80, 40);
    await expect.poll(async () => (await readLayout(page, id)).steps[buf]).not.toEqual(start);
    const dragged = (await readLayout(page, id)).steps[buf];
    await page.route(`**/api/recipes/${id}/layout`, (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
    await undo(page);
    await expect(statusChip(page)).toContainText(/Couldn.t save/);
    await expect(retryBtn(page)).toBeVisible();
    expect(await wrapper(page, buf).evaluate((el) => (el as HTMLElement).style.transform)).toBe(placeBefore);
    expect((await readLayout(page, id)).steps[buf]).toEqual(dragged);
    await page.unroute(`**/api/recipes/${id}/layout`);
    await clickRetry(page);
    await expect.poll(async () => (await readLayout(page, id)).steps[buf]).toEqual(start);
    // The step route cut.
    await selectTile(page, `${points}_fast`);
    await panel(page).getByLabel(/^sql/).fill(`SELECT name AS z FROM ${points}`);
    // The node has run, so the edit stands as its proposal: the effective
    // definition is the oracle here, never the active parameters alone.
    await expect.poll(() => liveSqlOf(fast)).toBe(`SELECT name AS z FROM ${points}`);
    // The node has run, so this undo travels the proposal's own road: the
    // cut covers both, the edit's PATCH and the discard's DELETE.
    const cutStep = `**/api/recipes/${id}/steps/${fast}**`;
    await page.route(cutStep, (route) => (["PATCH", "DELETE"].includes(route.request().method()) ? route.abort() : route.continue()));
    await undo(page);
    await expect(statusChip(page)).toContainText(/Couldn.t save/);
    await expect(retryBtn(page)).toBeVisible();
    await expect(undoBtn(page)).toBeEnabled();
    expect(await liveSqlOf(fast)).toBe(`SELECT name AS z FROM ${points}`);
    await page.unroute(cutStep);
    await clickRetry(page);
    await expect.poll(() => liveSqlOf(fast)).toBe(`SELECT name AS n FROM ${points}`);
    expect(stepById(await readRecipe(page, id), fast)?.proposedParameters).toBeNull();
    // The workflow's own read cut: the inverse cannot see what has
    // landed, so it says so and offers Retry through the frame's whisper,
    // as any edit's failure does.
    // This node has run, so the edit stands as its proposal: the
    // effective definition is the oracle, never the active parameters.
    await selectTile(page, `${points}_other`);
    await panel(page).getByLabel(/^sql/).fill(`SELECT name AS w FROM ${points}`);
    await expect.poll(() => liveSqlOf(other)).toBe(`SELECT name AS w FROM ${points}`);
    const cutRead = `**/api/recipes/${id}`;
    await page.route(cutRead, (route) => (route.request().method() === "GET" ? route.abort() : route.continue()));
    await undo(page);
    await expect(notice(page)).toContainText("Not undone");
    await expect(statusChip(page)).toContainText(/Couldn.t save/);
    await expect(retryBtn(page)).toBeVisible();
    await expect(undoBtn(page)).toBeEnabled();
    await page.unroute(cutRead);
    await clickRetry(page);
    await expect.poll(() => liveSqlOf(other)).toBe(`SELECT name FROM ${points}`);
    expect(stepById(await readRecipe(page, id), other)?.proposedParameters).toBeNull();
    // A removal's undo answered but its answer lost. The node is one that
    // never produced: a dataset the removal kept holds the name, and the
    // add would then be refused by the name rule,
    // never resumed.
    const count = (await readRecipe(page, id)).steps.length;
    await selectTile(page, `${points}_after`);
    await panel(page).getByRole("button", { name: "Remove node" }).click();
    await page.locator("[data-removal-dialog]").getByRole("button", { name: "Remove" }).click();
    await expect.poll(async () => (await readRecipe(page, id)).steps.length).toBe(count - 1);
    await page.route(`**/api/recipes/${id}/steps`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      // The server answers; the browser never hears it.
      await route.fetch();
      return route.abort();
    });
    await undo(page);
    await expect(statusChip(page)).toContainText(/Couldn.t save/);
    await expect(retryBtn(page)).toBeVisible();
    await page.unroute(`**/api/recipes/${id}/steps`);
    await clickRetry(page);
    await expect.poll(async () => (await readRecipe(page, id)).steps.length).toBe(count);
    expect((await readRecipe(page, id)).steps.filter((s) => s.parameters.name === `${points}_after`)).toHaveLength(1);
  });

  await test.step("a failure landing inside the previous save's fade keeps its Retry", async () => {
    // The record's writes follow one another closely: an undo's failed
    // write routinely lands while the *previous* save's "Saved" is still
    // fading. The fade is armed for 1400ms and belongs to the same owner,
    // so unless the owner's pending fade is dropped when it speaks again,
    // it clears the failure and its Retry about a second later and the
    // reader is left with a failed save and no way to send it again. The
    // gate is the visible "Saved": while it stands, its fade is pending.
    await page.keyboard.press("Escape");
    const start = (await readLayout(page, id)).steps[buf];
    await dragMember(page, bufName, 40, 24);
    await expect(statusChip(page)).toHaveText("Saved");
    await page.route(`**/api/recipes/${id}/layout`, (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
    await undo(page);
    await expect(statusChip(page)).toContainText(/Couldn.t save/);
    await expect(retryBtn(page)).toBeVisible();
    // Past the fade the earlier save armed: the failure must still stand.
    await page.waitForTimeout(1800);
    await expect(statusChip(page)).toContainText(/Couldn.t save/);
    await expect(retryBtn(page)).toBeVisible();
    await page.unroute(`**/api/recipes/${id}/layout`);
    await clickRetry(page);
    await expect.poll(async () => (await readLayout(page, id)).steps[buf]).toEqual(start);
  });

  await test.step("a Retry pressed after the canvas is locked sends nothing and keeps its step; unlocking lets the same Retry through", async () => {
    await page.keyboard.press("Escape");
    await selectTile(page, bufName);
    const before = await distanceOf();
    await panel(page).getByRole("spinbutton", { name: /^distance/ }).fill("512");
    await expect.poll(distanceOf).toBe(512);
    const cut = `**/api/recipes/${id}/steps/${buf}`;
    await page.route(cut, (route) => (route.request().method() === "PATCH" ? route.abort() : route.continue()));
    await undo(page);
    await expect(retryBtn(page)).toBeVisible();
    await page.unroute(cut);
    // The runs above left the results band open over the foot of the
    // stage stack, where the lock stands; a reader collapses it to reach
    // the lock, and so does this.
    await page.locator("[data-band-separator]").focus();
    await page.keyboard.press("Home");
    await expect(page.locator("[data-results-band]")).toHaveAttribute("data-collapsed", "true");
    // The canvas is locked after the failure. The whisper still offers
    // Retry, and that Retry re-enters the inverse: it must meet the lock
    // where a press meets it, send nothing, and leave the step where it
    // is.
    await lockBtn(page).click();
    await expect(host(page)).toHaveAttribute("data-locked", "true");
    await expect(retryBtn(page)).toBeVisible();
    const mutations = watchMutations(page);
    await clickRetry(page);
    await expect(notice(page)).toContainText(LOCK);
    await page.waitForTimeout(600);
    expect(mutations).toEqual([]);
    expect(await distanceOf()).toBe(512);
    // Unlocked, the same Retry resumes the step and applies it.
    await page.locator("[data-lock-pill] [data-unlock]").click();
    await expect(retryBtn(page)).toBeVisible();
    await clickRetry(page);
    await expect.poll(distanceOf).toBe(before);
    // The watcher's positive control, at its own site: the same watcher
    // that saw nothing while locked sees the request the unlocked Retry
    // made, so the empty assertion above was a watcher that can see.
    await expect.poll(() => mutations.filter((r) => r.method() === "PATCH" && r.url().endsWith(`/steps/${buf}`)).length).toBeGreaterThan(0);
    // The step was taken rather than dropped: it stands on the redo side.
    await expect(redoBtn(page)).toBeEnabled();
  });

  await test.step("a layout-save Retry pressed after the canvas is locked sends nothing and keeps Retry; unlocking lets the same Retry write", async () => {
    await page.keyboard.press("Escape");
    const before = (await readLayout(page, id)).steps[buf];
    await page.route(`**/api/recipes/${id}/layout`, (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
    await dragMember(page, bufName, 56, 32);
    await expect(retryBtn(page)).toBeVisible();
    const moved = await wrapper(page, buf).evaluate((el) => (el as HTMLElement).style.transform);
    await page.unroute(`**/api/recipes/${id}/layout`);

    await lockBtn(page).click();
    await expect(host(page)).toHaveAttribute("data-locked", "true");
    const writes = watchLayoutWrites(page);
    await clickRetry(page);
    // The absence first, so the red names the defect: on the unguarded road
    // the press sends the PUT at once.
    await page.waitForTimeout(600);
    expect(writes).toEqual([]);
    await expect(notice(page)).toHaveText(LOCK);
    await expect(retryBtn(page)).toBeVisible();
    expect(await wrapper(page, buf).evaluate((el) => (el as HTMLElement).style.transform)).toBe(moved);

    await page.locator("[data-lock-pill] [data-unlock]").click();
    await expect(retryBtn(page)).toBeVisible();
    await clickRetry(page);
    // Positive control at the absence assertion's own watcher: the same
    // listener sees the unlocked Retry carry the moved snapshot.
    await expect.poll(() => writes.length).toBeGreaterThan(0);
    await expect.poll(async () => (await readLayout(page, id)).steps[buf]).not.toEqual(before);
    expect(writes.at(-1)?.body.steps[buf]).toEqual((await readLayout(page, id)).steps[buf]);
  });

  await test.step("a definition changed headlessly, then that edit's undo: the read is the undone definition, last write wins", async () => {
    await selectTile(page, bufName);
    const before = await distanceOf();
    await panel(page).getByRole("spinbutton", { name: /^distance/ }).fill("300");
    await expect.poll(distanceOf).toBe(300);
    await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "PATCH", path: `/api/recipes/${id}/steps/${buf}`, body: { parameters: { input: points, distance: 400, name: bufName } } })).then(result => result.json);
    await undo(page);
    await expect(notice(page)).toContainText("Undone: Buffer edited");
    await expect.poll(distanceOf).toBe(before);
  });

  // The cut routes are the test's own, as is the failing statement's dry run and run.
  const induced = (e: { text: string; url?: string }) =>
    (/ERR_FAILED/.test(e.text) && /\/api\/recipes\//.test(e.url ?? "")) || (/status of 40[09]/.test(e.text) && /\/api\/(operations\/run|recipes\/)/.test(e.url ?? ""));
  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !induced(e));
  expect(unexpected).toEqual([]);
});

test("the chord, focus and the lock: every key, a held chord, focus after a stage press and empty ground, the editable controls and the dialogs, an open note editor, nothing to undo, inert while locked", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  const w = await seedWorkflow(page, "ch");
  await page.goto(`/workflows/${w.id}`);
  await settled(page);
  const bufAt = async () => (await readLayout(page, w.id)).steps[w.buf];
  const filtAt = async () => (await readLayout(page, w.id)).steps[w.filt];

  await test.step("⌘Z, Ctrl+Z, ⇧⌘Z, Shift+Ctrl+Z and Ctrl+Y each act; a held chord's repeats undo one step", async () => {
    const b0 = await bufAt();
    const f0 = await filtAt();
    await dragMember(page, w.bufName, 0, 64);
    await expect.poll(bufAt).not.toEqual(b0);
    const b1 = await bufAt();
    await dragMember(page, w.filtName, 0, 64);
    await expect.poll(filtAt).not.toEqual(f0);
    const f1 = await filtAt();
    await flowArea(page).focus();
    await page.keyboard.press("Meta+z");
    await expect.poll(filtAt).toEqual(f0);
    await page.keyboard.press("Control+z");
    await expect.poll(bufAt).toEqual(b0);
    await page.keyboard.press("Shift+Meta+z");
    await expect.poll(bufAt).toEqual(b1);
    await page.keyboard.press("Shift+Control+z");
    await expect.poll(filtAt).toEqual(f1);
    await page.keyboard.press("Control+y");
    await expect(notice(page)).toHaveText("Nothing to redo");
    // Held: one real press, then the browser's repeats, undo one step.
    await page.keyboard.down("Meta");
    await page.keyboard.press("z");
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, repeat: true, bubbles: true, cancelable: true }));
    });
    await page.keyboard.up("Meta");
    await expect.poll(filtAt).toEqual(f0);
    await page.waitForTimeout(600);
    expect(await bufAt()).toEqual(b1);
    await page.keyboard.press("Shift+Meta+z");
    await expect.poll(filtAt).toEqual(f1);
  });

  await test.step("after a press on Arrange and after a click on empty ground the chord undoes, wherever focus landed", async () => {
    const start = await readLayout(page, w.id);
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await expect.poll(bufAt).not.toEqual(start.steps[w.buf]);
    await page.waitForTimeout(700);
    await page.keyboard.press("Meta+z");
    await expect(notice(page)).toContainText("Undone: Arrange");
    await expect.poll(async () => positionsOf(await readLayout(page, w.id))).toEqual(positionsOf(start));
    await page.waitForTimeout(700);
    const b = await bufAt();
    await dragMember(page, w.bufName, 64, 0);
    await expect.poll(bufAt).not.toEqual(b);
    const at = await paneAt(page, 0.55, 0.6);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.press("Meta+z");
    await expect.poll(bufAt).toEqual(b);
  });

  await test.step("inside the note's field, the panel's name and a parameter field, the picker's search, the pane's search and the workflow's name, the chord is the control's own and the record is untouched; in the removal dialog and the run confirmation nothing is undone", async () => {
    // One step in the record, so an undo would be visible in the read.
    const b = await bufAt();
    await dragMember(page, w.bufName, 64, 0);
    await expect.poll(bufAt).not.toEqual(b);
    const moved = await bufAt();
    const untouched = async () => {
      await page.waitForTimeout(500);
      expect(await bufAt()).toEqual(moved);
      await expect(notice(page).filter({ hasText: /Undone/ })).toHaveCount(0);
    };
    // The note's field.
    await clickNote(page, w.notes[0].id);
    await page.keyboard.press("Enter");
    const field = page.locator("[data-note-field]");
    await expect(field).toBeFocused();
    const noteText = await field.inputValue();
    await page.keyboard.type("xyz");
    await page.keyboard.press("Meta+z");
    await expect(field).not.toHaveValue(`${noteText}xyz`);
    await untouched();
    await page.keyboard.press("Escape");
    // The panel's name and a parameter field.
    await selectTile(page, w.bufName);
    const name = panel(page).getByRole("textbox", { name: "Dataset name" });
    const nameBefore = await name.inputValue();
    await name.click();
    await page.keyboard.type("q");
    await page.keyboard.press("Meta+z");
    await expect(name).not.toHaveValue(`${nameBefore}q`);
    await untouched();
    const distance = panel(page).getByRole("spinbutton", { name: /^distance/ });
    await distance.click();
    await page.keyboard.press("End");
    await page.keyboard.type("5");
    await page.keyboard.press("Meta+z");
    await expect(distance).not.toHaveValue("1005");
    await untouched();
    // The picker's search.
    await panel(page).getByRole("combobox", { name: "Features to buffer" }).click();
    const search = page.locator("[data-picker-pop]").getByRole("textbox");
    await search.fill("");
    await page.keyboard.type("zz");
    await page.keyboard.press("Meta+z");
    await expect(search).not.toHaveValue("zz");
    await untouched();
    await page.keyboard.press("Escape");
    // The pane's search.
    await page.keyboard.press("Escape");
    const paneSearch = pane(page).getByRole("searchbox");
    await paneSearch.click();
    await page.keyboard.type("zz");
    await page.keyboard.press("Meta+z");
    await expect(paneSearch).not.toHaveValue("zz");
    await untouched();
    await paneSearch.fill("");
    // The workflow's name.
    await page.locator('button[title^="Rename "]').click();
    const wfName = page.getByRole("textbox", { name: "Workflow name" });
    await expect(wfName).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type("q");
    await page.keyboard.press("Meta+z");
    await expect(wfName).not.toHaveValue(/q$/);
    await untouched();
    await page.keyboard.press("Escape");
    // The removal dialog and the run confirmation.
    await selectTile(page, w.bufName);
    await panel(page).getByRole("button", { name: "Remove node" }).click();
    await expect(page.locator("[data-removal-dialog]")).toBeVisible();
    await page.keyboard.press("Meta+z");
    await untouched();
    await expect(page.locator("[data-removal-dialog]")).toBeVisible();
    await page.locator("[data-removal-dialog]").getByRole("button", { name: "Keep" }).click();
    await page.getByRole("button", { name: "Run all" }).click();
    await expect(page.locator("[data-run-confirm]")).toBeVisible();
    await page.keyboard.press("Meta+z");
    await untouched();
    await page.locator("[data-run-confirm]").getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("an undo pressed with a note editor open commits the changed text and takes that commit back", async () => {
    const before = (await readLayout(page, w.id)).notes.find((n) => n.id === w.notes[1].id)!;
    await page.keyboard.press("Escape");
    await clickNote(page, before.id);
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-note-field]")).toBeFocused();
    await page.keyboard.type(" tail");
    await undo(page);
    await expect(notice(page)).toContainText("Undone: note edited");
    await expect(page.locator("[data-note-field]")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect((await readLayout(page, w.id)).notes.find((n) => n.id === before.id)).toEqual(before);
  });

  await test.step("with nothing to undo the press says so and makes no request", async () => {
    await page.reload();
    await settled(page);
    const mutations = watchMutations(page);
    await expect(undoBtn(page)).toBeDisabled();
    await flowArea(page).focus();
    await page.keyboard.press("Meta+z");
    await expect(notice(page)).toHaveText("Nothing to undo");
    await page.waitForTimeout(500);
    expect(mutations).toEqual([]);
  });

  await test.step("the buttons and the chord are inert while locked with the reason, no request made; the record is intact after unlocking", async () => {
    const b = await bufAt();
    await dragMember(page, w.bufName, 64, 0);
    await expect.poll(bufAt).not.toEqual(b);
    await lockBtn(page).click();
    await expect(host(page)).toHaveAttribute("data-locked", "true");
    await expect(page.getByRole("button", { name: `Undo: ${LOCK}` })).toBeDisabled();
    await expect(page.getByRole("button", { name: `Redo: ${LOCK}` })).toBeDisabled();
    const mutations = watchMutations(page);
    await flowArea(page).focus();
    await page.keyboard.press("Meta+z");
    await expect(notice(page)).toContainText(LOCK);
    await page.waitForTimeout(500);
    expect(mutations).toEqual([]);
    expect(await bufAt()).not.toEqual(b);
    await page.locator("[data-lock-pill] [data-unlock]").click();
    await expect(undoBtn(page)).toBeEnabled();
    await undo(page);
    await expect.poll(bufAt).toEqual(b);
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

test("the session and the API: a reload, another workflow, a second tab each start empty; the inventory and the layout's documentation unchanged; an undo reads back as an ordinary edit", async ({ page, context }) => {
  const consoleErrors = trackConsole(page);
  const w = await seedWorkflow(page, "se");
  const wName = `Undo se ${runId}`;
  const elsewhereName = `Undo elsewhere ${runId}`;
  await newRecipe(page, elsewhereName);
  await page.goto(`/workflows/${w.id}`);
  await settled(page);
  const bufAt = async () => (await readLayout(page, w.id)).steps[w.buf];

  await test.step("a reload, and another workflow and back, start with an empty record; a second tab has no record of the first's steps", async () => {
    const b = await bufAt();
    await dragMember(page, w.bufName, 64, 0);
    await expect.poll(bufAt).not.toEqual(b);
    await expect(undoBtn(page)).toBeEnabled();
    const second = await context.newPage();
    await second.goto(`/workflows/${w.id}`);
    await settled(second);
    await expect(undoBtn(second)).toBeDisabled();
    await expect(redoBtn(second)).toBeDisabled();
    await second.close();
    await expect(undoBtn(page)).toBeEnabled();
    await page.reload();
    await settled(page);
    await expect(undoBtn(page)).toBeDisabled();
    await dragMember(page, w.bufName, 0, 64);
    await expect(undoBtn(page)).toBeEnabled();
    // Another workflow and back, client-side, through the rail and the
    // list: a fresh document empties every page-local state whatever the
    // canvas does, so a `goto` here could not fail. What carries this half
    // of the criterion is the canvas being keyed by the workflow's id, and
    // only a route change inside the same document can put that wrong. The
    // marker on `window` is the proof that the document never reloaded.
    await page.evaluate(() => ((window as unknown as { __sameDocument?: boolean }).__sameDocument = true));
    await openFromList(page, elsewhereName);
    await expect(undoBtn(page)).toBeDisabled();
    await openFromList(page, wName);
    await expect(undoBtn(page)).toBeDisabled();
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true)).toBe(true);
  });

  await test.step("the operation inventory and the layout document's documentation are unchanged", async () => {
    const doc = (await api(page, "GET", "/api/openapi.json")) as { paths: Record<string, Record<string, { tool?: string }>>; components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
    const recipePaths = Object.keys(doc.paths).filter((p) => p.startsWith("/api/recipes"));
    expect(recipePaths.filter((p) => /undo|redo|history/i.test(p))).toEqual([]);
    const recipeTools = recipePaths.flatMap((p) => Object.values(doc.paths[p]).map((o) => o.tool ?? ""));
    expect(recipeTools.filter((t) => /undo|redo|history/i.test(t))).toEqual([]);
    expect(Object.keys(doc.components.schemas.RecipeLayoutInput.properties ?? {}).sort()).toEqual(["notes", "sources", "steps"]);
  });

  await test.step("a step undone reads back through the API as an ordinary edit, the last-edited time advanced", async () => {
    const t0 = (await readRecipe(page, w.id)).updatedAt;
    const b = await bufAt();
    await page.waitForTimeout(1100);
    await dragMember(page, w.bufName, 64, 0);
    await expect.poll(bufAt).not.toEqual(b);
    const t1 = (await readRecipe(page, w.id)).updatedAt;
    expect(Date.parse(t1)).toBeGreaterThan(Date.parse(t0));
    await page.waitForTimeout(1100);
    await undo(page);
    await expect.poll(bufAt).toEqual(b);
    const t2 = (await readRecipe(page, w.id)).updatedAt;
    expect(Date.parse(t2)).toBeGreaterThan(Date.parse(t1));
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});
