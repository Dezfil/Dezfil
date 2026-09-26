// Legend fidelity: the deck's compact rhythm, the quiet attribute
// label, full in-token value wrap inside the width rule, and one
// typography — the UI face on every surface gate ruling retired the
// legend's system mono (interactive surfaces included, not just
// exports). Everything is measured from rendered boxes and computed
// styles, never from the classes that produce them; the client road is
// judged from the downloaded PNG's own ink, because it rasterizes the
// legend apart from its export-frame ancestor.
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
  seedCsv,
  trackConsole,
} from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const table = `fid_${runId}`;

const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

/** One unbroken token per value kind, longer than the card's cap in
 * EITHER face — the wrap fixture the spec names (80 glyphs: ~528px in
 * the ruled system mono at 11px, ~225px in the UI face; the cap line
 * is ~190px). */
const LONG = {
  entries: "i".repeat(80),
  density: "w".repeat(80),
  size: "m".repeat(80),
};

/** The PNG face discriminator: short enough to stay on ONE line in
 * both faces, wide apart in width — 18 i's run ~119 layout px in the
 * system mono and ~50px in the UI face. */
const DISCRIMINATOR = "i".repeat(18);

/** The classed layer's first swatch colour — kept off the map by the
 * export viewport (open ocean), so in the PNG it anchors the card. */
const SWATCH = { r: 26, g: 93, b: 74 };

const MONO = /SF Mono|Cascadia|ui-monospace|monospace/i;

async function seedMap(page: Page) {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, table, csv);
  const mapId = await createMap(page, `fidelity ${runId}`);

  // Three layers, one per entry-value kind (stored bottom-up, order
  // irrelevant here). Classy: quantile fill → discrete entries, its
  // attribute line hidden so the PNG's muted ink is values alone.
  const classy = await addLayer(
    page,
    mapId,
    "classy",
    `SELECT * FROM "${table}"`,
  );
  await patchLayer(page, classy, {
    style: {
      fill: {
        type: "quantile",
        attribute: "riders",
        palette: "global_warming",
        breaks: [8000, 16000],
        colors: [
          { r: SWATCH.r, g: SWATCH.g, b: SWATCH.b, a: 0.9 },
          { r: 233, g: 179, b: 91, a: 0.9 },
          { r: 194, g: 46, b: 24, a: 0.9 },
        ],
      },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 3,
      opacity: 1,
    },
    legendLabels: [LONG.entries, null, null],
    legendAttrs: { fill: null },
  });

  // Heaty: heatmap → the density row. Its one label slot takes a long
  // token too.
  const heaty = await addLayer(
    page,
    mapId,
    "heaty",
    `SELECT * FROM "${table}"`,
  );
  await patchLayer(page, heaty, {
    viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: null },
    legendLabels: [LONG.density],
  });

  // Sizy: a data-driven radius → the size-range row, and the block that
  // keeps a visible attribute line for the quiet-attr check.
  const sizy = await addLayer(page, mapId, "sizy", `SELECT * FROM "${table}"`);
  await patchLayer(page, sizy, {
    style: {
      fill: { type: "constant", color: { r: 90, g: 90, b: 90, a: 0.9 } },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 3,
      pointRadiusBy: {
        attribute: "riders",
        domain: [0, 24000],
        range: [3, 14],
      },
      opacity: 1,
    },
    legendLabels: [LONG.size],
  });

  return { mapId, layers: { classy, heaty, sizy } };
}

type Root = Page | ReturnType<Page["locator"]>;

/** Every long-token label's box and line count, plus its card's box —
 * the wrap-and-containment read used on each DOM surface. */
async function labelBoxes(root: Root, tokens: string[]) {
  return root
    .locator('[data-map-legend] [class*="label"]')
    .evaluateAll((labels, toks) => {
      const card = labels[0]
        ? (labels[0].closest("[data-map-legend]") as HTMLElement | null)
        : null;
      // Rects are post-transform (the export composition scales its
      // stage); the width RULE is asserted in layout pixels.
      const cardBox = card
        ? {
            ...card.getBoundingClientRect().toJSON(),
            layoutWidth: card.offsetWidth,
          }
        : null;
      const reads = labels
        .filter((l) => toks.some((t) => l.textContent?.includes(t)))
        .map((l) => {
          const el = l as HTMLElement;
          // Glyph lines come from TEXT-NODE ranges only — an element
          // range would also return the edit button's atomic box and
          // double-count a visual line.
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const rects: DOMRect[] = [];
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(n);
            for (const r of range.getClientRects()) {
              if (r.width > 0 && r.height > 0) rects.push(r);
            }
          }
          const lines = new Set(rects.map((r) => Math.round(r.top))).size;
          return {
            lines,
            right: Math.max(...rects.map((r) => r.right)),
            scrollOverflow: el.scrollWidth - el.clientWidth,
            font: getComputedStyle(el).fontFamily,
            lineHeight: parseFloat(getComputedStyle(el).lineHeight),
          };
        });
      const ramp = labels[0]
        ?.closest("[data-map-legend]")
        ?.querySelector('[class*="heatRamp"]');
      const rampWidth = ramp ? ramp.getBoundingClientRect().width : null;
      return { cardBox, reads, rampWidth };
    }, tokens);
}

