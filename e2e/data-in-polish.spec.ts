// The import box, the ghost card, and the SQL view.
//
// Everything is measured — computed colours against the gallery ghost's
// own, boxes against panes, dialog sizes against each other — never a
// class name standing in for a look. Transient upload/conversion
// containment rides the import matrix, which drives every family
// through the real flows.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { addLayer, createMap, seedFile, trackConsole } from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `datain_${runId}`;

const WIDE = { width: 1440, height: 900 };
const FAMILIES = [
  "GeoParquet",
  "GeoJSON",
  "CSV",
  "Shapefile",
  "GeoPackage",
  "KML",
  "KMZ",
];

const zone = (page: Page) =>
  page.getByRole("button", { name: "Upload data files" });

async function hoverStyle(target: Locator) {
  await target.hover();
  // Read once the hover's own transitions have finished: a fixed wait can
  // sample one mid-way when frames run late. Reading the running
  // animations flushes the style, so a transition the hover just started
  // is counted.
  await expect
    .poll(() =>
      target.evaluate(
        (el) =>
          el
            .getAnimations()
            .filter((a) => a instanceof CSSTransition && a.playState === "running")
            .length,
      ),
    )
    .toBe(0);
  return target.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return {
      borderColor: style.borderTopColor,
      // The full background, image layer included — a colour-only read
      // passed while the zone's radial gradient still differed from the
      // ghost's flat wash (measurement-defect class).
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      color: style.color,
    };
  });
}

async function settledDialogBox(
  dialog: Locator,
): Promise<{ width: number; height: number }> {
  let last = "";
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      const now = box ? `${Math.round(box.width)}:${Math.round(box.height)}` : "";
      const stable = now !== "" && now === last;
      last = now;
      return stable;
    })
    .toBe(true);
  const box = (await dialog.boundingBox())!;
  return { width: box.width, height: box.height };
}

async function seedMap(page: Page): Promise<string> {
  await page.goto("/maps");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `datain ${runId}`);
  await addLayer(page, mapId, stations, `SELECT * FROM ${stations}`);
  return mapId;
}

test.use({ viewport: WIDE });

test("the door opens on Files; editing opens SQL; the rail keeps its anatomy", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  // Fresh open: Files selected, the upload zone on screen.
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add layer" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /^Files/ }),
  ).toHaveAttribute("aria-current", "true");
  await expect(zone(page)).toBeVisible();

  // The rail's entries, order and anatomy (title + one-line description
  // each).
  const rail = dialog.getByRole("navigation", { name: "Layer sources" });
  const titles = await rail
    .locator("button strong")
    .evaluateAll((els) => els.map((el) => el.textContent));
  expect(titles).toEqual([
    "Tables",
    "SQL query",
    "Files",
    "Overture Maps",
    "OpenStreetMap",
    "PostGIS",
  ]);
  expect(await rail.locator("button small").count()).toBe(titles.length);
  await page.keyboard.press("Escape");

  // Editing an existing layer still opens straight on SQL.
  await page
    .locator("li")
    .filter({ hasText: new RegExp(`^${stations}`) })
    .getByRole("button", { name: "Layer menu", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit source" }).click();
  await expect(
    page.getByRole("textbox", { name: "Layer SQL query" }),
  ).toBeVisible({ timeout: 15_000 });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the zone's hover answers like the gallery ghost, both dialogs, both themes", async ({
  page,
}) => {
  const mapId = await seedMap(page);

  for (const theme of ["light", "dark"] as const) {
    // The ghost's hover treatment is the reference — read it from the
    // real ghost on the Maps screen, per theme.
    await page.goto("/maps");
    if (theme === "dark") {
      await page
        .getByRole("button", { name: "Switch between dark and light theme" })
        .click();
    }
    const ghost = page.getByRole("button", {
      name: "New map Start from a blank map",
    });
    const reference = await hoverStyle(ghost);

    // The builder catalog's zone.
    await page.goto(`/maps/${mapId}`);
    await page
      .getByRole("button", { name: "Add layer", exact: true })
      .click();
    expect(await hoverStyle(zone(page)), `catalog zone, ${theme}`).toEqual(
      reference,
    );
    await page.keyboard.press("Escape");

    // The Data Explorer's add-data zone.
    await page.goto("/data");
    await page.getByRole("button", { name: "Add data", exact: true }).click();
    expect(await hoverStyle(zone(page)), `add-data zone, ${theme}`).toEqual(
      reference,
    );
    await page.keyboard.press("Escape");
    if (theme === "dark") {
      await page
        .getByRole("button", { name: "Switch between dark and light theme" })
        .click();
    }
  }
});

