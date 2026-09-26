// Pixel baselines for the live screens' async states: pending / empty /
// failed × light / dark on Maps, Data Explorer and Connections — the
// states' first pixel coverage. Element-scoped to the workspace <main>.
// Every state is driven deterministically at the network boundary: held
// for pending, an empty answer for resolved-empty, aborted for failed;
// the settings read answers {} so no stored view or name leaks into a
// frame. Screenshot comparison disables CSS animation, which holds the
// spinner still.
//
// Baselines are darwin-generated — the same rule and reason as the
// publish popover's: the Linux container path hits the dev-server
// cross-origin wall; cross-platform pixel discipline is out of scope
// here. The spec skips visibly on other platforms.
import { test, expect } from "@playwright/test";
import { routeHouse } from "./support";

test.skip(
  process.platform !== "darwin",
  "pixel baselines are darwin-generated; no baseline exists for this platform",
);

const SCREENS = [
  {
    slug: "maps",
    path: "/maps",
    api: "/api/maps",
    pendingLabel: "Reading your maps…",
    emptyName: /New map Start from a blank map/,
  },
  {
    slug: "data",
    path: "/data",
    api: "/api/tables",
    pendingLabel: "Reading your tables…",
    emptyName: /Add data Upload a file or import from a source/,
  },
  {
    slug: "connections",
    path: "/connections",
    api: "/api/connections/postgis",
    pendingLabel: "Reading your connections…",
    emptyName: /Add connection Snapshot tables from a PostGIS database/,
  },
] as const;

for (const theme of ["light", "dark"] as const) {
  test(`the live screens' async states match their ${theme} baselines`, async ({
    page,
    context,
  }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);

    let armedPath = "";
    let mode: "hold" | "empty" | "abort" = "hold";
    await routeHouse(context, {
      handler: async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET") return false;
        if (url.pathname === "/api/settings") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "{}",
          });
          return true;
        }
        if (url.pathname !== armedPath) return false;
        if (mode === "hold") return true; // never answers — pending stays
        if (mode === "abort") {
          await route.abort();
          return true;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return true;
      },
    });

    const main = page.locator("main");
    for (const screen of SCREENS) {
      armedPath = screen.api;

      mode = "hold";
      await page.goto(screen.path);
      await expect(page.getByText(screen.pendingLabel)).toBeVisible();
      await expect(main).toHaveScreenshot(
        `${screen.slug}-pending-${theme}.png`,
      );

      mode = "empty";
      await page.goto(screen.path);
      await expect(
        page.getByRole("button", { name: screen.emptyName }),
      ).toBeVisible();
      // The resolved-empty shots carry the count row ("All · 0" …), whose
      // digit glyphs render with sub-pixel variation between otherwise
      // identical runs — measured for at 24 (light) / 32 (dark) differing
      // pixels, every one against a glyph edge, with the row's ink
      // bounding box unchanged. This budget absorbs exactly that class on
      // exactly the shots that showed it; every other assertion in the
      // suite still compares at zero tolerance.
      await expect(main).toHaveScreenshot(`${screen.slug}-empty-${theme}.png`, {
        maxDiffPixels: 80,
      });

      mode = "abort";
      await page.goto(screen.path);
      await expect(
        page.getByRole("button", { name: "Try again" }),
      ).toBeVisible();
      await expect(main).toHaveScreenshot(
        `${screen.slug}-failed-${theme}.png`,
      );
    }
  });
}
