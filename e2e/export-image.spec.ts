// The export flow: both doors reach the same
// actions; the card opens seeded to current state; its preview frames
// independently of the builder; options reflect live; the download is
// the framing the preview showed at exactly the chosen pixels, with
// every enabled element present — proven per element by region — and a
// capture made to fail is visible with a retry (red-proven: a silent
// no-op fails the arm).
import path from "node:path";
import { readFileSync } from "node:fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  patchLayer,
  patchMap,
  routeHouse,
  seedCsv,
  trackConsole,
} from "./support";
import { isAllowedConsoleError } from "./console-allowlist";
import { pngStats, type RegionStats } from "./png-probes";

const runId = Date.now().toString(36);
const tableName = `exp_${runId}`;

const KELP = { r: 26, g: 93, b: 74 };
const AMBER = { r: 233, g: 179, b: 91 };

async function seed(page: Page): Promise<{ mapId: string; layerId: string }> {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  const mapId = await createMap(page, "Export flow");
  const layerId = await addLayer(
    page,
    mapId,
    "stations",
    `SELECT * FROM "${tableName}"`,
  );
  await patchLayer(page, layerId, {
    style: {
      fill: {
        type: "quantile",
        attribute: "riders",
        palette: "global_warming",
        breaks: [12000],
        colors: [
          { r: KELP.r, g: KELP.g, b: KELP.b, a: 0.9 },
          { r: AMBER.r, g: AMBER.g, b: AMBER.b, a: 0.9 },
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
  await patchMap(page, mapId, {
    widgets: [
      {
        id: "w-hist",
        type: "histogram",
        layerId,
        title: "Riders",
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
  return { mapId, layerId };
}

async function openBuilder(page: Page, mapId: string): Promise<void> {
  await page.goto(`/maps/${mapId}`);
  await expect(page.getByText("12 features").first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Open the builder waiting on a specific layer name's count line —
 * the default helper waits on "stations", which a rename breaks. */
async function openBuilder2(
  page: Page,
  mapId: string,
  expectName: string,
): Promise<void> {
  await page.goto(`/maps/${mapId}`);
  await expect(page.getByText(expectName).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function openCard(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /Image/ }).first().click();
  await expect(page.getByRole("dialog", { name: "Export image" })).toBeVisible();
  // The preview map inside the frame must actually render before any
  // capture or framing assertion means anything.
  await expect(
    page.locator("[data-export-card] canvas").first(),
  ).toBeVisible({ timeout: 30_000 });
}

/** Region pixel stats of a PNG, decoded in-browser (the pixel suite's
 * decode pattern): counts per horizontal third and per corner region. */


test.describe("export image and data", () => {
  test("both doors, defaults, isolation, live options, and the image itself", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    const { mapId, layerId } = await seed(page);
    await openBuilder(page, mapId);

    await test.step("design A — two doors, no back step, rows that identify themselves", async () => {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const menu = page.getByRole("menu", { name: "Export" });
      // Both doors are present at once and stay present: the layer list
      // is already open underneath, so nothing navigates and nothing is
      // replaced. A back control existing at all fails this.
      await expect(menu.getByRole("menuitem", { name: /Image/ })).toBeVisible();
      await expect(menu.getByText("Data", { exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /Back/ })).toHaveCount(0);

      // The row carries all three identifiers, not just the name — a
      // name alone is what existed before and would pass a weaker check.
      // The list is behind the Data door, and the menu opens at the root.
      await expect(menu.locator("[class*=layerRow]")).toHaveCount(0);
      await menu.getByRole("menuitem", { name: /Data/ }).click();
      const row = menu.locator("[class*=layerRow]", { hasText: "stations" });
      await expect(row).toBeVisible();
      await expect(row).toContainText("Points");
      await expect(row).toContainText("12 features");
      await expect(row.locator("[class*=swatch]")).toBeVisible();

      // By geometry rather than class names: the Image
      // door's content sits at the row's left (the field round found it
      // spread to the right), the menu is narrower than shipped it
      // (348px), and while nothing is pointed at, the name may use the
      // space right up to where the hidden formats sit — they reserve
      // no layout.
      const imageDoor = menu.getByRole("menuitem", { name: /Image/ });
      const doorBox = await imageDoor.boundingBox();
      const textBox = await imageDoor
        .locator("[class*=doorText]")
        .boundingBox();
      if (!doorBox || !textBox) throw new Error("door not on screen");
      expect(textBox.x - doorBox.x).toBeLessThan(doorBox.width * 0.35);
      const menuBox = await menu.boundingBox();
      expect(menuBox!.width).toBeLessThan(348);
      // A genuinely long name, measured on the NAME node itself before
      // any reveal — the field-found regression squeezed it to a few
      // characters, and a container measurement would pass with the
      // name independently capped.
      await page.evaluate(
        async ({ layerId }) => {
          await (async function readThenWriteSetup() {
const read = await fetch(`/api/layers/${layerId}`, { cache: "no-store" });
if (!read.ok) throw new Error(await read.text());
const shown = await read.json();
return fetch(`/api/layers/${layerId}`, {
            method: "PATCH",
            headers: { "X-Edit-Revision": shown.editRevision, "content-type": "application/json" },
            body: JSON.stringify({
              name: "berlin_restaurants_and_cafes_rated_by_riders",
            }),
          });
})();
        },
        { layerId },
      );
      // The builder holds its loaded state; the rename is out of band,
      // so the page reloads to see it (and is restored below — the rest
      // of the journey addresses the layer as "stations").
      await openBuilder2(page, mapId, "berlin_restaurants");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const menu2 = page.getByRole("menu", { name: "Export" });
      await menu2.getByRole("menuitem", { name: /Data/ }).click();
      const longRow = menu2.locator("[class*=layerRow]", {
        hasText: "berlin_restaurants",
      });
      await expect(longRow).toBeVisible();
      const nameNode = longRow.locator("[class*=layerName]");
      const nameGeom = await nameNode.evaluate((el) => ({
        visible: el.clientWidth,
        full: el.scrollWidth,
      }));
      const rowBox = await longRow.boundingBox();
      // The name may ellipsize only because the ROW ran out — it shows
      // at least the row's width less the swatch and paddings, never a
      // few characters.
      expect(nameGeom.visible).toBeGreaterThan(rowBox!.width * 0.7);
      await page.keyboard.press("Escape");
      await page.evaluate(
        async ({ layerId }) => {
          await (async function readThenWriteSetup() {
const read = await fetch(`/api/layers/${layerId}`, { cache: "no-store" });
if (!read.ok) throw new Error(await read.text());
const shown = await read.json();
return fetch(`/api/layers/${layerId}`, {
            method: "PATCH",
            headers: { "X-Edit-Revision": shown.editRevision, "content-type": "application/json" },
            body: JSON.stringify({ name: "stations" }),
          });
})();
        },
        { layerId },
      );
      await openBuilder(page, mapId);
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await page
        .getByRole("menu", { name: "Export" })
        .getByRole("menuitem", { name: /Data/ })
        .click();

      // Two steps from opening the menu to a file: point at the row, its
      // formats appear on it.
      await row.hover();
      const parquetItem = row.getByRole("menuitem", { name: "GeoParquet" });
      await expect(parquetItem).toBeVisible();
      // In-builder downloads are managed actions, so failures can return to
      // the standing builder rail instead of navigating it to API JSON. The
      // documented bare GET remains the direct/agent road.
      expect(await parquetItem.evaluate((el) => el.tagName)).toBe("BUTTON");
      expect(await parquetItem.getAttribute("href")).toBeNull();
      await expect(parquetItem).not.toHaveAttribute("aria-disabled", "true");
      // The action changed from an anchor to a button in 0092. It remains a
      // compact format pill, not the generic full-row button treatment.
      // These values fail on the old anchor-only selectors (flex, baseline,
      // space-between), so this guards the presentational regression itself.
      const pillStyle = await parquetItem.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          alignItems: style.alignItems,
          borderRadius: style.borderRadius,
          borderTopWidth: style.borderTopWidth,
          fontSize: style.fontSize,
          height: style.height,
          justifyContent: style.justifyContent,
          whiteSpace: style.whiteSpace,
        };
      });
      expect(pillStyle).toEqual({
        alignItems: "center",
        borderRadius: "999px",
        borderTopWidth: "1px",
        fontSize: "11px",
        height: "24px",
        justifyContent: "center",
        whiteSpace: "nowrap",
      });
      // All three pills sit inside the menu whole (field round
      // at 264px the CSV pill clipped at the menu's edge).
      const menuEdge = await menu.boundingBox();
      for (const label of ["GeoParquet", "GeoJSON", "CSV"]) {
        const pill = await row
          .getByRole("menuitem", { name: label })
          .boundingBox();
        if (!pill || !menuEdge) throw new Error("pill not on screen");
        expect(
          pill.x + pill.width,
          `${label} fits inside the menu`,
        ).toBeLessThanOrEqual(menuEdge.x + menuEdge.width);
      }

      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Export", exact: true }),
      ).toBeFocused();
    });

    await test.step("a keyboard journey reaches a format without a pointer", async () => {
      // The hover reveal must not be the only way in. Opening with the
      // keyboard lands on the first item; arrowing walks into the layer
      // row's formats, which are menu items in their own right.
      //
      // The pointer is parked in a corner FIRST. Without that, the
      // previous step's hover left it over the menu and this arm passed
      // on a reveal the keyboard had not caused, in a test written to
      // prove the opposite.
      await page.mouse.move(0, 0);
      await page.getByRole("button", { name: "Export", exact: true }).focus();
      await page.keyboard.press("ArrowDown");
      const menu = page.getByRole("menu", { name: "Export" });
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name: /Data/ }).click();
      let reached = false;
      for (let i = 0; i < 8 && !reached; i++) {
        await page.keyboard.press("ArrowDown");
        reached = await menu
          .getByRole("menuitem", { name: "GeoParquet" })
          .evaluate((el) => el === document.activeElement)
          .catch(() => false);
      }
      expect(reached, "a format is reachable by keyboard alone").toBe(true);
      await page.keyboard.press("Escape");
    });

    await test.step("the menu stays on screen as it grows", async () => {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const menu = page.getByRole("menu", { name: "Export" });
      await menu.getByRole("menuitem", { name: /Data/ }).click();
      const box = await menu.boundingBox();
      const viewport = page.viewportSize();
      if (!box || !viewport) throw new Error("menu not on screen");
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      await page.keyboard.press("Escape");
    });

    await test.step("the per-layer door reaches the same file", async () => {
      const row = page.getByRole("listitem").filter({ hasText: "stations" });
      // The per-layer door lives in the row's overflow menu, and the
      // formats fold behind its Export data row (A1).
      await row
        .getByRole("button", { name: "Layer menu", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Export data" }).click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("menuitem", { name: /CSV/ }).click(),
      ]);
      expect(download.suggestedFilename()).toBe("stations.csv");
      const file = await download.path();
      const text = readFileSync(file, "utf8");
      expect(text.split("\n")[0]).toContain("geometry");
      expect(text).toContain("POINT");
    });

    await test.step("the card opens seeded, and the builder never moves", async () => {
      const before = await page.evaluate(async (id) => {
        const r = await fetch(`/api/maps/${id}`);
        return ((await r.json()) as { viewport: unknown }).viewport;
      }, mapId);

      await openCard(page);
      // Defaults: 4:3, basemap labels at S, legend on (a fill legend
      // exists), the widget on, no title. "Current view" is gone from
      // the shape list entirely — it was never a shape.
      await expect(
        page.getByRole("radio", { name: "Current view" }),
      ).toHaveCount(0);
      await expect(
        page
          .getByRole("radiogroup", { name: "Basemap label and symbol size" })
          .getByRole("radio", { name: "S", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await expect(page.getByRole("radio", { name: "4:3" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(page.getByRole("radio", { name: "1:1" })).toBeVisible();
      await expect(
        page.getByRole("switch", { name: "Include the legend" }),
      ).toBeChecked();
      await expect(page.getByRole("switch", { name: "Riders" })).toBeChecked();
      await expect(page.getByLabel("Image title")).toHaveValue("");
      await expect(page.getByText(/output 1920 × \d+ px/)).toBeVisible();
      // Every element's step opens at S, by a field ruling — the
      // card's seed, distinct from the contract's absent-means-M.
      for (const group of ["Legend size", "Widget size", "Credit size"]) {
        await expect(
          page
            .getByRole("radiogroup", { name: group })
            .getByRole("radio", { name: "S", exact: true }),
        ).toHaveAttribute("aria-checked", "true");
      }

      // Reframe INSIDE the preview: drag right so the data shifts left.
      const frame = page.locator("[data-export-card] canvas").first();
      const box = await frame.boundingBox();
      if (!box) throw new Error("preview not on screen");
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + box.width * 0.35, cy, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(400);

      // The builder's stored camera is untouched by the preview gesture.
      const after = await page.evaluate(async (id) => {
        const r = await fetch(`/api/maps/${id}`);
        return ((await r.json()) as { viewport: unknown }).viewport;
      }, mapId);
      expect(after).toEqual(before);
    });

    await test.step("the legend sits where the builder put it — no in-preview drag", async () => {
      // The in-preview corner drag retired: position is decided in the
      // builder's Legend tab, and the definition seeds from the map.
      const legend = page.locator('[data-export-card] [class*="legendScale"]');
      await expect(legend).toBeVisible();
      await expect(
        page.locator(
          '[data-export-card] [class*="legendCorner"][data-corner="bottom-left"]',
        ),
      ).toBeVisible();
      // A drag attempt moves nothing.
      const frameBox = await page
        .locator('[data-export-card] [class*="frame"]')
        .first()
        .boundingBox();
      const legendBox = await legend.boundingBox();
      if (!frameBox || !legendBox) throw new Error("legend not on screen");
      await page.mouse.move(
        legendBox.x + legendBox.width / 2,
        legendBox.y + 8,
      );
      await page.mouse.down();
      await page.mouse.move(frameBox.x + frameBox.width - 40, frameBox.y + 40, {
        steps: 10,
      });
      await page.mouse.up();
      await expect(
        page.locator(
          '[data-export-card] [class*="legendCorner"][data-corner="bottom-left"]',
        ),
      ).toBeVisible();
    });

    let dims: { width: number; height: number } = { width: 0, height: 0 };
    let firstStats: RegionStats | null = null;
    await test.step("options reflect live, meta line stays honest", async () => {
      // 16:9 reshapes the frame; the meta line answers with true pixels.
      await page.getByRole("radio", { name: "16:9" }).click();
      await expect(page.getByText("output 1920 × 1080 px", { exact: false })).toBeVisible();
      dims = { width: 1920, height: 1080 };
      // The stated preview scale is the truth of the frame's width.
      const meta = await page
        .getByText(/output 1920 × 1080 px · preview at \d+%/)
        .textContent();
      const stated = Number(/preview at (\d+)%/.exec(meta ?? "")?.[1]);
      const frameBox = await page
        .locator('[data-export-card] [class*="frame"]')
        .first()
        .boundingBox();
      if (!frameBox) throw new Error("frame not on screen");
      expect(
        Math.abs(stated - (frameBox.width / 1920) * 100),
      ).toBeLessThanOrEqual(1.5);

      // A title appears in the preview as typed.
      await page.getByLabel("Image title").fill("Berlin riders");
      await expect(
        page.locator("[data-export-card]").getByText("Berlin riders"),
      ).toBeVisible();
    });

    await test.step("the PNG is the framing shown, per element", async () => {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60_000 }),
        page.locator("[data-export-download]").click(),
      ]);
      expect(download.suggestedFilename()).toBe("Export flow.png");
      const png = readFileSync(await download.path());
      // Exact chosen dimensions from the PNG header (IHDR, bytes 16–24).
      expect(png.readUInt32BE(16)).toBe(dims.width);
      expect(png.readUInt32BE(20)).toBe(dims.height);

      const stats = await pngStats(page, png);
      firstStats = stats;
      expect(stats.width).toBe(dims.width);
      // Camera truth: the pan pushed the stations left — data pixels sit
      // in the left two thirds, not the right. A stale opened-camera
      // render (centered) or a blank canvas fails one of these.
      const kelpTotal = stats.kelpLeft + stats.kelpCenter + stats.kelpRight;
      expect(kelpTotal).toBeGreaterThan(80);
      expect(stats.kelpLeft + stats.kelpCenter).toBeGreaterThan(
        stats.kelpRight * 3,
      );
      // The legend, in its default bottom-left corner, carries both class
      // chips; the amber chip cannot come from the map (no amber points
      // sit bottom-left after the pan — and chip color is exact).
      expect(stats.kelpBottomLeft).toBeGreaterThan(40);
      expect(stats.amberBottomLeft).toBeGreaterThan(40);
      // The title's ink, top-left; the attribution's ink, bottom-right.
      expect(stats.inkTopLeft).toBeGreaterThan(150);
      expect(stats.inkBottomRight).toBeGreaterThan(30);
      // The widget card in the rail region draws its accent bars.
      expect(stats.accentTopRight).toBeGreaterThan(50);
    });

    await test.step("a disabled element leaves the image — differential per element", async () => {
      await page.getByRole("switch", { name: "Riders" }).uncheck();
      await page.getByRole("switch", { name: "Include the legend" }).uncheck();
      await page.getByLabel("Image title").fill("");
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60_000 }),
        page.locator("[data-export-download]").click(),
      ]);
      const stats = await pngStats(page, readFileSync(await download.path()));
      expect(stats.amberBottomLeft).toBeLessThanOrEqual(2);
      expect(stats.accentTopRight).toBeLessThanOrEqual(8);
      // The title's ink is proven differentially (an absolute dark-pixel
      // floor could be satisfied by the map itself);
      // with the title cleared the region loses most of its ink against
      // the titled first download.
      if (!firstStats) throw new Error("first download stats missing");
      expect(stats.inkTopLeft).toBeLessThan(firstStats.inkTopLeft / 3);
    });

    for (const err of consoleErrors) {
      expect(
        isAllowedConsoleError(err.text, err.url),
        `${err.text} (${err.url ?? "no url"})`,
      ).toBe(true);
    }
  });

  test("a failed capture is visible with a retry — red-proven", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    // Break PNG encoding for the whole page: toBlob answers null, the
    // exact silent-failure shape today's thumbnail path drops. The card
    // must SAY something — an implementation that no-ops fails here.
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.toBlob = function toBlobBroken(
        cb: BlobCallback,
      ) {
        cb(null);
      };
    });
    const { mapId } = await seed(page);
    await openBuilder(page, mapId);
    await openCard(page);
    await page.locator("[data-export-download]").click();
    // The failure is worded, and a retry is offered; nothing spins on.
    await expect(
      page.getByText(/could not encode|could not be produced/i),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: "Try again" }),
    ).toBeVisible();
    await expect(page.locator("[data-export-download]")).toBeEnabled();
  });

  test("right-corner legends use the export's effective widget-rail placement", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page);

    await test.step("top-right docks at the widget card width and rail step", async () => {
      await patchMap(page, mapId, { legendCorner: "top-right" });
      await openBuilder(page, mapId);
      await openCard(page);

      const frame = page.locator("[data-export-composition]");
      await expect(frame).toHaveAttribute("data-legend-placement", "docked");
      const rail = frame.locator("[data-widget-rail]");
      const legend = rail.locator(
        "[data-export-docked-legend] [data-map-legend][data-docked]",
      );
      const widget = rail.locator("[data-widget-card]").first();
      await expect(legend).toBeVisible();
      const [legendBox, widgetBox] = await Promise.all([
        legend.boundingBox(),
        widget.boundingBox(),
      ]);
      if (!legendBox || !widgetBox) throw new Error("rail cards not laid out");
      expect(Math.abs(legendBox.width - widgetBox.width)).toBeLessThan(1);
      await expect(frame.locator('[class*="legendScale"]')).toHaveCount(0);

      // Its own step does not detach or rescale a rail member. The rail's
      // widget step is the only scale wrapper around the docked legend.
      const before = await legend.boundingBox();
      await page
        .getByRole("radiogroup", { name: "Legend size" })
        .getByRole("radio", { name: "L", exact: true })
        .click();
      const afterLegendStep = await legend.boundingBox();
      expect(Math.abs(afterLegendStep!.width - before!.width)).toBeLessThan(1);
      await page
        .getByRole("radiogroup", { name: "Widget size" })
        .getByRole("radio", { name: "L", exact: true })
        .click();
      await expect
        .poll(async () => (await legend.boundingBox())?.width ?? 0)
        .toBeGreaterThan(before!.width * 1.1);

      await page.getByRole("button", { name: "Close" }).click();
    });

    await test.step("bottom-right stays standalone when the measured band is clear", async () => {
      await patchMap(page, mapId, { legendCorner: "bottom-right" });
      await openBuilder(page, mapId);
      await openCard(page);

      const frame = page.locator("[data-export-composition]");
      await expect(frame).toHaveAttribute(
        "data-legend-placement",
        "standalone",
      );
      await expect(
        frame.locator(
          '[class*="legendCorner"][data-corner="bottom-right"]:not([data-legend-placement-probe]) [data-map-legend]',
        ),
      ).toBeVisible();
      await expect(
        frame.locator('[data-widget-rail] [data-map-legend]'),
      ).toHaveCount(0);
      await expect(
        frame.locator('[class*="credit"][data-corner="bottom-left"]'),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close" }).click();
    });

    await test.step("a crowded bottom-right rail docks and keeps credit away", async () => {
      await patchMap(page, mapId, {
        legendCorner: "bottom-right",
        widgets: Array.from({ length: 10 }, (_, index) => ({
          id: `dock-note-${index}`,
          type: "note",
          layerId: null,
          title: `Dock note ${index + 1}`,
          field: null,
          agg: "count",
          aggField: null,
          unit: null,
          note: "A deliberately tall rail card for placement geometry.",
          format: null,
          visible: true,
        })),
      });
      await openBuilder(page, mapId);
      await openCard(page);

      const frame = page.locator("[data-export-composition]");
      await expect(frame).toHaveAttribute("data-legend-placement", "docked");
      await expect(
        frame.locator(
          '[data-widget-rail] [data-export-docked-legend] [data-map-legend]',
        ),
      ).toBeVisible();
      await expect(
        frame.locator('[class*="credit"][data-corner="bottom-left"]'),
      ).toBeVisible();
      await expect(
        frame.locator(
          '[class*="legendCorner"][data-corner="bottom-right"]:not([data-legend-placement-probe])',
        ),
      ).toHaveCount(0);
    });
  });
});

