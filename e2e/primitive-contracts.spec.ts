// The primitive kit's contracts, driven. Static inspection cannot tell a
// declared role from an implemented one: every strip in the tree already
// carried `role="tab"` before this package and none of them answered an
// arrow key. So each contract is exercised here through the keyboard and
// the pointer, not read off the markup.
//
// Environment: a running instance with an empty data directory is enough —
// this suite seeds the one table it needs. Run with DEZFIL_BASE_URL
// pointing at it (`npm run e2e:primitives`).
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  consumeExpected,
  createMap,
  routeHouse,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `prim_${runId}`;

/** The element that currently holds focus, as a role/name pair — what a
 * screen reader would announce, not a CSS selector. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "none";
    const name =
      el.getAttribute("aria-label") ??
      el.textContent?.trim().slice(0, 40) ??
      "";
    return `${el.getAttribute("role") ?? el.tagName.toLowerCase()}:${name}`;
  });
}

test.describe("the primitive kit's contracts", () => {
  test("dialog modality, menu keyboard, tabs, and loading truth", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/data");
    await seedCsv(page, tableName, "name,lat,lon\nharbour,52.5,13.4\n");

    await test.step("empty is not shown before the request resolves", async () => {
      // The query workspace listed tables from a state that started empty,
      // so it said "No tables yet" while the read was still in flight. Hold
      // the response open and the pending state must be what shows.
      await page.route("**/api/tables", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue();
      });
      await page.goto("/sql");
      await expect(page.getByText("Reading your tables…")).toBeVisible();
      // The false empty is the defect: it must not appear while pending.
      await expect(page.getByText("No tables yet")).toHaveCount(0);
      // …and the pending state gives way to content once the read lands.
      await expect(page.getByText("Reading your tables…")).toBeHidden({
        timeout: 15000,
      });
      await expect(page.getByText(tableName).first()).toBeVisible();
      await page.unroute("**/api/tables");
    });

    await test.step("a failed read offers a retry that re-requests", async () => {
      // Keep the fault armed until the retry: a development effect replay
      // issues a second read that an abort-once stub would let through.
      let failing = true;
      let attempts = 0;
      let aborted = 0;
      await page.route("**/api/tables", async (route) => {
        attempts += 1;
        if (failing) {
          aborted += 1;
          return route.abort("failed");
        }
        return route.continue();
      });
      await page.goto("/sql");
      const retry = page.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible();
      const before = attempts;
      failing = false;
      await retry.click();
      // The second request is a fresh one, and its answer replaces the
      // failure rather than sitting beside it.
      await expect(retry).toBeHidden();
      expect(attempts).toBeGreaterThan(before);
      await page.unroute("**/api/tables");
      // The browser's console shadows of the faults this step induced.
      for (let i = 0; i < aborted; i += 1)
        await consumeExpected(consoleErrors, /\/api\/tables/);
    });

    await test.step("table detail's tabs answer arrows, Home and End", async () => {
      await page.goto(`/tables/${tableName}`);
      const mapTab = page.getByRole("tab", { name: "Map preview" });
      await expect(mapTab).toHaveAttribute("aria-selected", "true");
      // Real linkage, not two roles that happen to sit together.
      const panelId = await mapTab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      await expect(page.locator(`#${panelId}`)).toHaveAttribute(
        "role",
        "tabpanel",
      );
      // One tab stop: the unselected tab is not in the tab order.
      await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute(
        "tabindex",
        "-1",
      );
      await mapTab.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.keyboard.press("Home");
      await expect(mapTab).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("End");
      await expect(page.getByRole("tab", { name: "Data preview" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    await test.step("the export menu opens on the keyboard and returns focus", async () => {
      await page.goto("/data");
      const trigger = page
        .getByRole("button", { name: `Export ${tableName}` })
        .first();
      await trigger.scrollIntoViewIfNeeded();
      await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.focus();
      // Enter is the case the old implementation missed: it opened the
      // menu and left focus behind on the trigger.
      await page.keyboard.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(await focused(page)).toContain("menuitem");
      await page.keyboard.press("ArrowDown");
      const second = await focused(page);
      await page.keyboard.press("ArrowUp");
      expect(await focused(page)).not.toBe(second);
      await page.keyboard.press("Escape");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toBeFocused();
    });

    await test.step("Add data contains focus, inerts the page, and returns focus", async () => {
      await page.goto("/data");
      const opener = page.getByRole("button", { name: "Add data" }).first();
      await opener.click();
      const dialog = page.getByRole("dialog", { name: "Add data" });
      await expect(dialog).toBeVisible();
      // Initial focus is inside.
      expect(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
      // The page behind is inert — not merely covered by a scrim. The
      // earlier form of this check exempted any ancestor *containing* the
      // dialog, which is every ancestor when the dialog renders in tree:
      // it could not fail. The dialog now portals to its own body-level
      // host, so the assertion is that every other body child is inert and
      // a real background control is genuinely disabled.
      const inertness = await page.evaluate(() => {
        const host = document.querySelector("[data-dialog-host]");
        const others = [...document.body.children].filter((c) => c !== host);
        const nav = document.querySelector<HTMLElement>(
          'a[href="/maps"], nav a',
        );
        return {
          hostFound: host !== null,
          others: others.length,
          allInert: others.every((c) => c.hasAttribute("inert")),
          navDisabled: nav ? nav.closest("[inert]") !== null : false,
        };
      });
      expect(inertness.hostFound).toBe(true);
      expect(inertness.others).toBeGreaterThan(0);
      expect(inertness.allInert).toBe(true);
      expect(inertness.navDisabled).toBe(true);
      // Tab cannot leave: walking well past the dialog's own stops still
      // lands inside it.
      for (let i = 0; i < 25; i += 1) await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
      for (let i = 0; i < 8; i += 1) await page.keyboard.press("Shift+Tab");
      expect(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
      // Escape closes and focus goes back to what opened it.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      // Inertness is lifted, not left behind on a live page.
      const stillInert = await page.evaluate(() =>
        [...document.body.children].some((child) =>
          child.hasAttribute("inert"),
        ),
      );
      expect(stillInert).toBe(false);
    });

    await test.step("Add to map holds the same contract", async () => {
      // Table detail carries the plainly-named trigger; the gallery card's
      // is name-scoped to its table.
      await page.goto(`/tables/${tableName}`);
      const opener = page.getByRole("button", { name: "Add to a map" }).first();
      await expect(opener).toBeVisible();
      await opener.click();
      const dialog = page.getByRole("dialog", { name: /Add .* to a map/ });
      await expect(dialog).toBeVisible();
      expect(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
      for (let i = 0; i < 20; i += 1) await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    });

    await test.step("every migrated icon action measures the hit floor", async () => {
      // The floor is the control's own box, so it is measurable — a
      // pseudo-element would take the pointer and leave the rect below it.
      //
      // Driven on the builder, where the migrated icon actions actually
      // are. The first version of this check walked table detail, which
      // renders none of them: the loop ran zero times and passed. A count
      // assertion now stands in front of the measurement, so an empty
      // sweep fails instead of certifying.
      const mapId = await createMap(page, `prim map ${runId}`);
      await addLayer(page, mapId, "harbours", `SELECT * FROM ${tableName}`);
      await page.goto(`/maps/${mapId}`);
      const card = page.locator('[class*="LayerList-module"] [class*="card"]').first();
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.hover();
      const measured = await page.evaluate(() => {
        const found: string[] = [];
        const undersized: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(
          "button[data-tone]",
        )) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const name = el.getAttribute("aria-label") ?? "?";
          found.push(name);
          if (r.width < 24 || r.height < 24)
            undersized.push(`${name} ${r.width}×${r.height}`);
        }
        return { found, undersized };
      });
      // The layer card alone carries six of them; anything less means the
      // sweep found the wrong surface.
      expect(measured.found.length).toBeGreaterThanOrEqual(6);
      expect(measured.undersized).toEqual([]);
    });

    await test.step("the query-area picker is a choice group, not a tabset", async () => {
      await page.goto("/data");
      await page.getByRole("button", { name: "Add data" }).first().click();
      await page.getByRole("button", { name: /OpenStreetMap/ }).click();
      const group = page.getByRole("radiogroup", { name: "Query area kind" });
      await expect(group).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(0);
      // Exactly one choice is checked, and it is the group's single tab
      // stop — the shape a radio group owes and a tablist does not.
      const checked = group.getByRole("radio", { checked: true });
      await expect(checked).toHaveCount(1);
      const before = await checked.textContent();
      await checked.focus();
      await page.keyboard.press("ArrowRight");
      const after = await group
        .getByRole("radio", { checked: true })
        .textContent();
      expect(after).not.toBe(before);
      await page.keyboard.press("Escape");
    });

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected, `console errors: ${JSON.stringify(unexpected)}`).toEqual(
      [],
    );
  });

  // The filter column picker adopted the popover
  // contract — the first popover whose dismissal is browser-driven, per
  // the verification's own recorded gap.
  test("the filter column picker honors the popover dismissal contract", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    const pickTable = `${tableName}_f`;
    await page.goto("/data");
    await seedCsv(
      page,
      pickTable,
      "name,riders,lat,lon\na,5,52.5,13.4\nb,9,52.51,13.41\n",
    );
    const mapId = await createMap(page, "popover contract");
    await addLayer(page, mapId, "picker layer", `SELECT * FROM ${pickTable}`);
    await page.goto(`/maps/${mapId}`);
    await page.getByRole("button", { name: /^picker layer/ }).click();

    const trigger = page.getByRole("button", { name: "+ Add filter" });
    await expect(trigger).toBeVisible();
    // Closed: nothing inside is reachable.
    await expect(page.getByLabel("Search fields")).toHaveCount(0);

    await trigger.click();
    // Open: the trigger stays mounted and states the relationship.
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await trigger.getAttribute("aria-controls")).toBeTruthy();
    await expect(page.getByLabel("Search fields")).toBeVisible();

    // Escape from an option — not the search field — dismisses and hands
    // focus back to the trigger. The one-field Escape was the residue.
    await page.getByRole("button", { name: /riders/ }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Search fields")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    // An outside pointer dismisses; no full-viewport backdrop swallows it.
    await trigger.click();
    await expect(page.getByLabel("Search fields")).toBeVisible();
    await page.locator("body").click({ position: { x: 8, y: 8 } });
    await expect(page.getByLabel("Search fields")).toHaveCount(0);

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected, `console errors: ${JSON.stringify(unexpected)}`).toEqual(
      [],
    );
  });
});
