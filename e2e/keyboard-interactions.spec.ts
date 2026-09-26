// Keyboard drives for the accessibility pass (7): the three
// direct-manipulation families that had no keyboard path — layer and
// widget-row reordering, the histogram brush, and canvas-legend entry —
// each driven end to end with the keyboard alone, asserting operation,
// accessible names, announcements, focus destinations, and visible focus
// in both themes. The widget RAIL must NOT grow a reorder control (the
// spec's declined-alternative boundary): its keyboard path is the
// Widgets tab, which edits the same persisted order.
//
// Environment: the documented verification gate — run via
// `npm run e2e:keyboard` with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  createMap,
  addLayer,
  layerSaveArrived,
  mapSaveArrived,
  patchLayer,
  patchMap,
  publishMap,
  routeHouse,
  saveSettled,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `kbi_${runId}`;

/** Walk Tab until the target holds focus. */
async function tabTo(
  page: Page,
  target: Locator,
  what: string,
  maxTabs = 120,
): Promise<void> {
  for (let i = 0; i < maxTabs; i += 1) {
    const focused = await target
      .evaluate((el) => el === document.activeElement)
      .catch(() => false);
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`${what} is not reachable by keyboard (${maxTabs} Tabs)`);
}

async function expectFocusedStop(target: Locator, what: string) {
  await expect(target, what).toBeFocused();
  const visible = await target.evaluate((el) => el.matches(":focus-visible"));
  expect(visible, `${what} shows visible focus`).toBe(true);
}

/** dnd-kit mounts one assertive live region per sortable context (the
 * layer list and the Widgets tab both hold one), so an announcement
 * assertion filters across them by text. */
const expectAnnounced = (page: Page, text: string) =>
  expect(
    page.locator('[id^="DndLiveRegion"]').filter({ hasText: text }),
  ).not.toHaveCount(0);

async function seedTwoLayerMap(page: Page): Promise<{
  mapId: string;
  alphaId: string;
  betaId: string;
}> {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  const mapId = await createMap(page, "Keyboard interactions");
  const alphaId = await addLayer(
    page,
    mapId,
    "alpha",
    `SELECT * FROM "${tableName}"`,
  );
  const betaId = await addLayer(
    page,
    mapId,
    "beta",
    `SELECT * FROM "${tableName}"`,
  );
  return { mapId, alphaId, betaId };
}