/** An element's share of the composition's SHORT side, measured on the
 * real rendered DOM in composition units (normalized by the width; the short side is what anchors to,
 * and at a fixed shape the two normalizations differ only by a constant,
 * so every invariance arm keeps its meaning). Layout geometry, never a
 * client rectangle: the preview is displayed scaled, and a client
 * rectangle would report the display factor rather than the composition.
 * `inset` is the title chip's corner offset — the middle-step chrome
 * scale that also places the failure prose. */
async function elementShares(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(
      "[data-export-composition]",
    );
    if (!frame) throw new Error("no composition");
    const short = Math.min(frame.offsetWidth, frame.offsetHeight);
    const share = (selector: string, scaleVar: string) => {
      const el = frame.querySelector<HTMLElement>(selector);
      if (!el) return 0;
      const scale = Number(
        getComputedStyle(el).getPropertyValue(scaleVar) || "1",
      );
      return (el.offsetWidth * (Number.isFinite(scale) ? scale : 1)) / short;
    };
    const title = frame.querySelector<HTMLElement>('[class*="titleChip"]');
    return {
      legend: share('[class*="legendScale"]', "--legend-scale"),
      rail: share('[class*="railScale"] > *', "--rail-scale"),
      title: share('[class*="titleChip"]', "--title-scale"),
      credit: share('[class*="credit"]', "--credit-scale"),
      inset: title ? title.offsetLeft / short : 0,
    };
  });
}

