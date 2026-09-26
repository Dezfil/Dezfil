// The assistant on the workflow canvas (of with overrides B): the door
// after Redo, the pane replacing or joining the node and source panels by
// view and band, the host's edge, the shifted panel, the band's edge
// equal to the pane's, member clicks keeping the pane, the captured
// context, the entry chips and their grounding, a hidden panel's unsaved
// edit, fit and placement, the toggle, the chips, and the dismissal
// contract. Geometry from rectangles; context from the wire.
//
// Environment: the documented gate (isolated server, fresh data dir, the
// scripted provider on 3202). Run with DEZFIL_BASE_URL at the server.
import { test, expect, type Page } from "@playwright/test";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { addLayer, createMap, routeHouse, seedCsv } from "./support";

const runId = Date.now().toString(36);
const H = 900;
const HELPER = 354;
const GUTTER = 14;
const PANE = "[data-assistant-pane]";
const HOST = "[data-workflow-canvas]";
const AREA = "[data-flow-area]";
const BAND = "[data-results-band]";
const FURNITURE = "[data-canvas-furniture]";

const provider = assistantProviderFixture();
test.beforeAll(async () => { await provider.start(); });
test.afterAll(async () => { await provider.stop(); });
test.beforeEach(async ({ context }) => { provider.reset(); await routeHouse(context, { basemapStyleStub: true }); });

