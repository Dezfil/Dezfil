// The mono diet's rendered truth: the coordinate readouts converge on
// the UI face with tabular numerals, the published view's chrome
// inherits the UI face, the two surviving code/data faces answer under
// their own roots — DM Mono in the workspace, IBM Plex Mono published —
// and the wider UI face stays contained on the constrained surfaces the
// diet demoted. The source-side boundary (which rules may carry mono at
// all) is the mono-boundary unit ratchet's; this suite measures
// computed styles and boxes.
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
const stations = `faces_${runId}`;

const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

const MONO = /SF Mono|Cascadia|ui-monospace|monospace|DM.?Mono|Plex/i;

async function seedMap(page: Page): Promise<string> {
  await page.goto("/maps");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `faces ${runId}`);
  const layerId = await addLayer(
    page,
    mapId,
    stations,
    `SELECT * FROM ${stations}`,
  );
  // A classed style so the Legend tab renders per-entry label inputs —
  // the surface whose UA control face the diet demotes explicitly.
  await patchLayer(page, layerId, {
    style: {
      fill: {
        type: "quantile",
        attribute: "riders",
        palette: "global_warming",
        breaks: [12000],
        colors: [
          { r: 26, g: 93, b: 74, a: 0.9 },
          { r: 233, g: 179, b: 91, a: 0.9 },
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
  // The two widget kinds whose demoted chrome is width-constrained: a
  // formula's caption-and-unit sub-line, and a histogram's range line.
  await patchMap(page, mapId, {
    widgets: [
      {
        id: "w-formula",
        type: "formula",
        layerId,
        title: "Riders",
        field: "riders",
        agg: "sum",
        aggField: null,
        unit: "riders per weekday",
        note: "A caption long enough to press against the card's width.",
        format: null,
        visible: true,
      },
      {
        id: "w-hist",
        type: "histogram",
        layerId,
        title: "Spread",
        field: "riders",
        agg: "count",
        aggField: null,
        unit: null,
        note: null,
        format: null,
        visible: true,
      },
    ],
  });
  return mapId;
}

test("readouts converge, the two data faces answer, the UI face stays contained", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);

  // ---- The workspace code/data face is DM Mono: the
  // dataset detail's identifier heading. ----
  await page.goto(`/tables/${stations}`);
  const tableTitle = page.locator('[class*="title"] h1').first();
  await expect(tableTitle).toBeVisible();
  expect(
    await tableTitle.evaluate((el) => getComputedStyle(el).fontFamily),
  ).toMatch(/DM.?Mono/i);

  // ---- Builder: the status bar's coordinate readout,
  // and containment on the demoted widget chrome and layer meta. ----
  await page.goto(`/maps/${mapId}`);
  await expect(page.getByText("6 features").first()).toBeVisible({
    timeout: 30_000,
  });
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const statusVal = page
    .locator('[data-status-bar] [class*="val"]')
    .first();
  await expect(statusVal).toBeVisible();
  const statusStyle = await statusVal.evaluate((el) => ({
    font: getComputedStyle(el).fontFamily,
    numeric: getComputedStyle(el).fontVariantNumeric,
  }));
  expect(MONO.test(statusStyle.font)).toBe(false);
  expect(statusStyle.numeric).toContain("tabular-nums");

  // A brush on the histogram makes its range readout appear AND
  // filters the formula off its baseline, so its filtered-from
  // sub-line appears — the two demoted lines a resting fixture never
  // shows (a selector matching nothing is not a check).
  const brushStart = page.getByRole("slider", {
    name: "Spread range start",
  });
  await expect(brushStart).toBeVisible();
  await brushStart.focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowRight");
  await expect(
    page.locator('[data-widget-rail] [class*="range"]').first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-widget-rail] [class*="sub"]').first(),
  ).toBeVisible();

  const constrained = [
    '[data-widget-rail] [class*="caption"]',
    '[data-widget-rail] [class*="sub"]',
    '[data-widget-rail] [class*="range"]',
    '[class*="LayerList"][class*="meta"]',
  ];
  for (const sel of constrained) {
    const els = page.locator(sel);
    const n = await els.count();
    for (let i = 0; i < n; i += 1) {
      const overflow = await els
        .nth(i)
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, `${sel} [${i}] overflows its box`).toBeLessThanOrEqual(
        1,
      );
    }
  }
  // The demoted surfaces are actually on screen (the loop above cannot
  // pass by matching nothing): the formula caption and the layer meta
  // line; the range and sub lines were staged by the brush above.
  await expect(
    page.locator('[data-widget-rail] [class*="caption"]').first(),
  ).toBeVisible();
  await expect(
    page.locator('[class*="LayerList"][class*="meta"]').first(),
  ).toBeVisible();

  // The UA-face escapes the source ratchet cannot see: a
  // bare <input> takes the browser's control face and <kbd> stays
  // UA-monospace unless demoted explicitly — measure the Legend tab's
  // entry input rendered.
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Legend" })
    .click();
  const entryInput = page.locator('input[class*="entryInput"]').first();
  await expect(entryInput).toBeVisible();
  expect(
    MONO.test(
      await entryInput.evaluate((el) => getComputedStyle(el).fontFamily),
    ),
  ).toBe(false);

  // ---- Published: the cursor readout converges, the
  // chrome inherits the UI face, and the
  // published code/data token answers as Plex. ----
  const token = await publishMap(page, mapId);
  await page.goto(`/v/${token}`);
  const pubCanvas = page.locator("canvas").first();
  await expect(pubCanvas).toBeVisible({ timeout: 30_000 });
  const pubBox = (await pubCanvas.boundingBox())!;
  await page.mouse.move(
    pubBox.x + pubBox.width / 2,
    pubBox.y + pubBox.height / 2,
  );
  const readout = page.getByTitle("Copy coordinates");
  await expect(readout).toBeVisible();
  const readoutStyle = await readout.evaluate((el) => ({
    font: getComputedStyle(el).fontFamily,
    numeric: getComputedStyle(el).fontVariantNumeric,
  }));
  expect(MONO.test(readoutStyle.font)).toBe(false);
  expect(readoutStyle.numeric).toContain("tabular-nums");

  const published = await page.evaluate(() => {
    const root = document.querySelector("[data-published-view]")!;
    // The chrome inherits the root's face; the demoted states
    // (preparing prose, Retry, alerts) carry no face rule of their own,
    // so this inheritance IS their computed face.
    const rootFont = getComputedStyle(root).fontFamily;
    // The published code/data token, asked directly where the kept
    // surfaces (popup values, error details) resolve it.
    const probe = document.createElement("span");
    probe.style.fontFamily = "var(--font-mono)";
    root.appendChild(probe);
    const monoFont = getComputedStyle(probe).fontFamily;
    probe.remove();
    // Absence, rendered: the undefined token no longer exists anywhere
    // as a reference, so nothing resolves through it.
    const monoVar = getComputedStyle(root).getPropertyValue("--mono");
    return { rootFont, monoFont, monoVar };
  });
  expect(MONO.test(published.rootFont)).toBe(false);
  expect(published.monoFont).toMatch(/Plex/i);
  expect(published.monoVar).toBe("");

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("gallery chip counts hold their boxes in the UI face", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  await page.goto("/maps");
  // The search shortcut <kbd> reads the UI face — the UA stylesheet
  // would keep it monospace without the explicit demotion.
  const kbd = page.locator('[class*="search"] kbd').first();
  await expect(kbd).toBeVisible();
  expect(
    MONO.test(await kbd.evaluate((el) => getComputedStyle(el).fontFamily)),
  ).toBe(false);
  const chips = page.locator('[class*="chipCount"]');
  await expect(chips.first()).toBeVisible();
  const n = await chips.count();
  for (let i = 0; i < n; i += 1) {
    const style = await chips.nth(i).evaluate((el) => ({
      overflow: el.scrollWidth - el.clientWidth,
      font: getComputedStyle(el).fontFamily,
    }));
    expect(style.overflow).toBeLessThanOrEqual(1);
    expect(MONO.test(style.font)).toBe(false);
  }
  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