/** The composition's own aspect, from the same layout geometry. */
async function compositionAspect(page: Page): Promise<number> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(
      "[data-export-composition]",
    );
    if (!frame) throw new Error("no composition");
    return frame.offsetWidth / frame.offsetHeight;
  });
}

test.describe("framing, scale, and the elements", () => {
  test("an element's share of the image is invariant, per element and per input", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page);
    await openBuilder(page, mapId);
    await openCard(page);
    await page.getByLabel("Image title").fill("Share check");

    const baseline = await elementShares(page);
    for (const [name, value] of Object.entries(baseline)) {
      expect(value, `${name} must be drawn at all`).toBeGreaterThan(0.01);
    }

    await test.step("across the four map-size steps", async () => {
      for (const step of ["S", "M", "L"]) {
        await page
          .getByRole("radiogroup", { name: "Basemap label and symbol size" })
          .getByRole("radio", { name: step, exact: true })
          .click();
        const shares = await elementShares(page);
        for (const key of Object.keys(baseline)) {
          expect(
            Math.abs(shares[key] - baseline[key]),
            `${key} moved when the map size changed to ${step}`,
          ).toBeLessThan(0.005);
        }
      }
      await page
        .getByRole("radiogroup", { name: "Basemap label and symbol size" })
        .getByRole("radio", { name: "XS", exact: true })
        .click();
    });

    await test.step("across the output width presets", async () => {
      for (const width of ["1280", "2560"]) {
        await page.getByRole("button", { name: `${width} px wide` }).click();
        const shares = await elementShares(page);
        for (const key of Object.keys(baseline)) {
          expect(
            Math.abs(shares[key] - baseline[key]),
            `${key} moved when the output width changed to ${width}`,
          ).toBeLessThan(0.005);
        }
      }
      await page.getByRole("button", { name: "1920 px wide" }).click();
    });

    await test.step("across two deliberately different shapes", async () => {
      // Criterion 2 names the shape as one of its inputs, and the first
      // version of this test never varied it. The
      // identity is the SHORT-side share — so the width-share, the rule
      // this replaces, must genuinely move here, or the invariance
      // below would hold under either rule and prove nothing about
      // which one renders.
      const aspectAt43 = await compositionAspect(page);
      for (const shape of ["16:9", "1:1"]) {
        await page.getByRole("radio", { name: shape, exact: true }).click();
        const aspect = await compositionAspect(page);
        expect(
          Math.abs(aspect - aspectAt43),
          `the composition's shape really changed to ${shape}`,
        ).toBeGreaterThan(0.2);
        const shares = await elementShares(page);
        for (const key of Object.keys(baseline)) {
          expect(
            Math.abs(shares[key] - baseline[key]),
            `${key} moved when the shape changed to ${shape}`,
          ).toBeLessThan(0.005);
        }
        // The width-normalized share differs between the shapes by the
        // short-over-width factor — red under the retired width rule.
        const widthShare =
          shares.legend * Math.min(1, 1 / aspect);
        const widthShare43 =
          baseline.legend * Math.min(1, 1 / aspectAt43);
        if (shape === "16:9") {
          expect(
            Math.abs(widthShare - widthShare43),
          ).toBeGreaterThan(widthShare43 * 0.15);
        }
      }
      await page.getByRole("radio", { name: "4:3", exact: true }).click();
    });

    await test.step("each element's own four steps are the only thing that moves it", async () => {
      // Criterion 3 asks for four RENDERED measurements per element; the
      // first version measured the shared arithmetic and clicked only the
      // map-size control.
      const controls: Array<[string, keyof typeof baseline]> = [
        ["Legend size", "legend"],
        ["Widget size", "rail"],
        ["Title size", "title"],
        ["Credit size", "credit"],
      ];
      for (const [label, key] of controls) {
        const seen: number[] = [];
        for (const step of ["XS", "S", "M", "L"]) {
          await page
            .getByRole("radiogroup", { name: label })
            .getByRole("radio", { name: step, exact: true })
            .click();
          seen.push((await elementShares(page))[key]);
        }
        // Four distinct sizes, ordered — and the S/M/L ratios are the
        // ones the app has always drawn.
        expect(new Set(seen.map((v) => v.toFixed(4))).size, `${key} steps`).toBe(4);
        expect(seen[0]).toBeLessThan(seen[1]);
        expect(seen[1]).toBeLessThan(seen[2]);
        expect(seen[2]).toBeLessThan(seen[3]);
        expect(seen[1] / seen[2]).toBeCloseTo(0.8, 2);
        expect(seen[3] / seen[2]).toBeCloseTo(1.3, 2);
        // Back to the card's OPENING step, because the window-resize
        // comparison below runs against the baseline captured at open —
        // S since the field round made S the seed.
        await page
          .getByRole("radiogroup", { name: label })
          .getByRole("radio", { name: "S", exact: true })
          .click();
      }
    });

    await test.step("across a deliberately different window size — the defect this fixes", async () => {
      const frameBefore = await page
        .locator('[data-export-card] [class*="frameBox"]')
        .first()
        .boundingBox();
      await page.setViewportSize({ width: 900, height: 700 });
      await expect
        .poll(async () => {
          const box = await page
            .locator('[data-export-card] [class*="frameBox"]')
            .first()
            .boundingBox();
          return Math.round(box?.width ?? 0);
        })
        .not.toBe(Math.round(frameBefore?.width ?? 0));
      // The input really varied — otherwise the assertion below would
      // hold for the wrong reason.
      const shares = await elementShares(page);
      for (const key of Object.keys(baseline)) {
        expect(
          Math.abs(shares[key] - baseline[key]),
          `${key} moved when the browser window changed`,
        ).toBeLessThan(0.005);
      }
    });
  });

  test("the shape drags to any ratio, names it, and lands exact pixels", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page);
    await openBuilder(page, mapId);
    await openCard(page);

    // Custom is a peer of the presets: its card enters the resize
    // state, which is where the sash lives — before it, no resize
    // affordance exists at all.
    const sashButton = page.getByRole("button", {
      name: "Drag to change the image's shape",
    });
    await expect(sashButton).toHaveCount(0);
    await page.getByRole("radio", { name: "Custom" }).click();
    await expect(
      page.getByRole("radio", { name: "Custom" }),
    ).toHaveAttribute("aria-checked", "true");
    const sash = sashButton;
    await expect(sash).toBeVisible();

    const box = await sash.boundingBox();
    const frame = await page
      .locator('[data-export-card] [class*="frameBox"]')
      .first()
      .boundingBox();
    if (!box || !frame) throw new Error("sash not on screen");

    // Drag the bottom edge to a height decisively outside every snap
    // window: 1.15 sits between 1:1's (≤1.04) and 4:3's (≥1.28) — the
    // first fixture used 1.37, which is INSIDE 4:3's ±4% window, so the
    // drag itself snapped and the sash unmounted under the next step.
    // The sash tracks the bottom edge about the frame's CENTRE (it is
    // vertically centered in its stage), so the aim is centre + h/2.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2,
      frame.y + frame.height / 2 + frame.width / 1.15 / 2,
      { steps: 8 },
    );
    await page.mouse.up();

    // The card names what it produced, and no preset is checked.
    await expect(page.getByText(/Custom · /)).toBeVisible();
    for (const preset of ["16:9", "4:3", "1:1"]) {
      await expect(
        page.getByRole("radio", { name: preset }),
      ).toHaveAttribute("aria-checked", "false");
    }

    // A release NEAR a preset snaps to it and hands the selection over —
    // the branch a deliberately awkward drag never executes (review
    // an untested branch is not verified).
    const frameLoc = page
      .locator('[data-export-card] [class*="frameBox"]')
      .first();
    const sash2 = await sash.boundingBox();
    if (!sash2) throw new Error("sash not on screen");
    await page.mouse.move(sash2.x + sash2.width / 2, sash2.y + sash2.height / 2);
    await page.mouse.down();
    // Land within the snap window of 1:1. The display refits while the
    // frame grows, so the aim point moves — re-aim from the live frame
    // each step and converge instead of trusting a pre-drag width.
    for (let i = 0; i < 10; i += 1) {
      const live = await frameLoc.boundingBox();
      if (!live) throw new Error("frame vanished mid-drag");
      await page.mouse.move(
        sash2.x + sash2.width / 2,
        live.y + live.height / 2 + live.width / 2,
        { steps: 2 },
      );
    }
    await page.mouse.up();
    await expect(page.getByRole("radio", { name: "1:1" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByRole("radio", { name: "Custom" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // The right-edge sash (field round): the width axis has its own
    // handle. From the 1:1 snap, re-enter Custom and drag the right
    // edge out to a ratio decisively off every snap window (1.15 again).
    // The sash computes the ratio from the POINTER about the frame's
    // fixed centre, so converging the aim on the live height lands the
    // exact ratio whichever axis the display happens to bind.
    await page.getByRole("radio", { name: "Custom" }).click();
    const rightSash = page.getByRole("button", {
      name: "Drag sideways to change the image's shape",
    });
    await expect(rightSash).toBeVisible();
    const rBox = await rightSash.boundingBox();
    if (!rBox) throw new Error("right sash not on screen");
    await page.mouse.move(rBox.x + rBox.width / 2, rBox.y + rBox.height / 2);
    await page.mouse.down();
    for (let i = 0; i < 10; i += 1) {
      const live = await frameLoc.boundingBox();
      if (!live) throw new Error("frame vanished mid-drag");
      await page.mouse.move(
        live.x + live.width / 2 + (live.height * 1.15) / 2,
        rBox.y + rBox.height / 2,
        { steps: 2 },
      );
    }
    await page.mouse.up();
    await expect(page.getByText(/Custom · /)).toBeVisible();
    for (const preset of ["16:9", "4:3", "1:1"]) {
      await expect(
        page.getByRole("radio", { name: preset }),
      ).toHaveAttribute("aria-checked", "false");
    }

    // ...and the snapped shape is exact, not near: back to Custom for
    // the download half of the arm.
    await page.getByRole("radio", { name: "Custom" }).click();
    const sash3 = await sashButton.boundingBox();
    if (!sash3) throw new Error("sash gone after re-entry");
    await page.mouse.move(sash3.x + sash3.width / 2, sash3.y + sash3.height / 2);
    await page.mouse.down();
    for (let i = 0; i < 10; i += 1) {
      const live = await frameLoc.boundingBox();
      if (!live) throw new Error("frame vanished mid-drag");
      await page.mouse.move(
        sash3.x + sash3.width / 2,
        live.y + live.height / 2 + live.width / 1.15 / 2,
        { steps: 2 },
      );
    }
    await page.mouse.up();
    await expect(page.getByText(/Custom · /)).toBeVisible();

    // The output is exactly what the card says — compared against the
    // downloaded file, not against the label the card derived.
    const stated = await page
      .getByText(/output \d+ × \d+ px/)
      .textContent();
    const [, w, h] = /output (\d+) × (\d+) px/.exec(stated ?? "") ?? [];
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.locator("[data-export-download]").click(),
    ]);
    const file = await download.path();
    const png = readFileSync(file);
    expect(png.readUInt32BE(16)).toBe(Number(w));
    expect(png.readUInt32BE(20)).toBe(Number(h));
  });


  test("the moved control disables with its reason, and imagery says why", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page);

    await test.step("a camera near the engine's ceiling disables the finest steps", async () => {
      // The card opens at S or the first coarser step the engine can
      // draw from the author's camera; finer steps are offered
      // disabled, with the reason on the control. The camera is driven
      // to the runtime ceiling through the real control — the arm's
      // former patched viewport presupposed the retired zoom-22 ceiling
 // (moved to 24 on, unexercised in the CI-dead window)
      // and did not survive the builder's own open-time framing.
      await openBuilder(page, mapId);
      const zoomIn = page.getByRole("button", { name: "Zoom in" });
      await expect
        .poll(
          async () => {
            await zoomIn.click();
            const text =
              (await page.locator("[data-status-bar]").textContent()) ?? "";
            const m = text.match(/Zoom(\d+(?:\.\d+)?)/);
            return m ? Number(m[1]) : 0;
          },
          { timeout: 60_000 },
        )
        .toBeGreaterThanOrEqual(24);
      await openCard(page);
      const group = page.getByRole("radiogroup", {
        name: "Basemap label and symbol size",
      });
      await expect(group.getByRole("radio", { name: "XS" })).toBeDisabled();
      await expect(
        group.getByRole("radio", { name: "XS" }),
      ).toHaveAttribute("data-hint", /as far in as it goes/);
      await page.getByRole("button", { name: "Close" }).click();
    });

    await test.step("imagery keeps the control and words the missing groups", async () => {
      // Imagery is a configured basemap, not a shipped one. Where the
      // instance configures none there is no imagery to open the card
      // on, and the picker must offer no card for it either.
      const configured = await page.evaluate(async () => {
        const r = await fetch("/api/config");
        const body = (await r.json()) as { basemaps: { key: string }[] };
        return body.basemaps.some((b) => b.key === "satellite");
      });
      if (!configured) {
        await openBuilder(page, mapId);
        await page.getByRole("tab", { name: "Basemap" }).click();
        await expect(
          page.getByRole("button", { name: "Satellite", exact: true }),
        ).toHaveCount(0);
        return;
      }
      await page.evaluate(
        async ({ mapId }) => {
          await (async function readThenWriteSetup() { const basis = await (await fetch(`/api/maps/${mapId}`)).json(); return fetch(`/api/maps/${mapId}`, {
            method: "PATCH",
            headers: { "X-Edit-Revision": basis.editRevision, "content-type": "application/json" },
            body: JSON.stringify({
              viewport: { lng: 13.4, lat: 52.5, zoom: 10, pitch: 0, bearing: 0 },
              basemap: "satellite",
            }),
          }); })();
        },
        { mapId },
      );
      await openBuilder(page, mapId);
      await openCard(page);
      await expect(
        page.getByRole("radiogroup", { name: "Basemap label and symbol size" }),
      ).toBeVisible();
      await expect(
        page.getByText(/Imagery basemap: no layers./),
      ).toBeVisible();
      await expect(
        page.getByRole("checkbox", { name: "Labels", exact: true }),
      ).toHaveCount(0);
    });
  });

  test("a basemap override changes the image and leaves the map alone", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page);
    await openBuilder(page, mapId);
    await openCard(page);

    const stored = async () =>
      page.evaluate(async (id) => {
        const r = await fetch(`/api/maps/${id}`);
        return ((await r.json()) as { basemapLayers: unknown }).basemapLayers;
      }, mapId);
    const before = await stored();

    // Labels off for this shot: the composition's basemap prop changes,
    // which is what the render route reads too.
    await page
      .getByRole("checkbox", { name: "Labels", exact: true })
      .uncheck();
    await expect(
      page.getByRole("checkbox", { name: "Labels", exact: true }),
    ).not.toBeChecked();
    await page.getByRole("checkbox", { name: "Roads", exact: true }).uncheck();

    // The saved map never learns about it.
    expect(await stored()).toEqual(before);

    // ...and reopening starts from the map's own choices again.
    await page.getByRole("button", { name: "Close" }).click();
    await openCard(page);
    await expect(
      page.getByRole("checkbox", { name: "Labels", exact: true }),
    ).toBeChecked();
  });
});

