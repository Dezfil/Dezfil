// The legend's order.
//
// Everything is measured from rendered legend blocks and the API's
// stored truth — never from component state. The contracts: while
// automatic, the legend reads the layer panel's top-to-bottom order
// and follows panel reorders; a Legend-tab move (keyboard here — the
// pointer road is the same emission) persists a manual arrangement
// the panel no longer moves, surviving reload and rendering the same
// on the published view; Reset order reveals only while manual and
// returns the follow; a manual move undoes and redoes.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  patchLayer,
  patchMap,
  publishMap,
  seedFile,
  trackConsole,
} from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const table = `ord_${runId}`;

const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

/** The on-map legend's titles, top to bottom. Ramp blocks name
 * themselves in the title row's first child; constant rows in their
 * own title span (class matching is case-sensitive, so "title" never
 * matches "constantTitle"). */
async function legendTitles(page: Page) {
  return page.locator('[data-map-legend] [class*="block"]').evaluateAll((blocks) =>
    blocks.map(
      (b) =>
        (
          (b.querySelector('[class*="constantTitle"]') ??
            b.querySelector('[class*="title"] > :first-child')) as
            | HTMLElement
            | null
        )?.textContent?.trim() ?? "",
    ),
  );
}

async function storedOrder(page: Page, mapId: string) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/maps/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    return ((await r.json()) as { legendOrder: string[] | null }).legendOrder;
  }, mapId);
}

/** Three constant layers over one table: stored bottom-up [A, B, C],
 * so the panel — and the automatic legend — read [C, B, A]. */
async function seedThree(page: Page) {
  await page.goto("/maps");
  await seedFile(
    page,
    `${table}.csv`,
    readFileSync(path.join(FIXTURES_DIR, "stations.csv")),
    "text/csv",
  );
  const mapId = await createMap(page, `order ${runId}`);
  const ids: Record<string, string> = {};
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    ids[name] = await addLayer(
      page,
      mapId,
      name,
      `SELECT * FROM ${table}`,
    );
  }
  return { mapId, ids };
}

/** Every block title's computed type and box, plus its card's box —
 * measured from the render, never from the classes that produce it. */
async function titleMetrics(page: Page) {
  return page.locator('[data-map-legend] [class*="block"]').evaluateAll((blocks) =>
    blocks.map((b) => {
      const el = (b.querySelector('[class*="constantTitle"]') ??
        b.querySelector('[class*="title"] > :first-child')) as HTMLElement;
      const cs = getComputedStyle(el);
      const card = el.closest('[data-map-legend]')!.getBoundingClientRect();
      // The text's own rendered line boxes: ranges over the TEXT NODES
      // see glyph lines only — an element range would also return the
      // edit button's atomic box and double-count one visual line.
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const rects: DOMRect[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width > 0 && r.height > 0) rects.push(r);
        }
      }
      const tops = new Set(rects.map((r) => Math.round(r.top)));
      return {
        text: el.textContent?.trim() ?? "",
        size: cs.fontSize,
        weight: cs.fontWeight,
        lines: tops.size,
        textRight: Math.max(...rects.map((r) => r.right)),
        cardRight: card.right,
      };
    }),
  );
}

/** dnd-kit mounts one assertive live region per sortable context; an
 * announcement assertion filters across them by text. */
const expectAnnounced = (page: Page, text: string) =>
  expect(
    page.locator('[id^="DndLiveRegion"]').filter({ hasText: text }),
  ).not.toHaveCount(0);

/** Pick the row up, settle a beat (the drag's rect measurements commit
 * an effect-cycle after the announcement — the suite's lesson), move
 * one down, drop. */
async function moveTopRowDown(page: Page, name: string) {
  const grip = page.getByRole("button", {
    name: `Reorder ${name} in the legend`,
  });
  await grip.focus();
  await page.keyboard.press("Space");
  await expectAnnounced(page, `${name} picked up`);
  await page.waitForTimeout(250);
  await page.keyboard.press("ArrowDown");
  await expectAnnounced(page, `${name} over position 2`);
  await page.keyboard.press("Space");
  await expectAnnounced(page, `${name} dropped at position 2`);
}

// 40 characters, no break opportunity anywhere.
const LONG_NAME = "berlin_restaurants_latest_spatial_join_x";

