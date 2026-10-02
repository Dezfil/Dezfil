import type { EditBasis } from "../src/lib/edit-basis";
// Resting baselines for the two-tone operation set (plan's pixel round):
// the four surfaces that draw an operation's pictogram, captured at rest
// in both themes — the builder drawer's catalog, the canvas pane's Tools
// rows, a Badge tile's face, and the node panel's head. Icon rendering
// is the pixel layer's to hold (the verification policy's third layer);
// the baselines are minted on the branch and accepted by a field round
// against the named references.
//
// Baselines are darwin-generated; the spec skips visibly elsewhere.
// Deterministic content only: the drawer and pane show the catalog's own
// fixed labels, captured group by group so the scrolling lists hide no
// drawing; the tile face and panel head are captured as their icon boxes
// alone, so run-scoped names stay outside every shot.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, addLayer, createMap, routeHouse, seedCsv, trackConsole } from "./support";
import { isAllowedConsoleError } from "./console-allowlist";

test.skip(process.platform !== "darwin", "pixel baselines are darwin-generated; no baseline exists for this platform");

const runId = Date.now().toString(36);
const tableName = `oip_${runId}`;

async function api(page: Page, method: string, pathName: string, body?: unknown, basis?: EditBasis): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ({ method, pathName, body, basis }) => {
      const r = await fetch(pathName, { method, headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok) throw new Error(`${method} ${pathName} → ${r.status}`);
      return (await r.json()) as Record<string, unknown>;
    },
    { method, pathName, body, basis },
  );
}

for (const theme of ["light", "dark"] as const) {
  test(`operation pictograms match their ${theme} baselines`, async ({ page, context }) => {
    const consoleErrors = trackConsole(page);
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    await routeHouse(context);

    // The canvas pane's Tools rows, a tile's face and the panel's head.
    await page.goto("/workflows");
    await seedCsv(page, tableName, readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8"));
    const recipe = (await api(page, "POST", "/api/recipes", { name: `Icon pixels ${theme} ${runId}` })).recipe as { id: string };
    await api(page, "POST", `/api/recipes/${recipe.id}/steps`, { operation: "sql_step", parameters: { sql: `SELECT * FROM ${tableName}`, name: `oip_out_${theme}_${runId}` } });
    await page.goto(`/workflows/${recipe.id}`);
    await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
    await page.waitForTimeout(400);

    // Every catalog drawing is inside a shot: the lists scroll, so each
    // of the six groups is captured as its own element (found at review:
    // a clipped list left the lower groups, the renamed verbs included,
    // unmeasured).
    const GROUPS = ["Data", "Overlay", "Proximity", "Geometry", "Aggregation", "Statistics"];
    await page.locator("[data-canvas-pane]").getByRole("tab", { name: /^Tools/ }).click();
    await expect(page.locator('[data-canvas-pane] [data-grp="Proximity"]').first()).toBeVisible();
    for (const group of GROUPS) {
      const section = page.locator(`[data-canvas-pane] [data-pane-group="${group}"]`);
      await expect(section.locator("p").first()).toHaveText(group);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toHaveScreenshot(`pane-${group.toLowerCase()}-${theme}.png`, { animations: "disabled" });
    }

    const face = page.locator('[data-node][data-kind="node"] [data-v]').first();
    await expect(face).toBeVisible();
    await expect(face).toHaveScreenshot(`tile-face-${theme}.png`, { animations: "disabled" });

    await face.click();
    const head = page.locator('[data-node-panel] span[class*="inspTile"]').first();
    await expect(head).toBeVisible();
    await expect(head).toHaveScreenshot(`panel-head-${theme}.png`, { animations: "disabled" });

    // The builder drawer's catalog, at rest.
    const mapId = await createMap(page, `Icon pixels ${theme}`);
    await addLayer(page, mapId, "alpha", `SELECT * FROM "${tableName}"`);
    await page.goto(`/maps/${mapId}`);
    await expect(page.locator("[data-tools-control]")).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-tools-control]").click();
    const picker = page.locator("[data-operation-picker]");
    await expect(picker).toBeVisible();
    await expect(picker.locator('[data-operation="buffer"]')).toBeVisible();
    for (const group of GROUPS) {
      const section = picker.locator(`[data-catalog-group="${group}"]`);
      await expect(section.locator("p").first()).toHaveText(group);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toHaveScreenshot(`drawer-${group.toLowerCase()}-${theme}.png`, { animations: "disabled" });
    }

    const unexpected = consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url));
    expect(unexpected).toEqual([]);
  });
}
