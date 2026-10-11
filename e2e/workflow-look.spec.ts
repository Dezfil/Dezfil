import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { addLayer, createMap, seedCsv, trackConsole } from "./support";

/**
 * The canvas field round's look: the rendered geometry of the workflow
 * page read against reference 13's measures — the pane level with the
 * rail, the results band as a card beside the pane, the canvas surface
 * as the workspace's ground edge to edge with the header dissolved, the
 * framed view's three cards, every port on its tile's edge, the header's
 * order, the pane's kit chrome. Seen red once against the shipped
 * surface (main 73972fdc) before the fix landed; the verification record
 * names each failure. The measures are soft assertions, so one run
 * reports every mismatch rather than the first.
 */

const runId = Date.now().toString(36);
/** The names are per test: the callout step runs the recipe, and a run's
 * output name is taken for good, so two tests never share one. */
let table = "";
/** A second source with a long name, for the panel's callout. */
let longTable = "";
const GUTTER = 14;
const RAIL_TOP = 62;

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

/** A source and one named-input node reading it: a port on each side. */
async function seed(page: Page, tag: string): Promise<string> {
  table = `lk_${runId}_${tag}`;
  longTable = `${table}_long_second_source_name_for_the_callout`;
  await page.goto("/workflows");
  await seedCsv(page, table, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  await seedCsv(page, longTable, "name,lon,lat\nmitte,13.40,52.52\n");
  const made = await api(page, "POST", "/api/recipes", { name: `Look ${runId}` });
  const id = (made.recipe as { id: string }).id;
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/steps`, body: {
    operation: "buffer",
    parameters: { input: table, distance: 100, name: `${table}_rings` },
  } })).then(result => result.json);
  return id;
}

async function settled(page: Page) {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.waitForTimeout(400);
}

const box = async (loc: Locator) => {
  const b = await loc.boundingBox();
  if (!b) throw new Error("no box");
  return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.x + b.width, bottom: b.y + b.height, cx: b.x + b.width / 2 };
};
const style = (loc: Locator, prop: string, pseudo?: string) =>
  loc.evaluate((el, [p, ps]) => getComputedStyle(el, ps || undefined).getPropertyValue(p), [prop, pseudo ?? ""]);
/** The colour a token resolves to under the current theme. A token the
 * vocabulary does not define resolves to transparent, and a comparison
 * against transparent could pass on a surface that draws nothing (the
 * `--accent-wash` tile did, in the smoke): such a token fails here. */
const token = async (page: Page, name: string) => {
  const c = await page.evaluate((t) => {
    const el = document.createElement("div");
    el.style.background = `var(${t})`;
    document.body.appendChild(el);
    const value = getComputedStyle(el).backgroundColor;
    el.remove();
    return value;
  }, name);
  expect(c, `${name} is defined in the vocabulary`).not.toBe("rgba(0, 0, 0, 0)");
  return c;
};

/** A custom property's raw value under the current theme. */
const varOf = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
/** A colour expression resolved under the current theme, so a mix in the
 * reference's own words can be compared with what the app computes. */
const resolved = async (page: Page, expr: string) => {
  const c = await page.evaluate((e) => {
    const el = document.createElement("div");
    el.style.background = e;
    document.body.appendChild(el);
    const value = getComputedStyle(el).backgroundColor;
    el.remove();
    return value;
  }, expr);
  expect(c, `${expr} resolves`).not.toBe("rgba(0, 0, 0, 0)");
  return c;
};

const pane = (page: Page) => page.locator("[data-canvas-pane]");
const rail = (page: Page) => page.locator('nav[aria-label="Product navigation"]');
const band = (page: Page) => page.locator("[data-results-band]");
/** The card inside the band's column (the shipped surface had no card: the column itself is measured then). */
const card = (page: Page) => page.locator("[data-band-card], [data-results-band]").last();
const flow = (page: Page) => page.locator("[data-flow-area]");
const host = (page: Page) => page.locator("[data-workflow-canvas]");
const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol;

/** The pane runs from the rail's top to the rail's bottom. */
async function expectPaneLevel(page: Page, where: string) {
  const p = await box(pane(page));
  const r = await box(rail(page));
  expect.soft(near(p.y, r.y), `${where}: the pane's top (${p.y}) is level with the rail's (${r.y})`).toBe(true);
  expect.soft(near(p.bottom, r.bottom), `${where}: the pane's bottom (${p.bottom}) is level with the rail's (${r.bottom})`).toBe(true);
  expect.soft(near(p.y, RAIL_TOP), `${where}: the pane's top is the reference's ${RAIL_TOP}px`).toBe(true);
}

/** Every port's centre on its tile's edge. */
async function expectPortsOnEdge(page: Page) {
  for (const kind of ["node", "source"] as const) {
    const member = page.locator(`[data-node][data-kind="${kind}"]`).first();
    const tile = await box(member.locator('[data-v="badge"]'));
    const out = await box(member.locator("[data-out]"));
    expect.soft(near(out.cx, tile.right), `${kind}: the output port's centre (${out.cx}) sits on the tile's right edge (${tile.right})`).toBe(true);
    expect.soft(near(out.y + out.h / 2, tile.y + tile.h / 2), `${kind}: the output port is at the tile's mid-height`).toBe(true);
    if (kind === "node") {
      const inp = await box(member.locator(".react-flow__handle.target").first());
      expect.soft(near(inp.cx, tile.x), `${kind}: the input port's centre (${inp.cx}) sits on the tile's left edge (${tile.x})`).toBe(true);
    }
  }
}

