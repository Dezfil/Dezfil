// One tooltip voice: the styled bubble on the ruled surfaces, on hover
// and focus, edge-safe, native titles gone, visible wording
// suppressing, shortcuts carried.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { addLayer, createMap, publishMap, seedFile } from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `voice_${runId}`;

const WIDE = { width: 1440, height: 900 };
const BUBBLE = "[data-hint-bubble]";

async function seedMap(page: Page): Promise<string> {
  await page.goto("/maps");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `voice ${runId}`);
  await addLayer(page, mapId, stations, `SELECT * FROM ${stations}`);
  return mapId;
}

async function bubbleOnScreen(page: Page) {
  const box = (await page.locator(BUBBLE).boundingBox())!;
  const vw = page.viewportSize()!.width;
  const vh = page.viewportSize()!.height;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vw + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(vh + 1);
  return box;
}

test.use({ viewport: WIDE });

test("the ruled surfaces answer with the bubble — hover, focus, edges, shortcuts, no titles", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector("[data-map-layer]");

  // Map toolbar, left edge: hover shows the bubble fully on screen; the
  // control carries no native title.
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await zoomIn.hover();
  await expect(page.locator(BUBBLE)).toHaveText("Zoom in");
  await bubbleOnScreen(page);
  expect(await zoomIn.getAttribute("title")).toBeNull();

  // Keyboard focus shows it too — real keyboard focus, which is what
  // arms it (click-parked focus deliberately does not).
  await page.mouse.move(700, 400);
  await expect(page.locator(BUBBLE)).toHaveCount(0);
  await zoomIn.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(BUBBLE)).toHaveText("Zoom in");

  // Undo carries its shortcut.
  await page.getByRole("button", { name: "Undo" }).hover();
  await expect(page.locator(BUBBLE)).toHaveText(/^Undo\b.*\(⌘Z \/ Ctrl\+Z\)$/);

  // Top bar right edge: the theme toggle's bubble stays on screen.
  await page
    .getByRole("button", { name: "Switch between dark and light theme" })
    .hover();
  await expect(page.locator(BUBBLE)).toHaveText("Switch theme");
  await bubbleOnScreen(page);

  // Responsive rule: Tools shows its word at 1440 — no bubble; below the
  // word's breakpoint the bubble arms.
  await page.locator("[data-tools-control]").hover();
  await page.waitForTimeout(400);
  await expect(page.locator(BUBBLE)).toHaveCount(0);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.locator("[data-tools-control]").hover();
  await expect(page.locator(BUBBLE)).toHaveText("Tools");
  await page.setViewportSize(WIDE);

  // Status copy button: visible value, hint still ruled in.
  await page
    .locator('[data-status-bar] [data-hint="Copy coordinates"]')
    .hover();
  await expect(page.locator(BUBBLE)).toHaveText("Copy coordinates");

  // Legend affordance (bottom-left): the bubble flips to stay on screen.
  const legendTitle = page
    .locator("[data-corner] [class*='constantRow']")
    .getByRole("button")
    .first();
  await legendTitle.hover();
  await expect(page.locator(BUBBLE)).toHaveText("Click to edit");
  await bubbleOnScreen(page);
});

test("card actions at the viewport edge escape their clipped cards", async ({
  page,
}) => {
  await seedMap(page);
  await page.goto("/data");
  // Residue-proof: the view preference is workspace-global and the page
  // carries every table the suites before this one left, so ask for the
  // grid and narrow it to this run's table before reading its cards.
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await page.getByLabel("Search data").fill(stations);
  const grid = page.locator('[class*="dataGrid"]');
  await expect(grid).toBeVisible();

  // The rightmost card's delete action: the bubble renders on screen,
  // outside the card's own clipped box.
  const cards = grid.locator("article");
  const count = await cards.count();
  let rightmost = cards.first();
  let maxX = -1;
  for (let i = 0; i < count; i += 1) {
    const box = await cards.nth(i).boundingBox();
    if (box && box.x > maxX) {
      maxX = box.x;
      rightmost = cards.nth(i);
    }
  }
  await rightmost.hover();
  const del = rightmost.locator("[data-hint]").last();
  await del.hover();
  await expect(page.locator(BUBBLE)).toBeVisible();
  const bubble = await bubbleOnScreen(page);
  const cardBox = (await rightmost.boundingBox())!;
  // Escaped the clip: some part of the bubble lies outside the card.
  const inside =
    bubble.x >= cardBox.x &&
    bubble.x + bubble.width <= cardBox.x + cardBox.width &&
    bubble.y >= cardBox.y &&
    bubble.y + bubble.height <= cardBox.y + cardBox.height;
  expect(inside).toBe(false);
  expect(await del.getAttribute("title")).toBeNull();
});

