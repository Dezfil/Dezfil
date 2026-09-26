// Keyboard and screen-reader journey: the core flow — create a map, add a
// layer from an existing dataset, apply a data-driven fill, publish, open
// the published view — completed with the keyboard alone. Every stop
// asserts three truths: the control is reachable by Tab from the current
// position (bounded — an unreachable stop fails naming its step), it
// shows visible focus (:focus-visible), and it exposes the accessible
// role and name a screen reader would announce (every locator here
// resolves through real accessible-name computation; tree-level
// assertions, not a live screen reader).
//
// Environment: the documented verification gate — production standalone,
// DEZFIL_RENDER_CAP_FEATURES=2000, third-party hosts blocked; run via
// `npm run e2e:keyboard` with DEZFIL_BASE_URL pointing at the server.
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FIXTURES_DIR,
  layerSaveArrived,
  routeHouse,
  saveSettled,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `kbd_${runId}`;

/** Walk Tab from the current focus until the target holds it. Bounded:
 * an unreachable control is a finding, not an infinite loop. */
async function tabTo(
  page: Page,
  target: Locator,
  what: string,
  opts: { maxTabs?: number; backward?: boolean } = {},
): Promise<void> {
  const { maxTabs = 80, backward = false } = opts;
  const key = backward ? "Shift+Tab" : "Tab";
  for (let i = 0; i < maxTabs; i += 1) {
    const focused = await target
      .evaluate((el) => el === document.activeElement)
      .catch(() => false);
    if (focused) return;
    await page.keyboard.press(key);
  }
  throw new Error(
    `keyboard journey: ${what} is not reachable by keyboard (${maxTabs} ${key} presses walked)`,
  );
}

/** The stop is focused AND visibly focused — a keyboard user can see
 * where they are. */
async function expectFocusedStop(target: Locator, what: string) {
  await expect(target, what).toBeFocused();
  const visible = await target.evaluate((el) => el.matches(":focus-visible"));
  expect(visible, `${what} shows visible focus`).toBe(true);
}