/** The stage stack, the node tile, the library's viewport scale. */
const stage = (page: Page) => page.locator("[data-canvas-stage]");
const nodeTile = (page: Page) => page.locator('[data-node][data-kind="node"] [data-v="badge"]').first();
const scale = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((el) => Number(/scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? "1"));
/** A token's raw value (a length, not a colour). */
const tokenValue = (page: Page, name: string) =>
  page.evaluate((t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim(), name);
/** A colour's luminance from its computed form, `rgb(...)` or the
 * `color(srgb r g b)` a colour mix computes to, for ordering. */
const lum = (c: string) => {
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (rgb) return 0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3]);
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(c);
  if (srgb) return 255 * (0.2126 * Number(srgb[1]) + 0.7152 * Number(srgb[2]) + 0.0722 * Number(srgb[3]));
  throw new Error(`not a colour: ${c}`);
};
/** A point on the canvas's background near the fraction asked for (the notes journey's rule). */
async function paneAt(page: Page, fx: number, fy: number) {
  const area = (await flow(page).boundingBox())!;
  const candidates: { x: number; y: number }[] = [];
  for (let dy = 0; dy <= 0.5; dy += 0.05) for (let dx = 0; dx <= 0.5; dx += 0.05) candidates.push({ x: area.x + area.width * Math.min(0.95, fx + dx), y: area.y + area.height * Math.min(0.85, fy + dy) });
  const found = await page.evaluate(
    (points) => points.find((p) => document.elementFromPoint(p.x, p.y)?.classList.contains("react-flow__pane")) ?? null,
    candidates,
  );
  if (!found) throw new Error("no background point found");
  return found;
}
/** A tile stays under the same pixels and the zoom stays across one toggle. */
async function expectToggleKeepsPlace(page: Page, to: "Framed view" | "Fill the screen", where: string) {
  const before = await box(nodeTile(page));
  const z0 = await scale(page);
  await page.getByRole("button", { name: to }).click();
  await page.waitForTimeout(500);
  const after = await box(nodeTile(page));
  // Half a pixel: the framed card's border must not count as a move (the smoke found a 1px shift).
  expect.soft(near(after.x, before.x, 0.5) && near(after.y, before.y, 0.5), `${where}: the tile stays under the same pixels (${before.x},${before.y} → ${after.x},${after.y})`).toBe(true);
  expect.soft(near(await scale(page), z0, 0.001), `${where}: the zoom stays`).toBe(true);
}

/** The pair's states against the reference: a button with
 * nothing on its side is disabled and dimmed to the reference's 0.45 in
 * the faint ink, and does not lift on hover; one with a step is neither;
 * locked, both are inert and carry the lock's reason in their names. The
 * pass ends with its Arrange undone, so the layout is as it was and the
 * record holds that one step on the redo side: a second pass needs a
 * fresh page, which is what empties the record. */
