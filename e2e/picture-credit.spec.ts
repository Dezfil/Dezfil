// The map pictures on the Maps gallery and on Home credit the basemaps
// they were drawn on with one quiet line for the page: under the
// gallery's scroller, where it stays in view whatever the scroll, and as
// Home's last row, at its foot. Each credit is a link a keyboard reaches.
// The seeded map stays on Auto, so its picture is credited with the
// built-in styles' line. Run with DEZFIL_BASE_URL at an isolated instance.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForPicture } from "./picture-support";
import { createMap, routeHouse, trackConsole } from "./support";
import { isAllowedConsoleError } from "./console-allowlist";

const runId = Date.now().toString(36);

/** The server makes the picture without a visit to the builder. */
async function picturedMap(page: Page, name: string): Promise<string> {
  const mapId = await createMap(page, name);
  await waitForPicture(page.request, mapId);
  return mapId;
}

/** Both credits link out, and Tab moves from one to the next and back. */
async function creditsReachedByKeyboard(page: Page, line: Locator) {
  const omt = line.getByRole("link", { name: "© OpenMapTiles", exact: true });
  const osm = line.getByRole("link", { name: "© OpenStreetMap", exact: true });
  await expect(omt).toHaveAttribute("href", "https://openmaptiles.org");
  await expect(osm).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
  await omt.focus();
  await expect(omt).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(osm).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(omt).toBeFocused();
}

test("the line crediting the map pictures stands under the gallery's scroller and at Home's foot", async ({ page, context }) => {
  const errors = trackConsole(page);
  await routeHouse(context);
  await page.goto("/maps");
  await picturedMap(page, `Credited pictures ${runId}`);

  await test.step("the Maps gallery: under the scroller, in view whatever the scroll", async () => {
    await page.goto("/maps");
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    const line = page.locator('[data-picture-credit="page"]');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText("Map previews:");
    await expect(page.getByRole("link", { name: `Open Credited pictures ${runId}`, exact: true })).toBeVisible();
    const scroller = page.locator('[class*="scroller"]').filter({ has: page.getByRole("link", { name: `Open Credited pictures ${runId}`, exact: true }) });
    for (const to of ["top", "bottom"] as const) {
      await scroller.evaluate((el, to) => el.scrollTo(0, to === "top" ? 0 : el.scrollHeight), to);
      await expect(line, `scrolled to the ${to}`).toBeInViewport();
      const [list, credit] = [await scroller.boundingBox(), await line.boundingBox()];
      expect(credit!.y, `scrolled to the ${to}`).toBeGreaterThanOrEqual(list!.y + list!.height - 1);
    }
    await creditsReachedByKeyboard(page, line);
  });

  await test.step("the Maps list: the list card's foot row, and no line under the scroller", async () => {
    await page.getByRole("button", { name: "List view", exact: true }).click();
    const foot = page.locator('[data-picture-credit="foot"]');
    await expect(foot).toHaveCount(1);
    await expect(page.locator('[data-picture-credit="page"]')).toHaveCount(0);
    await expect(foot).toContainText("Map previews:");
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
  });

  await test.step("Home: its last row, at the foot of the page", async () => {
    await page.goto("/");
    await expect(page.locator(`[data-lead="continue"]`)).toBeVisible();
    const line = page.locator('[data-home] > [data-picture-credit="page"]');
    await expect(line).toHaveCount(1);
    await expect(page.locator("[data-home] > :last-child")).toHaveAttribute("data-picture-credit", "page");
    await line.scrollIntoViewIfNeeded();
    await expect(line).toBeInViewport();
    await creditsReachedByKeyboard(page, line);
  });

  const unexpected = errors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected).toEqual([]);
});
