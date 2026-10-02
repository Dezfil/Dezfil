// Resting baselines for the surfaces hit-floor and focus work touched
// but no existing baseline represents: the layer list, the
// Widgets tab, the histogram card, the canvas legend, and the class
// editing block — both themes. These hold the "no resting drift" claim:
// the floors come from padding/margin compensation, so the resting
// render must look exactly as it did.
//
// Baselines are darwin-generated; the spec skips visibly elsewhere.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FIXTURES_DIR,
  createMap,
  addLayer,
  patchLayer,
  patchMap,
  routeHouse,
  seedCsv,
  trackConsole,
} from "./support";
import { isAllowedConsoleError } from "./console-allowlist";

test.skip(
  process.platform !== "darwin",
  "pixel baselines are darwin-generated; no baseline exists for this platform",
);

const runId = Date.now().toString(36);
const tableName = `arp_${runId}`;

async function seed(
  page: Page,
): Promise<{ mapId: string; layerId: string }> {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  const mapId = await createMap(page, "Resting");
  const layerId = await addLayer(
    page,
    mapId,
    "alpha",
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

for (const theme of ["light", "dark"] as const) {
  test(`resting surfaces match their ${theme} baselines`, async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    await routeHouse(context);
    const { mapId, layerId } = await seed(page);
    // `?layer=` selects the layer server-side, so the expanded class
    // editor — swatches and boundary fields — is inside the shot: the
    // collapsed card alone would overclaim the guard.
    await page.goto(`/maps/${mapId}?layer=${layerId}`);
    await expect(page.getByText("12 features").first()).toBeVisible({
      timeout: 30_000,
    });

    // The layer list with the selected card's class editing visible.
    await expect(
      page.getByRole("textbox", { name: "Fill class boundary 1" }),
    ).toBeVisible();
    await expect(page.locator('ul[class*="LayerList"]')).toHaveScreenshot(
      `layer-list-${theme}.png`,
      { animations: "disabled" },
    );

    // The histogram card in the rail (its handles' floor is invisible).
    const railCard = page.locator('[data-widget-card="histogram"]');
    await expect(railCard).toBeVisible();
    await expect(railCard).toHaveScreenshot(`histogram-card-${theme}.png`, {
      animations: "disabled",
    });

    // The canvas legend (editable text became buttons dressed as text).
    const legend = page.locator("[data-corner]").first();
    await expect(legend).toBeVisible();
    await expect(legend).toHaveScreenshot(`canvas-legend-${theme}.png`, {
      animations: "disabled",
    });

    // The Widgets tab rows (the grip became a button, same 11px seat).
    await page.getByRole("tab", { name: "Widgets" }).click();
    await expect(
      page.getByRole("button", { name: "Reorder Riders" }),
    ).toBeVisible();
    await expect(page.locator("[data-widgets-tab]")).toHaveScreenshot(
      `widgets-tab-${theme}.png`,
      { animations: "disabled" },
    );

    // The owed focused-handle baseline. Add the filter only after the
    // existing resting shots, so those baselines keep representing the
    // surfaces they originally froze rather than absorbing a new section.
    await patchLayer(page, layerId, {
      filters: [{ kind: "range", field: "riders", min: null, max: null }],
    });
    await page.goto(`/maps/${mapId}?layer=${layerId}`);
    const minimum = page.getByRole("slider", { name: "Minimum" });
    await expect(minimum).toBeVisible({ timeout: 30_000 });
    await minimum.focus();
    await expect(minimum).toBeFocused();
    // Hold the whole filter card: the knob's 2px outline + offset extends
    // beyond the brush's zero-bottom-padding box, so a brush-only crop cuts
    // off the very focus ring this baseline exists to protect.
    const focusedFilter = page
      .locator('div[class*="filter"]')
      .filter({ has: minimum })
      .first();
    await expect(focusedFilter).toHaveScreenshot(
      `focused-filter-handle-${theme}.png`,
      { animations: "disabled" },
    );

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });

  test(`published title matches its ${theme} baseline`, async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/maps");
    const mapId = await createMap(page, `Published title ${theme}`);
    const token = await page.evaluate(
      async ({ id, authoredTheme }) => {
        const response = await (async function readThenWritePublicationSetup() { const basis = await (await fetch(`/api/maps/${id}`)).json(); return fetch(`/api/maps/${id}/publish`, {
          method: "POST",
          headers: { "X-Edit-Revision": basis.editRevision, "content-type": "application/json" },
          body: JSON.stringify({ theme: authoredTheme }),
        }); })();
        if (!response.ok) throw new Error(await response.text());
        return ((await response.json()) as { token: string }).token;
      },
      { id: mapId, authoredTheme: theme },
    );
    await page.goto(`/v/${token}`);
    const title = page.locator('header[class*="titleBar"]');
    await expect(title).toContainText(`Published title ${theme}`);
    await expect(title).toHaveScreenshot(`published-title-${theme}.png`, {
      animations: "disabled",
    });

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });
}