async function expectHistoryStates(page: Page, where: string) {
  // The pair stands in the header beside the theme toggle after a field
  // round: the visual reference's header placement, with the builder's chrome states (a disabled
  // chrome
  // button reads in the faint ink and never lifts).
  const undoBtn = page.locator("#header-actions-left [data-undo]");
  const redoBtn = page.locator("#header-actions-left [data-redo]");
  const arrangeBtn = page.getByRole("button", { name: "Arrange by dependency" });
  const dimmed = async (btn: Locator, what: string) => {
    await expect.soft(btn, `${where}: ${what} is disabled`).toBeDisabled();
    expect.soft(await style(btn, "color"), `${where}: ${what} reads in the faint ink`).toBe(await token(page, "--fg-faint"));
    await btn.hover({ force: true });
    await page.waitForTimeout(200);
    expect.soft(await style(btn, "transform"), `${where}: ${what} does not lift on hover`).toBe("none");
  };
  const lit = async (btn: Locator, what: string) => {
    await expect.soft(btn, `${where}: ${what} is enabled`).toBeEnabled();
    // The ink is polled, not read once: under a loaded whole-set run the
    // re-render that lifts the faint ink can land a beat after the control
    // enables.
    const faint = await token(page, "--fg-faint");
    await expect
      .poll(() => style(btn, "color"), { message: `${where}: ${what} reads in the muted ink, not the faint` })
      .not.toBe(faint);
  };
  await dimmed(undoBtn, "Undo with nothing to undo");
  await dimmed(redoBtn, "Redo with nothing to redo");
  await arrangeBtn.click();
  await page.waitForTimeout(700);
  await lit(undoBtn, "Undo after Arrange");
  await dimmed(redoBtn, "Redo after Arrange");
  await undoBtn.click();
  await page.waitForTimeout(700);
  // The notice the undo raised, against the reference's glass pill, while
  // it still stands (it fades on its own after a few seconds).
  await expectNotice(page, `${where}: the notice`, "Undone: Arrange");
  await dimmed(undoBtn, "Undo after the undo");
  await lit(redoBtn, "Redo after the undo");
  const lockBtn = page.getByRole("button", { name: "Lock canvas" });
  await lockBtn.click();
  const LOCK = "Canvas locked. Unlock to edit.";
  await expect.soft(page.getByRole("button", { name: `Undo: ${LOCK}` }), `${where}: Undo carries the lock's reason`).toBeDisabled();
  await expect.soft(page.getByRole("button", { name: `Redo: ${LOCK}` }), `${where}: Redo carries the lock's reason`).toBeDisabled();
  // The chord's refusal while locked: the same pill in the reference's bad tone.
  await flow(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expectNotice(page, `${where}: the locked notice`, LOCK, "bad");
  await page.getByRole("button", { name: "Unlock canvas" }).click();
  await lit(redoBtn, "Redo after unlocking");
}

/** The notice against the reference's glass pill.
 * The reference draws it with `wf-kit.css`'s `.statusPill`: the pill
 * radius, 32px tall, 15px of side padding, the panel ground at 93% under
 * an 8px blur with the kit's shadow, the muted ink, and the danger ink in
 * the bad tone. The app's own named differences are its width cap, the
 * foot it keeps above the results band and its shadow: read over the
 * canvas, it is an overlay panel like the legend and carries the legend's
 * overlay shadow. The box is measured for its ink, its glass and its
 * centring, never for its width. */
async function expectNotice(page: Page, where: string, text: string, tone?: "bad") {
  const el = page.locator("[data-canvas-notice]");
  await expect.soft(el, `${where} reads its step`).toHaveText(text);
  expect.soft(await style(el, "border-radius"), `${where} is a pill`).toBe(await varOf(page, "--radius-pill"));
  const b = await box(el);
  expect.soft(b.h >= 32, `${where} is the reference's 32px tall (${b.h})`).toBe(true);
  expect.soft(await style(el, "padding-left"), `${where} keeps the reference's side padding`).toBe("15px");
  expect.soft(await style(el, "padding-right"), `${where} keeps the reference's side padding`).toBe("15px");
  expect.soft(await style(el, "background-color"), `${where} is the panel ground at the reference's 93%`).toBe(await resolved(page, "color-mix(in srgb, var(--bg-panel) 93%, transparent)"));
  expect.soft(await style(el, "box-shadow"), `${where} carries the overlay shadow, as the legend does`).toContain("0px 8px 26px");
  expect.soft(await style(el, "color"), `${where} reads in the ${tone === "bad" ? "danger" : "muted"} ink`).toBe(await token(page, tone === "bad" ? "--danger" : "--fg-muted"));
  // Centred in the area the overlays leave free, as the reference centres
  // its pill on its own `--ov-shift`: in full view the pane floats over
  // the flow area's left, in the framed view it stands outside it. The
  // free area is measured from the boxes, never from the app's variable.
  const f = await box(flow(page));
  const p = await box(pane(page));
  // The pane floating over the flow area leaves the free area a gutter
  // beyond its own right edge, the same gutter reference 13 keeps.
  const freeLeft = p.right > f.x + 1 && p.x < f.right ? p.right + GUTTER : f.x;
  expect.soft(near(b.cx, (freeLeft + f.right) / 2, 4), `${where} is centred in the free area (${b.cx} against ${(freeLeft + f.right) / 2})`).toBe(true);
  expect.soft(b.y > f.y + f.h / 2, `${where} stands at the frame's foot`).toBe(true);
}

/** Computed rather than read from source or a served stylesheet: this is
 * the browser-visible contract broke. Exact values keep the check sensitive
 * to a dropped declaration as well as an accidental blur change. */
async function expectBlur(loc: Locator, value: string, surface: string) {
  await expect(loc, `${surface} is rendered`).toBeVisible();
  expect.soft(await style(loc, "backdrop-filter"), `${surface} computes ${value}, never none`).toBe(value);
}

/** A written layout with the node below its arranged place, so Arrange is
 * a genuine move. A workflow with no written layout opens *already*
 * arranged (the canvas's own rule), and an Arrange that moves nothing is
 * no step, so the record would stay empty. */
async function offArrangement(page: Page, id: string) {
  const recipe = (await api(page, "GET", `/api/recipes/${id}`)).recipe as { steps: { id: string }[] };
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "PUT", path: `/api/recipes/${id}/layout`, body: {
    steps: { [recipe.steps[0].id]: { x: 288, y: 200 } },
    sources: { [table]: { x: 48, y: 40 } },
    notes: [],
  } })).then(result => result.json);
}

