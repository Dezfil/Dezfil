import { stepDefinitions } from "./workflow-definition";
import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
import { test, expect, type Page, type Request } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { seedCsv, trackConsole } from "./support";

/**
 * Notes on the canvas: the note tool and note mode, placing by click,
 * drag and Enter, the lead facts of a note in the layout read, moving
 * and resizing on the grid, the six colours, Duplicate, Delete, editing
 * in place, the markdown and the label block, headless notes and their
 * stacking, the minimap, Arrange, the empty prompt, the saves and Retry,
 * the run in flight, the hundred-note limit. The oracle for every stored
 * fact is the layout read and the recipe read; a claim of no write is
 * the absence of a write request.
 */

const runId = Date.now().toString(36);
const stations = `nt_stations_${runId}`;

type Json = Record<string, unknown>;
type Note = { id: string; x: number; y: number; w: number; h: number; color: string; text: string };
type Layout = { steps: Record<string, { x: number; y: number }>; sources: Record<string, { x: number; y: number }>; notes: Note[]; updatedAt: string | null };
type Run = { id: string; outcome: string | null; members: { stepId: string; state: string }[] };

const ENDLESS = "SELECT count(*) AS n FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";
const NEW_TEXT = "---\nlabel: note\n---\n";

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
const readLayout = async (page: Page, id: string) => (await ok(page, "GET", `/api/recipes/${id}/layout`)).layout as Layout;
const readRecipe = async (page: Page, id: string) => (await ok(page, "GET", `/api/recipes/${id}`)).recipe as Json & { steps: Json[]; updatedAt: string };
const putLayout = (page: Page, id: string, layout: Partial<Layout>) => readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "PUT", path: `/api/recipes/${id}/layout`, body: { steps: {}, sources: {}, notes: [], ...layout } })).then(result => result.json);
const listRuns = async (page: Page, id: string) => (await ok(page, "GET", `/api/recipes/${id}/runs`)).runs as Run[];