type Json = Record<string, unknown>;
async function api(page: Page, method: string, path: string, body?: unknown): Promise<Json> {
  return page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }, { method, path, body });
}
const door = (page: Page) => page.locator("header").getByRole("button", { name: /^(Open|Close) assistant$/ });
const pane = (page: Page) => page.locator(PANE);
const paneOpen = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "true");
const paneClosed = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "false");
const member = (page: Page, text: string) => page.locator("[data-node]").filter({ hasText: text }).first();
const nodePanel = (page: Page) => page.locator("[data-node-panel]");
const sourcePanel = (page: Page) => page.locator("[data-source-panel]");
const chips = (page: Page) => pane(page).locator("[data-talking-about] [data-chip]");
const entries = (page: Page) => pane(page).locator("[data-entry-chips] [data-entry]");
async function box(page: Page, locator: ReturnType<Page["locator"]>) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}
const right = (b: { x: number; width: number }) => b.x + b.width;
/** A box read once its entrance animation has settled: the same box across a gap longer than the panel's motion. */
async function settledBox(page: Page, locator: ReturnType<Page["locator"]>) {
  await expect.poll(async () => {
    const key = async () => { const b = await box(page, locator); return `${Math.round(b.x)}:${Math.round(b.y)}:${Math.round(b.width)}`; };
    const first = await key();
    await page.waitForTimeout(320);
    return first === (await key());
  }).toBe(true);
  return box(page, locator);
}
const view = (page: Page) => page.locator(HOST).getAttribute("data-view");
async function setView(page: Page, next: "full" | "framed") {
  if ((await view(page)) === next) return;
  await page.getByRole("button", { name: next === "full" ? "Fill the screen" : "Framed view", exact: true }).click();
  await expect(page.locator(HOST)).toHaveAttribute("data-view", next);
  await page.waitForTimeout(300);
}
async function seedWorkflow(page: Page, opts: { failing?: boolean; slow?: boolean } = {}) {
  await page.goto("/workflows");
  const table = `asst_cv_${runId}_${Math.random().toString(36).slice(2, 6)}`;
  await seedCsv(page, table, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  const made = await api(page, "POST", "/api/recipes", { name: `assistant ${runId}` });
  const id = (made.recipe as { id: string }).id;
  // The slow step does work the engine cannot shortcut, so a run is observed in progress.
  const sql = opts.failing ? `SELECT * FROM ${table}_missing_table` : opts.slow ? "SELECT sum(a.range * b.range) AS n FROM range(40000) a, range(40000) b" : `SELECT name FROM ${table}`;
  const one = await api(page, "POST", `/api/recipes/${id}/steps`, { operation: "sql_step", parameters: { sql, name: `${table}_one` } });
  return { id, table, step: (one.step as { id: string }).id, stepName: `${table}_one` };
}
async function openCanvas(page: Page, id: string, width: number) {
  await page.setViewportSize({ width, height: H });
  await page.goto(`/workflows/${id}`);
  await expect(page.locator(HOST)).toBeVisible();
  await page.waitForTimeout(400);
}
async function ensureOpen(page: Page) {
  if ((await pane(page).getAttribute("data-open")) !== "true") { await door(page).click(); await paneOpen(page); }
  await expect(pane(page).getByRole("textbox", { name: "Ask the assistant" })).toBeEnabled();
}
/** The stage's own fit, to what the pane leaves. The canvas counts the
 * pane in its fit when the page opens, and the pane now opens closed on
 * every page open: a hand open moves nothing,
 * so at 1000 a tile can stand under the overlaying pane until a fit. */
async function fitToPane(page: Page) {
  await page.getByRole("button", { name: "Fit to view", exact: true }).click();
  await page.waitForTimeout(500);
}
async function ensureClosed(page: Page) {
  if ((await pane(page).getAttribute("data-open")) === "true") { await door(page).click(); await paneClosed(page); }
}
function nextMessage(page: Page) {
  return page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
}
async function send(page: Page, text: string) {
  const request = nextMessage(page);
  await pane(page).getByRole("textbox", { name: "Ask the assistant" }).fill(text);
  await pane(page).getByRole("button", { name: "Send", exact: true }).click();
  return (await request).postDataJSON() as { message: string; context?: Record<string, unknown> };
}
/** Start a run from the header and see it settle. */
async function startRun(page: Page) {
  await page.locator('[data-run-action="run-all"]').click();
  const dialog = page.getByRole("dialog");
  if (await dialog.waitFor({ state: "visible", timeout: 1500 }).then(() => true).catch(() => false)) await dialog.getByRole("button", { name: /^Run/ }).click();
}
async function runAll(page: Page) {
  await startRun(page);
  await expect(page.locator('[data-run-dock="ended"]')).toBeVisible({ timeout: 60_000 });
}
const grounding = (index: number) => JSON.parse(String(provider.captures[index].input[0].content).split("Instance grounding (data):\n")[1]);

test.describe("2: the door on the canvas", () => {
  test("2a-c: exactly one door, after Redo, with the compact name", async ({ page }) => {
    const { id } = await seedWorkflow(page);
    for (const width of [1440, 1200]) {
      await openCanvas(page, id, width);
      await expect(page.getByRole("button", { name: /^(Open|Close) assistant$/ })).toHaveCount(1);
      const names = await page.locator("#header-actions-left button").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
      expect(names.slice(0, 3)).toEqual(["Undo", "Redo", "Open assistant"]);
    }
  });
});

test.describe("7: the pane, the panels and the band", () => {
  test("framed at 1440 with a node selected, the pane hides the panel and keeps the tile selected; closing shows the same node's panel", async ({ page }) => {
    const { id, stepName } = await seedWorkflow(page);
    await openCanvas(page, id, 1440);
    await ensureClosed(page);
    await setView(page, "framed");
    await member(page, stepName).click();
    await expect(nodePanel(page)).toBeVisible();
    await door(page).click();
    await paneOpen(page);
    await expect(nodePanel(page)).toBeHidden();
    await expect(page.locator(FURNITURE)).toHaveAttribute("hidden", "");
    expect(await page.locator(".react-flow__node.selected").count(), "the tile stays selected").toBe(1);
    await door(page).click();
    await paneClosed(page);
    await expect(nodePanel(page)).toBeVisible();
    // The panel names the member by its operation's label; the tile carries the output name too.
    await expect(nodePanel(page)).toHaveAttribute("aria-label", "SQL step, node");
  });

  test("framed at 1920 the host's right edge moves in by the pane and the panel stays inside the card; framed at 1100 the host is unmoved and the pane over it", async ({ page }) => {
    const { id, stepName } = await seedWorkflow(page);
    for (const [width, docks] of [[1920, true], [1100, false]] as const) {
      await openCanvas(page, id, width);
      await ensureClosed(page);
      await setView(page, "framed");
      const before = await box(page, page.locator(HOST));
      expect(Math.round(right(before))).toBe(width - GUTTER);
      await member(page, stepName).click();
      await expect(nodePanel(page)).toBeVisible();
      await door(page).click();
      await paneOpen(page);
      await page.waitForTimeout(300);
      const after = await box(page, page.locator(HOST));
      expect(Math.round(right(after)), `host right edge at ${width}`).toBe(width - GUTTER - (docks ? HELPER : 0));
      expect(Math.round(after.x)).toBe(Math.round(before.x));
      const p = await box(page, pane(page));
      expect(Math.round(right(p))).toBe(width - GUTTER);
      if (docks) {
        await expect(nodePanel(page)).toBeVisible();
        const card = await box(page, page.locator(AREA));
        const panel = await settledBox(page, nodePanel(page));
        expect(right(panel)).toBeLessThanOrEqual(right(card) + 0.5);
        expect(right(card)).toBeLessThanOrEqual(p.x + 0.5);
      } else {
        expect(p.x).toBeLessThan(right(after));
        await expect(nodePanel(page)).toBeHidden();
      }
    }
  });

  test("full at 1920 the panel shifts left by the pane and both stay, full at 1440 it hides; at 1000, 1440 and 1920 the band's right edge stops 12 px short of the pane's left edge, the two never intersect, and the band's tab and a row stay reachable", async ({ page }) => {
    const { id, stepName } = await seedWorkflow(page);
    // A run, so the band's messages list holds a row with its node link.
    await openCanvas(page, id, 1440);
    await runAll(page);
    for (const width of [1000, 1440, 1920] as const) {
      await openCanvas(page, id, width);
      await ensureClosed(page);
      await setView(page, "full");
      await member(page, stepName).click();
      await expect(nodePanel(page)).toBeVisible();
      const panelBefore = await settledBox(page, nodePanel(page));
      expect(Math.round(right(panelBefore))).toBe(width - GUTTER);
      await door(page).click();
      await paneOpen(page);
      await page.waitForTimeout(300);
      const p = await box(page, pane(page));
      const band = await box(page, page.locator(BAND));
      // Item 2: the band's right edge stops 12 px short of the pane's left
      // edge (the helper gutter), never equal to it; the literal 12 is the
      // expectation, not the constant the layout reads.
      expect(Math.round(p.x - right(band)), `gap between the band and the pane at ${width}`).toBe(12);
      expect(right(band)).toBeLessThanOrEqual(p.x + 0.5);
      // 2b: the two rectangles do not intersect.
      const intersect = band.x < right(p) && p.x < right(band) && band.y < p.y + p.height && p.y < band.y + band.height;
      expect(intersect, `the band and the pane do not intersect at ${width}`).toBe(false);
      // 2c: the band's tabs and a row are hit-testable and activatable with the pane open.
      const tab = page.locator(`${BAND} [data-band-tab="messages"]`);
      const tabHit = await tab.evaluate((el) => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return at === el || el.contains(at); });
      expect(tabHit, `the messages tab is reachable at ${width}`).toBe(true);
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      // A row's node link may overflow the band's own clip at 1000 (its cut
      // text is an accepted overlay consequence), so the point tested and
      // pressed is a visible one: inside the link and inside the band.
      const row = page.locator(`${BAND} [data-band-node]`).first();
      await expect(row).toBeVisible();
      const rowPoint = await row.evaluate((el, bandSel) => {
        const r = el.getBoundingClientRect(); const b = document.querySelector(bandSel)!.getBoundingClientRect();
        const x = Math.max(r.x, b.x) + 6; const y = r.y + r.height / 2;
        const at = document.elementFromPoint(x, y);
        return { hit: at === el || el.contains(at), x: x - r.x, y: y - r.y, insideBand: x < Math.min(r.x + r.width, b.x + b.width) };
      }, BAND);
      expect(rowPoint.insideBand, `a row's node link has a visible point at ${width}`).toBe(true);
      expect(rowPoint.hit, `a row's node link is reachable at ${width}`).toBe(true);
      await page.locator(AREA).click({ position: { x: 20, y: 200 } }).catch(() => undefined);
      await row.click({ position: { x: rowPoint.x, y: rowPoint.y } });
      expect(await page.locator(".react-flow__node.selected").count(), `the row's node is selected at ${width}`).toBe(1);
      if (width === 1920) {
        await expect(nodePanel(page)).toBeVisible();
        const panel = await settledBox(page, nodePanel(page));
        expect(Math.round(right(panel))).toBe(width - GUTTER - HELPER);
        expect(right(panel)).toBeLessThanOrEqual(p.x + 0.5);
      } else {
        await expect(nodePanel(page)).toBeHidden();
      }
    }
  });

  test("with the pane closed the band ends at the screen gutter; framed view at 1000, 1440 and 1920 keeps geometry with and without a selected member", async ({ page }) => {
    const { id, stepName } = await seedWorkflow(page);
    for (const width of [1000, 1440, 1920] as const) {
      await openCanvas(page, id, width);
      await ensureClosed(page);
      await setView(page, "full");
      // The closed-pane expectation, stated from the viewport and the screen's 14 px gutter.
      expect(Math.round(right(await box(page, page.locator(BAND)))), `closed: the band ends at the screen gutter at ${width}`).toBe(width - 14);
      await setView(page, "framed");
      const docks = width > 1120;
      for (const selected of [false, true]) {
        await ensureClosed(page);
        if (selected) { await member(page, stepName).click(); await expect(nodePanel(page)).toBeVisible(); }
        else { await page.locator(AREA).focus(); await page.keyboard.press("Escape"); await expect(nodePanel(page)).toHaveCount(0); }
        const before = await box(page, page.locator(HOST));
        expect(Math.round(right(before))).toBe(width - GUTTER);
        await door(page).click();
        await paneOpen(page);
        await page.waitForTimeout(300);
        const after = await box(page, page.locator(HOST));
        expect(Math.round(right(after)), `framed host edge at ${width}, selected ${selected}`).toBe(width - GUTTER - (docks ? HELPER : 0));
        expect(Math.round(after.x)).toBe(Math.round(before.x));
        const p = await box(page, pane(page));
        expect(Math.round(right(p))).toBe(width - GUTTER);
        if (selected) {
          if (width === 1920) { await expect(nodePanel(page)).toBeVisible(); expect(right(await settledBox(page, nodePanel(page)))).toBeLessThanOrEqual(right(await box(page, page.locator(AREA))) + 0.5); }
          else await expect(nodePanel(page)).toBeHidden();
          expect(await page.locator(".react-flow__node.selected").count(), "the selection stays").toBe(1);
        } else {
          await expect(nodePanel(page)).toHaveCount(0);
        }
        // Framed: no band column is fixed at the foot, so nothing here changes with the pane.
        await expect(page.locator(BAND)).toHaveCount(1);
      }
    }
  });

  test("a node click and a source click with the pane open select and keep the pane, at three widths in both views; a source panel follows the rule and yields no step", async ({ page }) => {
    const { id, table, stepName } = await seedWorkflow(page);
    for (const width of [1000, 1440, 1920] as const) {
      for (const v of ["full", "framed"] as const) {
        await openCanvas(page, id, width);
        await setView(page, v);
        await ensureOpen(page);
        await fitToPane(page);
        await member(page, stepName).click();
        await paneOpen(page);
        expect(await page.locator(".react-flow__node.selected").count()).toBe(1);
        await member(page, table).click();
        await paneOpen(page);
        const shows = width === 1920;
        if (shows) {
          await expect(sourcePanel(page)).toBeVisible();
          if (v === "full") expect(Math.round(right(await settledBox(page, sourcePanel(page))))).toBe(width - GUTTER - HELPER);
        } else {
          await expect(sourcePanel(page)).toBeHidden();
        }
        await expect(entries(page).filter({ hasText: "Explain this node" })).toHaveCount(0);
        provider.replies.push({ text: "About the source." });
        const body = await send(page, "Source?");
        expect(body.context).toMatchObject({ page: "workflow", recipeId: id, selectedStepId: null });
        await expect(pane(page).getByText("About the source.", { exact: true })).toBeVisible();
        // The next iteration starts a fresh conversation for its chips: reload clears the tab's
        // store.
      }
    }
  });

  test("the captured context, the entry chips, a Diagnose turn grounded in the failed member, and the run chip's words", async ({ page }) => {
    const { id, step, stepName } = await seedWorkflow(page, { failing: true });
    await openCanvas(page, id, 1440);
    await ensureOpen(page);
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toHaveText(new RegExp(`Workflow.*assistant ${runId}`));
    await expect(entries(page)).toHaveCount(0);
    // A node selected: the Explain chip alone, the step in the chips.
    await member(page, stepName).click();
    await expect(entries(page)).toHaveCount(1);
    await expect(entries(page).first()).toHaveText("Explain this node");
    await expect(chips(page).nth(1)).toHaveText(/Node.*SQL step/);
    // A run observed to fail: the Diagnose chip, the failure tone.
    await runAll(page);
    await expect(entries(page)).toHaveCount(2);
    await expect(entries(page).nth(1)).toHaveText("Diagnose the last run");
    await expect(chips(page).nth(2)).toHaveAttribute("data-tone", "bad");
    await expect(chips(page).nth(2)).toContainText("failed");
    const runs = await api(page, "GET", `/api/recipes/${id}/runs`) as { runs: { id: string; outcome: string; members: { stepId: string; state: string; stoppedReason: string | null }[] }[] };
    const failed = runs.runs.find((r) => r.outcome === "failed")!;
    expect(failed).toBeTruthy();
    // Diagnose sends its words with the page's context (7g: each equal to the page's state read
    // apart).
    const request = nextMessage(page);
    provider.replies.push({ text: "It failed at the first node." });
    await entries(page).nth(1).click();
    const body = (await request).postDataJSON() as { message: string; context: Record<string, unknown> };
    expect(body.message).toBe("Diagnose the last run");
    expect(body.context).toEqual({ page: "workflow", recipeId: id, selectedStepId: step, lastRunId: failed.id });
    await expect(pane(page).getByText("Diagnose the last run", { exact: true }).last()).toBeVisible();
    await expect(pane(page).getByText("It failed at the first node.", { exact: true })).toBeVisible();
    await expect(entries(page)).toHaveCount(0);
    // 7i: the provider's input names the failed member and its stop reason.
    await expect.poll(() => provider.captures.length).toBe(1);
    const ground = grounding(0);
    const memberRow = ground.run.members.items.find((m: { stepId: string }) => m.stepId === step);
    expect(ground.run.outcome).toBe("failed");
    expect(memberRow.state).toBe("failed");
    expect(memberRow.stoppedReason).toBe(failed.members.find((m) => m.stepId === step)!.stoppedReason);
    expect(String(memberRow.stoppedReason).length).toBeGreaterThan(0);
  });

  test("the run chip reads in progress while a run is observed running and its outcome once it settles", async ({ page }) => {
    const { id } = await seedWorkflow(page, { slow: true });
    await openCanvas(page, id, 1440);
    await ensureOpen(page);
    await startRun(page);
    await expect(chips(page).filter({ hasText: "in progress" })).toHaveCount(1, { timeout: 10_000 });
    await expect(chips(page).filter({ hasText: /completed|failed/ })).toHaveCount(1, { timeout: 90_000 });
  });

  test("a node panel with an unsaved parameter edit hidden by the pane returns with that edit", async ({ page }) => {
    const { id, stepName } = await seedWorkflow(page);
    await openCanvas(page, id, 1440);
    await ensureClosed(page);
    await member(page, stepName).click();
    const name = nodePanel(page).locator('[data-param="name"]');
    await name.fill(`${stepName}_edited`);
    await door(page).click();
    await paneOpen(page);
    await expect(nodePanel(page)).toBeHidden();
    await door(page).click();
    await paneClosed(page);
    await expect(nodePanel(page)).toBeVisible();
    await expect(name).toHaveValue(`${stepName}_edited`);
  });

  test("fit to view and a newly added member land outside the pane and the shifted panel; the toggle keeps position and zoom with the pane open", async ({ page }) => {
    const { id, table, stepName } = await seedWorkflow(page);
    await page.goto("/workflows");
    const other = `${table}_b`;
    await seedCsv(page, other, "name,lon,lat\nb,13.4,52.5\n");
    // At 1000 a member is selected too: its panel is hidden under the
    // overlaying pane, so the fit must count the pane once and the panel
    // not at all (counting both made the padding
    // exceeded the viewport and the fit placed tiles behind the left pane).
    for (const width of [1000, 1440, 1920] as const) {
      await openCanvas(page, id, width);
      await setView(page, "full");
      await ensureOpen(page);
      if (width !== 1440) { await member(page, stepName).click(); if (width === 1920) await expect(nodePanel(page)).toBeVisible(); else await expect(nodePanel(page)).toBeHidden(); }
      const limit = width === 1920 ? (await settledBox(page, nodePanel(page))).x : (await box(page, pane(page))).x;
      const leftPane = await box(page, page.locator("[data-canvas-pane]"));
      await fitToPane(page);
      for (const tile of await page.locator("[data-node]").all()) {
        const b = await box(page, tile);
        expect(right(b), `a tile clears the pane and the panel at ${width}`).toBeLessThanOrEqual(limit - GUTTER + 0.5);
        expect(b.x, `a tile clears the canvas's own pane at ${width}`).toBeGreaterThanOrEqual(right(leftPane) - 0.5);
      }
      // A newly added member: the pane's Sources row places it in the free rect.
      await page.getByRole("tab", { name: "Sources" }).click();
      await page.locator(`[data-table="${other}"]`).click();
      await expect(member(page, other)).toBeVisible();
      await page.waitForTimeout(400);
      expect(right(await box(page, member(page, other))), `the added member clears the pane and the panel at ${width}`).toBeLessThanOrEqual(limit - GUTTER + 0.5);
      // The toggle keeps position and zoom with the pane open.
      const before = await box(page, member(page, stepName));
      const zoomBefore = await page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);
      await setView(page, "framed");
      const after = await box(page, member(page, stepName));
      const zoomAfter = await page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);
      expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
      expect(zoomAfter.match(/scale\(([^)]+)\)/)?.[1]).toBe(zoomBefore.match(/scale\(([^)]+)\)/)?.[1]);
      await api(page, "DELETE", `/api/recipes/${id}/sources/${encodeURIComponent(other)}`).catch(() => undefined);
      if (width === 1000) continue;
    }
  });
});