/** The three wrap/containment/typography assertions every DOM surface
 * shares; `mono` says which face the surface must render. */
async function checkSurface(root: Root, mono: boolean) {
  await expect
    .poll(
      async () => (await labelBoxes(root, Object.values(LONG))).reads.length,
      {
        timeout: 30_000,
      },
    )
    .toBe(3);
  const { cardBox, reads, rampWidth } = await labelBoxes(
    root,
    Object.values(LONG),
  );
  expect(cardBox).not.toBeNull();
  // The width rule holds: hug, floor 180, cap 240 (a whisker for the
  // border box).
  expect(cardBox!.layoutWidth).toBeGreaterThanOrEqual(179);
  expect(cardBox!.layoutWidth).toBeLessThanOrEqual(242);
  // The density ramp never collapses under a long label (same
  // transform space as the card, so the ratio is scale-free).
  expect(rampWidth, "the heat ramp is rendered").not.toBeNull();
  expect(rampWidth! / cardBox!.width).toBeGreaterThanOrEqual(0.25);
  for (const read of reads) {
    // Wrapped in full, in-token, never ellipsized, never outside.
    expect(
      read.lines,
      "a long value wraps to more than one line",
    ).toBeGreaterThanOrEqual(2);
    // The edit affordance bleeds 3px past the label's box by design
    // (padding/negative-margin pair); glyph containment is held by the
    // rect check below, so only real clipping past that bleed counts.
    expect(read.scrollOverflow, "no value is clipped").toBeLessThanOrEqual(4);
    expect(read.right, "no glyph crosses the card's edge").toBeLessThanOrEqual(
      cardBox!.right + 0.5,
    );
    // The surface's face, and the deck's compact line box (11px × 1.2).
    expect(MONO.test(read.font)).toBe(mono);
    expect(read.lineHeight).toBeGreaterThanOrEqual(12.5);
    expect(read.lineHeight).toBeLessThanOrEqual(14);
  }
}