for (const theme of ["light", "dark"] as const) {
  test(`the shell, the graph and the pane follow reference 13 (${theme})`, async ({ page }) => {
    const consoleErrors = trackConsole(page);
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    const id = await seed(page, theme);

    await test.step("a list screen: the header bar's ground is the body's fixed sheet", async () => {
      // seed() leaves the page on the Workflows list.
      const bar = page.locator("header");
      expect.soft(await style(bar, "background-image"), "the bar paints the shell sheet").toContain("shell-sheet");
      expect.soft(await style(bar, "background-attachment"), "the bar's sheet is fixed, like the body's").toBe("fixed");
      expect.soft(await style(bar, "background-color"), "the bar keeps an opaque ground, so scrolled content never shows through").toBe(await token(page, "--bg"));
    });

    await page.goto(`/workflows/${id}`);
    await settled(page);
    const vp = page.viewportSize()!;

    await test.step("full view: the surface is the ground edge to edge, the header dissolves", async () => {
      const h = await box(host(page));
      expect.soft(near(h.x, 0) && near(h.y, 0) && near(h.w, vp.width) && near(h.h, vp.height), "the host covers the viewport").toBe(true);
      const f = await box(flow(page));
      expect.soft(near(f.x, 0) && near(f.y, 0) && near(f.w, vp.width) && near(f.h, vp.height), "the flow area covers the viewport").toBe(true);
      expect.soft(await style(host(page), "background-color"), "the surface is the workspace's ground").toBe(await token(page, "--bg"));
      expect.soft(await style(page.locator("header"), "background-color"), "the header bar dissolves over the surface").toBe("rgba(0, 0, 0, 0)");
    });

    await test.step("full view: the pane is level with the rail", async () => {
      await expectPaneLevel(page, "full view");
    });

    await test.step("full view: the band is the reference's card beside the pane, never under it", async () => {
      const p = await box(pane(page));
      const b = await box(card(page));
      expect.soft(b.x, "the band starts right of the pane and its gutter").toBeGreaterThanOrEqual(p.right + GUTTER - 1.5);
      expect.soft(near(b.right, vp.width - GUTTER), `the band ends at the right gutter (${b.right} vs ${vp.width - GUTTER})`).toBe(true);
      expect.soft(near(b.bottom, vp.height - GUTTER), `the band stands on the bottom gutter (${b.bottom})`).toBe(true);
      expect.soft(await style(card(page), "border-top-left-radius"), "the band is a rounded card").toBe("20px");
      // Open, then collapse: the pane never gives way to it.
      await band(page).locator("[data-band-lead]").click();
      await page.waitForTimeout(200);
      await expectPaneLevel(page, "band open");
      // Resized taller by the keyboard (six steps of 24px): still beside the pane.
      const before = await box(card(page));
      await band(page).locator("[data-band-separator]").focus();
      for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(200);
      expect.soft((await box(card(page))).h, "the band grew by the keyboard").toBeGreaterThan(before.h);
      await expectPaneLevel(page, "band resized");
      await band(page).locator("[data-band-separator]").focus();
      await page.keyboard.press("Home");
      await page.waitForTimeout(200);
      await expectPaneLevel(page, "band collapsed");
    });

    await test.step("the header: theme toggle, then Run all at the far right; Arrange in the stage stack", async () => {
      const toggle = await box(page.getByRole("button", { name: "Switch between dark and light theme" }));
      const run = await box(page.locator('[data-run-action="run-all"]'));
      expect.soft(toggle.right, "the theme toggle stands left of Run all").toBeLessThanOrEqual(run.x);
      expect.soft(near(run.right, vp.width - 16), `Run all ends at the header's right edge (${run.right} of ${vp.width})`).toBe(true);
      expect.soft(await style(page.locator('[data-run-action="run-all"]'), "border-radius"), "Run all wears the chrome radius").toBe("12px");
      expect.soft(await style(page.locator('[data-run-action="run-all"]'), "box-shadow"), "Run all wears the chrome shadow").not.toBe("none");
      await expect.soft(page.locator("[data-canvas-stage]").getByRole("button", { name: "Arrange by dependency" }), "Arrange stands in the stage stack").toBeVisible({ timeout: 2000 });
      await expect.soft(page.locator("header").getByRole("button", { name: "Arrange by dependency" }), "no Arrange in the header").toHaveCount(0, { timeout: 2000 });
    });

    await test.step("ports on the tile's edge", async () => {
      await expectPortsOnEdge(page);
    });

    await test.step("the pane's chrome is the kit's", async () => {
      const on = pane(page).locator('[role="tab"][aria-selected="true"]');
      expect.soft(await style(on, "color"), "the selected tab is the accent word").toBe(await token(page, "--accent"));
      const tab = await box(on);
      const underline = parseFloat(await style(on, "width", "::after"));
      expect.soft(underline > 0 && underline < tab.w * 0.6, `the underline is the kit's short centred mark (${underline} of ${tab.w})`).toBe(true);
      const search = pane(page).getByRole("searchbox");
      await expect.soft(search.locator("xpath=..").locator("svg"), "the search carries its magnifier").toHaveCount(1, { timeout: 2000 });
      const glyph = pane(page).locator(`[data-table="${table}"] > span`).first();
      expect.soft(await style(glyph, "background-color"), "a source row shows the tinted geometry tile").toBe(await token(page, "--accent-wash"));
    });

    await test.step("the grid's dot holds 2px at 100% or above and at 60% or below", async () => {
      const dot = page.locator(".react-flow__background pattern circle").first();
      const diameter = async () => 2 * Number(await dot.getAttribute("r"));
      // The stage's buttons step the zoom by a fixed factor from the fit's
      // deterministic level, so the levels reached are fixed too; each is
      // asserted before the dot is measured (found at review).
      const stepTo = async (name: "Zoom in" | "Zoom out", done: (z: number) => boolean) => {
        for (let i = 0; i < 12 && !done(await scale(page)); i += 1) {
          await page.getByRole("button", { name }).click();
          await page.waitForTimeout(150);
        }
        return scale(page);
      };
      const far = await stepTo("Zoom out", (z) => z <= 0.6);
      expect.soft(far, "zoomed out to 60% or below").toBeLessThanOrEqual(0.6);
      expect.soft(near(await diameter(), 2, 0.1), `the dot is 2px at ${far}`).toBe(true);
      const nearZoom = await stepTo("Zoom in", (z) => z >= 1);
      expect.soft(nearZoom, "zoomed in to 100% or above").toBeGreaterThanOrEqual(1);
      expect.soft(near(await diameter(), 2, 0.1), `the dot is 2px at ${nearZoom}`).toBe(true);
      await page.getByRole("button", { name: "Fit to view" }).click();
      await page.waitForTimeout(400);
    });

    await test.step("the view toggle moves nothing, at rest", async () => {
      await expectToggleKeepsPlace(page, "Framed view", "full to framed");
      await expectToggleKeepsPlace(page, "Fill the screen", "framed to full");
    });

    await test.step("full view: the stack and the panel on the fullscreen map's line, the panel's foot at the band's gap", async () => {
      const p = await box(pane(page));
      const st = await box(stage(page));
      expect.soft(near(st.y, RAIL_TOP), `the stack's top (${st.y}) is level with the pane's (${RAIL_TOP})`).toBe(true);
      expect.soft(near(st.x, p.right + GUTTER), `the stack stands a gutter right of the pane (${st.x} vs ${p.right + GUTTER})`).toBe(true);
      await nodeTile(page).click();
      const panel = page.locator("[data-node-panel]");
      await expect(panel).toBeVisible();
      await page.waitForTimeout(350);
      const check = async (where: string) => {
        const pb = await box(panel);
        const b = await box(card(page));
        expect.soft(near(pb.y, RAIL_TOP), `${where}: the panel's top (${pb.y}) is level with the pane's`).toBe(true);
        expect.soft(near(pb.bottom, b.y - GUTTER), `${where}: the panel's foot (${pb.bottom}) stands a gutter above the results card (${b.y})`).toBe(true);
        expect.soft(near(pb.right, b.right), `${where}: the panel's right edge is level with the results card's`).toBe(true);
      };
      await check("band collapsed");
      await band(page).locator("[data-band-lead]").click();
      await page.waitForTimeout(250);
      await check("band open");
      await band(page).locator("[data-band-separator]").focus();
      await page.keyboard.press("Home");
      await page.waitForTimeout(250);
      await expectToggleKeepsPlace(page, "Framed view", "full to framed, panel open");
      await expectToggleKeepsPlace(page, "Fill the screen", "framed to full, panel open");
    });

    await test.step("the operation glyph is 52px, a source's 50 (amended)", async () => {
      expect.soft(await style(nodeTile(page).locator("svg").first(), "width"), "the operation glyph").toBe("52px");
      expect.soft(await style(page.locator('[data-node][data-kind="source"] [data-v="badge"] svg').first(), "width"), "the source glyph").toBe("50px");
    });

    await test.step("the edge's tip reads: larger than 7px and with more contrast than the line, the line more than the strong border", async () => {
      const ground = lum(await token(page, "--bg"));
      const contrast = (rgb: string) => Math.abs(lum(rgb) - ground);
      const line = await style(page.locator(".react-flow__edge-path").first(), "stroke");
      const arrow = page.locator(".react-flow__edge polygon").first();
      const fill = await style(arrow, "fill");
      const xs = (await arrow.getAttribute("points"))!.trim().split(/\s+/).map((pt) => Number(pt.split(",")[0]));
      expect.soft(Math.max(...xs) - Math.min(...xs), "the arrowhead's length").toBeGreaterThanOrEqual(10);
      expect.soft(contrast(fill), `the tip (${fill}) has more contrast than the line (${line})`).toBeGreaterThan(contrast(line));
      expect.soft(contrast(line), `the line (${line}) has more contrast than the strong border`).toBeGreaterThan(contrast(await token(page, "--border-strong")));
    });

    await test.step("the panel's callout wraps: no sideways scroll after an edit with long names", async () => {
      const panel = page.locator("[data-node-panel]");
      // The callout shows for a node whose output holds a last run: run it once.
      await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/runs` })).then(result => result.json);
      await expect
        .poll(async () => ((await api(page, "GET", `/api/recipes/${id}`)).recipe as { steps: { output: unknown }[] }).steps[0]?.output ?? null, { timeout: 30000 })
        .not.toBeNull();
      await page.waitForTimeout(300);
      await panel.locator('[data-input="input"]').click();
      await page.locator(`[data-picker-pop] [data-option="${longTable}"]`).click();
      await expect(panel.locator('[data-callout="edited"]')).toBeVisible();
      // The edit proposes a link: its tip, in the kind's own hue, reads over its own line too.
      const proposed = page.locator('[data-time="proposed"]').first();
      await expect(proposed).toHaveCount(1);
      const ground = lum(await token(page, "--bg"));
      const pTip = await style(proposed.locator("polygon"), "fill");
      const pLine = await style(proposed.locator("path.react-flow__edge-path"), "stroke");
      expect.soft(Math.abs(lum(pTip) - ground), `the proposed tip (${pTip}) has more contrast than its line (${pLine})`).toBeGreaterThan(Math.abs(lum(pLine) - ground));
      const widths = await panel.locator('[class*="inspBody"]').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect.soft(widths.scroll, `the panel body never scrolls sideways (${widths.scroll} of ${widths.client})`).toBeLessThanOrEqual(widths.client);
      await panel.locator("[data-discard-edit]").click();
      await expect(panel.locator('[data-callout="edited"]')).toHaveCount(0);
    });

    await test.step("notes: one frame when editing, the placeholder, a list at any dash line, the heading sizes", async () => {
      await page.locator("[data-note-tool]").click();
      // Clear of the floating pane, the tiles' labels and the band: nothing run-scoped near the
      // note.
      const at = await paneAt(page, 0.5, 0.74);
      await page.mouse.click(at.x, at.y);
      const field = page.locator("[data-note-field]");
      await expect(field).toBeFocused();
      const note = page.locator("[data-note]").first();
      // One frame: the field's focus ring (the census's ring, kept), with the note's own border
      // stepped aside.
      expect.soft(await style(field, "outline-style"), "the editor's ring is drawn").toBe("solid");
      expect.soft(await style(note, "border-top-color"), "the editing note's own border steps aside for the ring").toBe("rgba(0, 0, 0, 0)");
      expect.soft(await style(note, "box-shadow"), "the editing note keeps the selected halo").not.toBe("none");
      await expect.soft(page.locator("[data-note-placeholder]"), "an empty note's editor shows the placeholder").toBeVisible({ timeout: 2000 });
      await page.keyboard.type("# One\n## Two\n### Three\nHere:\n- a\n- b");
      await expect.soft(page.locator("[data-note-placeholder]"), "the first character replaces the placeholder").toHaveCount(0, { timeout: 2000 });
      await page.keyboard.press("Escape");
      await expect(field).toHaveCount(0);
      const body = note.locator("[data-note-body]");
      await expect.soft(body.locator("li"), "a dash line after a paragraph line is a list item").toHaveCount(2, { timeout: 2000 });
      expect.soft(await style(body.locator("h1"), "font-size"), "the first heading level is the hero size").toBe(await tokenValue(page, "--text-hero"));
      expect.soft(await style(body.locator("h2"), "font-size"), "the second is the title size").toBe(await tokenValue(page, "--text-title"));
      expect.soft(await style(body.locator("h3"), "font-size"), "the third is the heading size").toBe(await tokenValue(page, "--text-heading"));
    });

    await test.step("framed view: three cards at the reference's places", async () => {
      await page.getByRole("button", { name: "Framed view" }).click();
      await page.waitForTimeout(500);
      await expectPaneLevel(page, "framed view");
      const p = await box(pane(page));
      const f = await box(flow(page));
      const b = await box(card(page));
      expect.soft(near(f.y, p.y), `the canvas card's top (${f.y}) is level with the pane's (${p.y})`).toBe(true);
      expect.soft(near(f.x, p.right + GUTTER), `the canvas card starts a gutter right of the pane (${f.x} vs ${p.right + GUTTER})`).toBe(true);
      expect.soft(near(f.right, vp.width - GUTTER), "the canvas card ends at the right gutter").toBe(true);
      expect.soft(await style(flow(page), "border-top-left-radius"), "the canvas card is rounded").toBe("20px");
      expect.soft(b.y, "the results card stands a gutter under the canvas card").toBeGreaterThanOrEqual(f.bottom + GUTTER - 1.5);
      expect.soft(near(b.x, f.x) && near(b.right, f.right), "the results card shares the canvas card's column").toBe(true);
      expect.soft(near(b.bottom, vp.height - GUTTER), "the results card stands on the bottom gutter").toBe(true);
      expect.soft(await style(host(page), "background-color"), "the column behind the cards is not painted").toBe("rgba(0, 0, 0, 0)");
      expect.soft(await style(flow(page), "background-color"), "the canvas card's surface is the ground").toBe(await token(page, "--bg"));
      await expectPortsOnEdge(page);
      // With a panel open, the panel stays inside the canvas card and the toggle back lands clean.
      await page.locator('[data-node][data-kind="node"] [data-v="badge"]').first().click();
      const panel = await box(page.locator("[data-node-panel]"));
      const frame = await box(flow(page));
      expect.soft(panel.x >= frame.x - 1 && panel.right <= frame.right + 1 && panel.y >= frame.y - 1 && panel.bottom <= frame.bottom + 1, "the panel stays inside the canvas card").toBe(true);
      await page.getByRole("button", { name: "Fill the screen" }).click();
      await page.waitForTimeout(500);
      const back = await box(flow(page));
      expect.soft(near(back.x, 0) && near(back.y, 0) && near(back.w, vp.width) && near(back.h, vp.height), "the flow area covers the viewport again").toBe(true);
      await expectPaneLevel(page, "back in full view");
      const openPanel = await box(page.locator("[data-node-panel]"));
      const bandBox = await box(card(page));
      expect.soft(openPanel.bottom, "the panel keeps above the band").toBeLessThanOrEqual(bandBox.y - GUTTER + 1.5);
    });

    const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
    expect(unexpected).toEqual([]);
  });
}

test("the glass surfaces compute their declared blur", async ({ page }) => {
  const id = await seed(page, "glass");
  await offArrangement(page, id);
  await page.goto(`/workflows/${id}`);
  await settled(page);

  await page.getByRole("button", { name: "Arrange by dependency" }).click();
  await page.locator("#header-actions-left [data-undo]").click();
  await expect(page.locator("[data-canvas-notice]")).toHaveText("Undone: Arrange");
  await expectBlur(page.locator("[data-canvas-notice]"), "blur(8px)", "the canvas notice");
  await expectBlur(page.locator('header [class*="headCard"]'), "blur(18px)", "the workspace header");
  await expectBlur(pane(page), "blur(18px)", "the canvas pane");

  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/runs` })).then(result => result.json);
  await expect
    .poll(async () => ((await api(page, "GET", `/api/recipes/${id}`)).recipe as { steps: { output: unknown }[] }).steps[0]?.output ?? null, { timeout: 30_000 })
    .not.toBeNull();
  // A run started through the API is found on open, not by the page that
  // was already up: reload, as the results journey does after its runs.
  await page.reload();
  await settled(page);
  await nodeTile(page).click();
  const mapTab = page.getByRole("tab", { name: "Map" });
  await expect(mapTab).toBeEnabled({ timeout: 15_000 });
  await mapTab.click();
  await expectBlur(page.locator("[data-band-readout]"), "blur(8px)", "the results band");

  await page.getByRole("button", { name: "Run all" }).click();
  const scrim = page.locator("[data-dialog-host] > div");
  await expectBlur(scrim, "blur(4px)", "the dialog scrim");
  await page.locator("[data-run-confirm]").getByRole("button", { name: "Cancel" }).click();

  const mapId = await createMap(page, `Glass ${runId}`);
  await addLayer(page, mapId, "Glass control", `SELECT * FROM ${table}`);
  await page.goto(`/maps/${mapId}`);
  await expectBlur(page.locator("[data-map-legend]"), "blur(8px)", "the standard-only legend control");
});

