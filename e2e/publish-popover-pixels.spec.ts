// Pixel baselines for the publish popover: the surface's first pixel
// coverage — both themes × both states, element-scoped so no map canvas
// or floating chrome is in frame. The popover is plain DOM on an opaque
// panel, so these are direct screenshot comparisons, unlike the
// statistical map-region detectors in pixel-regressions.spec.ts. Dynamic
// values are handled, not masked away: the elapsed time reads "just now"
// throughout (the shot follows the publish within seconds) and the token
// URL is masked.
//
// Baselines are darwin-generated — where the local browser rounds run —
// so the spec skips visibly elsewhere, including main's ubuntu browser
// gate. Linux baselines were attempted in the Playwright container and
// hit a dev-server cross-origin wall: the builder chunk never loads via
// host.docker.internal. Cross-platform pixel discipline is out of scope
// here.
import { test, expect } from "@playwright/test";
import { addLayer, createMap, saveSettled, seedCsv } from "./support";

test.skip(
  process.platform !== "darwin",
  "pixel baselines are darwin-generated; no baseline exists for this platform",
);

const runId = Date.now().toString(36);
const tableName = `pub_px_${runId}`;

test("the publish popover matches its baselines in both themes and states", async ({
  page,
}) => {
  // **Wide enough for the popover to be on screen at all.** At the default
  // 1280 the builder header's right-hand cluster runs past the viewport when a
  // map is published — measured at 133 px over with the newest control
  // hidden, so this predates it — and the popover, anchored to the Publish
  // trigger, goes with it. A baseline captured there compares how much of the
  // popover was clipped rather than what it looks like. The header's width
  // budget is a defect in its own right and is recorded as one; this suite's
  // subject is the popover.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await seedCsv(
    page,
    tableName,
    "name,lng,lat\nBuoy A,7.10,53.52\nBuoy B,7.22,53.44\nBuoy C,6.98,53.61\n",
  );
  const mapId = await createMap(page, "Pixel harbor");
  await addLayer(page, mapId, tableName, `SELECT * FROM ${tableName}`);
  await page.goto(`/maps/${mapId}`);
  await expect(
    page.getByRole("button", { name: new RegExp(`^${tableName}`) }),
  ).toBeVisible({ timeout: 30_000 });
  await saveSettled(page);

  const popover = page.locator("#publish-popover");
  const themeToggle = page.getByRole("button", {
    name: "Switch between dark and light theme",
  });
  const maskUrl = [page.locator("[data-publish-url]")];

  // The theme toggle sits outside the popover, so using it dismisses the
  // popover (that is the dismissal contract) — each shot reopens.
  const openPopover = async (trigger: string) => {
    await page.getByRole("button", { name: trigger, exact: true }).click();
    await expect(popover).toBeVisible();
  };

  await test.step("unpublished, light then dark", async () => {
    await openPopover("Publish");
    await expect(popover).toHaveScreenshot("unpublished-light.png");
    await page.keyboard.press("Escape");
    await themeToggle.click();
    await openPopover("Publish");
    await expect(popover).toHaveScreenshot("unpublished-dark.png");
    await page.keyboard.press("Escape");
    await themeToggle.click();
  });

  await test.step("published, light then dark", async () => {
    await openPopover("Publish");
    await page.getByRole("button", { name: "Publish map" }).click();
    await expect(page.getByText("Published · just now")).toBeVisible();
    // The copy confirmation from the publish withdraws itself; the
    // assertion pins the settled label before the shot.
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(popover).toHaveScreenshot("published-light.png", {
      mask: maskUrl,
    });
    await page.keyboard.press("Escape");
    await themeToggle.click();
    await openPopover("Published");
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(popover).toHaveScreenshot("published-dark.png", {
      mask: maskUrl,
    });
  });
});