test.describe("11: dismissal on the canvas", () => {
  test("the close control, the door and Escape from inside close it with focus on the door; canvas, node and source clicks leave it open; one Escape never both closes the pane and clears the selection", async ({ page }) => {
    const { id, table, stepName } = await seedWorkflow(page);
    await openCanvas(page, id, 1920);
    await ensureOpen(page);
    await pane(page).locator('[aria-label="Close assistant"]').click();
    await paneClosed(page);
    await door(page).click();
    await paneOpen(page);
    await door(page).click();
    await paneClosed(page);
    await door(page).click();
    await paneOpen(page);
    await member(page, stepName).click();
    expect(await page.locator(".react-flow__node.selected").count()).toBe(1);
    await pane(page).getByRole("textbox", { name: "Ask the assistant" }).focus();
    await page.keyboard.press("Escape");
    await paneClosed(page);
    await expect(door(page)).toBeFocused();
    expect(await page.locator(".react-flow__node.selected").count(), "Escape inside the pane leaves the selection").toBe(1);
    await door(page).click();
    await paneOpen(page);
    // Canvas, node and source clicks leave it open.
    // A press on the canvas itself: in full view the flow area spans the
    // screen, so the point is taken inside its free middle, clear of the
    // rail, the pane, the band and the tiles.
    const area = await box(page, page.locator(AREA));
    await page.mouse.click(area.x + area.width * 0.45, area.y + area.height * 0.72);
    await paneOpen(page);
    await member(page, stepName).click();
    await paneOpen(page);
    await member(page, table).click();
    await paneOpen(page);
    // Escape with focus outside the pane clears the selection and leaves the pane open.
    await page.locator(AREA).focus();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await paneOpen(page);
    expect(await page.locator(".react-flow__node.selected").count()).toBe(0);
    // A chrome pointer leaves it open.
    const rail = await box(page, page.locator('nav[aria-label="Product navigation"]'));
    await page.mouse.click(rail.x + 27, rail.y + rail.height * 0.55);
    await paneOpen(page);
  });
});

