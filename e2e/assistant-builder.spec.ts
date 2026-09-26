// The assistant on the builder (of): the door in the header's left group,
// the pane right of the stage, the three width bands and both boundaries,
// the replacement measured frame by frame, the resize swap and its
// passive memory, the right-edge tenants, the fullscreen map, fit to data
// and the camera's commit count, and the dismissal contract. Everything
// is read from rectangles the page reports and the number the camera
// receives, never from a pane's own flag alone.
//
// Environment: the documented gate (isolated server, fresh data dir, the
// scripted provider on 3202). Run with DEZFIL_BASE_URL at the server.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { addLayer, createMap, mapSaveArrived, patchLayer, patchMap, routeHouse, seedFile, trackConsole } from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const H = 900;
const HELPER = 354;
const GUTTER = 14;

const PANE = "[data-assistant-pane]";
const DRAWER = "[data-recipe-drawer]";
const TOOLS_DOOR = "[data-tools-control]";
const STAGE = "[data-map-layer]";
/** The visible stage window: the card both edges move. */
const WINDOW = "[data-drag-canvas]";

const provider = assistantProviderFixture();
test.beforeAll(async () => { await provider.start(); });
test.afterAll(async () => { await provider.stop(); });
test.beforeEach(async ({ context }) => { provider.reset(); await routeHouse(context, { basemapStyleStub: true }); });

const door = (page: Page) => page.locator("header").getByRole("button", { name: /^(Open|Close) assistant$/ });
const pane = (page: Page) => page.locator(PANE);
const drawer = (page: Page) => page.locator(DRAWER);
const paneOpen = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "true");
const paneClosed = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "false");
const drawerVisible = (page: Page) => page.locator(`${DRAWER}:not([data-hidden])`);

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, `${selector} has a box`).not.toBeNull();
  return b!;
}
/** A box that has stopped moving (the card slides on a hand open and
 * settles in vertically on entrance): the same box across a gap longer
 * than the panel's transition, so a motion that has not yet begun cannot
 * pass as rest. */
async function settled(page: Page, selector: string) {
  await expect.poll(async () => {
    const key = async () => { const b = await box(page, selector); return `${Math.round(b.x)}:${Math.round(b.y)}:${Math.round(b.width)}`; };
    const first = await key();
    await page.waitForTimeout(320);
    return first === (await key());
  }).toBe(true);
  return box(page, selector);
}
const right = (b: { x: number; width: number }) => b.x + b.width;