// Undo and Redo in the stack: the pair's states against the reference —
// dimmed with nothing on their side, lit with a step, inert while locked
// with the lock's reason — in both views and both themes. Its own
// workflow, laid out off the dependency arrangement so Arrange is a
// genuine move; the record is this page's, so the reload between the two
// views empties it and the pass that left its Arrange
// undone leaves the layout as it was seeded. Seen red once against the
// shipped surface, which has no such buttons (the verification record
// names the run).
for (const theme of ["light", "dark"] as const) {
  test(`Undo and Redo in the header follow the reference's header placement (${theme})`, async ({ page }) => {
    const consoleErrors = trackConsole(page);
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    const id = await seed(page, `${theme}_history`);
    await offArrangement(page, id);
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await expectHistoryStates(page, "full view");
    await page.reload();
    await settled(page);
    await page.getByRole("button", { name: "Framed view" }).click();
    await page.waitForTimeout(500);
    await expectHistoryStates(page, "framed view");
    const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
    expect(unexpected).toEqual([]);
  });
}

// The pixel capture: two linked tiles with their edge, in
// both themes, so the port's place on the tile's edge and the reference's
// curve are held by the pixel layer. The clip stops above the labels, so
// run-scoped names stay outside the shot. Baselines are darwin-generated;
// red-proven once by seeding the old output-port offset (the verification
// record names the run).
for (const theme of ["light", "dark"] as const) {
  test(`two linked tiles and their edge match the ${theme} baseline`, async ({ page }) => {
    test.skip(process.platform !== "darwin", "pixel baselines are darwin-generated; no baseline exists for this platform");
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    const id = await seed(page, `${theme}_tiles`);
    await page.goto(`/workflows/${id}`);
    await settled(page);
    const src = await box(page.locator('[data-node][data-kind="source"] [data-v="badge"]').first());
    const node = await box(page.locator('[data-node][data-kind="node"] [data-v="badge"]').first());
    const pad = 12;
    const x = Math.min(src.x, node.x) - pad;
    const y = Math.min(src.y, node.y) - pad;
    const clip = {
      x: Math.floor(x),
      y: Math.floor(y),
      width: Math.ceil(Math.max(src.right, node.right) + pad - x),
      height: Math.ceil(Math.max(src.bottom, node.bottom) + pad - y),
    };
    // Exact: at the comparator's default colour threshold a light-grey port
    // dot moving on the light ground did not count (seen while red-proving
    // this capture), so every differing pixel counts here.
    await expect(page).toHaveScreenshot(`linked-tiles-${theme}.png`, { clip, animations: "disabled", threshold: 0 });
  });
}