test("the published toolbar shares the treatment", async ({ page }) => {
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  const token = await publishMap(page, mapId);
  await page.goto(`/v/${token}`);
  await page.getByRole("button", { name: "Zoom in" }).hover();
  await expect(page.locator(BUBBLE)).toHaveText("Zoom in");
  await bubbleOnScreen(page);
});

test("disabled reasons show through the bubble and live in the tree", async ({
  page,
}) => {
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /Image/ }).click();
  const dialog = page.getByRole("dialog", { name: "Export image" });
  await expect(dialog).toBeVisible();

  // The credit picker's blocked corner (legend bottom-left by default):
  // its reason hovers up through the layer, and the same words sit in
  // the control's accessible description.
  const blocked = dialog
    .getByRole("radiogroup", { name: "Credit corner" })
    .getByRole("radio", { name: "Bottom left", exact: true });
  await expect(blocked).toBeDisabled();
  await page.mouse.move(400, 400);
  await blocked.hover({ force: true });
  await expect(page.locator(BUBBLE)).toHaveText("The legend is in this corner");
  // Painted, not merely present: the smoke caught the bubble rendering
  // BEHIND the dialog scrim — DOM-text assertions cannot see a lost
  // stacking fight, so hit-test the bubble's own centre.
  const topmost = await page.evaluate(() => {
    const bubble = document.querySelector<HTMLElement>("[data-hint-bubble]");
    if (!bubble) return "no-bubble";
    // The bubble is pointer-transparent by design; lift that for the
    // duration of the hit-test so paint order is what's measured.
    bubble.style.pointerEvents = "auto";
    const r = bubble.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    bubble.style.pointerEvents = "";
    return hit === bubble || bubble.contains(hit) ? "bubble" : hit?.className;
  });
  expect(topmost).toBe("bubble");
  const described = await blocked.evaluate((el) => {
    const id = el.getAttribute("aria-describedby");
    return id ? document.getElementById(id)?.textContent : null;
  });
  expect(described).toBe("The legend is in this corner");
  expect(await blocked.getAttribute("title")).toBeNull();
});

// The layer's pointer hit-test runs on the next animation frame. A frame
// delayed past a keyboard focus (a busy first render did it, 1 in 5
// whole-set runs) resolved the old pointer position over the map and
// disarmed the bubble the keyboard had just earned. The newest input
// keeps the bubble; this holds the frame so the order is certain.
test("a pointer hit-test still queued when keyboard focus lands does not take the bubble", async ({
  page,
}) => {
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector("[data-map-layer]");
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await zoomIn.hover();
  await expect(page.locator(BUBBLE)).toHaveText("Zoom in");

  await page.evaluate(() => {
    const w = window as unknown as {
      __held: FrameRequestCallback[];
      __raf: typeof requestAnimationFrame;
    };
    w.__held = [];
    w.__raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      w.__held.push(cb);
      return w.__held.length;
    };
  });
  // Leaving the control disarms at once; the hit-test waits in the held frame.
  await page.mouse.move(700, 400);
  await expect(page.locator(BUBBLE)).toHaveCount(0);
  await zoomIn.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  // Release the frame: the stale hit-test resolves to the map.
  await page.evaluate(() => {
    const w = window as unknown as {
      __held: FrameRequestCallback[];
      __raf: typeof requestAnimationFrame;
    };
    window.requestAnimationFrame = w.__raf;
    const held = w.__held;
    w.__held = [];
    for (const cb of held) cb(performance.now());
  });
  await expect(page.locator(BUBBLE)).toHaveText("Zoom in");
  expect(await zoomIn.evaluate((el) => el === document.activeElement)).toBe(
    true,
  );
});

// The second way: a map settling late under a resting pointer (the
// whole-set run's contended render) changes the element under it, and
// the engine re-synthesizes the hover boundary events at the same
// point. Those are not an approach; a keyboard bubble keeps its place.
test("a DOM change under a resting pointer does not take the bubble keyboard focus earned", async ({
  page,
}) => {
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector("[data-map-layer]");
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await zoomIn.hover();
  await expect(page.locator(BUBBLE)).toHaveText("Zoom in");
  await page.mouse.move(700, 400);
  await expect(page.locator(BUBBLE)).toHaveCount(0);
  await zoomIn.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(BUBBLE)).toHaveText("Zoom in");
  // Something lands under the pointer without it moving.
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.setAttribute("data-late-arrival", "");
    Object.assign(d.style, {
      position: "fixed",
      left: "650px",
      top: "350px",
      width: "100px",
      height: "100px",
      zIndex: "5",
    });
    document.body.appendChild(d);
  });
  await page.waitForTimeout(600);
  await expect(page.locator(BUBBLE)).toHaveText("Zoom in");
  expect(await zoomIn.evaluate((el) => el === document.activeElement)).toBe(
    true,
  );
});