/** The drawn points' fill, distinctive on the stubbed basemap. */
const INK: [number, number, number] = [255, 0, 255];
async function seedMap(page: Page, opts: { widget?: boolean; legend?: boolean; ink?: boolean } = {}) {
  await page.goto("/maps");
  const stations = `asst_${runId}_${Math.random().toString(36).slice(2, 6)}`;
  await seedFile(page, `${stations}.geojson`, readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"), "application/geo+json");
  const mapId = await createMap(page, `assistant ${runId}`);
  const layerId = await addLayer(page, mapId, stations, `SELECT * FROM ${stations}`);
  if (opts.ink) {
    await patchLayer(page, layerId, { style: { fill: { type: "constant", color: { r: INK[0], g: INK[1], b: INK[2], a: 1 } }, fillOpacity: 1, stroke: { r: INK[0], g: INK[1], b: INK[2], a: 1 }, strokeOpacity: 1, strokeWidth: 0, pointRadius: 6, opacity: 1 } });
  }
  // A widget docks a top-right legend into the rail (use-legend-placement),
  // so the two right tenants are seeded apart: the floating legend corner
  // on one map, the widget rail on another.
  if (opts.legend) await patchMap(page, mapId, { legendCorner: "top-right" });
  if (opts.widget) {
    await patchMap(page, mapId, { widgets: [{ id: "w-count", type: "formula", layerId, title: "Stations", field: null, agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }] });
  }
  return { mapId, layerId, stations };
}
/** Where the drawn ink lands on screen: the bounding box of the pixels
 * in the layer's fill, from a screenshot decoded in the page. The
 * swatches that wear the same fill (the legend, the inspector's layer
 * card, a widget) are masked out by their elements' rectangles. */
const SWATCH_HOSTS = "[data-corner], [data-builder-pane], [data-widget-rail], [data-assistant-pane], [data-recipe-drawer]";
async function drawnBox(page: Page, color: [number, number, number]) {
  const png = await page.screenshot({ fullPage: false });
  return page.evaluate(async ({ b64, color, hosts }) => {
    const masks = Array.from(document.querySelectorAll(hosts)).map((el) => el.getBoundingClientRect());
    const masked = (x: number, y: number) => masks.some((m) => x >= m.left && x < m.right && y >= m.top && y < m.bottom);
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d")!; ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
    const scale = c.width / window.innerWidth;
    for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) {
      const i = (y * c.width + x) * 4;
      if (masked(x / scale, y / scale)) continue;
      if (Math.abs(data[i] - color[0]) < 40 && Math.abs(data[i + 1] - color[1]) < 40 && Math.abs(data[i + 2] - color[2]) < 40) {
        count += 1; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    return { count, x: minX / scale, y: minY / scale, right: (maxX + 1) / scale, bottom: (maxY + 1) / scale };
  }, { b64: png.toString("base64"), color, hosts: SWATCH_HOSTS });
}
/** The pane's remembered open state carries across a test's navigations. */
async function ensureClosed(page: Page) {
  if ((await pane(page).getAttribute("data-open")) === "true") { await door(page).click(); await paneClosed(page); await settled(page, WINDOW); }
}
async function openBuilder(page: Page, mapId: string, width: number) {
  await page.setViewportSize({ width, height: H });
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);
  await settled(page, WINDOW);
}
/** The committed-edge counter: the number handed to the camera, both
 * edges in one value, so one commit is one mutation. */
async function armCommits(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __commits: number };
    w.__commits = 0;
    new MutationObserver((records) => { w.__commits += records.length; })
      .observe(document.querySelector("[data-map-layer]")!, { attributes: true, attributeFilter: ["data-stage-edge"] });
  });
}
const commits = (page: Page) => page.evaluate(() => (window as unknown as { __commits: number }).__commits);
/** Frame sampling, armed before a press or a resize: every rendered frame
 * records both edges, the visible helpers and the card's transition. */
