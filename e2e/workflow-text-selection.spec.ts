import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { seedCsv, trackConsole } from "./support";

/**
 * Text selection on the workflow page ("text selected across the whole
 * page"). The shell's chrome is not text a user copies: a press-and-move
 * that starts on a dimmed stage button, or on the band's bar, selects
 * nothing; Cmd/Ctrl+A with the canvas owning the key ('s rule: not
 * inside an editable control, not inside a dialog) never selects the
 * page, from the canvas and from a stage button alike; and a press on
 * canvas ground clears a selection made elsewhere. What a user
 * legitimately copies stays selectable: Cmd+A inside a panel field
 * selects that field's text, and the Messages log's text can be swept by
 * the pointer. Seen red once against the shipped surface (the
 * verification record names the run): the sweep from the stack's box
 * beside the dimmed Undo, the bar sweep and both Cmd+A presses selected
 * the page, and the ground press left the sweep in place. The press on
 * the disabled button itself dispatches no mousedown in this Chromium
 * and swept nothing even before the fix; it stays as the gesture a hand
 * actually makes.
 */

const runId = Date.now().toString(36);
const table = `ts_points_${runId}`;

type Json = Record<string, unknown>;

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

/** A source, a buffer reading it, and a run of the buffer: a tile to
 * open a panel on, an Arrange with something to move, and a Messages
 * log with text in it. */
async function seed(page: Page): Promise<{ id: string; node: string }> {
  await page.goto("/workflows");
  await seedCsv(page, table, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  const id = ((await api(page, "POST", "/api/recipes", { name: `Selection ${runId}` })).recipe as { id: string }).id;
  const node = ((await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps`, body: { operation: "buffer", parameters: { input: table, distance: 100, name: `${table}_rings` } } })).then(result => result.json)).step as { id: string }).id;
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "PUT", path: `/api/recipes/${id}/layout`, body: { steps: { [node]: { x: 288, y: 40 } }, sources: { [table]: { x: 48, y: 40 } }, notes: [] } })).then(result => result.json);
  await api(page, "POST", `/api/recipes/${id}/steps/${node}/run`);
  await expect
    .poll(async () => ((await api(page, "GET", `/api/recipes/${id}`)).recipe as { steps: { output: unknown }[] }).steps[0].output ?? null, { timeout: 40_000 })
    .not.toBeNull();
  return { id, node };
}

async function settled(page: Page) {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.waitForTimeout(500);
}
const box = async (loc: Locator) => {
  const b = await loc.boundingBox();
  if (!b) throw new Error("no box");
  return b;
};
/** What the document's selection reads: the page's text when the page
 * was selected, nothing when nothing was. */
const selectedText = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? "");
/** A press-and-move from one point to another, the pointer's own sweep. */
async function sweep(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}
async function groundAt(page: Page, fx: number, fy: number) {
  const area = (await page.locator("[data-flow-area]").boundingBox())!;
  const candidates: { x: number; y: number }[] = [];
  for (let dy = 0; dy <= 0.5; dy += 0.05) for (let dx = 0; dx <= 0.5; dx += 0.05) candidates.push({ x: area.x + area.width * Math.min(0.95, fx + dx), y: area.y + area.height * Math.min(0.8, fy + dy) });
  const found = await page.evaluate((pts) => pts.find((p) => document.elementFromPoint(p.x, p.y)?.classList.contains("react-flow__pane")) ?? null, candidates);
  if (!found) throw new Error("no background point found");
  return found;
}
const band = (page: Page) => page.locator("[data-results-band]");

test("the shell's chrome selects nothing: a sweep from the dimmed Undo, a sweep on the band's bar, Cmd+A from the canvas and after a stage press; a panel field's Cmd+A and the log's text stay selectable; a ground press clears a sweep", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  const w = await seed(page);
  await page.goto(`/workflows/${w.id}`);
  await settled(page);

  await test.step("a press-and-move that starts on the dimmed Undo button, or on the stack beside it, selects nothing", async () => {
    // The dimmed Undo now stands in the header after a field round; the
    // stack's own box beside the note tool is the ground the
    // finding named, and stays the second sweep below.
    const undo = await box(page.locator("#header-actions-left [data-undo]"));
    await expect(page.locator("#header-actions-left [data-undo]")).toBeDisabled();
    const lead = await box(band(page).locator("[data-band-lead]"));
    const end = { x: lead.x + lead.width - 4, y: lead.y + lead.height / 2 };
    // On the button itself. This Chromium dispatches no mousedown for a
    // disabled control, so no sweep starts here; the press is kept as the
    // gesture a hand actually makes.
    await sweep(page, { x: undo.x + undo.width / 2, y: undo.y + undo.height / 2 }, end);
    expect(await selectedText(page)).toBe("");
    // On the stack's own box, in the gap under the button: the press the
    // stack receives, which swept the page before the fix.
    await sweep(page, { x: undo.x + undo.width / 2, y: undo.y + undo.height + 3 }, end);
    expect(await selectedText(page)).toBe("");
  });

  await test.step("a press-and-move on the band's bar selects nothing, its placeholder included", async () => {
    const tabs = await box(band(page).locator("[role='tablist']"));
    const lead = await box(band(page).locator("[data-band-lead]"));
    // The bar's empty area between the tabs and the placeholder, swept
    // across the placeholder's text.
    await sweep(page, { x: (tabs.x + tabs.width + lead.x) / 2, y: lead.y + lead.height / 2 }, { x: lead.x + lead.width - 4, y: lead.y + lead.height / 2 });
    expect(await selectedText(page)).toBe("");
  });

  await test.step("Cmd+A with the canvas focused selects nothing", async () => {
    await page.locator("[data-flow-area]").focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForTimeout(150);
    expect(await selectedText(page)).toBe("");
  });

  await test.step("Cmd+A after a press on Arrange selects nothing, wherever focus landed", async () => {
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await page.waitForTimeout(700);
    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForTimeout(150);
    expect(await selectedText(page)).toBe("");
  });

  await test.step("Cmd+A inside a panel field still selects that field's text: what is typed next replaces all of it", async () => {
    await page.locator(`[data-node][data-name="${table}_rings"]`).first().locator("[data-v]").first().click();
    const field = page.locator("[data-node-panel]").getByRole("spinbutton", { name: /^distance/ });
    await expect(field).toHaveValue("100");
    await field.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("150");
    await expect(field).toHaveValue("150");
    // Back to the value it had, the same way: a value unchanged is no step.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("100");
    await expect(field).toHaveValue("100");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
  });

  await test.step("the Messages log's text can be swept by the pointer, and a press on canvas ground clears the sweep", async () => {
    if (await band(page).getAttribute("data-collapsed")) await band(page).locator("[data-band-lead]").click();
    await expect(band(page)).not.toHaveAttribute("data-collapsed", "true");
    const entry = band(page).locator("[data-band-entries] li").first();
    await expect(entry).toBeVisible();
    const text = await box(entry.locator("span").last());
    await sweep(page, { x: text.x + 2, y: text.y + text.height / 2 }, { x: text.x + text.width - 2, y: text.y + text.height / 2 });
    expect((await selectedText(page)).length).toBeGreaterThan(0);
    const at = await groundAt(page, 0.55, 0.3);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(150);
    expect(await selectedText(page)).toBe("");
  });

  const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});