test.describe("the dialog's room", () => {
  // The catalog's widest frame, measured rendered, plus
  // the room's destination: the rail keeps 300px, so the
  // default composition — which the old 1060px frame displayed scaled
  // down at ~720px — now shows meaningfully larger.
  test("the export dialog takes the catalog's widest frame; the preview gets the room", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    // The frame needs 1320+48 by 820+48 of viewport to render at full
    // size; the suite default is smaller, and a capped frame would make
    // the exact-size assertion meaningless.
    await page.setViewportSize({ width: 1600, height: 1000 });
    const { mapId } = await seed(page);
    await openBuilder(page, mapId);
    await openCard(page);

    const settled = async (dialog: Locator) => {
      let last = "";
      await expect
        .poll(async () => {
          const b = await dialog.boundingBox();
          const now = b ? `${Math.round(b.width)}:${Math.round(b.height)}` : "";
          const stable = now !== "" && now === last;
          last = now;
          return stable;
        })
        .toBe(true);
      return (await dialog.boundingBox())!;
    };

    const card = page.getByRole("dialog", { name: "Export image" });
    const box = await settled(card);
    expect(Math.round(box.width)).toBe(1320);
    expect(Math.round(box.height)).toBe(820);

    const rail = await page
      .locator('[data-export-card] [class*="rail"]')
      .filter({ hasText: "Shape" })
      .boundingBox();
    expect(Math.round(rail!.width)).toBe(300);
    const frame = await page
      .locator('[data-export-card] [class*="frameBox"]')
      .boundingBox();
    expect(frame!.width).toBeGreaterThan(900);

    // The same rendered box as the catalog's widest frame (the SQL
    // source view) — one dialog species, one big-task size.
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const catalog = page.getByRole("dialog", { name: "Add layer" });
    await catalog.getByRole("button", { name: /^SQL query/ }).click();
    const catalogBox = await settled(catalog);
    expect(Math.round(catalogBox.width)).toBe(Math.round(box.width));
    expect(Math.round(catalogBox.height)).toBe(Math.round(box.height));
    await page.keyboard.press("Escape");

    expect(
      consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
    ).toEqual([]);
  });
});