test("one title scale, and a long unbroken name stays inside the card — builder, published, render road", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const { mapId, ids } = await seedThree(page);
  // A mixed card: Beta becomes a ramp block, Alpha takes the long name.
  await patchLayer(page, ids.Beta, {
    style: {
      fill: {
        type: "quantile",
        attribute: "riders",
        palette: "global_warming",
        breaks: [400],
        colors: [
          { r: 13, g: 125, b: 92, a: 0.9 },
          { r: 224, g: 154, b: 66, a: 0.9 },
        ],
      },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 6,
      opacity: 1,
    },
  });
  await patchLayer(page, ids.Alpha, { name: LONG_NAME });
  const token = await publishMap(page, mapId);

  const check = async () => {
    await expect
      .poll(async () => (await titleMetrics(page)).length)
      .toBe(3);
    const metrics = await titleMetrics(page);
    // One scale: every title, ramp and constant alike.
    const sizes = new Set(metrics.map((m) => m.size));
    const weights = new Set(metrics.map((m) => m.weight));
    expect(sizes.size, `title sizes: ${[...sizes]}`).toBe(1);
    expect(weights.size, `title weights: ${[...weights]}`).toBe(1);
    // Containment: the long name wraps — provably more than one line —
    // and never crosses the card's edge. Height compares against a
    // one-line sibling in the same card, so the render road's legend
    // scale cancels out of the measurement.
    const long = metrics.find((m) => m.text === LONG_NAME);
    const short = metrics.find((m) => m.text === "Gamma");
    expect(long, "the long-named row renders").toBeTruthy();
    expect(short, "the one-line row renders").toBeTruthy();
    expect(short!.lines, "the short name sits on one line").toBe(1);
    expect(
      long!.lines,
      "the name wraps to more than one line",
    ).toBeGreaterThanOrEqual(2);
    expect(
      long!.textRight,
      "no glyph crosses the card's edge",
    ).toBeLessThanOrEqual(long!.cardRight + 0.5);
  };

  await page.goto(`/maps/${mapId}`);
  await check();
  await page.goto(`/v/${token}`);
  await check();
  // The server road's page — the same composition chromium screenshots,
  // driven with the template the server suite uses.
  await page.addInitScript((d) => {
    (
      window as { __DEZFIL_EXPORT_DEFINITION__?: unknown }
    ).__DEZFIL_EXPORT_DEFINITION__ = d;
  }, {
    viewport: { lng: 13.38, lat: 52.5, zoom: 9, pitch: 0, bearing: 0 },
    size: { width: 960, height: 540 },
    legend: { visible: true, corner: "bottom-left", size: "m" },
    widgets: [],
    title: { text: "Order render", size: "m" },
    appearance: "light",
    overlayScale: 2,
  });
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(`/render/${mapId}`);
  await expect(page.locator("[data-export-root]")).toBeVisible({
    timeout: 30_000,
  });
  await check();

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("while automatic, the legend mirrors the panel and follows its reorders", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const { mapId, ids } = await seedThree(page);
  await page.goto(`/maps/${mapId}`);

  await expect
    .poll(() => legendTitles(page))
    .toEqual(["Gamma", "Beta", "Alpha"]);

  // A panel reorder (the API road — the panel's drag emits exactly
  // this) moves the legend identically while the order is automatic.
  await patchMap(page, mapId, {
    layerOrder: [ids.Gamma, ids.Beta, ids.Alpha],
  });
  await page.reload();
  await expect
    .poll(() => legendTitles(page))
    .toEqual(["Alpha", "Beta", "Gamma"]);
  expect(await storedOrder(page, mapId)).toBeNull();

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("a keyboard move persists a manual order the panel no longer moves", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const { mapId, ids } = await seedThree(page);
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("tab", { name: "Legend" }).click();

  // Pick up the top row (Gamma) and drop it one slot down.
  await moveTopRowDown(page, "Gamma");

  const manual = [ids.Beta, ids.Gamma, ids.Alpha];
  await expect.poll(() => storedOrder(page, mapId)).toEqual(manual);
  await expect
    .poll(() => legendTitles(page))
    .toEqual(["Beta", "Gamma", "Alpha"]);

  // The panel keeps reordering drawing — the legend no longer follows.
  await patchMap(page, mapId, {
    layerOrder: [ids.Gamma, ids.Beta, ids.Alpha],
  });
  await page.reload();
  await expect
    .poll(() => legendTitles(page))
    .toEqual(["Beta", "Gamma", "Alpha"]);
  expect(await storedOrder(page, mapId)).toEqual(manual);

  // The published view renders the stored arrangement (its legend has
  // no builder corner slot — the page is the scope).
  const token = await publishMap(page, mapId);
  await page.goto(`/v/${token}`);
  await expect
    .poll(() => legendTitles(page))
    .toEqual(["Beta", "Gamma", "Alpha"]);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("reset reveals only while manual, returns the follow, and the move undoes", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const { mapId, ids } = await seedThree(page);
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("tab", { name: "Legend" }).click();

  const reset = page.getByRole("button", { name: "Reset order" });
  await expect(reset).toHaveCount(0);

  await moveTopRowDown(page, "Gamma");
  await expect
    .poll(() => storedOrder(page, mapId))
    .toEqual([ids.Beta, ids.Gamma, ids.Alpha]);
  await expect(reset).toBeVisible();

  // One undo takes the move back; one redo restores it.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => storedOrder(page, mapId)).toBeNull();
  await expect(reset).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect
    .poll(() => storedOrder(page, mapId))
    .toEqual([ids.Beta, ids.Gamma, ids.Alpha]);

  // Reset returns the map to the follow — the panel moves it again.
  await reset.click();
  await expect.poll(() => storedOrder(page, mapId)).toBeNull();
  await expect(reset).toHaveCount(0);
  await expect
    .poll(() => legendTitles(page))
    .toEqual(["Gamma", "Beta", "Alpha"]);

  // A post-reset undo returns the manual order: each drop and each
  // reset is its own history gesture — ungrouped, the two
  // writes above would coalesce into one null→null step and this undo
  // would restore nothing.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(() => storedOrder(page, mapId))
    .toEqual([ids.Beta, ids.Gamma, ids.Alpha]);
  await expect(reset).toBeVisible();

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