async function armFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: unknown[]; __sampling: boolean };
    w.__frames = []; w.__sampling = true;
    const sample = () => {
      const card = document.querySelector("[data-drag-canvas]")!.parentElement!;
      const rect = card.getBoundingClientRect();
      const p = document.querySelector("[data-assistant-pane]") as HTMLElement;
      const d = document.querySelector("[data-recipe-drawer]") as HTMLElement | null;
      const paneShown = p.getAttribute("data-open") === "true" && getComputedStyle(p).visibility !== "hidden";
      const drawerShown = !!d && getComputedStyle(d).visibility !== "hidden";
      w.__frames.push({ left: rect.left, right: rect.right, helpers: (paneShown ? 1 : 0) + (drawerShown ? 1 : 0), width: window.innerWidth, transition: getComputedStyle(card).transitionDuration });
      if (w.__sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}
type Frame = { left: number; right: number; helpers: number; width: number; transition: string };
const frames = (page: Page) => page.evaluate(() => { const w = window as unknown as { __frames: Frame[]; __sampling: boolean }; w.__sampling = false; return w.__frames; });

test.describe("2: one door, in the header's left group", () => {
  for (const width of [1440, 1200]) test(`2a-c at ${width}: exactly one door after Redo, compact name, no toolbar entry`, async ({ page }) => {
    const errors = trackConsole(page);
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, width);
    const doors = page.getByRole("button", { name: /^(Open|Close) assistant$/ });
    await expect(doors).toHaveCount(1);
    await expect(page.locator("#header-actions-left").getByRole("button", { name: "Open assistant", exact: true })).toHaveCount(1);
    const names = await page.locator("#header-actions-left button, #header-actions-left a").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    expect(names[names.indexOf("Redo") + 1]).toBe("Open assistant");
    expect(await page.locator("[data-stage-anchor], [class*='stageStack']").getByRole("button", { name: /assistant/i }).count()).toBe(0);
    expect(errors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
  });
});

test.describe("3: the width rule", () => {
  test("3a at 1100: the stage is unmoved, the pane over its right side, and Tools replaces it", async ({ page }) => {
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, 1100);
    const before = await box(page, WINDOW);
    await door(page).click();
    await paneOpen(page);
    await expect(pane(page)).toHaveAttribute("data-overlay", "true");
    const after = await settled(page, WINDOW);
    expect(Math.round(after.x)).toBe(Math.round(before.x));
    expect(Math.round(after.width)).toBe(Math.round(before.width));
    const p = await box(page, PANE);
    expect(Math.round(right(p))).toBe(1100 - GUTTER);
    expect(p.x).toBeGreaterThanOrEqual(before.x + before.width / 2);
    expect(p.x).toBeLessThan(right(before));
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toBeVisible();
    await paneClosed(page);
  });

  test("3b at 1440: the right edge moves in by the pane; a replacement moves both edges together with never none or two helpers", async ({ page }) => {
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, 1440);
    await armCommits(page);
    const closed = await box(page, WINDOW);
    expect(Math.round(right(closed))).toBe(1440 - GUTTER);
    await door(page).click();
    await paneOpen(page);
    const docked = await settled(page, WINDOW);
    expect(Math.round(right(docked))).toBe(1440 - GUTTER - HELPER);
    expect(Math.round(docked.x)).toBe(Math.round(closed.x));
    await expect.poll(() => commits(page)).toBe(1);

    // The replacement, sampled frame by frame from before the press.
    await armFrames(page);
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toBeVisible();
    await paneClosed(page);
    const replaced = await settled(page, WINDOW);
    await page.waitForTimeout(150);
    const sampled = await frames(page);
    expect(sampled.length).toBeGreaterThan(5);
    expect(sampled.every((f) => f.helpers === 1), `helpers per frame: ${sampled.map((f) => f.helpers).join("")}`).toBe(true);
    const start = sampled[0];
    for (const f of sampled) {
      const movedLeft = Math.abs(f.left - start.left) > 0.5;
      const movedRight = Math.abs(f.right - start.right) > 0.5;
      expect(movedLeft, `a frame moved one edge and not the other: ${JSON.stringify(f)} from ${JSON.stringify(start)}`).toBe(movedRight);
    }
    expect(Math.round(replaced.x)).toBe(Math.round(closed.x) + HELPER);
    expect(Math.round(right(replaced))).toBe(1440 - GUTTER);
    expect(await commits(page), "a replacement is one commit").toBe(2);
    // Focus stayed on the pressed control, not the replaced pane's opener.
    expect(await page.evaluate(() => document.activeElement?.closest("[data-tools-control], [data-recipe-drawer]") !== null)).toBe(true);
    // And back: the pane replaces Tools, one more commit, one helper.
    await door(page).click();
    await paneOpen(page);
    await expect(drawerVisible(page)).toHaveCount(0);
    await settled(page, WINDOW);
    expect(await commits(page)).toBe(3);
    await expect(door(page)).toBeFocused();
  });

  test("3c at 1920: both dock and the map keeps at least 700 px", async ({ page }) => {
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, 1920);
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toBeVisible();
    await door(page).click();
    await paneOpen(page);
    await expect(drawerVisible(page)).toBeVisible();
    const both = await settled(page, WINDOW);
    expect(Math.round(both.x)).toBe(438 + HELPER);
    expect(Math.round(right(both))).toBe(1920 - GUTTER - HELPER);
    expect(both.width).toBeGreaterThanOrEqual(700);
  });

  test("3d the boundaries: 1859 replaces and 1860 does not; 1120 overlays and 1121 docks", async ({ page }) => {
    const { mapId } = await seedMap(page);
    for (const [width, replaces] of [[1859, true], [1860, false]] as const) {
      await openBuilder(page, mapId, width);
      await page.locator(TOOLS_DOOR).click();
      await expect(drawerVisible(page)).toBeVisible();
      await door(page).click();
      await paneOpen(page);
      await expect(drawerVisible(page)).toHaveCount(replaces ? 0 : 1);
      await door(page).click();
      await paneClosed(page);
      if (!replaces) { await page.locator(TOOLS_DOOR).click(); await expect(drawerVisible(page)).toHaveCount(0); }
    }
    for (const [width, docks] of [[1120, false], [1121, true]] as const) {
      await openBuilder(page, mapId, width);
      const before = await box(page, WINDOW);
      await door(page).click();
      await paneOpen(page);
      await expect(pane(page)).toHaveAttribute("data-overlay", docks ? "false" : "true");
      const after = await settled(page, WINDOW);
      expect(Math.round(right(after))).toBe(Math.round(right(before)) - (docks ? HELPER : 0));
      await door(page).click();
      await paneClosed(page);
    }
  });

  test("3e at 1440: fit to data centers the data within the visible map, and the camera receives one padding commit per open, close or replacement", async ({ page }) => {
    const { mapId } = await seedMap(page, { ink: true });
    await openBuilder(page, mapId, 1440);
    await armCommits(page);
    await door(page).click();
    await paneOpen(page);
    const window_ = await settled(page, WINDOW);
    await expect.poll(() => commits(page)).toBe(1);
    // The data's centre against the stage rectangle, read from the drawn
    // pixels: the map's persisted centre is already the padded centre and
    // would read the same under a wrong padding, so it proves nothing here.
    const saved = mapSaveArrived(page);
    await page.getByRole("button", { name: "Fit to data", exact: true }).click();
    await saved;
    await expect.poll(async () => {
      const ink = await drawnBox(page, INK);
      if (ink.count < 6) return { count: ink.count };
      return { count: 6, dx: Math.round((ink.x + ink.right) / 2 - (window_.x + window_.width / 2)), dy: Math.round((ink.y + ink.bottom) / 2 - (window_.y + window_.height / 2)) };
    }, { timeout: 15_000 }).toEqual({ count: 6, dx: expect.any(Number), dy: expect.any(Number) });
    const ink = await drawnBox(page, INK);
    expect(Math.abs((ink.x + ink.right) / 2 - (window_.x + window_.width / 2)), "the data's centre sits at the visible window's centre").toBeLessThanOrEqual(3);
    expect(Math.abs((ink.y + ink.bottom) / 2 - (window_.y + window_.height / 2))).toBeLessThanOrEqual(3);
    expect(ink.right, "the drawn data stays inside the visible window").toBeLessThanOrEqual(right(window_));
    // Close: one more commit; replace Tools for the pane: one more.
    await door(page).click();
    await paneClosed(page);
    await settled(page, WINDOW);
    expect(await commits(page)).toBe(2);
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toBeVisible();
    await settled(page, WINDOW);
    expect(await commits(page)).toBe(3);
    await door(page).click();
    await paneOpen(page);
    await settled(page, WINDOW);
    expect(await commits(page)).toBe(4);
  });
});