test("values wrap, sit compact, and read the UI face on the interactive surfaces", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  const { mapId } = await seedMap(page);

  await page.goto(`/maps/${mapId}`);
  await checkSurface(page, false);

  // The compact rhythm, measured between the classed block's two
  // single-line entries (the first entry holds the wrap fixture).
  const pitch = await page
    .locator('[data-map-legend] li[class*="entry"]')
    .evaluateAll((entries) => {
      const tops = entries.slice(-2).map((e) => e.getBoundingClientRect().top);
      return tops[1] - tops[0];
    });
  expect(pitch, "entry pitch matches the deck (17.2px)").toBeGreaterThanOrEqual(
    16,
  );
  expect(pitch).toBeLessThanOrEqual(18.5);

  // The attribute label reads quiet — regular weight, not the title's
  // semibold (sizy's block keeps its attribute line).
  const attrWeight = await page
    .locator('[data-map-legend] [class*="attr"]')
    .first()
    .evaluate((el) => getComputedStyle(el).fontWeight);
  expect(attrWeight).toBe("400");

  // Editing containment: opening the long value's editor keeps the
  // field inside the card.
  await page
    .locator('[data-map-legend] [class*="label"] [class*="editable"]')
    .filter({ hasText: LONG.entries })
    .click();
  const editor = page.locator('[data-map-legend] input[class*="labelInput"]');
  await expect(editor).toBeVisible();
  const contained = await editor.evaluate((el) => {
    const card = el.closest("[data-map-legend]")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return box.right <= card.right + 0.5 && box.left >= card.left - 0.5;
  });
  expect(contained, "the value editor stays inside the card").toBe(true);
  await page.keyboard.press("Escape");

  // And from the OTHER fitted state: a card resting short, a long
  // draft typed in — the input clamps to the card instead of riding
  // its size attribute out of it.
  await page
    .locator('[data-map-legend] li[class*="entry"]')
    .nth(1)
    .locator('[class*="editable"]')
    .click();
  const draftEditor = page.locator(
    '[data-map-legend] input[class*="labelInput"]',
  );
  await expect(draftEditor).toBeVisible();
  await draftEditor.fill(LONG.entries);
  const draftContained = await draftEditor.evaluate((el) => {
    const card = el.closest("[data-map-legend]")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return box.right <= card.right + 0.5 && box.left >= card.left - 0.5;
  });
  expect(draftContained, "a long draft stays inside the card").toBe(true);
  await page.keyboard.press("Escape");

  // The Legend tab's rows carry no kind caption, and the data-driven
  // row still exposes its variable editor.
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Legend" })
    .click();
  const rows = page.locator("[data-legend-row]");
  await expect(rows).toHaveCount(3);
  for (const banned of ["single color", "by riders", "density"]) {
    await expect(rows.filter({ hasText: banned })).toHaveCount(0);
  }
  await expect(
    rows.filter({ hasText: "classy" }).locator('[class*="attrInput"]'),
  ).toHaveCount(1);

  // The published view renders the same truth.
  const token = await publishMap(page, mapId);
  await page.goto(`/v/${token}`);
  await checkSurface(page, false);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the rail headings speak the section-title voice", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors = trackConsole(page);
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, `${table}_h`, csv);
  const mapId = await createMap(page, `voices ${runId}`);
  await addLayer(page, mapId, "alpha", `SELECT * FROM "${table}_h"`);
  await page.goto(`/maps/${mapId}`);

  const voice = (locator: ReturnType<Page["locator"]>) =>
    locator.evaluate((el) => {
      const cs = getComputedStyle(el);
      return [
        cs.fontFamily,
        cs.fontSize,
        cs.fontWeight,
        cs.color,
        cs.textTransform,
        cs.letterSpacing,
      ].join(" | ");
    });

  // The reference: a layer card's section title.
  await page.locator("[data-layer-select]").first().click();
  const reference = await voice(
    page.getByText("Visualization", { exact: true }),
  );

  const tabs = page.getByRole("tablist", { name: "Builder panels" });
  await tabs.getByRole("tab", { name: "Legend" }).click();
  expect(await voice(page.getByText("Corner", { exact: true }))).toBe(
    reference,
  );
  // A single-colour layer's row: no kind caption; a title editor but
  // no variable editor (none applies).
  const constantRow = page.locator("[data-legend-row]");
  await expect(constantRow).toHaveCount(1);
  await expect(constantRow.filter({ hasText: "single color" })).toHaveCount(0);
  await expect(constantRow.locator('[class*="titleInput"]')).toHaveCount(1);
  await expect(constantRow.locator('[class*="attrInput"]')).toHaveCount(0);
  await tabs.getByRole("tab", { name: "Basemap" }).click();
  expect(await voice(page.getByRole("heading", { name: "Map layers" }))).toBe(
    reference,
  );
  expect(await voice(page.getByRole("heading", { name: "Overlays" }))).toBe(
    reference,
  );
  await tabs.getByRole("tab", { name: "Widgets" }).click();
  expect(
    await voice(page.getByRole("heading", { name: "Widgets", exact: true })),
  ).toBe(reference);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("both export roads print the UI face, and the client PNG's own ink proves it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  const { mapId } = await seedMap(page);

  // The client road's DOM: the export card's preview is the very node
  // the rasterizer clones, and it must already resolve the UI face and
  // contain the wrapped values.
  await page.goto(`/maps/${mapId}`);
  // Under a loaded whole-set run the first press can land mid-render and
  // open nothing, and the item can resolve while still unstable ('s
  // recorded failure: "element is not stable"): the gesture binds to its
  // outcome, the dialog, and repeats whole until that outcome holds.
  const dialog = page.getByRole("dialog", { name: "Export image" });
  await expect(async () => {
    const item = page.getByRole("menuitem", { name: /Image/ });
    if (!(await item.isVisible())) {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await item.waitFor({ state: "visible", timeout: 5_000 });
    }
    await item.click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await checkSurface(dialog, false);
  await page.keyboard.press("Escape");

  // The server road: the page chromium screenshots, driven with the
  // template the server suite uses. Ocean viewport — the classed swatch
  // colour appears nowhere but the legend.
  await page.addInitScript(
    (d) => {
      (
        window as { __DEZFIL_EXPORT_DEFINITION__?: unknown }
      ).__DEZFIL_EXPORT_DEFINITION__ = d;
    },
    {
      viewport: { lng: -30, lat: 30, zoom: 5, pitch: 0, bearing: 0 },
      size: { width: 960, height: 540 },
      legend: { visible: true, corner: "bottom-left", size: "m" },
      widgets: [],
      title: { text: "Fidelity render", size: "m" },
      appearance: "light",
      overlayScale: 2,
    },
  );
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(`/render/${mapId}`);
  await expect(page.locator("[data-export-root]")).toBeVisible({
    timeout: 30_000,
  });
  await checkSurface(page, false);

  // The server road's REAL bytes were attempted here and withdrawn:
  // the gate instance's render browser exhausts the 90s export budget
  // headless (the docker image job's offline probe is where that
  // pipeline is exercised end to end). The page above IS what the
  // server screenshots; its computed faces and geometry stand for it.

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the client download carries the UI face into its pixels", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { mapId, layers } = await seedMap(page);
  // The labels drop to the one-line discriminator token and every
  // attribute line hides, so the card's muted ink is values alone —
  // its measured extent then separates the faces cleanly. Top-left
  // keeps the card away from the attribution strip, whose dark text
  // antialiases through the values' gray.
  await patchMap(page, mapId, {
    legendCorner: "top-left",
  });
  await patchLayer(page, layers.classy, {
    legendLabels: [DISCRIMINATOR, null, null],
  });
  await patchLayer(page, layers.heaty, { legendLabels: [DISCRIMINATOR] });
  await patchLayer(page, layers.sizy, {
    legendLabels: [DISCRIMINATOR],
    legendAttrs: { radius: null },
  });
  // The widget conjunct: a formula card whose muted caption is the same
  // one-line token. It rides the composition's widget rail — top-right,
  // on the card's own white — so its caption is the only value-gray ink
  // in that quadrant, and its extent against the card's white span
  // separates the faces without knowing the rail's scale.
  await patchMap(page, mapId, {
    widgets: [
      {
        id: "w-face",
        type: "formula",
        layerId: layers.classy,
        title: "N",
        field: null,
        agg: "count",
        aggField: null,
        unit: null,
        note: DISCRIMINATOR,
        format: null,
        visible: true,
      },
    ],
  });
  await page.goto(`/maps/${mapId}`);

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /Image/ }).click();
  const dialog = page.getByRole("dialog", { name: "Export image" });
  await expect(dialog).toBeVisible();

  // The preview DOM already resolves the UI face (the frame's door).
  const previewFont = await dialog
    .locator('[data-map-legend] [class*="label"]')
    .first()
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(MONO.test(previewFont)).toBe(false);

  const waiting = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PNG" }).click();
  const file = await (await waiting).path();
  const { readFileSync: read, copyFileSync } = await import("node:fs");
  const png = read(file!);
  if (process.env.DEZFIL_DEBUG_PNG) {
    copyFileSync(file!, process.env.DEZFIL_DEBUG_PNG);
  }

  // Decode in-browser (the png-probes pattern). The swatch blob anchors
  // the card and yields the pixel scale (13 layout px); the muted ink's
  // horizontal extent, rescaled to layout px, separates the faces: the
  // 18-glyph tokens run ~119px in the system mono and ~55px in the UI
  // face, so the bound at 90 fails exactly when export ink is mono. Ink
  // must also stay within a card's width of the swatch.
  const ink = await page.evaluate(
    async ({ b64, sw }) => {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const bmp = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const near = (i: number, t: [number, number, number], tol: number) =>
        Math.abs(data[i] - t[0]) <= tol &&
        Math.abs(data[i + 1] - t[1]) <= tol &&
        Math.abs(data[i + 2] - t[2]) <= tol;
      // The value gray is distinctly GREENISH (95,111,107): requiring
      // its g−r and g−b signature keeps the basemap's neutral label
      // grays out of the count.
      const valueInk = (i: number) =>
        near(i, [95, 111, 107], 14) &&
        data[i + 1] - data[i] >= 12 &&
        data[i + 1] - data[i + 2] >= 2;
      // Pass 1: the swatch anchors the card — over open ocean its
      // colour appears nowhere else in the whole image.
      let swMinX = Infinity;
      let swMaxX = -Infinity;
      let swMinY = Infinity;
      let swMaxY = -Infinity;
      for (let y = 0; y < bmp.height; y += 1) {
        for (let x = 0; x < bmp.width; x += 1) {
          const i = (y * bmp.width + x) * 4;
          if (near(i, [sw.r, sw.g, sw.b], 16)) {
            swMinX = Math.min(swMinX, x);
            swMaxX = Math.max(swMaxX, x);
            swMinY = Math.min(swMinY, y);
            swMaxY = Math.max(swMaxY, y);
          }
        }
      }
      const scale = (swMaxX - swMinX + 1) / 13;
      // Pass 2: value ink in the CLASSED block's rows alone — the
      // swatch column delimits them exactly. The other blocks put
      // labels after ramps and glyphs, which pads the extent whatever
      // the face; the classed rows start at the swatch, so their ink
      // extent IS the face's width.
      const box = {
        x0: Math.max(0, Math.floor(swMinX - 20 * scale)),
        // Past the card's right edge on purpose: ink that ESCAPED the
        // card must be seen, or the containment bound below can't fail.
        x1: Math.min(bmp.width, Math.ceil(swMinX + 320 * scale)),
        y0: Math.max(0, Math.floor(swMinY - 5 * scale)),
        y1: Math.min(bmp.height, Math.ceil(swMaxY + 8 * scale)),
      };
      let inkMinX = Infinity;
      let inkMaxX = -Infinity;
      let inkCount = 0;
      for (let y = box.y0; y < box.y1; y += 1) {
        for (let x = box.x0; x < box.x1; x += 1) {
          const i = (y * bmp.width + x) * 4;
          if (valueInk(i)) {
            inkMinX = Math.min(inkMinX, x);
            inkMaxX = Math.max(inkMaxX, x);
            inkCount += 1;
          }
        }
      }
      // Pass 3: the widget caption's ink, alone in the top-right
      // quadrant — the legend sits top-left, the attribution bottom,
      // and the card's dark title and figure fail the greenish
      // signature.
      const halfX = Math.floor(bmp.width / 2);
      let wMinX = Infinity;
      let wMaxX = -Infinity;
      let wMinY = Infinity;
      let wMaxY = -Infinity;
      let wCount = 0;
      for (let y = 0; y < Math.floor(bmp.height / 2); y += 1) {
        for (let x = halfX; x < bmp.width; x += 1) {
          const i = (y * bmp.width + x) * 4;
          if (valueInk(i)) {
            wMinX = Math.min(wMinX, x);
            wMaxX = Math.max(wMaxX, x);
            wMinY = Math.min(wMinY, y);
            wMaxY = Math.max(wMaxY, y);
            wCount += 1;
          }
        }
      }
      // The card's interior width: the longest clean near-white run in
      // the caption's neighbourhood — text-free rows inside the card
      // span its full interior, and nothing on the basemap runs white
      // that wide.
      const white = (i: number) =>
        data[i] >= 246 && data[i + 1] >= 246 && data[i + 2] >= 242;
      let cardW = 0;
      if (wCount > 0) {
        const y0 = Math.max(0, wMinY - 40);
        const y1 = Math.min(bmp.height, wMaxY + 40);
        for (let y = y0; y < y1; y += 1) {
          let run = 0;
          for (let x = halfX; x < bmp.width; x += 1) {
            const i = (y * bmp.width + x) * 4;
            if (white(i)) {
              run += 1;
              cardW = Math.max(cardW, run);
            } else run = 0;
          }
        }
      }
      return {
        swMinX,
        swMaxX,
        inkMinX,
        inkMaxX,
        inkCount,
        widget: { wMinX, wMaxX, wCount, cardW },
      };
    },
    { b64: png.toString("base64"), sw: SWATCH },
  );

  // The card is present: its swatch and its muted values both left ink.
  expect(ink.swMaxX).toBeGreaterThan(ink.swMinX);
  expect(ink.inkCount).toBeGreaterThan(40);
  const scale = (ink.swMaxX - ink.swMinX + 1) / 13;
  expect(scale).toBeGreaterThan(0.5);
  const extentLayout = (ink.inkMaxX - ink.inkMinX + 1) / scale;
  expect(
    extentLayout,
    "muted ink runs at the UI face's width, not the mono's",
  ).toBeLessThanOrEqual(90);
  // Containment: no value ink escapes a card's width of the swatch.
  expect((ink.inkMaxX - ink.swMinX) / scale).toBeLessThanOrEqual(230);

  // The widget conjunct: the caption left ink, the card's white span
  // encloses it, and the extent ratio sits at the UI face's width
  // (~0.25 of the card) rather than the mono's (~0.55) — scale-free, so
  // the rail's own size step cannot fake a pass.
  expect(ink.widget.wCount).toBeGreaterThan(15);
  const captionExtent = ink.widget.wMaxX - ink.widget.wMinX + 1;
  expect(ink.widget.cardW).toBeGreaterThan(captionExtent);
  expect(
    captionExtent / ink.widget.cardW,
    "widget caption ink runs at the UI face's width, not the mono's",
  ).toBeLessThanOrEqual(0.42);
});
