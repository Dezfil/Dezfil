// Resting baselines for the surfaces re-dressed that no existing baseline
// represents (an honest gap in the pixel layer). Three surfaces, both
// themes:
//
//   builder chrome  — the header and the stage stack, whose
//                     drawn icons, 11px whisper faces and motion tokens
//                     no shot holds today (`mapShot` masks exactly these
//                     regions by design, so the map detectors never see
//                     them).
//   gallery card    — the gallery's main surface, populated: the card a
//                     field round ruled prose-side, with real
//                     content rather than the empty-state shots.
//   dialog shell    — the kit's Dialog contract in its gallery dress,
//                     with no pixel baseline at all until now.
//
// Baselines are darwin-generated, as elsewhere in the pixel suite;
// the spec skips visibly elsewhere. Comparison runs under the tolerance
// (playwright.config.ts) — sub-pixel glyph rendering is absorbed, a real
// change is not.
//
// Recording discipline (the pre-warm hazard): record against a warm
// server, then hold green three consecutive runs.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FIXTURES_DIR,
  addLayer,
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
const tableName = `whp_${runId}`;

// The in-test back-out runs only on the success path; a mid-test
// failure must not leave the workspace-global name for later suites.
test.afterEach(async ({ request }) => {
  await request
    .patch("/api/settings", { data: { instanceName: null } })
    .catch(() => {});
});

async function seed(page: Page): Promise<string> {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  // The header baseline holds whole dress: the project segment and the
  // instance chip ride the capture (re-minted for the moved breadcrumb
  // — the Workspace segment is retired). The instance name is
  // workspace-global like the recipe count, so the suite sets it
  // deterministically here and clears it before it ends.
  const projectId = await page.evaluate(async () => {
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Wheelhouse study" }),
    });
    if (!r.ok) throw new Error(await r.text());
    return ((await r.json()) as { id: string }).id;
  });
  await page.evaluate(async () => {
    const r = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceName: "Stadtwerke" }),
    });
    if (!r.ok) throw new Error(await r.text());
  });
  const mapId = await page.evaluate(async (projectId) => {
    const r = await fetch("/api/maps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Wheelhouse chrome", projectId }),
    });
    if (!r.ok) throw new Error(await r.text());
    return ((await r.json()) as { id: string }).id;
  }, projectId);
  await addLayer(page, mapId, "stations", `SELECT * FROM "${tableName}"`);
  return mapId;
}

/** The global fixtures back out — before the later steps, whose
 * baselines predate and hold surfaces the chip must not touch (an
 * instance name shifts backdrop pixels at the dialog's corner). */
async function unseed(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const r = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceName: null }),
    });
    if (!r.ok) throw new Error(await r.text());
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`re-dressed surfaces match their ${theme} baselines`, async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    await routeHouse(context);
    const mapId = await seed(page);

    await test.step("builder chrome: the header band and the stage stack", async () => {
      await page.goto(`/maps/${mapId}`);
      await expect(page.getByText("12 features").first()).toBeVisible({
        timeout: 30_000,
      });
      // The header carries drawn icons and its re-faced controls. It's
      // the workspace shell's <header> (layout.module.css's `topbar`) —
      // the builder portals its breadcrumb tail and action buttons into
      // its slots, there is no BuilderChrome-owned header. Both marks
      // settle before the shot: the chip and the project segment arrive
      // from their own fetches.
      await expect(page.locator('[title="This instance"]')).toHaveText(
        "Stadtwerke",
      );
      await expect(
        page.getByRole("link", { name: "Wheelhouse study" }),
      ).toBeVisible();
      await expect(page.locator('header[class*="topbar"]').first()).toHaveScreenshot(
        `builder-header-${theme}.png`,
        {
          animations: "disabled",
          // **The recipe count is live and workspace-global**, so an unmasked
          // shot bakes in whatever other suites left behind and is red the
          // next time the workspace differs. The control's shape is what this
          // baseline is for; the digit inside it is not.
          mask: [page.locator("[data-recipe-count]")],
        },
      );
      // The stage stack holds the chrome icon tier, including the 22px
      // compass.
      await expect(page.locator('[class*="stageStack"]').first()).toHaveScreenshot(
        `stage-stack-${theme}.png`,
        {
          animations: "disabled",
          // The stack itself is transparent. Without a capture-only
          // backdrop, rounded corners and gaps sample live basemap pixels,
          // turning tile variation into chrome drift.
          stylePath: path.join(FIXTURES_DIR, "stage-stack-screenshot.css"),
        },
      );
    });

    await unseed(page);

    await test.step("gallery: a populated card, not an empty state", async () => {
      await page.goto("/maps");
      await page.getByRole("button", { name: "Grid view", exact: true }).click();
      const card = page
        .locator('a[class*="card"], article[class*="card"]')
        .filter({ hasText: "Wheelhouse chrome" })
        .first();
      await expect(card).toBeVisible({ timeout: 30_000 });
      // The timestamp is live text: mask it so the shot holds the card's
      // dress, not the clock (the masking pattern).
      await expect(card).toHaveScreenshot(`gallery-card-${theme}.png`, {
        animations: "disabled",
        mask: [card.locator("time, [class*='stamp'], [class*='when']")],
      });
    });

    await test.step("dialog: the kit shell as dressed it", async () => {
      await page.goto("/data");
      await page.getByRole("button", { name: /Add data/ }).first().click();
      const dialog = page.getByRole("dialog").first();
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await expect(dialog).toHaveScreenshot(`add-data-dialog-${theme}.png`, {
        animations: "disabled",
        // The corner outside the dialog's arc samples the scrim; a flat
        // capture-only ground keeps the page behind it out of the shot
        // (the stored captures had bound 16 pixels of /data).
        stylePath: path.join(FIXTURES_DIR, "dialog-screenshot.css"),
      });
      await page.keyboard.press("Escape");
    });

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected, `console errors: ${JSON.stringify(unexpected)}`).toEqual([]);
  });
}
