// The isochrone verb through the Tools surface (the configured halves;
// the unconfigured row is held at the component layer, where served
// fixtures make both states reachable in one suite).
//
// Environment: the documented gate, plus a fixture provider —
// `node scripts/isochrone-fixture.mjs 3199` — and the dev instance booted
// with DEZFIL_ISOCHRONE_URL=http://127.0.0.1:3199 and 127.0.0.1 on the
// egress allowlist. The suite skips itself, loudly, when the instance has
// no isochrone capability: a silent pass on an unconfigured gate would be
// this file asserting nothing.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  routeHouse,
  seedFile,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const origins = `iso_${runId}`;
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const WIDE = { width: 1440, height: 900 };

test("the isochrone form is data end to end, refuses at the field, and lands selected", async ({
  page,
  context,
}) => {
  const capable = await page.request
    .get("/api/operations")
    .then(async (r) => {
      const body = (await r.json()) as {
        operations: { id: string; availability?: { available: boolean } }[];
      };
      return body.operations.find((o) => o.id === "isochrone")?.availability
        ?.available;
    });
  test.skip(
    capable !== true,
    "the gate instance has no isochrone provider configured — boot it with the fixture",
  );

  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);

  await page.goto("/data");
  await seedFile(
    page,
    `${origins}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  await page.goto("/maps");
  const mapId = await createMap(page, `iso ${runId}`);
  await addLayer(page, mapId, `Origins ${runId}`, `SELECT * FROM ${origins}`);
  await page.goto(`/maps/${mapId}`);

  await test.step("the row is served and the form renders from the catalog", async () => {
    if ((await page.locator('li[data-selected="true"]').count()) === 0) {
      await page.locator("[data-layer-select]").first().click();
    }
    await page.locator("[data-tools-control]").click();
    await expect(page.locator("[data-operation='isochrone']")).toHaveCount(1);
    await expect(
      page.locator("[data-operation='isochrone']"),
    ).not.toHaveAttribute("data-operation-unavailable");
    await page.locator("[data-operation='isochrone']").click();
    await expect(page.locator("[data-parameter-form]")).toBeVisible();
    // The declared parameters render as data: the mode enum, the bands
    // boxes with the minutes label, no distance slider anywhere.
    await expect(page.locator("[data-param='travel_mode']")).toBeVisible();
    await expect(page.locator("[data-param-item='bands-0']")).toBeVisible();
    await expect(page.locator("[data-param-item='bands-3']")).toBeVisible();
    await expect(page.locator("[data-param-slider]")).toHaveCount(0);
  });

  await test.step("the bands refuse at the field, before the dry run", async () => {
    // Nothing typed yet: the gate waits on the bands, and no dry-run
    // request exists for values the catalog refuses.
    let dryRuns = 0;
    await page.route("**/api/operations/run**", (route) => {
      const body = route.request().postDataJSON() as { dryRun?: boolean } | null;
      if (body?.dryRun === true) dryRuns += 1;
      return route.continue();
    });

    await page.locator("[data-param-item='bands-0']").fill("0");
    await expect(page.locator("[data-bounds-problem='bands']")).toContainText(
      /whole number of at least 1/,
    );
    await expect(page.locator("[data-form-run]")).toBeDisabled();

    await page.locator("[data-param-item='bands-0']").fill("7.5");
    await expect(page.locator("[data-bounds-problem='bands']")).toContainText(
      /whole number/,
    );

    await page.locator("[data-param-item='bands-0']").fill("10");
    await page.locator("[data-param-item='bands-1']").fill("10");
    await expect(page.locator("[data-bounds-problem='bands']")).toContainText(
      /asked once\. 10 appears twice/,
    );
    await expect(page.locator("[data-form-run]")).toBeDisabled();
    // The interception outlives the debounce before the absence speaks.
    await page.waitForTimeout(900);
    expect(dryRuns).toBe(0);

    // A valid set arms the gate through the dry run's own answer.
    await page.locator("[data-param-item='bands-1']").fill("5");
    await expect(page.locator("[data-dry-run]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("[data-form-run]")).toBeEnabled();
    expect(dryRuns).toBeGreaterThan(0);
    await page.unroute("**/api/operations/run**");
  });

  const reachable = `reach_${runId}`;
  await test.step("the run lands as the standing surface promises", async () => {
    await page.locator("[data-output-name]").fill(reachable);
    await page.locator("[data-form-run]").click();
    await expect(page.locator("[data-run-notice]")).toContainText(reachable, {
      timeout: 90_000,
    });
    // The success face states the facts, and the layer arrived selected
    // under the derived display name.
    await expect(page.locator("[data-success-facts]")).toContainText(/polygon/i);
    await page.locator("[data-drawer-dismiss]").click();
    const selected = page.locator('li[data-selected="true"]');
    await expect(selected).toContainText(/\(Isochrone \/ travel-time area\)/);
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
