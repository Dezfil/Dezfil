// The preview map survives a theme flip in place. The feature preview
// primitive rebuilds its MapLibre map when the theme changes; its
// features must wait for the NEW map's own style to load. Until the fix
// they landed on the old map's loaded flag, `addSource` threw "Style is
// not done loading." out of a React effect, and the app's error boundary
// replaced the whole page, header and all, on every host of the
// primitive, geometry or none. Three hosts, each flipped there and back:
// the Data Explorer's Map preview on a table with geometry and on one
// without, and the SQL workspace's result map. Run
// with DEZFIL_BASE_URL at an isolated instance.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  routeHouse,
  seedCsv,
  seedFile,
  trackConsole,
  type ConsoleError,
} from "./support";

const runId = Date.now().toString(36);
const T = (tag: string) => `tf_${runId}_${tag}`;

const toggle = (page: Page) =>
  page.getByRole("button", { name: "Switch between dark and light theme" });
const appliedTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.theme ?? "light");
/** The primitive's host element carries the count of style loads its
 * features have landed on; a flip must raise it, since the features
 * land again on the remounted map's own load. */
const landed = async (page: Page) =>
  Number(
    await page
      .locator("[data-preview-map]")
      .getAttribute("data-features-landed"),
  );

async function expectLanded(page: Page) {
  await expect.poll(() => landed(page), { timeout: 20_000 }).toBeGreaterThan(0);
  return landed(page);
}

/** What the page says after a flip: the applied theme once it survived,
 * or the words of its failure, so a red run names the crash rather than
 * a timeout. (The app's global boundary replaces the whole document on
 * an uncaught throw, header and root attribute included.) */
async function afterFlip(page: Page, errors: ConsoleError[]) {
  const thrown = errors.find((e) => /Style is not done loading/.test(e.text));
  if (thrown) return `threw: ${thrown.text}`;
  return page.evaluate(() => {
    const header = document.querySelector(
      'button[aria-label="Switch between dark and light theme"]',
    );
    if (!header) return "the header is gone: the boundary swallowed the page";
    return document.documentElement.dataset.theme ?? "light";
  });
}

/** Flip the theme in place and hold the survival: the theme applied with
 * nothing thrown and the header still standing, then the features landed
 * on a later style load than before, on the one canvas. */
async function flipAndSurvive(page: Page, errors: ConsoleError[]) {
  const before = await appliedTheme(page);
  const after = before === "light" ? "dark" : "light";
  const landedBefore = await landed(page);
  await toggle(page).click();
  await expect.poll(() => afterFlip(page, errors), { timeout: 15_000 }).toBe(after);
  await expect
    .poll(() => landed(page), { timeout: 20_000 })
    .toBeGreaterThan(landedBefore);
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(1);
}