test.describe("the short side holds the steps steady", () => {
  test("stepping the basemap size never moves the preview frame", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page);
    await openBuilder(page, mapId);
    await openCard(page);
    await page.getByRole("radio", { name: "16:9", exact: true }).click();

    const frameLoc = page
      .locator('[data-export-card] [class*="frameBox"]')
      .first();
    const stage = await page
      .locator('[data-export-card] [class*="stage"]')
      .first()
      .boundingBox();
    const before = await frameLoc.boundingBox();
    if (!stage || !before) throw new Error("no stage geometry");

    // The frame is the largest uniform fit: it reaches the stage's
    // bound on at least one axis.
    const reaches = (b: { width: number; height: number }) =>
      Math.abs(b.width - stage.width) < 6 || Math.abs(b.height - stage.height) < 6;
    expect(reaches(before), "the frame fills its stage at S").toBe(true);

    for (const step of ["L", "XS", "S"]) {
      await page
        .getByRole("radiogroup", { name: "Basemap label and symbol size" })
        .getByRole("radio", { name: step, exact: true })
        .click();
      const after = await frameLoc.boundingBox();
      // Under the earlier display cap, L at 16:9 rendered the raw
      // 720×405 composition and the frame visibly shrank — this arm is
      // red against that behaviour.
      expect(
        Math.abs((after?.width ?? 0) - before.width),
        `frame width moved at ${step}`,
      ).toBeLessThan(3);
      expect(
        Math.abs((after?.height ?? 0) - before.height),
        `frame height moved at ${step}`,
      ).toBeLessThan(3);
    }
  });

  test("both roads draw one definition's overlays alike, landscape and portrait", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page);
    await openBuilder(page, mapId);
    await openCard(page);
    await page.getByLabel("Image title").fill("Share check");

    /** The equivalent definition, rendered on the server road's own
     * view (the render route hosts the same composition), measured
     * with the same layout-geometry probe. */
    const routeShares = async (def: Record<string, unknown>) => {
      const route = await context.newPage();
      await route.addInitScript((d) => {
        (window as unknown as Record<string, unknown>)[
          "__DEZFIL_EXPORT_DEFINITION__"
        ] = d;
      }, def);
      await route.goto(`/render/${mapId}`);
      await expect(route.locator("[data-export-ready]")).toBeVisible({
        timeout: 60_000,
      });
      const shares = await elementShares(route);
      await route.close();
      return shares;
    };

    const baseDef = {
      viewport: { lng: 13.37, lat: 52.5, zoom: 10.5, pitch: 0, bearing: 0 },
      legend: { visible: true, corner: "bottom-left", size: "s" },
      widgets: ["w-hist"],
      widgetSize: "s",
      title: { text: "Share check", size: "s" },
      credit: { corner: "bottom-right", size: "s" },
      appearance: "light",
    };

    await test.step("landscape: 16:9 at the opening step", async () => {
      await page.getByRole("radio", { name: "16:9", exact: true }).click();
      const card = await elementShares(page);
      const server = await routeShares({
        ...baseDef,
        size: { width: 1920, height: 1080 },
        // The S space at 16:9 — the card's own opening step geometry.
        mapScale: 1,
      });
      for (const key of Object.keys(card)) {
        expect(
          Math.abs(card[key] - server[key]),
          `${key} differs between the two roads at 16:9`,
        ).toBeLessThan(0.005);
      }
    });

    await test.step("portrait: the drag's 1:2 clamp", async () => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.getByRole("radio", { name: "Custom" }).click();
      const sash = page.getByRole("button", {
        name: "Drag to change the image's shape",
      });
      await expect(sash).toBeVisible();
      const frameLoc = page
        .locator('[data-export-card] [class*="frameBox"]')
        .first();
      const grip = await sash.boundingBox();
      if (!grip) throw new Error("sash not on screen");
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      // Aim past the 1:2 clamp each step; the display refits while the
      // frame narrows, so re-aim from the live frame and converge.
      for (let i = 0; i < 12; i += 1) {
        const live = await frameLoc.boundingBox();
        if (!live) throw new Error("frame vanished mid-drag");
        await page.mouse.move(
          grip.x + grip.width / 2,
          Math.min(live.y + live.height / 2 + live.width / 0.9, 2600),
          { steps: 2 },
        );
      }
      await page.mouse.up();
      await expect(page.getByText(/1 : 2\.00/)).toBeVisible();
      await expect(page.getByText("output 1920 × 3840 px")).toBeVisible();

      const card = await elementShares(page);
      const server = await routeShares({
        ...baseDef,
        size: { width: 1920, height: 3840 },
        // The S space in portrait is 1080 wide.
        mapScale: 1920 / 1080,
      });
      for (const key of Object.keys(card)) {
        expect(
          Math.abs(card[key] - server[key]),
          `${key} differs between the two roads at 1:2`,
        ).toBeLessThan(0.005);
      }
    });
  });

  test("the failure prose rides the short side too — server road", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page);
    await page.goto(`/maps/${mapId}`);

    // The failure surface only exists where a layer could not answer,
    // which is the server road's own state — so it is measured there
    // rather than claimed from the arithmetic it shares with the
    // insets. A landscape shape, where the two rules disagree.
    const route = await context.newPage();
    await route.route("**/api/layers/*/render", (r) => r.abort());
    await route.addInitScript((d) => {
      (window as unknown as Record<string, unknown>)[
        "__DEZFIL_EXPORT_DEFINITION__"
      ] = d;
    }, {
      viewport: { lng: 13.37, lat: 52.5, zoom: 10.5, pitch: 0, bearing: 0 },
      size: { width: 1920, height: 1080 },
      legend: { visible: false, corner: "bottom-left", size: "s" },
      widgets: [] as string[],
      title: null as null,
      appearance: "light",
      mapScale: 1,
    });
    await route.goto(`/render/${mapId}`);
    await expect(route.locator("[data-export-ready]")).toBeVisible({
      timeout: 60_000,
    });

    const measured = await route.evaluate(() => {
      const frame = document.querySelector<HTMLElement>(
        "[data-export-composition]",
      );
      const note = frame?.querySelector<HTMLElement>('[class*="failures"]');
      if (!frame || !note) return null;
      const scale = getComputedStyle(note).scale;
      return {
        applied: Number(scale === "none" ? 1 : scale.split(" ")[0]),
        short: Math.min(frame.offsetWidth, frame.offsetHeight),
        text: note.textContent ?? "",
      };
    });
    if (!measured) throw new Error("no failure prose was drawn");

    // It said something truthful, and it is drawn at the short side's
    // scale — 1080/540 = 2 here. Under the retired width rule the same
    // 16:9 composition would have drawn it at 1920/720 ≈ 2.67.
    expect(measured.text.length).toBeGreaterThan(0);
    expect(measured.applied).toBeCloseTo(measured.short / 540, 3);
    expect(measured.applied).not.toBeCloseTo(1920 / 720, 2);
    await route.close();
  });
});