test("the zone fills its pane and keeps guidance, progress and errors inside — both hosts", async ({
  page,
}) => {
  const mapId = await seedMap(page);

  const measureHost = async (paneSelector: string) => {
    const pane = page.locator(paneSelector);
    const paneBox = (await pane.boundingBox())!;
    const zoneBox = (await zone(page).boundingBox())!;
    const hint = page.getByText(/A file with several layers lands as one table each/);
    const hintBox = (await hint.boundingBox())!;
    const contained = async (locBox: { y: number; height: number }) =>
      expect(locBox.y + locBox.height).toBeLessThanOrEqual(
        paneBox.y + paneBox.height + 1,
      );

    // Idle: the zone grows well past its text; the guidance stays in.
    expect(zoneBox.height).toBeGreaterThan(paneBox.height * 0.6);
    await contained(hintBox);

    // Conversion state, held deterministic: the upload's bytes are done,
    // the response is not — the zone shows "converting…" and holds it.
    let release: (() => void) | null = null;
    await page.route("**/api/tables", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise<void>((r) => {
        release = r;
      });
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "held-upload probe: refused on release" },
        }),
      });
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "probe.geojson",
      mimeType: "application/geo+json",
      buffer: Buffer.from(
        '{"type":"FeatureCollection","features":[]}',
      ),
    });
    // An intercepted request emits no byte-progress events, so the held
    // state is the upload bar itself (filename + percentage) — the
    // upload-state containment, measured where it actually renders.
    const uploadState = zone(page).getByText("probe.geojson");
    await expect(uploadState).toBeVisible({ timeout: 15_000 });
    await contained((await uploadState.boundingBox())!);
    release!();
    // The released refusal surfaces as an error, inside the pane — and
    // only then is the route safe to remove (unrouting earlier raced
    // the in-flight fulfill).
    const note = page.getByRole("alert").filter({ hasText: /probe|refused/i });
    await expect(note.first()).toBeVisible({ timeout: 15_000 });
    await contained((await note.first().boundingBox())!);
    await page.unroute("**/api/tables");
  };

  // The builder's catalog host.
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  await measureHost('[class*="importPane"]');
  await page.keyboard.press("Escape");

  // The Data Explorer's add-data host.
  await page.goto("/data");
  await page.getByRole("button", { name: "Add data", exact: true }).click();
  await measureHost('[role="dialog"] [class*="pane"]');
});

test("the chips tell the accept truth, add no stops, and the prose stops repeating it", async ({
  page,
}) => {
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("button", { name: "Add layer", exact: true }).click();

  // Exactly the accepted families, as chips inside the zone.
  const chipTexts = await zone(page)
    .locator("span")
    .evaluateAll((els) =>
      els
        .map((el) => el.textContent?.trim() ?? "")
        .filter((t) =>
          [
            "GeoParquet",
            "GeoJSON",
            "CSV",
            "Shapefile",
            "GeoPackage",
            "KML",
            "KMZ",
          ].includes(t),
        ),
    );
  expect(chipTexts).toEqual(FAMILIES);

  // The accept list and the chips agree on families: KML and KMZ both
  // reachable through the input the zone opens.
  const accept = await page
    .locator('input[type="file"]')
    .getAttribute("accept");
  for (const ext of [".kml", ".kmz"]) expect(accept).toContain(ext);

  // No focus stops inside the zone: the zone itself is the only stop.
  expect(
    await zone(page)
      .locator("button, a, [tabindex]:not([tabindex='-1'])")
      .count(),
  ).toBe(0);

  // The hosts' hints no longer enumerate formats (dropped the GeoParquet
  // blurb entirely); the URL tab keeps its own truthful list.
  const hint = page.getByText(/A file with several layers lands as one table each/);
  await expect(hint).toBeVisible();
  await expect(hint).not.toContainText("GeoParquet,");
  await page.getByRole("tab", { name: "From URL" }).click();
  await expect(
    page.getByText(/Reads Parquet, CSV, GeoJSON/).first(),
  ).toBeVisible();
});