// The second round's capture: an editing note with its label strip and its
// placeholder, in both themes, so the single frame and the tag over it are
// held by the pixel layer. Red-proven once by re-seeding the editor's own
// outline (the verification record names the run).
for (const theme of ["light", "dark"] as const) {
  test(`an editing note matches the ${theme} baseline`, async ({ page }) => {
    test.skip(process.platform !== "darwin", "pixel baselines are darwin-generated; no baseline exists for this platform");
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    const id = await seed(page, `${theme}_note`);
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await page.locator("[data-note-tool]").click();
    // Clear of the floating pane, the tiles' labels and the band, and of
    // the stage column, which reaches this far down added its two
    // buttons: nothing but the note in the frame.
    const at = await paneAt(page, 0.58, 0.74);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator("[data-note-field]")).toBeFocused();
    await page.waitForTimeout(300);
    const n = await box(page.locator("[data-note]").first());
    // A tight pad: the tiles' labels stand just above the note's room.
    const pad = 8;
    const clip = { x: Math.floor(n.x - pad), y: Math.floor(n.y - pad), width: Math.ceil(n.w + 2 * pad), height: Math.ceil(n.h + 2 * pad) };
    await expect(page).toHaveScreenshot(`editing-note-${theme}.png`, { clip, animations: "disabled", threshold: 0 });
  });
}