test.describe("4: the resize swap", () => {
  const openBoth = async (page: Page, order: ["tools", "assistant"] | ["assistant", "tools"]) => {
    for (const helper of order) {
      if (helper === "tools") { await page.locator(TOOLS_DOOR).click(); await expect(drawerVisible(page)).toBeVisible(); }
      else { await door(page).click(); await paneOpen(page); }
    }
    await settled(page, WINDOW);
  };
  test("narrowing keeps the later-opened helper in both orders and widening returns the hidden one; the crossing frame shows the final geometry with no transition", async ({ page }) => {
    const { mapId } = await seedMap(page);
    for (const order of [["tools", "assistant"], ["assistant", "tools"]] as ["tools", "assistant"][] | ["assistant", "tools"][]) {
      await openBuilder(page, mapId, 1920);
      await ensureClosed(page);
      await openBoth(page, order);
      const later = order[1];
      await armFrames(page);
      await page.setViewportSize({ width: 1440, height: H });
      await page.waitForTimeout(400);
      const sampled = await frames(page);
      const at1440 = sampled.filter((f) => f.width === 1440);
      expect(at1440.length).toBeGreaterThan(3);
      const finalLeft = later === "tools" ? 438 + HELPER : 438;
      const finalRight = later === "assistant" ? 1440 - GUTTER - HELPER : 1440 - GUTTER;
      const first = at1440[0];
      expect(Math.round(first.left), `first frame at 1440 (${order.join(">")}): ${JSON.stringify(first)}`).toBe(finalLeft);
      expect(Math.round(first.right)).toBe(finalRight);
      expect(first.transition, "no transition runs on the crossing frame").toBe("0s");
      for (const f of at1440) { expect(Math.round(f.left)).toBe(finalLeft); expect(Math.round(f.right)).toBe(finalRight); }
      if (later === "assistant") { await paneOpen(page); await expect(drawerVisible(page)).toHaveCount(0); await expect(drawer(page)).toHaveAttribute("data-hidden", "true"); }
      else { await paneClosed(page); await expect(drawerVisible(page)).toBeVisible(); }
      await page.setViewportSize({ width: 1920, height: H });
      await paneOpen(page);
      await expect(drawerVisible(page)).toBeVisible();
      const both = await settled(page, WINDOW);
      expect(Math.round(both.x)).toBe(438 + HELPER);
      expect(Math.round(right(both))).toBe(1920 - GUTTER - HELPER);
    }
  });

  test("a hand action at 1440 forgets the hidden helper; widening shows only what was open", async ({ page }) => {
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, 1920);
    await openBoth(page, ["assistant", "tools"]);
    await page.setViewportSize({ width: 1440, height: H });
    await expect(drawerVisible(page)).toBeVisible();
    await paneClosed(page);
    // A hand close of Tools: the hidden assistant is forgotten.
    await drawer(page).locator("[data-drawer-dismiss]").click();
    await expect(drawerVisible(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1920, height: H });
    await page.waitForTimeout(300);
    await paneClosed(page);
    await expect(drawerVisible(page)).toHaveCount(0);
    // A hand open of the assistant at 1440 replaces the visible Tools and forgets nothing else.
    await page.setViewportSize({ width: 1440, height: H });
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toBeVisible();
    await door(page).click();
    await paneOpen(page);
    await expect(drawerVisible(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1920, height: H });
    await page.waitForTimeout(300);
    await paneOpen(page);
    await expect(drawerVisible(page)).toHaveCount(0);
  });

  test("a typed drawer value and a transcript turn survive the hide, and focus inside the hiding helper lands on its door", async ({ page }) => {
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, 1920);
    // Tools first, with a value typed; the assistant later, with a turn.
    await page.locator(TOOLS_DOOR).click();
    await drawer(page).locator("[data-operation='buffer']").click();
    await drawer(page).locator("[data-param='distance']").fill("777");
    await door(page).click();
    await paneOpen(page);
    provider.replies.push({ text: "A turn that must survive the hide." });
    await pane(page).getByRole("textbox", { name: "Ask the assistant" }).fill("Say something durable");
    await pane(page).getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane(page).getByText("A turn that must survive the hide.", { exact: true })).toBeVisible();
    // Narrow: the assistant (later) stays, Tools hides with its value.
    await page.setViewportSize({ width: 1440, height: H });
    await expect(drawer(page)).toHaveAttribute("data-hidden", "true");
    await page.setViewportSize({ width: 1920, height: H });
    await expect(drawerVisible(page)).toBeVisible();
    await expect(drawer(page).locator("[data-param='distance']")).toHaveValue("777");
    // Now Tools later: close it and open it again by hand, so it is the
    // later-opened; the assistant hides with its transcript, and focus
    // inside it moves to its door.
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toHaveCount(0);
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toBeVisible();
    await pane(page).getByRole("textbox", { name: "Ask the assistant" }).focus();
    await page.setViewportSize({ width: 1440, height: H });
    await paneClosed(page);
    await expect(door(page)).toBeFocused();
    await page.setViewportSize({ width: 1920, height: H });
    await paneOpen(page);
    await expect(pane(page).getByText("A turn that must survive the hide.", { exact: true })).toBeVisible();
  });

  test("4c bis: after a width hide, one press on the hidden helper's door replaces the visible one in one step and keeps the retained form", async ({ page }) => {
    // the Tools door read the drawer's hand
    // state, so with Tools hidden by the width the next press closed the
    // hidden drawer (discarding its form) instead of replacing the pane.
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, 1920);
    await ensureClosed(page);
    await page.locator(TOOLS_DOOR).click();
    await drawer(page).locator("[data-operation='buffer']").click();
    await drawer(page).locator("[data-param='distance']").fill("321");
    await door(page).click();
    await paneOpen(page);
    await page.setViewportSize({ width: 1440, height: H });
    await expect(drawer(page)).toHaveAttribute("data-hidden", "true");
    await paneOpen(page);
    await expect(page.locator(TOOLS_DOOR)).toHaveAttribute("aria-pressed", "false");
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toBeVisible();
    await paneClosed(page);
    await expect(drawer(page).locator("[data-param='distance']")).toHaveValue("321");
    await expect(page.locator(TOOLS_DOOR)).toHaveAttribute("aria-pressed", "true");
    // That press replaced the pane by hand, so the memory forgets it:
    // widening shows Tools alone. Then the mirror: the pane reopened by
    // hand, Tools made the later-opened, the pane hidden by the width, its
    // door opens it in one press.
    await page.setViewportSize({ width: 1920, height: H });
    await expect(drawerVisible(page)).toBeVisible();
    await paneClosed(page);
    await door(page).click();
    await paneOpen(page);
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toHaveCount(0);
    await page.locator(TOOLS_DOOR).click();
    await expect(drawerVisible(page)).toBeVisible();
    await paneOpen(page);
    await page.setViewportSize({ width: 1440, height: H });
    await paneClosed(page);
    await expect(door(page)).toHaveAttribute("aria-expanded", "false");
    await door(page).click();
    await paneOpen(page);
    await expect(drawerVisible(page)).toHaveCount(0);
  });

  test("a reload at 1440 opens neither helper, after a width hide and after a hand close alike; Tools is never restored", async ({ page }) => {
    // The pane opens closed on every page open, so neither a width hide nor a hand close before the
    // reload changes
    // what comes back: nothing, and the door opens it again.
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, 1920);
    await openBoth(page, ["assistant", "tools"]);
    await page.setViewportSize({ width: 1440, height: H });
    await paneClosed(page);
    await expect(drawerVisible(page)).toBeVisible();
    await page.reload();
    await page.waitForSelector(STAGE);
    await paneClosed(page);
    await expect(drawerVisible(page)).toHaveCount(0);
    // Opened by hand here, then closed by hand: the same nothing back.
    await door(page).click();
    await paneOpen(page);
    await door(page).click();
    await paneClosed(page);
    await page.reload();
    await page.waitForSelector(STAGE);
    await paneClosed(page);
    await expect(drawerVisible(page)).toHaveCount(0);
  });
});