test("the populated grid opens with the Add-data ghost — render-only, first cell, its own name", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  await seedMap(page);
  // Two grid rows minimum (273px cells): seed enough sibling tables.
  await page.goto("/maps");
  for (let i = 0; i < 5; i += 1) {
    await seedFile(
      page,
      `${stations}_row${i}.geojson`,
      readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
      "application/geo+json",
    );
  }
  await page.goto("/data");
  // The view preference is workspace-global: ask for the grid.
  await page.getByRole("button", { name: "Grid view", exact: true }).click();

  const grid = page.locator('[class*="dataGrid"]');
  await expect(grid).toBeVisible();
  const ghost = grid.getByRole("button", {
    name: "Add data Upload a file or import from a source",
  });
  await expect(ghost).toBeVisible();

  // First cell, and a cell-sized one. Same-row equality is stretch and
  // proves nothing: the honest check compares the ghost's row
  // against a row WITHOUT the ghost, so the grid must have two rows.
  expect(
    await grid.evaluate((el) => el.firstElementChild?.tagName),
  ).toBe("BUTTON");
  await expect
    .poll(async () => grid.locator("article").count())
    .toBeGreaterThanOrEqual(5); // 273px cells at 1440: rows wrap past four
  const ghostBox = (await ghost.boundingBox())!;
  const rows = await grid
    .locator("article")
    .evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        return { top: Math.round(box.y), height: Math.round(box.height) };
      }),
    );
  const firstRowTop = Math.min(...rows.map((r) => r.top));
  const laterRow = rows.find((r) => r.top > firstRowTop + 10);
  expect(laterRow, "a second grid row exists to compare against").toBeTruthy();
  const firstRowHeight = rows.find((r) => r.top === firstRowTop)!.height;
  // The ghost's row is no taller than an unaffected row, and the ghost
  // fills its row like any cell.
  expect(firstRowHeight - laterRow!.height).toBeLessThanOrEqual(2);
  expect(Math.abs(ghostBox.height - firstRowHeight)).toBeLessThanOrEqual(2);

  // The header keeps its exact, distinct name — one match only.
  expect(
    await page
      .getByRole("button", { name: "Add data", exact: true })
      .count(),
  ).toBe(1);

  // Counts derive from tables alone: the All chip's number equals the
  // API's own table count, ghost excluded — never the grid's articles,
  // which on a shared instance include other suites' workflow folders
  // and hide the tables folded under them.
  const allChip = await page
    .getByRole("button", { name: /^All/ })
    .textContent();
  const counted = Number(allChip?.replace(/\D+/g, ""));
  const listed = (await (await page.request.get("/api/tables")).json()) as unknown[];
  expect(counted).toBe(listed.length);
  await expect(grid.locator("article").first()).toBeVisible();

  // The ghost opens the same dialog the header action opens.
  await ghost.click();
  await expect(page.getByRole("dialog", { name: "Add data" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Zero-match keeps its non-actionable prose — no ghost, no grid.
  await page.getByPlaceholder(/Search data/).fill("zz-nothing-matches-zz");
  await expect(page.getByText(/No tables match/)).toBeVisible();
  expect(await grid.count()).toBe(0);
  await page.getByPlaceholder(/Search data/).clear();

  // List view carries no ghost.
  await page.getByRole("button", { name: "List view" }).click();
  expect(
    await page
      .getByRole("button", {
        name: "Add data Upload a file or import from a source",
      })
      .count(),
  ).toBe(0);
  await page.getByRole("button", { name: "Grid view" }).click();

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the SQL view takes the map-source geometry and wraps long lines", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  // Measure the Overture dialog, then the SQL dialog: same box.
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add layer" });
  await dialog.getByRole("button", { name: /^Overture Maps/ }).click();
  const mapSourceBox = await settledDialogBox(dialog);
  await dialog.getByRole("button", { name: /^SQL query/ }).click();
  const sqlBox = await settledDialogBox(dialog);
  expect(Math.round(sqlBox.width)).toBe(Math.round(mapSourceBox.width));
  expect(Math.round(sqlBox.height)).toBe(Math.round(mapSourceBox.height));

  // A long line wraps: no horizontal scrolling in the editor, and the
  // content grows taller than a single line's height.
  const editor = page.getByRole("textbox", { name: "New layer SQL" });
  await editor.click();
  const longLine = `SELECT ${Array.from({ length: 30 }, (_, i) => `'column_number_${i}' AS c${i}`).join(", ")} FROM x`;
  await page.keyboard.insertText(longLine);
  const scroller = page.locator(".cm-scroller");
  const overflow = await scroller.evaluate(
    (el) => el.scrollWidth - el.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const lineBox = (await page.locator(".cm-line").first().boundingBox())!;
  expect(lineBox.height).toBeGreaterThan(30);
  await page.keyboard.press("Escape");

  // Edit mode shares the geometry and the wrap:
  // open Edit source and measure the same two facts there.
  await page
    .locator("li")
    .filter({ hasText: new RegExp(`^${stations}`) })
    .getByRole("button", { name: "Layer menu", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit source" }).click();
  const editDialog = page.getByRole("dialog", { name: /Layer source/ });
  await expect(editDialog).toBeVisible();
  const editBox = await settledDialogBox(editDialog);
  expect(Math.round(editBox.width)).toBe(Math.round(mapSourceBox.width));
  expect(Math.round(editBox.height)).toBe(Math.round(mapSourceBox.height));
  const editArea = page.getByRole("textbox", { name: "Layer SQL query" });
  await editArea.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(longLine);
  const editOverflow = await page
    .locator(".cm-scroller")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(editOverflow).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");

  // The Overture release probe 502s without the import-matrix fixture —
  // this test measures the pane's frame, not its data road.
  expect(
    consoleErrors.filter(
      (e) =>
        !isAllowedConsoleError(e.text, e.url) &&
        !/\/api\/imports\/overture\//.test(e.url ?? ""),
    ),
  ).toEqual([]);
});
