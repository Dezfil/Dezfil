// The control vocabulary: a state flips a switch, a list checks boxes —
// asserted by role and by persisted truth, per surface, against the
// spec's inventories.
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
  patchMap,
  seedFile,
  trackConsole,
} from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `vocab_${runId}`;

const WIDE = { width: 1440, height: 900 };

/** A title at the 60-char cap — the longest a widget can carry — so it
 * must wrap beside the 36px switch track in the export rail's 300px
 * column. */
const LONG_TITLE =
  "Average weekday riders per station across the Berlin network";

async function seedMap(page: Page): Promise<string> {
  await page.goto("/maps");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `vocab ${runId}`);
  const layerId = await addLayer(
    page,
    mapId,
    stations,
    `SELECT * FROM ${stations}`,
  );
  // Two widgets so the export dialog's rows exist to be censused: one
  // visible, one map-hidden with a long title — the hidden one proves
  // the for-this-image-only seeding, the long one the wrap.
  await patchMap(page, mapId, {
    widgets: [
      {
        id: "w-vis",
        type: "formula",
        layerId,
        title: "Riders",
        field: null,
        agg: "count",
        aggField: null,
        unit: null,
        note: null,
        format: null,
        visible: true,
      },
      {
        id: "w-hid",
        type: "note",
        layerId: null,
        title: LONG_TITLE,
        field: null,
        agg: "count",
        aggField: null,
        unit: null,
        note: "For this image only.",
        format: null,
        visible: false,
      },
    ],
  });
  return mapId;
}

const mapField = async (page: Page, mapId: string, pick: string) =>
  page.evaluate(
    async ({ id, pick }) => {
      const m = (await (
        await fetch(`/api/maps/${id}`, { cache: "no-store" })
      ).json()) as Record<string, unknown> & {
        layers: Record<string, unknown>[];
      };
      return pick === "widgetsPublished"
        ? m.widgetsPublished
        : (m.layers[0] as Record<string, unknown>)[pick];
    },
    { id: mapId, pick },
  );

test.use({ viewport: WIDE });

test("switches for states, checkboxes for lists — roles and persistence per surface", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  // Widgets tab: the published toggle is a switch and persists.
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Widgets" })
    .click();
  const published = page.getByRole("switch", {
    name: "Show widgets on published view",
  });
  await expect(published).toBeVisible();
  const before = (await mapField(page, mapId, "widgetsPublished")) as boolean;
  await published.click();
  await expect
    .poll(async () => mapField(page, mapId, "widgetsPublished"))
    .toBe(!before);
  await published.click();
  await expect
    .poll(async () => mapField(page, mapId, "widgetsPublished"))
    .toBe(before);

  // Style panel, hexbin: Extrude is a switch; the tooltip/pop-up
  // sections pair an Automatic switch with field checkboxes.
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Layers" })
    .click();
  await page.locator("[data-layer-select]").first().click();
  await page.getByRole("button", { name: "Hex bins", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Extrude cells (3D)" }),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Points", exact: true }).click();
  const autoTooltip = page
    .getByRole("switch", { name: "Automatic (first fields)" })
    .first();
  await expect(autoTooltip).toBeVisible();
  await expect(autoTooltip).toBeChecked();
  await autoTooltip.click();
  // The field list appears as checkboxes; picking one persists the list.
  const nameField = page.getByRole("checkbox", { name: "name", exact: true }).first();
  await expect(nameField).toBeVisible();
  // A controlled input settles through the persistence round-trip; the
  // API poll below is the real assertion, so a plain click avoids the
  // kit-checkbox race uncheck() sometimes loses.
  await nameField.click();
  await expect
    .poll(async () => {
      const t = (await mapField(page, mapId, "tooltip")) as string[] | null;
      return Array.isArray(t) && !t.includes("name");
    })
    .toBe(true);
  await autoTooltip.click();
  await expect
    .poll(async () => mapField(page, mapId, "tooltip"))
    .toBe(null);

  // Legend tab rows stay checkboxes (membership). (Rows are
  // data-legend-row divs sortable tab.)
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Legend" })
    .click();
  await expect(
    page
      .locator("[data-legend-row]")
      .filter({ hasText: stations })
      .getByRole("checkbox")
      .first(),
  ).toBeVisible();

  // Export dialog: include-the-legend is a switch, and each widget row
  // is one too — the ruled exception to the pick-many rule,
  // this list alone. The basemap-group rows stay checkboxes.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /Image/ }).click();
  const dialog = page.getByRole("dialog", { name: "Export image" });
  await expect(
    dialog.getByRole("switch", { name: "Include the legend" }),
  ).toBeVisible();

  // Widget rows: switches, seeded from the map's widget visibility.
  await expect(
    dialog.getByRole("switch", { name: "Riders", exact: true }),
  ).toBeChecked();
  const hidRow = dialog.getByRole("switch", { name: LONG_TITLE });
  await expect(hidRow).not.toBeChecked();

  // The long title wraps beside the track instead of leaving the rail —
  // measured on the TEXT's own rendered line boxes, not the row (a
  // one-line switch row is already 32px tall, so a row-height check
  // cannot fail; PR round finding). Every line box must also end inside
  // the section, so clipping cannot pass as wrapping.
  const wrap = await dialog
    .locator("label")
    .filter({ hasText: LONG_TITLE })
    .evaluate((el) => {
      const section = el.closest("section")!.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const ys = new Set<number>();
      let maxRight = -Infinity;
      let text = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        text += n.textContent ?? "";
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width === 0) continue;
          ys.add(Math.round(r.y));
          maxRight = Math.max(maxRight, r.right);
        }
      }
      return { lines: ys.size, overshoot: maxRight - section.right, text };
    });
  expect(wrap.text).toContain(LONG_TITLE);
  expect(wrap.lines).toBeGreaterThanOrEqual(2);
  expect(wrap.overshoot).toBeLessThanOrEqual(1);

  // A map-hidden widget switched on joins the preview; the stored map
  // never learns about it, and reopening reseeds from the map. Pointer
  // first, then the keyboard round-trip — each toggles only its row.
  await hidRow.check();
  await expect(dialog.locator('[data-widget-card="note"]')).toBeVisible();
  await hidRow.focus();
  await page.keyboard.press("Space");
  await expect(hidRow).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(hidRow).toBeChecked();
  await expect(
    dialog.getByRole("switch", { name: "Riders", exact: true }),
  ).toBeChecked();
  const widgetVisibility = () =>
    page.evaluate(async (id) => {
      const m = (await (
        await fetch(`/api/maps/${id}`, { cache: "no-store" })
      ).json()) as { widgets: Array<{ id: string; visible: boolean }> };
      return Object.fromEntries(m.widgets.map((w) => [w.id, w.visible]));
    }, mapId);
  expect(await widgetVisibility()).toEqual({ "w-vis": true, "w-hid": false });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /Image/ }).click();
  await expect(
    dialog.getByRole("switch", { name: LONG_TITLE }),
  ).not.toBeChecked();

  // Basemap groups stay checkboxes.
  await expect(
    dialog.getByRole("checkbox", { name: "Labels", exact: true }),
  ).toBeVisible();
  expect(
    await dialog.getByRole("checkbox").count(),
  ).toBeGreaterThan(0);
  await page.keyboard.press("Escape");

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