test.describe("5: the right-edge tenants and the fullscreen map", () => {
  /** The three tenants on two seeds: a widget docks a top-right legend
   * into the rail, so the floating legend corner and the widget rail are
   * seeded on maps of their own, the credit on both. */
  const SEEDS = [
    { seed: { legend: true }, tenants: ['[data-corner="top-right"]', "[data-map-credit]"] },
    { seed: { widget: true }, tenants: ["[data-widget-rail]", "[data-map-credit]"] },
  ] as const;
  test("5a at 1440: docked, the legend corner, the widget rail and the credit lie inside the narrowed stage", async ({ page }) => {
    for (const { seed, tenants } of SEEDS) {
      const { mapId } = await seedMap(page, seed);
      await openBuilder(page, mapId, 1440);
      await ensureClosed(page);
      for (const t of tenants) await expect(page.locator(t).first()).toBeVisible();
      await door(page).click();
      await paneOpen(page);
      const stage = await settled(page, WINDOW);
      for (const t of tenants) {
        const b = await settled(page, t);
        expect(b.x, `${t} starts inside the stage`).toBeGreaterThanOrEqual(stage.x - 0.5);
        expect(right(b), `${t} ends inside the stage`).toBeLessThanOrEqual(right(stage) + 0.5);
      }
    }
  });
  test("5b at 1100: overlaying, the tenants are unmoved and the pane paints above them", async ({ page }) => {
    for (const { seed, tenants } of SEEDS) {
    const { mapId } = await seedMap(page, seed);
    await openBuilder(page, mapId, 1100);
    await ensureClosed(page);
    const TENANTS = tenants;
    const before = await Promise.all(TENANTS.map((t) => settled(page, t)));
    await door(page).click();
    await paneOpen(page);
    await page.waitForTimeout(400);
    for (const [i, t] of TENANTS.entries()) {
      const b = await box(page, t);
      expect(Math.round(b.x)).toBe(Math.round(before[i].x));
      expect(Math.round(b.y)).toBe(Math.round(before[i].y));
      const hit = await page.evaluate(({ selector }) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + Math.min(r.width / 2, 20), r.y + Math.min(r.height / 2, 12));
        return el?.closest("[data-assistant-pane]") !== null;
      }, { selector: t });
      expect(hit, `${t} is under the pane`).toBe(true);
    }
    }
  });
  test("in fullscreen with the pane open the visible map fills the viewport with no retained right clip", async ({ page }) => {
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, 1440);
    await door(page).click();
    await paneOpen(page);
    await settled(page, WINDOW);
    await page.getByRole("button", { name: "Fullscreen map", exact: true }).click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector("[data-map-layer]")!).clipPath)).toMatch(/^inset\(0px( 0px 0px 0px)?\)/);
    const card = await settled(page, WINDOW);
    expect(Math.round(card.x)).toBe(0);
    expect(Math.round(right(card))).toBe(1440);
    // Paint outside the former card, under the pane's side: the map layer itself.
    const under = await page.evaluate(() => document.elementFromPoint(1300, 450)?.closest("[data-map-layer], [data-assistant-pane]")?.getAttribute("data-assistant-pane") !== null);
    expect(under, "the pane floats over the map").toBe(true);
    await paneOpen(page);
    await page.getByRole("button", { name: "Exit fullscreen map", exact: true }).click();
    const back = await settled(page, WINDOW);
    expect(Math.round(right(back))).toBe(1440 - GUTTER - HELPER);
  });
});