test("the preview map survives a theme flip in place on every host", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  const consoleErrors = trackConsole(page);
  await page.goto("/data");
  const { name: points } = await seedFile(
    page,
    `${T("points")}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson")),
    "application/geo+json",
  );
  const { name: plain } = await seedCsv(page, T("plain"), "name,value\nonly,1\n");

  await test.step("Data Explorer, Map preview, a table with geometry", async () => {
    await page.goto(`/tables/${points}`);
    await expect(page.getByText(/6 features/)).toBeVisible({ timeout: 20_000 });
    await expectLanded(page);
    await flipAndSurvive(page, consoleErrors);
    await flipAndSurvive(page, consoleErrors);
    // The readout stands: the host did not remount, only the map did.
    await expect(page.getByText(/6 features/)).toBeVisible();
  });

  await test.step("Data Explorer, Map preview, a table without geometry", async () => {
    await page.goto(`/tables/${plain}`);
    await expect(page.getByText("This table has no geometry column.")).toBeVisible({ timeout: 20_000 });
    await expectLanded(page);
    await flipAndSurvive(page, consoleErrors);
    await flipAndSurvive(page, consoleErrors);
    await expect(page.getByText("This table has no geometry column.")).toBeVisible();
  });

  await test.step("SQL workspace, the result's map", async () => {
    await page.goto("/sql");
    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type(`SELECT * FROM ${points}`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByRole("cell", { name: "Hauptbahnhof" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    await expect(page.getByText(/features/)).toBeVisible({ timeout: 20_000 });
    await expectLanded(page);
    await flipAndSurvive(page, consoleErrors);
    await flipAndSurvive(page, consoleErrors);
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

/** The stock attribution pill painted against the theme's own raised
 * surface and muted ink, read from probes painted with the same tokens:
 * MapLibre's stylesheet gives it white and black whatever the theme. */
async function attributionPaint(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--bg-raised)";
    probe.style.color = "var(--fg-muted)";
    document.body.append(probe);
    const want = {
      bg: getComputedStyle(probe).backgroundColor,
      fg: getComputedStyle(probe).color,
    };
    probe.remove();
    const pill = document.querySelector(".maplibregl-ctrl-attrib");
    const button = document.querySelector(".maplibregl-ctrl-attrib-button");
    if (!pill || !button) return { want, got: null, glyph: null, text: null };
    return {
      want,
      got: {
        bg: getComputedStyle(pill).backgroundColor,
        fg: getComputedStyle(pill).color,
      },
      glyph: getComputedStyle(button).filter,
      text: pill.textContent?.trim() ?? "",
    };
  });
}

test("the attribution pill wears the theme, in both themes", async ({
  page,
  context,
}) => {
  await routeHouse(context);
  // A basemap style with a credit line, so the pill has words to show:
  // registered after the house policy, so it answers first for its host.
  await context.route("**://tiles.openfreemap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        sources: {
          credit: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            attribution: "Credit line",
          },
        },
        // A source is credited only once a layer uses it.
        layers: [{ id: "credit", type: "circle", source: "credit" }],
      }),
    }),
  );
  const consoleErrors = trackConsole(page);
  await page.goto("/data");
  const { name: points } = await seedFile(
    page,
    `${T("credit")}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson")),
    "application/geo+json",
  );
  await page.goto(`/tables/${points}`);
  await expect(page.getByText(/6 features/)).toBeVisible({ timeout: 20_000 });
  await expectLanded(page);
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Credit line");

  for (const theme of ["light", "dark"] as const) {
    if ((await appliedTheme(page)) !== theme) {
      await toggle(page).click();
      await expect.poll(() => appliedTheme(page)).toBe(theme);
      await expectLanded(page);
      await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Credit line");
    }
    const paint = await attributionPaint(page);
    expect(paint.got, `${theme}: the pill's surface and ink`).toEqual(paint.want);
    // MapLibre's (i) glyph is a black SVG: inverted on dark chrome, as
    // the builder inverts its control group, left alone on light.
    expect(paint.glyph, `${theme}: the glyph`).toBe(theme === "dark" ? "invert(0.85)" : "none");
  }

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

/** The refusal notice's paint, read against probes painted
 * with the tokens: the sentence's colour, the body and muted inks, the
 * plate under the sentence and whether a mark sits beside it. */
async function refusalPaint(page: Page) {
  return page.evaluate(() => {
    const ink = (token: string) => {
      const probe = document.createElement("div");
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const got = getComputedStyle(probe).color;
      probe.remove();
      return got;
    };
    const notice = document.querySelector("[data-preview-refusal]");
    const plate = notice?.firstElementChild ?? null;
    const sentence = plate?.querySelector("span") ?? null;
    return {
      body: ink("--fg"),
      muted: ink("--fg-muted"),
      text: sentence ? getComputedStyle(sentence).color : null,
      plate: plate ? getComputedStyle(plate).backgroundColor : null,
      mark: !!plate?.querySelector("svg"),
    };
  });
}

const channels = (rgb: string) =>
  (rgb.match(/[\d.]+/g) ?? []).map(Number);
/** WCAG relative-luminance contrast between two computed colours. */
function contrast(a: string, b: string) {
  const lum = (rgb: string) => {
    const [r, g, b] = channels(rgb).slice(0, 3).map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** The alpha of a computed colour: 1 for rgb(), the fourth channel for rgba(). */
const alpha = (rgb: string) => channels(rgb)[3] ?? 1;

// the no-geometry refusal is stated, not whispered. The
// sentence is the API's and stays byte-identical (the step above asserts
// it); what changes is measured here in both themes from the rendered
// notice: a mark beside the sentence, the body colour rather than the
// muted one, on an opaque plate that holds its own contrast. The loading
// message shares the notice element and must still read as loading, so it
// is held on the wire and measured in the muted register.
test("the preview's no-geometry refusal reads at the body colour on a plate, in both themes; loading stays muted", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  const consoleErrors = trackConsole(page);
  await page.goto("/data");
  const { name: plain } = await seedCsv(page, T("plate"), "name,value\nonly,1\n");

  // Hold the features read so the loading state stands still to be read.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route(`**/api/tables/${plain}/features*`, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`/tables/${plain}`);
  const loading = page.getByText("Reading features…");
  await expect(loading).toBeVisible({ timeout: 20_000 });
  const loadingPaint = await loading.evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.color = "var(--fg-muted)";
    document.body.append(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    return { text: getComputedStyle(el).color, muted, mark: !!el.querySelector("svg") };
  });
  expect(loadingPaint.text, "loading reads in the muted register").toBe(loadingPaint.muted);
  expect(loadingPaint.mark, "loading carries no mark").toBe(false);
  release();

  await expect(page.getByText("This table has no geometry column.")).toBeVisible({ timeout: 20_000 });
  for (const theme of ["light", "dark"] as const) {
    if ((await appliedTheme(page)) !== theme) {
      await toggle(page).click();
      await expect.poll(() => appliedTheme(page)).toBe(theme);
    }
    await expect(page.getByText("This table has no geometry column.")).toBeVisible();
    const paint = await refusalPaint(page);
    expect(paint.mark, `${theme}: a mark beside the sentence`).toBe(true);
    expect(paint.text, `${theme}: the sentence at the body colour`).toBe(paint.body);
    expect(paint.text, `${theme}: not the muted one`).not.toBe(paint.muted);
    expect(paint.plate, `${theme}: a plate under the sentence`).not.toBeNull();
    expect(alpha(paint.plate!), `${theme}: the plate is opaque`).toBe(1);
    expect(contrast(paint.text!, paint.plate!), `${theme}: the plate holds its contrast`).toBeGreaterThanOrEqual(4.5);
  }

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