test("the core flow is keyboard-operable and announces itself", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await test.step("seed: one dataset through the API", async () => {
    await page.goto("/maps");
    const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
    await seedCsv(page, tableName, csv);
  });

  await test.step("create a map from the keyboard", async () => {
    await page.goto("/maps");
    // The gallery announces itself: a heading and the New-map control by
    // accessible name (the ghost tile shares the text — exact match).
    const newMap = page.getByRole("button", { name: "New map", exact: true });
    await tabTo(page, newMap, "the New map button");
    await expectFocusedStop(newMap, "the New map button");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/maps\/[^/]+$/);
    // The builder announces its panel rail as a named navigation landmark.
    await expect(
      page.getByRole("tablist", { name: "Builder panels" }),
    ).toBeVisible();
  });

  await test.step("add a layer from the dataset, keyboard only", async () => {
    const addLayer = page.getByRole("button", { name: "Add layer", exact: true });
    await tabTo(page, addLayer, "the Add-layer opener");
    await expectFocusedStop(addLayer, "the Add-layer opener");
    await page.keyboard.press("Enter");

    // Files is the door's default — reach the Tables source by keyboard
    // first; it is the rail's first stop.
    const tablesSource = page
      .getByRole("dialog")
      .getByRole("button", { name: /^Tables/ });
    await tabTo(page, tablesSource, "the Tables source");
    await expectFocusedStop(tablesSource, "the Tables source");
    await page.keyboard.press("Enter");

    const row = page.getByRole("button", { name: tableName, exact: true });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await tabTo(page, row, "the dataset row");
    await expectFocusedStop(row, "the dataset row");
    await page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("data-selected", "true");

    const submit = page
      .getByRole("dialog")
      .getByRole("button", { name: "Add layer", exact: true });
    // On a long-lived instance every seeded table is a stop between the
    // picked row and the submit — budget for a populated catalog.
    await tabTo(page, submit, "the Add-layer submit", { maxTabs: 200 });
    await expectFocusedStop(submit, "the Add-layer submit");
    await page.keyboard.press("Enter");
    await expect(page.getByText("12 features")).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step("a data-driven fill from the keyboard builds the legend", async () => {
    // The freshly added layer is auto-selected and the style panel open.
    const fillLabel = page.getByText("Fill", { exact: true });
    await expect(fillLabel).toBeVisible();
    const fillSelect = fillLabel.locator("xpath=following::select[1]");
    await tabTo(page, fillSelect, "the fill attribute select");
    await expectFocusedStop(fillSelect, "the fill attribute select");
    // The fill control is a NATIVE <select>. Arrow keys open the darwin
    // popup, which headless cannot drive — but CLOSED-select type-ahead
    // is real keyboard input the control handles itself: typing the
    // option's label selects and commits it, which is a genuine keyboard
    // path rather than a DOM-level fallback.
    const selectedLabel = () =>
      fillSelect.evaluate(
        (el) => (el as HTMLSelectElement).selectedOptions[0]?.label ?? "",
      );
    const saved = layerSaveArrived(page);
    await page.keyboard.type("riders");
    // React-controlled: poll the settled value, never the transient
    // window between the change event and the re-render.
    await expect
      .poll(selectedLabel, { timeout: 10_000 })
      .toBe("riders");
    await saved;
    // The canvas legend now announces the layer with real class entries.
    const legend = page.locator("[data-corner]", { hasText: tableName });
    await expect(legend).toBeVisible();
    await expect
      .poll(async () => legend.locator("li").count())
      .toBeGreaterThan(1);
    await saveSettled(page);
  });

  await test.step("publish from the keyboard", async () => {
    const trigger = page.getByRole("button", { name: "Publish", exact: true });
    await tabTo(page, trigger, "the Publish control");
    await expectFocusedStop(trigger, "the Publish control");
    await page.keyboard.press("Enter");

    const publish = page.getByRole("button", { name: "Publish map" });
    await expect(publish).toBeVisible();
    await tabTo(page, publish, "the Publish-map action");
    await expectFocusedStop(publish, "the Publish-map action");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Published · just now")).toBeVisible();

    // The copy action and the open-in-new-tab affordance are keyboard
    // stops too (the URL itself is a statement, not a control).
    const copy = page.getByRole("button", { name: "Copy link" });
    await tabTo(page, copy, "the copy-link action");
    await expectFocusedStop(copy, "the copy-link action");
    expect(
      await page
        .locator("[data-publish-url]")
        .getAttribute("data-publish-url"),
    ).toMatch(/\/v\/.+/);
    // The open affordance sits just before the copy action in the popover —
    // a keyboard user reaches it with Shift+Tab; both directions are
    // keyboard navigation.
    // exact: the basemap credit link's name also contains "Open".
    const open = page.getByRole("link", { name: "Open", exact: true });
    await tabTo(page, open, "the open-published link", {
      backward: true,
      maxTabs: 6,
    });
    await expectFocusedStop(open, "the open-published link");
  });

  await test.step("the published view opens on Enter and announces itself", async () => {
    const url =
      (await page
        .locator("[data-publish-url]")
        .getAttribute("data-publish-url")) ?? "";
    // ACTIVATED with the keyboard: the focused link is
    // opened by pressing Enter, not by navigating around it — the link
    // carries target="_blank", so activation lands as a new page. A link
    // that ignored keyboard activation now reddens this step.
    const [published] = await Promise.all([
      context.waitForEvent("page"),
      page.keyboard.press("Enter"),
    ]);
    const publishedErrors = trackConsole(published);
    await published.waitForLoadState();
    expect(published.url()).toContain(new URL(url).pathname);
    await expect(
      published.getByRole("heading", { name: "Untitled map" }),
    ).toBeVisible();
    await expect(published.locator(".maplibregl-canvas")).toBeVisible();
    await expect(
      published.getByText("basemap offline · data only"),
    ).toBeVisible();
    // The styled legend reached the viewer with its entries.
    await expect(published.getByText(tableName)).toBeVisible();
    await expect
      .poll(async () => published.locator("li").count())
      .toBeGreaterThan(1);
    await expect(published.getByText("made with Dezfil")).toBeVisible();

    // The reader theme toggle is a keyboard stop with an accessible
    // name, visible focus, exposed state — and it works.
    const themeToggle = published.getByRole("button", {
      name: /Switch to (light|dark) theme/,
    });
    await tabTo(published, themeToggle, "the reader theme toggle");
    await expectFocusedStop(themeToggle, "the reader theme toggle");
    expect(await themeToggle.getAttribute("aria-pressed")).toMatch(
      /^(true|false)$/,
    );
    const themeBefore = await published
      .locator("[data-published-view]")
      .getAttribute("data-view-theme");
    await published.keyboard.press("Enter");
    await expect
      .poll(() =>
        published
          .locator("[data-published-view]")
          .getAttribute("data-view-theme"),
      )
      .toBe(themeBefore === "dark" ? "light" : "dark");
    // Restore, so later steps read the authored default.
    await published.keyboard.press("Enter");

    expect(
      publishedErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
    ).toEqual([]);
    await published.close();
  });

  await test.step("the console stayed clean", async () => {
    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });
});