test.describe("keyboard interactions", () => {
  test("layers and widget rows reorder from the keyboard; the rail stays pointer-only", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    const { mapId, alphaId, betaId } = await seedTwoLayerMap(page);

    await test.step("layer list: pick up, move, drop — announced, persisted, focus kept", async () => {
      await page.goto(`/maps/${mapId}`);
      await expect(page.getByText("12 features").first()).toBeVisible({
        timeout: 30_000,
      });
      // Display order is top-first: beta (added last) sits at position 1.
      const grip = page.getByRole("button", { name: "Reorder beta", exact: true });
      await tabTo(page, grip, "the beta reorder grip");
      await expectFocusedStop(grip, "the beta reorder grip");

      await page.keyboard.press("Space");
      await expectAnnounced(page, "beta picked up, position 1 of 2.");
      // The drag's rect measurements commit an effect-cycle after the
      // pick-up announcement — a human's next keypress is comfortably
      // later; a driver's is not. One settle beat, then move.
      await page.waitForTimeout(250);
      await page.keyboard.press("ArrowDown");
      await expectAnnounced(page, "beta over position 2 of 2.");
      const saved = mapSaveArrived(page);
      await page.keyboard.press("Space");
      await expectAnnounced(page, "beta dropped at position 2 of 2.");
      await saved;
      await saveSettled(page);
      // Draw order is bottom-up, so beta at display position 2 is the
      // bottom layer — first in the persisted order.
      const layers = await page.evaluate(async (id) => {
        const r = await fetch(`/api/maps/${id}`, { cache: "no-store" });
        const m = (await r.json()) as { layers: { id: string }[] };
        return m.layers.map((l) => l.id);
      }, mapId);
      expect(layers[0]).toBe(betaId);
      expect(layers[1]).toBe(alphaId);
      // Focus came back to the moved item's grip.
      await expect(grip).toBeFocused();
    });

    await test.step("escape cancels a keyboard reorder", async () => {
      const grip = page.getByRole("button", { name: "Reorder beta", exact: true });
      await grip.focus();
      await page.keyboard.press("Space");
      // The sensor arms its key listener a tick after pick-up — await the
      // announcement before moving, as a real keyboard user would hear it.
      await expectAnnounced(page, "beta picked up, position 2 of 2.");
      // The drag's rect measurements commit an effect-cycle after the
      // pick-up announcement — a human's next keypress is comfortably
      // later; a driver's is not. One settle beat, then move.
      await page.waitForTimeout(250);
      await page.keyboard.press("ArrowUp");
      await expectAnnounced(page, "beta over position 1 of 2.");
      await page.keyboard.press("Escape");
      await expectAnnounced(page, "Reorder cancelled");
      const layers = await page.evaluate(async (id) => {
        const r = await fetch(`/api/maps/${id}`, { cache: "no-store" });
        const m = (await r.json()) as { layers: { id: string }[] };
        return m.layers.map((l) => l.id);
      }, mapId);
      expect(layers[0]).toBe(betaId);
    });

    await test.step("widgets tab rows reorder by keyboard; the rail carries no reorder control", async () => {
      await patchMap(page, mapId, {
        widgets: [
          {
            id: "w-first",
            type: "formula",
            layerId: alphaId,
            title: "First count",
            field: null,
            agg: "count",
            aggField: null,
            unit: null,
            note: null,
            format: null,
            visible: true,
          },
          {
            id: "w-second",
            type: "formula",
            layerId: alphaId,
            title: "Second count",
            field: null,
            agg: "count",
            aggField: null,
            unit: null,
            note: null,
            format: null,
            visible: true,
          },
        ],
      });
      await page.reload();
      await expect(page.locator("[data-widget-rail]")).toBeVisible();
      // The declined-alternative boundary holds: no rail reorder control.
      await expect(
        page
          .locator("[data-widget-rail]")
          .getByRole("button", { name: /^Reorder / }),
      ).toHaveCount(0);

      await page
        .getByRole("tab", { name: "Widgets" })
        .click();
      const rowGrip = page.getByRole("button", { name: "Reorder First count", exact: true });
      await expect(rowGrip).toBeVisible();
      await tabTo(page, rowGrip, "the widget row grip");
      await expectFocusedStop(rowGrip, "the widget row grip");
      await page.keyboard.press("Enter");
      await expectAnnounced(page, "First count picked up, position 1 of 2.");
      // The drag's rect measurements commit an effect-cycle after the
      // pick-up announcement — a human's next keypress is comfortably
      // later; a driver's is not. One settle beat, then move.
      await page.waitForTimeout(250);
      await page.keyboard.press("ArrowDown");
      await expectAnnounced(page, "First count over position 2 of 2.");
      const saved = mapSaveArrived(page);
      await page.keyboard.press("Enter");
      await expectAnnounced(page, "First count dropped at position 2 of 2.");
      await saved;
      await saveSettled(page);
      const widgets = await page.evaluate(async (id) => {
        const r = await fetch(`/api/maps/${id}`, { cache: "no-store" });
        const m = (await r.json()) as { widgets: { id: string }[] };
        return m.widgets.map((w) => w.id);
      }, mapId);
      expect(widgets).toEqual(["w-second", "w-first"]);
      // A reorder key on the grip must not toggle the row editor open.
      await expect(page.locator("[data-widget-row][data-expanded]")).toHaveCount(
        0,
      );
    });

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });

  test("the histogram brush adjusts by keyboard with one trailing settle — author and reader", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    const { mapId, alphaId } = await seedTwoLayerMap(page);
    await patchMap(page, mapId, {
      widgets: [
        {
          id: "w-hist",
          type: "histogram",
          layerId: alphaId,
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
      widgetsPublished: true,
    });

    const drive = async (root: Page, valuesPath: RegExp) => {
      const lo = root.getByRole("slider", { name: "Riders range start" });
      await expect(lo).toBeVisible({ timeout: 30_000 });
      const min = Number(await lo.getAttribute("aria-valuemin"));
      const max = Number(
        await root
          .getByRole("slider", { name: "Riders range end" })
          .getAttribute("aria-valuemax"),
      );
      expect(max).toBeGreaterThan(min);
      await tabTo(root, lo, "the range-start handle");
      await expectFocusedStop(lo, "the range-start handle");

      // A three-tap burst previews immediately and settles exactly once.
      let recomputes = 0;
      const counter = (r: { url(): string; method(): string }) => {
        if (r.method() === "POST" && valuesPath.test(r.url())) recomputes += 1;
      };
      root.on("request", counter);
      const before = Number(await lo.getAttribute("aria-valuenow"));
      await root.keyboard.press("ArrowRight");
      await root.keyboard.press("ArrowRight");
      await root.keyboard.press("ArrowUp");
      const step = (max - min) / 100;
      await expect
        .poll(async () => Number(await lo.getAttribute("aria-valuenow")))
        .toBeCloseTo(before + 3 * step, 5);
      // The settle trails the last tap (600ms) and lands one recompute.
      await expect.poll(() => recomputes, { timeout: 5_000 }).toBe(1);
      await root.waitForTimeout(800);
      expect(recomputes).toBe(1);
      root.off("request", counter);

      // Down/Left decrease; the handle never crosses its partner.
      await root.keyboard.press("ArrowDown");
      await expect
        .poll(async () => Number(await lo.getAttribute("aria-valuenow")))
        .toBeCloseTo(before + 2 * step, 5);
      const hi = root.getByRole("slider", { name: "Riders range end" });
      const hiNow = Number(await hi.getAttribute("aria-valuenow"));
      expect(Number(await lo.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(
        hiNow,
      );
      // The value is announced as text, not just a number.
      expect(await lo.getAttribute("aria-valuetext")).not.toBeNull();
    };

    await test.step("author: the builder rail histogram", async () => {
      await page.goto(`/maps/${mapId}`);
      await drive(page, /\/api\/maps\/[^/]+\/widget-values$/);
    });

    await test.step("reader: the published rail histogram", async () => {
      const token = await publishMap(page, mapId);
      await page.goto(`/v/${token}`);
      await drive(page, /\/api\/published\/[^/]+\/widget-values$/);
    });

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });

  test("canvas-legend titles, variable names, and labels edit from the keyboard, both themes", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    const { mapId, alphaId } = await seedTwoLayerMap(page);
    // A data-driven fill so the legend holds classes with editable labels.
    await patchLayer(page, alphaId, {
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
      pointRadius: 3,
      opacity: 1,
    },
    });

    await test.step("title: Enter hands focus to the Legend tab's field", async () => {
      await page.goto(`/maps/${mapId}`);
      await expect(page.getByText("12 features").first()).toBeVisible({
        timeout: 30_000,
      });
      const title = page.getByRole("button", {
        name: "Edit legend title, alpha",
      });
      await tabTo(page, title, "the legend title affordance");
      await expectFocusedStop(title, "the legend title affordance");
      await page.keyboard.press("Enter");
      const railTitle = page.getByRole("textbox", {
        name: "Legend title, alpha",
      });
      await expect(railTitle).toBeFocused();
    });

    await test.step("variable name: same hand-off to its rail field", async () => {
      const attr = page.getByRole("button", {
        name: "Edit fill variable name, alpha",
      });
      await tabTo(page, attr, "the variable-name affordance");
      await expectFocusedStop(attr, "the variable-name affordance");
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("textbox", { name: /variable name, alpha/ }),
      ).toBeFocused();
    });

    await test.step("slot label: in-place editor, Enter commits, Escape cancels", async () => {
      const label = page
        .getByRole("button", { name: /^Edit label ".*", alpha$/ })
        .first();
      await tabTo(page, label, "the first slot-label affordance");
      await expectFocusedStop(label, "the first slot-label affordance");
      await page.keyboard.press("Enter");
      const editor = page.locator('[class*="labelInput"]');
      await expect(editor).toBeFocused();
      const saved = layerSaveArrived(page);
      await editor.fill("Low riders");
      await page.keyboard.press("Enter");
      await saved;
      await expect(
        page.getByRole("button", { name: 'Edit label "Low riders", alpha' }),
      ).toBeVisible();
      // Escape cancels without committing.
      const again = page.getByRole("button", {
        name: 'Edit label "Low riders", alpha',
      });
      await again.focus();
      await page.keyboard.press("Enter");
      await editor.fill("Discarded");
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: 'Edit label "Low riders", alpha' }),
      ).toBeVisible();
    });

    await test.step("dark theme: the new keyboard stops stay visibly focused", async () => {
      await page.evaluate(() =>
        window.localStorage.setItem("dezfil-theme", "dark"),
      );
      await page.reload();
      await expect(page.getByText("12 features").first()).toBeVisible({
        timeout: 30_000,
      });
      for (const [locator, what] of [
        [
          page.getByRole("button", { name: "Reorder beta", exact: true }),
          "the reorder grip (dark)",
        ],
        [
          page.getByRole("button", { name: "Edit legend title, alpha" }),
          "the legend title affordance (dark)",
        ],
      ] as const) {
        await tabTo(page, locator, what);
        await expectFocusedStop(locator, what);
        const outline = await locator.evaluate(
          (el) => getComputedStyle(el).outlineStyle,
        );
        expect(outline, `${what} draws the ring`).toBe("solid");
      }
    });

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });
});