// The stack's capture (re-read after): seven buttons since the pair moved
// to the header, in both themes. The
// clip is the stack's own box (eight buttons with the minimap's toggle):
// nothing run-scoped is in it. Baselines are darwin-generated; the
// nine-button captures this replaced were red-proven against the shipped
// seven-button stack and re-minted when the zoom readout was removed;
// these were minted on the header build.
for (const theme of ["light", "dark"] as const) {
  test(`the stack matches the ${theme} baseline`, async ({ page }) => {
    test.skip(process.platform !== "darwin", "pixel baselines are darwin-generated; no baseline exists for this platform");
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    const id = await seed(page, `${theme}_stack`);
    await offArrangement(page, id);
    await page.goto(`/workflows/${id}`);
    await settled(page);
    await expect(stage(page).locator("button")).toHaveCount(8);
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await page.waitForTimeout(900);
    // The pointer away from the stack, so no button wears its hover.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    // The stack's own box, with no pad: the floating pane's shadow falls
    // across the ground just outside it, and the pane's height follows
    // whatever the run's data directory holds, so a padded frame compares
    // a background that is not the subject.
    const st = await box(stage(page));
    const clip = { x: Math.ceil(st.x), y: Math.ceil(st.y), width: Math.floor(st.w), height: Math.floor(st.h) };
    // Exact color, with a count bound for the anti-aliased edges' wobble
    // (2 pixels differed on a whole-set run and none alone; the form,
    // ~2x the measured wobble).
    await expect(page).toHaveScreenshot(`stack-${theme}.png`, { clip, animations: "disabled", threshold: 0, maxDiffPixels: 4 });
  });
}