test.describe("8: the builder's chips", () => {
  test("the chips name the map and the selected layer, change on selection with no message sent, and show no layer chip without a selection", async ({ page }) => {
    const { mapId, layerId, stations } = await seedMap(page);
    await openBuilder(page, mapId, 1440);
    await door(page).click();
    await paneOpen(page);
    await expect(pane(page).getByRole("textbox", { name: "Ask the assistant" })).toBeEnabled();
    const chips = pane(page).locator("[data-talking-about] [data-chip]");
    let messages = 0;
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/assistant/messages")) messages += 1; });
    // Nothing selected: the map alone, named as the API names it.
    const map = await (await page.request.get(`/api/maps/${mapId}`)).json() as { name: string };
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveText(new RegExp(`Map${map.name}`));
    // A layer selected: its name joins; deselected: it leaves. No message sent.
    await page.locator(`[data-layer-select="${layerId}"]`).click();
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toHaveText(new RegExp(`Layer${stations}`));
    await page.locator(`[data-layer-select="${layerId}"]`).click();
    await expect(chips).toHaveCount(1);
    expect(messages).toBe(0);
  });
});

test.describe("11: dismissal on the builder", () => {
  test("close control, door and Escape from inside close it with focus back on the door; clicks on the map, the rail, the inspector and Escape from outside leave it open", async ({ page }) => {
    const { mapId } = await seedMap(page);
    await openBuilder(page, mapId, 1440);
    await door(page).click();
    await paneOpen(page);
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
    // Outside pointers leave it open: the map canvas, the rail, the inspector.
    const stage = await settled(page, WINDOW);
    await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await paneOpen(page);
    const rail = await box(page, 'nav[aria-label="Product navigation"]');
    await page.mouse.click(rail.x + 27, rail.y + rail.height * 0.55);
    await paneOpen(page);
    await page.getByRole("tab", { name: "Basemap" }).click();
    await paneOpen(page);
    // Escape with focus outside the pane leaves it open.
    await page.getByRole("tab", { name: "Layers" }).focus();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await paneOpen(page);
  });
});