/** Every layout write the page makes. */
function watchWrites(page: Page): Request[] {
  const writes: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && /\/layout$/.test(r.url())) writes.push(r);
  });
  return writes;
}
async function settled(page: Page) {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.waitForTimeout(400);
}
const host = (page: Page) => page.locator("[data-workflow-canvas]");
const tool = (page: Page) => page.locator("[data-note-tool]");
const noteEl = (page: Page, id: string) => page.locator(`[data-note][data-note-id="${id}"]`);
const noteNode = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="note:${id}"]`);
const field = (page: Page) => page.locator("[data-note-field]");
const menu = (page: Page) => page.locator("[data-note-menu]");
const notesOf = async (page: Page, id: string) => (await readLayout(page, id)).notes;
/** A point on the canvas's background near the fraction asked for: the
 * nearest spot whose top element is the library's pane, clear of the
 * floating pane, the stage, the tiles, the notes and the band. */
async function paneAt(page: Page, fx: number, fy: number) {
  const area = (await page.locator("[data-flow-area]").boundingBox())!;
  const candidates: { x: number; y: number }[] = [];
  for (let dy = 0; dy <= 0.5; dy += 0.05) for (let dx = 0; dx <= 0.5; dx += 0.05) candidates.push({ x: area.x + area.width * Math.min(0.95, fx + dx), y: area.y + area.height * Math.min(0.85, fy + dy) });
  const found = await page.evaluate(
    (points) => points.find((p) => document.elementFromPoint(p.x, p.y)?.classList.contains("react-flow__pane")) ?? null,
    candidates,
  );
  if (!found) throw new Error("no background point found");
  return found;
}
/** On the eight-pixel grid (a negative value's remainder is a negative zero). */
const onGrid = (v: number) => Math.abs(v % 8) === 0;
/** A point inside two notes' overlap whose top element is a note at all:
 * clear of the stage stack, a tile and a panel. Returns the note found on
 * top there, so the stacking claim is the caller's assertion. */
async function overlapPoint(page: Page, a: string, b: string) {
  const ba = (await noteEl(page, a).boundingBox())!;
  const bb = (await noteEl(page, b).boundingBox())!;
  const left = Math.max(ba.x, bb.x);
  const top = Math.max(ba.y, bb.y);
  const right = Math.min(ba.x + ba.width, bb.x + bb.width);
  const bottom = Math.min(ba.y + ba.height, bb.y + bb.height);
  expect(right - left).toBeGreaterThan(20);
  expect(bottom - top).toBeGreaterThan(20);
  const candidates: { x: number; y: number }[] = [];
  for (let fy = 0.1; fy <= 0.9; fy += 0.1) for (let fx = 0.1; fx <= 0.9; fx += 0.1) candidates.push({ x: left + (right - left) * fx, y: top + (bottom - top) * fy });
  const found = await page.evaluate(
    (points) => {
      for (const p of points) {
        const note = document.elementFromPoint(p.x, p.y)?.closest("[data-note]");
        if (note) return { ...p, top: note.getAttribute("data-note-id") };
      }
      return null;
    },
    candidates,
  );
  if (!found) throw new Error("no point in the overlap shows a note on top");
  return found;
}
/** A click on a note where the note is on top: the preferred spot first
 * (its lower right by default), else the first of a grid over its box
 * whose top element is this note, clear of the stage, a tile, a later
 * note, the floating pane and a panel. Fails when none appears within five
 * seconds. */
async function noteSpot(page: Page, id: string, fx = 0.8, fy = 0.8) {
  // The box is read where the points are tried, once the note has held
  // still for two frames: a view change moves the canvas after the library
  // measures it, and something passing over the note (a closing menu, a
  // note being dropped) clears again. Asked again until a bound, so only a
  // note that stays covered fails.
  let found: { x: number; y: number } | null = null;
  await expect
    .poll(
      async () =>
        (found = await page.evaluate(
          async ({ id, fx, fy }) => {
            const note = document.querySelector(`[data-note][data-note-id="${id}"]`);
            if (!note) return null;
            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            const before = note.getBoundingClientRect();
            await frame();
            await frame();
            const box = note.getBoundingClientRect();
            if (box.x !== before.x || box.y !== before.y || box.width !== before.width || box.height !== before.height) return null;
            const points = [{ x: box.x + box.width * fx, y: box.y + box.height * fy }];
            for (let gy = 1; gy <= 9; gy++) for (let gx = 1; gx <= 9; gx++) points.push({ x: box.x + (box.width * gx) / 10, y: box.y + (box.height * gy) / 10 });
            return points.find((p) => document.elementFromPoint(p.x, p.y)?.closest("[data-note]")?.getAttribute("data-note-id") === id) ?? null;
          },
          { id, fx, fy },
        )),
      { message: `a clear spot on note ${id}`, timeout: 5_000 },
    )
    .not.toBeNull();
  return found!;
}
async function clickNote(page: Page, id: string, fx = 0.8, fy = 0.8) {
  const at = await noteSpot(page, id, fx, fy);
  await page.mouse.click(at.x, at.y);
}
/** A drag: a two-pixel nudge first, which the library spends starting the
 * drag, then the distance in steps, so the moved distance is the asked one. */
async function dragFrom(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(dx || 1) * 2, from.y);
  for (let i = 1; i <= 6; i++) await page.mouse.move(from.x + (dx * i) / 6, from.y + (dy * i) / 6);
  await page.mouse.up();
}
test.afterEach(async ({ page }) => {
  for (const id of made.splice(0)) {
    const runs = await api(page, "GET", `/api/recipes/${id}/runs`);
    for (const run of ((runs.json.runs as Run[] | undefined) ?? []).filter((r) => r.outcome === null)) {
      await api(page, "POST", `/api/recipes/${id}/runs/${run.id}/cancel`);
    }
  }
});

test("the tool and note mode, placing by click, drag and Enter, moving, resizing, the colours, Duplicate, Delete, editing and the markdown", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await page.goto("/workflows");
  await seedCsv(page, stations, "name,riders,lon,lat\nalex,10450,13.4133,52.5219\nhbf,22310,13.3696,52.5251\n");
  const id = await newRecipe(page, `Notes ${runId}`);
  await addSql(page, id, `SELECT * FROM ${stations}`, `nt_a_${runId}`);
  // The node sits at the far right so the notes have the pane's left clear.
  await page.goto(`/workflows/${id}`);
  await settled(page);
  await page.getByRole("button", { name: "Arrange by dependency" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const writes = watchWrites(page);
  let first: Note;

  await test.step("the tool enters note mode with the notice; a click places the default note, opened for editing; the read holds it", async () => {
    const recipeBefore = await readRecipe(page, id);
    await tool(page).click();
    await expect(host(page)).toHaveAttribute("data-mode", "note");
    await expect(tool(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-canvas-notice]")).toContainText("Click or drag on the canvas to place a note, or press Enter for the centre. Esc cancels.");
    const at = await paneAt(page, 0.3, 0.75);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator("[data-note]")).toHaveCount(1);
    await expect(host(page)).not.toHaveAttribute("data-mode", "note");
    await expect(field(page)).toBeFocused();
    await expect(page.locator("[data-node-panel]")).toHaveCount(0);
    await expect.poll(async () => (await notesOf(page, id)).length).toBe(1);
    first = (await notesOf(page, id))[0];
    expect(first).toMatchObject({ w: 320, h: 176, color: "yellow", text: NEW_TEXT });
    expect(onGrid(first.x)).toBe(true);
    expect(onGrid(first.y)).toBe(true);
    expect(stepDefinitions((await readRecipe(page, id)).steps)).toEqual(stepDefinitions(recipeBefore.steps));
    await page.keyboard.press("Escape");
    await expect(field(page)).toHaveCount(0);
    await expect(noteNode(page, first.id)).toBeFocused();
    await expect(noteEl(page, first.id).locator("[data-note-label]")).toHaveText("note");
    // An empty note shows its label strip and nothing else: the display-mode
    // hint was cut at a field round.
    await expect(noteEl(page, first.id).locator("[data-note-body]")).toHaveCount(0);
    await expect(noteEl(page, first.id)).toHaveText("note");
  });

  await test.step("a drag draws a note of its size on the grid; a tiny drag makes the minimum; Enter places the default at the centre", async () => {
    await tool(page).click();
    const from = await paneAt(page, 0.3, 0.35);
    await dragFrom(page, from, 400, 250);
    await expect.poll(async () => (await notesOf(page, id)).length).toBe(2);
    const zoom = Number(await page.locator(".react-flow__viewport").evaluate((el) => /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? "1"));
    const second = (await notesOf(page, id))[1];
    expect(Math.abs(second.w - Math.round(400 / zoom / 8) * 8)).toBeLessThanOrEqual(8);
    expect(onGrid(second.w)).toBe(true);
    expect(onGrid(second.h)).toBe(true);
    expect(second.w).toBeGreaterThanOrEqual(200);
    await page.keyboard.press("Escape");
    await tool(page).click();
    const tiny = await paneAt(page, 0.6, 0.2);
    await dragFrom(page, tiny, 10, 6);
    await expect.poll(async () => (await notesOf(page, id)).length).toBe(3);
    // Past the click tolerance, a drag; under the minimum, the minimum.
    const third = (await notesOf(page, id))[2];
    expect(third.w).toBe(200);
    expect(third.h).toBe(112);
    await page.keyboard.press("Escape");
    // A key-closed edit returns focus to the note; n from there.
    await expect(noteNode(page, third.id)).toBeFocused();
    await page.keyboard.press("n");
    await expect(host(page)).toHaveAttribute("data-mode", "note");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await notesOf(page, id)).length).toBe(4);
    const fourth = (await notesOf(page, id))[3];
    expect(fourth).toMatchObject({ w: 320, h: 176 });
    await page.keyboard.press("Escape");
    await expect(field(page)).toHaveCount(0);
    await expect(noteNode(page, fourth.id)).toBeFocused();
  });

  await test.step("note mode ends on Escape with focus on the tool; N does nothing from the pane's search or the band's tab", async () => {
    await page.keyboard.press("n");
    await expect(host(page)).toHaveAttribute("data-mode", "note");
    await page.keyboard.press("Escape");
    await expect(host(page)).not.toHaveAttribute("data-mode", "note");
    await expect(tool(page)).toBeFocused();
    await page.getByRole("searchbox", { name: "Search sources" }).focus();
    await page.keyboard.press("n");
    await expect(host(page)).not.toHaveAttribute("data-mode", "note");
    await page.getByRole("tab", { name: /^Messages/ }).focus();
    await page.keyboard.press("n");
    await expect(host(page)).not.toHaveAttribute("data-mode", "note");
    await page.keyboard.press("Escape");
  });

  await test.step("the swatches recolour; Duplicate adds an offset copy, selected and focused; Delete removes with the notice", async () => {
    await clickNote(page, first.id);
    await expect(menu(page)).toBeVisible();
    await menu(page).locator("[data-note-swatch='blue']").click();
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === first.id)?.color).toBe("blue");
    await expect(menu(page).locator("[data-note-swatch='blue']")).toHaveAttribute("aria-pressed", "true");
    const before = await notesOf(page, id);
    await menu(page).locator("[data-note-duplicate]").click();
    await expect.poll(async () => (await notesOf(page, id)).length).toBe(before.length + 1);
    const after = await notesOf(page, id);
    const copy = after[after.length - 1];
    expect(copy).toMatchObject({ x: first.x + 32, y: first.y + 32, w: first.w, h: first.h, color: "blue", text: first.text });
    await expect(noteEl(page, copy.id)).toHaveAttribute("data-sel", "true");
    await expect(noteNode(page, copy.id)).toBeFocused();
    const recipeBefore = await readRecipe(page, id);
    await page.keyboard.press("Delete");
    await expect(page.locator("[data-canvas-notice]")).toContainText("Note removed.");
    await expect.poll(async () => (await notesOf(page, id)).map((n) => n.id)).not.toContain(copy.id);
    expect(stepDefinitions((await readRecipe(page, id)).steps)).toEqual(stepDefinitions(recipeBefore.steps));
    await expect(page.locator("[data-flow-area]")).toBeFocused();
  });

  await test.step("a drag moves a note on the grid; the arrows step it; the read agrees, after a reload too", async () => {
    const notes = await notesOf(page, id);
    const target = notes[1];
    const steps = (await readLayout(page, id)).steps;
    await dragFrom(page, await noteSpot(page, target.id, 0.5, 0.8), 80, 40);
    // The move's own write, not an earlier Saved still showing.
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === target.id)?.x).not.toBe(target.x);
    const zoom = Number(await page.locator(".react-flow__viewport").evaluate((el) => /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? "1"));
    const moved = (await notesOf(page, id)).find((n) => n.id === target.id)!;
    expect(onGrid(moved.x)).toBe(true);
    expect(onGrid(moved.y)).toBe(true);
    expect(Math.abs(moved.x - target.x - 80 / zoom)).toBeLessThanOrEqual(8);
    expect((await readLayout(page, id)).steps).toEqual(steps);
    expect((await notesOf(page, id)).filter((n) => n.id !== target.id)).toEqual(notes.filter((n) => n.id !== target.id));
    await clickNote(page, target.id);
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === target.id)?.x).toBe(moved.x + 8);
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === target.id)?.x).toBe(moved.x + 40);
    await page.reload();
    await settled(page);
    expect((await notesOf(page, id)).find((n) => n.id === target.id)?.x).toBe(moved.x + 40);
  });

  await test.step("the east, south-east and north-west handles resize on the grid, the far edge kept; the read holds every changed field", async () => {
    // The last note: on top of every other, so no later note covers a
    // handle (the stacking is the document's order, selection lifting
    // nothing).
    const notes = await notesOf(page, id);
    const target = notes[notes.length - 1];
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(300);
    await clickNote(page, target.id);
    const zoomOf = async () => Number(await page.locator(".react-flow__viewport").evaluate((el) => /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? "1"));
    const refit = async () => {
      await page.getByRole("button", { name: "Fit to view" }).click();
      await page.waitForTimeout(350);
      await expect(noteEl(page, target.id)).toHaveAttribute("data-sel", "true");
      return zoomOf();
    };
    let zoom = await zoomOf();
    // A side is the library's line control; a corner carries both classes.
    const handle = (pos: string) => {
      const [a, b] = pos.split("-");
      return noteNode(page, target.id).locator(b ? `.react-flow__resize-control.handle.${a}.${b}` : `.react-flow__resize-control.line.${a}`);
    };
    const centreOf = async (pos: string) => {
      const b = (await handle(pos).boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    await dragFrom(page, await centreOf("right"), 64 * zoom, 0);
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === target.id)?.w).toBe(target.w + 64);
    let now = (await notesOf(page, id)).find((n) => n.id === target.id)!;
    expect(now.h).toBe(target.h);
    // A wider note may reach past the edge: the view is fitted again
    // before each corner, the selection kept.
    zoom = await refit();
    await dragFrom(page, await centreOf("bottom-right"), 16 * zoom, 16 * zoom);
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === target.id)?.w).toBe(now.w + 16);
    now = (await notesOf(page, id)).find((n) => n.id === target.id)!;
    expect(now.h).toBe(target.h + 16);
    const right = now.x + now.w;
    const bottom = now.y + now.h;
    zoom = await refit();
    await dragFrom(page, await centreOf("top-left"), -16 * zoom, -16 * zoom);
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === target.id)?.x).toBe(now.x - 16);
    const last = (await notesOf(page, id)).find((n) => n.id === target.id)!;
    expect(last.y).toBe(now.y - 16);
    expect(last.x + last.w).toBe(right);
    expect(last.y + last.h).toBe(bottom);
    await page.reload();
    await settled(page);
    expect((await notesOf(page, id)).find((n) => n.id === target.id)).toEqual(last);
  });

  await test.step("editing: the raw text, the label strip, the markdown, an unchanged edit writes nothing, the limit", async () => {
    const notes = await notesOf(page, id);
    const target = notes[0];
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(300);
    await noteEl(page, target.id).dblclick();
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue(target.text);
    const text = "---\nlabel: intake\n---\n# One\n## Two\n### Three\n- a\n- b\n\n**bold** *it* `code` [OSM](https://osm.org) <b>x</b> ![alt](https://x.example/a.png) [x](javascript:alert(1))";
    await field(page).fill(text);
    await page.keyboard.press("Control+Enter");
    await expect(field(page)).toHaveCount(0);
    await expect(noteNode(page, target.id)).toBeFocused();
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === target.id)?.text).toBe(text);
    const el = noteEl(page, target.id);
    await expect(el.locator("[data-note-label]")).toHaveText("intake");
    const body = el.locator("[data-note-body]");
    await expect(body.locator("h1")).toHaveText("One");
    await expect(body.locator("h2")).toHaveText("Two");
    await expect(body.locator("h3")).toHaveText("Three");
    await expect(body.locator("ul li")).toHaveCount(2);
    await expect(body.locator("strong")).toHaveText("bold");
    await expect(body.locator("em")).toHaveText("it");
    await expect(body.locator("code")).toHaveText("code");
    await expect(body.locator("a")).toHaveCount(1);
    await expect(body.locator("a")).toHaveAttribute("href", "https://osm.org");
    await expect(body.locator("a")).toHaveAttribute("target", "_blank");
    await expect(body.locator("b, img, table")).toHaveCount(0);
    await expect(body).toContainText("<b>x</b>");
    await expect(body).toContainText("![alt](https://x.example/a.png)");
    await expect(body).toContainText("[x](javascript:alert(1))");
    // An unchanged edit closes without a write request.
    const seen = writes.length;
    const stamp = (await readLayout(page, id)).updatedAt;
    await el.dblclick();
    await expect(field(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(field(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(writes.length).toBe(seen);
    expect((await readLayout(page, id)).updatedAt).toBe(stamp);
    // The limit, in the API's measure: 3,998 letters accept one emoji and no more.
    await el.dblclick();
    await field(page).fill("x".repeat(3998) + "😀");
    await expect(page.locator("[data-note-limit]")).toBeVisible();
    await page.keyboard.type("y");
    expect((await field(page).inputValue()).length).toBe(4000);
    await page.keyboard.press("Control+Enter");
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === target.id)?.text.length).toBe(4000);
    // The canvas's keys do nothing while the field has focus.
    await el.dblclick();
    await expect(field(page)).toBeFocused();
    const before = await notesOf(page, id);
    await page.keyboard.press("Delete");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("n");
    await expect(host(page)).not.toHaveAttribute("data-mode", "note");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    expect((await notesOf(page, id)).map((n) => [n.id, n.x])).toEqual(before.map((n) => [n.id, n.x]));
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});

test("headless notes: stacking under the graph and among themselves, the label block's readings, the minimap, Arrange, fit, the empty prompt, a removed node, the duplicate, an unknown colour, the limit", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await page.goto("/workflows");
  await seedCsv(page, stations, "name,riders,lon,lat\nalex,10450,13.4133,52.5219\nhbf,22310,13.3696,52.5251\n");
  const id = await newRecipe(page, `Notes headless ${runId}`);
  const a = await addSql(page, id, `SELECT * FROM ${stations}`, `nh_a_${runId}`);
  const n1: Note = { id: "n1", x: 120, y: 120, w: 400, h: 300, color: "yellow", text: "---\nlabel: intake\nextra: 1\n---\nbody one" };
  const n2: Note = { id: "n2", x: 320, y: 220, w: 400, h: 300, color: "green", text: "no block here" };
  const n3: Note = { id: "n3", x: 900, y: 120, w: 200, h: 112, color: "grey", text: "---\nlabel:\n---\nblank label" };
  const n4: Note = { id: "n4", x: 900, y: 300, w: 200, h: 112, color: "pink", text: "---\nlabel: lost\nno fence" };
  const small: Note = { id: "n5", x: 900, y: 500, w: 100, h: 50, color: "purple", text: "small" };
  await putLayout(page, id, { steps: { [a]: { x: 400, y: 300 } }, sources: { [stations]: { x: 40, y: 600 } }, notes: [n1, n2, n3, n4, small] });
  const writes = watchWrites(page);
  await page.goto(`/workflows/${id}`);
  await settled(page);

  await test.step("they draw where the document puts them, the small one at its size, and the open makes no write request", async () => {
    await expect(page.locator("[data-note]")).toHaveCount(5);
    await page.waitForTimeout(500);
    expect(writes).toEqual([]);
    const zoom = Number(await page.locator(".react-flow__viewport").evaluate((el) => /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? "1"));
    const box = (await noteEl(page, "n5").boundingBox())!;
    expect(Math.abs(box.width / zoom - 100)).toBeLessThan(3);
    expect(Math.abs(box.height / zoom - 50)).toBeLessThan(3);
  });

  await test.step("the label block: a second line does not unmake it; no block, a blank value and a missing fence read as the spec says", async () => {
    await expect(noteEl(page, "n1").locator("[data-note-label]")).toHaveText("intake");
    await expect(noteEl(page, "n1").locator("[data-note-body]")).toHaveText("body one");
    await expect(noteEl(page, "n2").locator("[data-note-label]")).toHaveCount(0);
    await expect(noteEl(page, "n2").locator("[data-note-body]")).toHaveText("no block here");
    await expect(noteEl(page, "n3").locator("[data-note-label]")).toHaveCount(0);
    await expect(noteEl(page, "n3").locator("[data-note-body]")).toHaveText("blank label");
    await expect(noteEl(page, "n4").locator("[data-note-label]")).toHaveCount(0);
    await expect(noteEl(page, "n4").locator("[data-note-body]")).toContainText("label: lost");
  });

  await test.step("a node over a note takes the pointer and drags alone; the later note over the earlier takes it; the earlier is reached by keyboard; the order never changes", async () => {
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(300);
    const tile = page.locator(`[data-node][data-name="nh_a_${runId}"] [data-v]`).first();
    const tb = (await tile.boundingBox())!;
    const topAtTile = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-node], [data-note]")?.getAttribute("data-name") ?? document.elementFromPoint(x, y)?.closest("[data-note]")?.getAttribute("data-note-id"), { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 });
    expect(topAtTile).toBe(`nh_a_${runId}`);
    const notesBefore = await notesOf(page, id);
    await dragFrom(page, { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 }, 40, 0);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect(await notesOf(page, id)).toEqual(notesBefore);
    // Where n1 and n2 overlap, n2 (the later) takes the click.
    const over = await overlapPoint(page, "n1", "n2");
    expect(over.top).toBe("n2");
    await page.mouse.click(over.x, over.y);
    await expect(noteEl(page, "n2")).toHaveAttribute("data-sel", "true");
    await expect(noteEl(page, "n1")).not.toHaveAttribute("data-sel", "true");
    // The earlier by keyboard, then a recolour: the read's order stands.
    await noteNode(page, "n1").focus();
    await page.keyboard.press("Enter");
    await expect(noteEl(page, "n1")).toHaveAttribute("data-sel", "true");
    await menu(page).locator("[data-note-swatch='blue']").click();
    await expect.poll(async () => (await notesOf(page, id)).map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect((await notesOf(page, id))[0].color).toBe("blue");
  });

  await test.step("selecting a note closes the source panel; selecting a source clears the note", async () => {
    await page.locator(`.react-flow__node[aria-label="${stations}, source table"]`).click();
    await expect(page.locator("[data-source-panel]")).toBeVisible();
    // The first note's lower left: clear of the panel on the right, the
    // later note over its right half, the floating pane and the stage.
    await clickNote(page, "n1", 0.15, 0.85);
    await expect(noteEl(page, "n1")).toHaveAttribute("data-sel", "true");
    await expect(page.locator("[data-source-panel]")).toHaveCount(0);
    await expect(page.locator("[data-band-lead]")).toHaveText("Select a node or a table to see its data");
    await page.locator(`.react-flow__node[aria-label="${stations}, source table"]`).click();
    await expect(noteEl(page, "n1")).not.toHaveAttribute("data-sel", "true");
    await page.keyboard.press("Escape");
  });

  await test.step("Arrange leaves every note; Fit brings a far note into view; a small note's first resize brings it to the minimum", async () => {
    const before = await notesOf(page, id);
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect(await notesOf(page, id)).toEqual(before);
    await putLayout(page, id, { ...(await readLayout(page, id)), notes: [...before, { id: "far", x: 4000, y: 3000, w: 320, h: 176, color: "yellow", text: "far" }] });
    await page.reload();
    await settled(page);
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(400);
    await expect(noteEl(page, "far")).toBeInViewport();
    // The small note: selected it keeps 100 by 50; its first resize settles at the minimum.
    await clickNote(page, "n5");
    expect((await notesOf(page, id)).find((n) => n.id === "n5")).toMatchObject({ w: 100, h: 50 });
    const handle = noteNode(page, "n5").locator(".react-flow__resize-control.line.right");
    const hb = (await handle.boundingBox())!;
    await dragFrom(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, 4, 0);
    await expect.poll(async () => (await notesOf(page, id)).find((n) => n.id === "n5")?.w).toBe(200);
    expect((await notesOf(page, id)).find((n) => n.id === "n5")?.h).toBe(112);
  });

  await test.step("the minimap draws the notes behind the members and takes them into its extent at six members, and is absent at five", async () => {
    // Five more nodes: six members with the source.
    for (let i = 0; i < 4; i++) await addSql(page, id, `SELECT ${i} AS v`, `nh_${i}_${runId}`);
    await page.reload();
    await settled(page);
    await expect(page.locator("[data-minimap]")).toBeVisible();
    await expect(page.locator("[data-minimap] rect[data-c]")).toHaveCount(6);
    const order = await page.locator("[data-minimap] rect").evaluateAll((rs) => rs.map((r) => (r.hasAttribute("data-c") ? "note" : r.hasAttribute("data-s") ? "member" : "view")));
    expect(order.indexOf("member")).toBeGreaterThan(order.lastIndexOf("note"));
  });

  await test.step("an empty workflow with one note shows no empty prompt; a removed node leaves the notes; the duplicate carries them; an unknown colour is refused", async () => {
    const lone = await newRecipe(page, `Notes lone ${runId}`);
    await putLayout(page, lone, { notes: [{ id: "only", x: 100, y: 100, w: 320, h: 176, color: "grey", text: "alone" }] });
    await page.goto(`/workflows/${lone}`);
    await settled(page);
    await expect(page.locator("[data-note]")).toHaveCount(1);
    await expect(page.getByText("No nodes yet")).toHaveCount(0);
    const gone = await addSql(page, lone, "SELECT 1 AS x", `nh_gone_${runId}`);
    await readThenWriteBrowserSetup(page, `/api/recipes/${lone}`, () => ({ method: "DELETE", path: `/api/recipes/${lone}/steps/${gone}` })).then(result => result.json);
    expect((await notesOf(page, lone)).map((n) => n.id)).toEqual(["only"]);
    const copy = (await ok(page, "POST", `/api/recipes/${lone}/duplicate`, {})).recipe as { id: string };
    made.push(copy.id);
    expect(await notesOf(page, copy.id)).toEqual(await notesOf(page, lone));
    await page.goto(`/workflows/${copy.id}`);
    await settled(page);
    await expect(noteEl(page, "only")).toBeVisible();
    const layoutBefore = await readLayout(page, lone);
    const refused = await readThenWriteBrowserSetup(page, `/api/recipes/${lone}`, () => ({ method: "PUT", path: `/api/recipes/${lone}/layout`, body: { steps: {}, sources: {}, notes: [{ ...layoutBefore.notes[0], color: "red" }] } }));
    expect(refused.status).toBe(400);
    expect(await readLayout(page, lone)).toEqual(layoutBefore);
  });

  await test.step("a hundred notes: the tool and Duplicate unavailable, saying why", async () => {
    const lone = made[made.length - 2];
    const hundred = Array.from({ length: 100 }, (_, i) => ({ id: `h${i}`, x: (i % 10) * 340, y: Math.floor(i / 10) * 200, w: 320, h: 176, color: "yellow", text: `note ${i}` }));
    await putLayout(page, lone, { notes: hundred });
    await page.goto(`/workflows/${lone}`);
    await settled(page);
    await expect(tool(page)).toBeDisabled();
    expect(await tool(page).getAttribute("aria-label")).toContain("a hundred notes");
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(300);
    await noteNode(page, "h0").focus();
    await page.keyboard.press("Enter");
    await expect(menu(page).locator("[data-note-duplicate]")).toBeDisabled();
  });

  await test.step("a note id with a quote, valid to the API, renders, opens and closes an edit, focus returning, without a crash", async () => {
    const quoted = 'q"uo\\te';
    await putLayout(page, id, { ...(await readLayout(page, id)), notes: [...(await notesOf(page, id)), { id: quoted, x: 1400, y: 120, w: 320, h: 176, color: "green", text: "quoted id" }] });
    // The earlier steps left the page on another workflow: back to this one.
    await page.goto(`/workflows/${id}`);
    await settled(page);
    const el = page.locator('[data-note][data-note-id^="q"]');
    await expect(el).toHaveCount(1);
    await page.getByRole("button", { name: "Fit to view" }).click();
    await page.waitForTimeout(300);
    await el.dblclick();
    await expect(field(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(field(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-id"))).toBe(`note:${quoted}`);
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !/\/layout$/.test(e.url ?? ""));
  expect(unexpected).toEqual([]);
});

test("the saves: Saving and Saved, a cut write with a change meanwhile and Retry, last-edited, the run in flight, the framed view, the limit across a stale retry and Reload", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await page.goto("/workflows");
  await seedCsv(page, stations, "name,riders,lon,lat\nalex,10450,13.4133,52.5219\n");
  const id = await newRecipe(page, `Notes saves ${runId}`);
  const slow = await addSql(page, id, ENDLESS, `ns_slow_${runId}`);
  await putLayout(page, id, { steps: { [slow]: { x: 300, y: 120 } }, notes: [{ id: "s1", x: 200, y: 200, w: 400, h: 300, color: "yellow", text: "behind the slow node" }] });
  await page.goto(`/workflows/${id}`);
  await settled(page);

  await test.step("a note change says Saving then Saved and advances last-edited; a cut write keeps the state, a change meanwhile is kept, Retry writes the newest", async () => {
    const recipeBefore = await readRecipe(page, id);
    await clickNote(page, "s1");
    await menu(page).locator("[data-note-swatch='green']").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect((await notesOf(page, id))[0].color).toBe("green");
    const recipeAfter = await readRecipe(page, id);
    expect(String(recipeAfter.updatedAt) > String(recipeBefore.updatedAt)).toBe(true);
    expect(stepDefinitions(recipeAfter.steps)).toEqual(stepDefinitions(recipeBefore.steps));
    await page.route("**/api/recipes/*/layout", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
    await menu(page).locator("[data-note-swatch='pink']").click();
    await expect(page.getByText("Couldn’t save")).toBeVisible();
    await expect(noteEl(page, "s1")).toHaveAttribute("data-color", "pink");
    await menu(page).locator("[data-note-swatch='purple']").click();
    await expect(noteEl(page, "s1")).toHaveAttribute("data-color", "purple");
    expect((await notesOf(page, id))[0].color).toBe("green");
    await page.unroute("**/api/recipes/*/layout");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect((await notesOf(page, id))[0].color).toBe("purple");
  });

  await test.step("a note behind a running member is recoloured while the run holds the lane; the run's record names the same members in the same states", async () => {
    await page.locator("[data-run-action='run-all']").click();
    await page.locator("[data-run-confirm] [data-confirm-run]").click();
    await expect(page.locator("[data-run-dock]")).toHaveAttribute("data-run-dock", "running");
    await expect(page.locator(`[data-node][data-name="ns_slow_${runId}"]`)).toHaveAttribute("data-state", "running", { timeout: 15_000 });
    const run = (await listRuns(page, id)).find((r) => r.outcome === null)!;
    const before = run.members.map((m) => [m.stepId, m.state]);
    await clickNote(page, "s1");
    await menu(page).locator("[data-note-swatch='grey']").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect((await notesOf(page, id))[0].color).toBe("grey");
    const after = (await listRuns(page, id)).find((r) => r.id === run.id)!;
    expect(after.members.map((m) => [m.stepId, m.state])).toEqual(before);
    expect(after.outcome).toBeNull();
    await ok(page, "POST", `/api/recipes/${id}/runs/${run.id}/cancel`);
    await expect.poll(async () => (await listRuns(page, id)).find((r) => r.id === run.id)?.outcome, { timeout: 60_000 }).not.toBeNull();
  });

  await test.step("the framed view holds the note within the card", async () => {
    await page.getByRole("button", { name: "Framed view" }).click();
    await page.waitForTimeout(500);
    const card = (await page.locator("[data-flow-area]").boundingBox())!;
    const box = (await noteEl(page, "s1").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(card.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 1);
    expect(box.y).toBeGreaterThanOrEqual(card.y - 1);
    await page.getByRole("button", { name: "Fill the screen" }).click();
  });

  await test.step("overlapping saves: an older write's echo never rolls the notes back, and work made meanwhile is composed from the newest state", async () => {
    // The next write's response is held 700 ms; later ones flow freely. A
    // second change lands while the first is on the wire, and a duplicate
    // is made just as the older echo arrives.
    let held = false;
    await page.route("**/api/recipes/*/layout", async (route) => {
      if (route.request().method() === "PUT" && !held) {
        held = true;
        await new Promise((r) => setTimeout(r, 700));
      }
      await route.continue();
    });
    await clickNote(page, "s1");
    await menu(page).locator("[data-note-swatch='green']").click();
    await page.waitForTimeout(120);
    await menu(page).locator("[data-note-swatch='purple']").click();
    await page.waitForTimeout(650);
    await menu(page).locator("[data-note-duplicate]").click();
    await expect(page.locator("[data-note]")).toHaveCount(2);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect.poll(async () => (await notesOf(page, id)).map((n) => n.color)).toEqual(["purple", "purple"]);
    await page.unroute("**/api/recipes/*/layout");
  });

  await test.step("ninety-nine notes stored, one made with the write cut, a headless hundred landing in between: Retry is stale, Reload keeps the accepted hundred", async () => {
    const other = await newRecipe(page, `Notes limit ${runId}`);
    const ninetyNine = Array.from({ length: 99 }, (_, i) => ({ id: `l${i}`, x: 4000 + (i % 10) * 340, y: 4000 + Math.floor(i / 10) * 200, w: 320, h: 176, color: "yellow", text: `l ${i}` }));
    await putLayout(page, other, { notes: ninetyNine });
    await page.goto(`/workflows/${other}`);
    await settled(page);
    await page.route("**/api/recipes/*/layout", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
    await tool(page).click();
    // Ninety-nine notes fill the fitted view: the hundredth by Enter, at the centre.
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-note]")).toHaveCount(100);
    await page.keyboard.press("Escape");
    await expect(page.getByText("Couldn’t save")).toBeVisible();
    await expect(tool(page)).toBeDisabled();
    // The cut is lifted first: the headless hundred is the test's own write.
    await page.unroute("**/api/recipes/*/layout");
    const hundredOthers = Array.from({ length: 100 }, (_, i) => ({ id: `o${i}`, x: (i % 10) * 340, y: Math.floor(i / 10) * 200, w: 320, h: 176, color: "grey", text: `o ${i}` }));
    await putLayout(page, other, { notes: hundredOthers });
    const refusal = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith(`/api/recipes/${other}/layout`) && r.status() === 409);
    await page.getByRole("button", { name: "Retry" }).click();
    expect((await (await refusal).json()).error.code).toBe("stale_revision");
    const recovery = page.locator("[data-stale-recovery]");
    await expect(recovery).toContainText("This item has changed. Reload it before trying again.");
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);
    await expect(page.locator("[data-note]")).toHaveCount(100);
    await expect(noteEl(page, "l0")).toHaveCount(1);
    await expect(tool(page)).toBeDisabled();
    expect(await notesOf(page, other)).toEqual(hundredOthers);
    const writes = watchWrites(page);
    await recovery.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(recovery.getByRole("button", { name: "Copy note text" })).toBeVisible();
    await recovery.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await expect(page.locator("[data-note]")).toHaveCount(100);
    await expect(noteEl(page, "o0")).toHaveCount(1);
    await expect(noteEl(page, "l0")).toHaveCount(0);
    await expect(tool(page)).toBeDisabled();
    expect(await notesOf(page, other)).toEqual(hundredOthers);
    expect(writes).toHaveLength(0);
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url) && !/\/layout$/.test(e.url ?? ""));
  expect(unexpected).toEqual([]);
});