test.describe("download doors on the canvas", () => {
  test("a layer-download door whose preparation fails shows the coordinator's failure and its Retry in the pane", async ({ page }) => {
    const { id, table } = await seedWorkflow(page);
    await page.goto("/maps");
    const mapId = await createMap(page, `canvas-download ${runId}`);
    const layerId = await addLayer(page, mapId, table, `SELECT * FROM ${table}`);
    await openCanvas(page, id, 1440);
    await ensureOpen(page);
    provider.replies.push({ calls: [{ name: "export_layer_data", args: { id: layerId, format: "csv" } }] }, { text: "Ready to download." });
    await send(page, "Export the layer");
    const door = pane(page).getByRole("button", { name: /Download the CSV/ });
    await expect(door).toBeVisible();
    await page.route(`**/api/layers/${layerId}/export/csv?**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("__ui_prepare") !== "1") { await route.continue(); return; }
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { code: "sql_error", message: "seeded failure" } }) });
    });
    await door.click();
    const note = pane(page).locator(`[data-layer-download-failed="${layerId}:csv"]`);
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(note.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  });
});

test.describe("the gutter capture", () => {
  /** A crop spanning the band card's inside, its right border, the gap,
   * the pane's left border and the pane's inside, decoded in the page at
   * the card's middle row: the run of columns that match neither interior
   * is border plus gap plus border, and the gap is that run less the two
   * border widths read from computed style. The pane's shadow darkens the
   * gap to within a few levels of the border colour, which is why the
   * interiors, not the borders, are the landmarks. The crop is attached as
   * the capture. Seeded red by restoring the touching edge (the layout
   * surrendering the pane's width alone): the run is the two borders and
   * the gap reads 0. */
  async function gapColumns(page: Page): Promise<{ gap: number; run: number; borders: number; width: number }> {
    const card = await box(page, page.locator("[data-band-card]"));
    const p = await box(page, pane(page));
    const x0 = Math.round(right(card)) - 8;
    const x1 = Math.round(p.x) + 8;
    const y = Math.round(card.y + card.height / 2);
    const clip = { x: x0, y: y - 4, width: Math.max(1, x1 - x0), height: 8 };
    const png = await page.screenshot({ clip, animations: "disabled" });
    const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? "light");
    await test.info().attach(`gutter-${theme}.png`, { body: png, contentType: "image/png" });
    const borders = await page.evaluate(() => {
      const card = getComputedStyle(document.querySelector("[data-band-card]")!);
      const pane = getComputedStyle(document.querySelector("[data-assistant-pane]")!);
      return Math.round(parseFloat(card.borderRightWidth) + parseFloat(pane.borderLeftWidth));
    });
    const measured = await page.evaluate(async ({ b64 }) => {
      const raw = atob(b64); const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext("2d")!; ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const scale = window.devicePixelRatio || 1;
      const row = Math.floor(c.height / 2);
      const column = (x: number) => { const i = (row * c.width + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
      const same = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) < 4 && Math.abs(a[1] - b[1]) < 4 && Math.abs(a[2] - b[2]) < 4;
      const cardInside = column(0); const paneInside = column(c.width - 1);
      let from = 0; while (from < c.width && same(column(from), cardInside)) from += 1;
      let to = c.width - 1; while (to >= 0 && same(column(to), paneInside)) to -= 1;
      return { run: Math.round((to - from + 1) / scale), width: Math.round(c.width / scale) };
    }, { b64: png.toString("base64") });
    return { gap: measured.run - borders, run: measured.run, borders, width: measured.width };
  }
  test("both facing borders and the gap between them hold the 12 px, in the light and the dark theme", async ({ page }) => {
    const { id } = await seedWorkflow(page);
    await openCanvas(page, id, 1440);
    await setView(page, "full");
    await ensureOpen(page);
    await page.waitForTimeout(350);
    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark") {
        await page.getByRole("button", { name: "Switch between dark and light theme" }).click();
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
        await page.waitForTimeout(350);
      }
      const measured = await gapColumns(page);
      expect(measured.borders, `${theme}: two one-pixel borders face each other`).toBe(2);
      expect(measured.run, `${theme}: the crop holds both borders and the gap`).toBeGreaterThanOrEqual(2);
      expect(measured.gap, `${theme}: the gap between the two borders`).toBe(12);
    }
  });
});
