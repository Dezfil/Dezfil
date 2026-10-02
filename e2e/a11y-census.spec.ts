// The census checks: every named control family exposes a stable
// accessibility-tree name; every family whose focus ring was
// un-suppressed shows the established ring on keyboard focus, in
// both themes; every hit-area census target measures at least 24×24 in
// the rendered page. These are census assertions, not flow drives — the
// flows live in keyboard-interactions.spec.ts.
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  createMap,
  addLayer,
  patchLayer,
  patchMap,
  routeHouse,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `cen_${runId}`;

async function tabTo(
  page: Page,
  target: Locator,
  what: string,
  maxTabs = 140,
): Promise<void> {
  for (let i = 0; i < maxTabs; i += 1) {
    const focused = await target
      .evaluate((el) => el === document.activeElement)
      .catch(() => false);
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`${what} is not reachable by keyboard (${maxTabs} Tabs)`);
}

/** The focus-census assertion: reached by keyboard, :focus-visible, and
 * the global ring actually drawn (outline un-suppressed). */
async function expectRing(page: Page, target: Locator, what: string) {
  await tabTo(page, target, what);
  await expect(target, what).toBeFocused();
  expect(
    await target.evaluate((el) => el.matches(":focus-visible")),
    `${what} is :focus-visible`,
  ).toBe(true);
  const style = await target.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
  });
  expect(style.outlineStyle, `${what} draws the ring`).toBe("solid");
  expect(
    parseFloat(style.outlineWidth),
    `${what} ring width`,
  ).toBeGreaterThanOrEqual(2);
}

/** The relocated-ring assertion: a transparent control cannot paint
 * the global ring, so its drawn stand-in wears one instead. The control is
 * still the keyboard stop and still :focus-visible — only the paint moves,
 * and the control itself must not be carrying a suppressed outline. */
async function expectRelocatedRing(
  page: Page,
  control: Locator,
  drawn: Locator,
  what: string,
) {
  await tabTo(page, control, what);
  await expect(control, what).toBeFocused();
  expect(
    await control.evaluate((el) => el.matches(":focus-visible")),
    `${what} is :focus-visible`,
  ).toBe(true);
  const style = await drawn.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
  });
  expect(style.outlineStyle, `${what} draws the ring on its stand-in`).toBe(
    "solid",
  );
  expect(
    parseFloat(style.outlineWidth),
    `${what} ring width`,
  ).toBeGreaterThanOrEqual(2);
  // The ring must sit on the handle, not on the full-width control it
  // stands in for — the defect fixed was a ring around the histogram.
  const [drawnBox, controlBox] = await Promise.all([
    drawn.boundingBox(),
    control.boundingBox(),
  ]);
  expect(drawnBox!.width, `${what} ring is the handle's size`).toBeLessThan(
    controlBox!.width / 4,
  );
}

/** How far below 24 a measured box may fall and still be the 24px control it is: floating-point drift, never a smaller control. */
const HIT_FLOOR_EPSILON = 0.01;

/** The hit-floor assertion: the rendered box is at least 24×24. */
async function expectHitFloor(target: Locator, what: string) {
  const box = await target.boundingBox();
  expect(box, `${what} renders`).not.toBeNull();
  // The box is fractional (a 24px swatch measured 23.99999237060547 on a
  // fractional y), so the floor allows a hundredth of a pixel of drift and no
  // more: a rounded box would pass a genuinely undersized 23.5px control (found
  // at review).
  expect(box!.width, `${what} width`).toBeGreaterThanOrEqual(24 - HIT_FLOOR_EPSILON);
  expect(box!.height, `${what} height`).toBeGreaterThanOrEqual(24 - HIT_FLOOR_EPSILON);
}

async function seedStyledMap(page: Page): Promise<{
  mapId: string;
  layerId: string;
}> {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  const mapId = await createMap(page, "Census");
  const layerId = await addLayer(
    page,
    mapId,
    "alpha",
    `SELECT * FROM "${tableName}"`,
  );
  // Classified fill: exposes Method, palette, class swatches, break
  // fields, and a legend with editable labels.
  await patchLayer(page, layerId, {
    style: {
      fill: {
        type: "quantile",
        attribute: "riders",
        palette: "global_warming",
        breaks: [12000],
        colors: [
          { r: 26, g: 93, b: 74, a: 0.9 },
          { r: 233, g: 179, b: 91, a: 0.9 },
        ],
      },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 3,
      opacity: 1,
    },
    filters: [{ kind: "range", field: "riders", min: null, max: null }],
  });
  await patchMap(page, mapId, {
    widgets: [
      {
        id: "w-hist",
        type: "histogram",
        layerId,
        title: "Riders",
        field: "riders",
        agg: "count",
        aggField: null,
        unit: null,
        note: null,
        format: null,
        visible: true,
      },
    ],
  });
  return { mapId, layerId };
}

/** A workflow with one source and one node: the canvas's
 * control families — the stage, the pane, a node — need a graph to stand
 * on. Authored through the API. */
/** A layout written off the dependency arrangement, so Arrange is a
 * genuine move. A workflow with no written layout opens *already*
 * arranged, and an Arrange that moves nothing is no step, so the record
 * would stay empty and Undo dimmed. */
async function seedOffArrangement(page: Page, id: string): Promise<void> {
  await page.evaluate(async (id) => {
    const headers = { "content-type": "application/json" };
    const read = await fetch(`/api/recipes/${id}`);
    if (!read.ok) throw new Error(await read.text());
    const { recipe } = (await read.json()) as { recipe: { steps: { id: string }[] } };
    const put = await (async function readThenWriteWorkflowSetup() { const basis = await (await fetch(`/api/recipes/${id}`)).json(); return (async function readThenWriteWorkflowSetup() { const basis = await (await fetch(`/api/recipes/${id}`)).json(); return fetch(`/api/recipes/${id}/layout`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ steps: { [recipe.steps[0].id]: { x: 480, y: 320 } }, sources: {}, notes: [] }),
    }); })(); })();
    if (!put.ok) throw new Error(await put.text());
  }, id);
}

async function seedWorkflow(page: Page): Promise<string> {
  // One table per call: the census seeds a workflow in three tests.
  const table = `census_wf_${runId}_${Math.random().toString(36).slice(2, 6)}`;
  await seedCsv(page, table, "name,lon,lat\nalex,13.41,52.52\n");
  return page.evaluate(async ({ table }) => {
    const headers = { "content-type": "application/json" };
    const made = await fetch("/api/recipes", { method: "POST", headers, body: JSON.stringify({ name: "Census workflow" }) });
    if (!made.ok) throw new Error(await made.text());
    const { recipe } = (await made.json()) as { recipe: { id: string } };
    const added = await (async function readThenWriteWorkflowSetup() { const basis = await (await fetch(`/api/recipes/${recipe.id}`)).json(); return (async function readThenWriteWorkflowSetup() { const basis = await (await fetch(`/api/recipes/${recipe.id}`)).json(); return fetch(`/api/recipes/${recipe.id}/steps`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "sql_step", parameters: { sql: `SELECT name FROM ${table}`, name: `${table}_one` } }),
    }); })(); })();
    if (!added.ok) throw new Error(await added.text());
    return recipe.id;
  }, { table });
}

test.describe("census checks", () => {
  test("the name census: builder families expose stable specific names", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    const { mapId, layerId } = await seedStyledMap(page);
    // `?layer=` selects it server-side: the style panel is up.
    await page.goto(`/maps/${mapId}?layer=${layerId}`);
    await expect(page.getByText("12 features").first()).toBeVisible({
      timeout: 30_000,
    });

    await test.step("style panel: fill, palette, size, filter families", async () => {
      await expect(
        page.getByRole("combobox", { name: "Fill color attribute" }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Fill classification method" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^Choose fill palette: / }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Point size scale attribute" }),
      ).toBeVisible();
      // Class rows: named swatches and positional boundary fields.
      await expect(
        page.getByRole("button", { name: "Fill class 1 color" })
          .or(page.locator('input[aria-label="Fill class 1 color"]')),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Fill class boundary 1" }),
      ).toBeVisible();
      // Filter bounds carry their field.
      await expect(
        page.getByRole("spinbutton", { name: "riders minimum" }),
      ).toBeVisible();
      await expect(
        page.getByRole("spinbutton", { name: "riders maximum" }),
      ).toBeVisible();
    });

    await test.step("aggregated viz: aggregate and cell-height families", async () => {
      await patchLayer(page, layerId, {
        viz: {
          type: "hexbin",
          cellKm: 5,
          aggregate: { fn: "sum", attribute: "riders" },
          elevation: {
            aggregate: { fn: "sum", attribute: "riders" },
            height: 1000,
          },
        },
      });
      await page.goto(`/maps/${mapId}?layer=${layerId}`);
      await expect(
        page.getByRole("combobox", { name: "Aggregate function" }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("combobox", { name: "Aggregate attribute" }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Cell height function" }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Cell height attribute" }),
      ).toBeVisible();
    });

    await test.step("cluster and heatmap: color and weight families", async () => {
      await patchLayer(page, layerId, {
        viz: {
          type: "cluster",
          radiusPx: 40,
          color: { fn: "sum", attribute: "riders" },
          showCounts: true,
        },
      });
      await page.goto(`/maps/${mapId}?layer=${layerId}`);
      await expect(
        page.getByRole("combobox", { name: "Cluster color function" }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("combobox", { name: "Cluster color attribute" }),
      ).toBeVisible();
      await patchLayer(page, layerId, {
        viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: null },
      });
      await page.goto(`/maps/${mapId}?layer=${layerId}`);
      await expect(
        page.getByRole("combobox", { name: "Heatmap weight attribute" }),
      ).toBeVisible({ timeout: 30_000 });
      await patchLayer(page, layerId, { viz: { type: "points" } });
    });

    await test.step("legend tab: title, variable, slot, and toggle names", async () => {
      await page.goto(`/maps/${mapId}?layer=${layerId}`);
      await page.getByRole("tab", { name: "Legend" }).click();
      await expect(
        page.getByRole("textbox", { name: "Legend title, alpha" }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: /variable name, alpha/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Hide fill variable name, alpha/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Legend label 1, alpha" }),
      ).toBeVisible();
    });

    await test.step("widgets: row actions carry the widget's title", async () => {
      await page.getByRole("tab", { name: "Widgets" }).click();
      await expect(
        page.getByRole("button", { name: "Reorder Riders", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Hide Riders" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Delete widget Riders" }),
      ).toBeVisible();
      // The histogram handles carry the widget title too.
      await expect(
        page.getByRole("slider", { name: "Riders range start" }),
      ).toBeVisible();
      await expect(
        page.getByRole("slider", { name: "Riders range end" }),
      ).toBeVisible();
    });

    await test.step("workflow canvas: the stage, the pane, the nodes and their ports are named", async () => {
      const id = await seedWorkflow(page);
      await page.goto(`/workflows/${id}`);
      await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
      // Undo and Redo: the stack's seventh and eighth buttons, named while dimmed.
      for (const name of ["Zoom in", "Zoom out", "Fit to view", "Framed view", "Arrange by dependency", "Undo", "Redo"]) {
        await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
      }
      await expect(page.getByRole("tab", { name: /^Sources/ })).toBeVisible();
      await expect(page.getByRole("tab", { name: /^Tools/ })).toBeVisible();
      await expect(page.getByRole("searchbox", { name: "Search sources" })).toBeVisible();
      // A node's name says its operation, its output and its state; a source's its table.
      await expect(page.locator('.react-flow__node[aria-label^="SQL step, census_wf_"][aria-label$="_one, never run"]')).toHaveCount(1);
      await expect(page.locator('.react-flow__node[aria-label^="census_wf_"][aria-label$=", source table"]')).toHaveCount(1);
      await expect(page.getByLabel("Reads what its query names")).toHaveCount(1);
      await expect(page.getByLabel("Output").first()).toBeVisible();
      await page.goto(`/maps/${mapId}?layer=${layerId}`);
      await expect(page.getByText("12 features").first()).toBeVisible({ timeout: 30_000 });
    });

    await test.step("workflow canvas, editing: the pane's rows, the panel's picker, controls and actions, the confirmation", async () => {
      const id = await seedWorkflow(page);
      await page.goto(`/workflows/${id}`);
      await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
      const pane = page.locator("[data-canvas-pane]");
      await pane.getByRole("tab", { name: /^Tools/ }).click();
      // A Tools row is a button that says what it adds; an unavailable one says why.
      await expect(pane.getByRole("button", { name: "Add Buffer" })).toBeVisible();
      const unavailable = pane.locator("[data-tool][disabled]").first();
      if ((await unavailable.count()) > 0) expect(await unavailable.getAttribute("aria-label")).toMatch(/: .+/);
      await pane.getByRole("button", { name: "Add Buffer" }).click();
      await page.locator('[data-node][data-name="result_buffer"] [data-v]').first().click();
      // The node's panel: the picker named for the input, the detach, the
      // parameter control, the name, Remove node, Close.
      const panel = page.locator("[data-node-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("combobox", { name: "Features to buffer" })).toBeVisible();
      await expect(panel.getByRole("spinbutton", { name: /^distance/ })).toBeVisible();
      await expect(panel.getByRole("textbox", { name: "Dataset name" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Remove node" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Close panel" })).toBeVisible();
      // A node's input port names its input and its value.
      await expect(page.getByLabel("Features to buffer: not set")).toHaveCount(1);
      await panel.getByRole("button", { name: "Remove node" }).click();
      const dialog = page.locator("[data-removal-dialog]");
      await expect(dialog.getByRole("button", { name: "Keep" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Remove" })).toBeVisible();
      await dialog.getByRole("button", { name: "Remove" }).click();
      await expect(dialog).toHaveCount(0);
    });

    await test.step("workflow canvas, runs: the frame's action, the confirmation, the panel's Run section, the band's bar, separator and tabs are named", async () => {
      const id = await seedWorkflow(page);
      await page.goto(`/workflows/${id}`);
      await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
      await expect(page.getByRole("button", { name: "Run all" })).toBeVisible();
      await expect(page.getByRole("separator", { name: "Resize the results band" })).toBeVisible();
      await expect(page.getByRole("tab", { name: /^Messages/ })).toBeVisible();
      await expect(page.getByRole("group", { name: "Which nodes" })).toBeVisible();
      await page.getByRole("button", { name: "Run all" }).click();
      const confirm = page.locator("[data-run-confirm]");
      await expect(confirm.getByRole("button", { name: /^Run 1 node$/ })).toBeVisible();
      await expect(confirm.getByRole("button", { name: "Cancel" })).toBeVisible();
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await page.locator('[data-node][data-kind="node"] [data-v]').first().click();
      const panel = page.locator("[data-node-panel]");
      await expect(panel.getByRole("button", { name: /Run this node|Run again/ })).toBeVisible();
      // The result tabs, the actions, a grid cell and its Copy, the map and
      // the provenance are named; a source table shows them all.
      for (const name of ["Data", "Map", "Provenance"]) await expect(page.getByRole("tab", { name })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.locator('.react-flow__node[aria-label$=", source table"]').first().click();
      await page.getByRole("tab", { name: "Data" }).click();
      const resultsBand = page.locator("[data-results-band]");
      await expect(resultsBand.getByRole("button", { name: "Add to a map" })).toBeVisible();
      await expect(resultsBand.getByRole("link", { name: "Open in Data" })).toBeVisible();
      const cell = page.locator("[data-band-data] td[tabindex='0']").first();
      await expect(cell).toBeVisible();
      await cell.click();
      await expect(page.getByRole("dialog", { name: "Cell value" }).getByRole("button", { name: "Copy" })).toBeVisible();
      await page.getByRole("tab", { name: "Map" }).click();
      await expect(page.locator("[data-band-readout]")).toBeVisible({ timeout: 30_000 });
      expect(await page.locator("[data-band-map] canvas.maplibregl-canvas").getAttribute("aria-label"), "the band's map is named").toBeTruthy();
      await page.getByRole("tab", { name: "Provenance" }).click();
      await expect(page.locator("[data-band-provenance='imported']")).toBeVisible();
      // Notes: the tool, a note as an annotation with its own name and
      // description, its menu's swatches and buttons, its text.
      await page.keyboard.press("Escape");
      const noteTool = page.getByRole("button", { name: "Add a note" });
      await expect(noteTool).toBeVisible();
      await noteTool.click();
      await page.keyboard.press("Enter");
      const noteField = page.getByRole("textbox", { name: "Note text" });
      await expect(noteField).toBeFocused();
      await page.keyboard.press("Escape");
      const note = page.locator(".react-flow__node[data-id^='note:']").first();
      await expect(note).toBeFocused();
      await expect(note).toHaveAttribute("role", "note");
      await expect(note).toHaveAttribute("aria-roledescription", "annotation");
      await expect(note).toHaveAccessibleName("Note, note");
      await expect(note).toHaveAccessibleDescription(/Press Enter to write/);
      const noteMenu = page.getByRole("group", { name: "Note", exact: true });
      await expect(noteMenu.getByRole("group", { name: "Note colour" }).getByRole("button", { name: "green", exact: true })).toBeVisible();
      for (const name of ["Edit note", "Duplicate note", "Delete note"]) await expect(noteMenu.getByRole("button", { name })).toBeVisible();
      await noteMenu.getByRole("button", { name: "Delete note" }).click();
      await expect(note).toHaveCount(0);
      // Back to the map for the chrome step that follows.
      await page.goto(`/maps/${mapId}?layer=${layerId}`);
      await expect(page.getByText("12 features").first()).toBeVisible({ timeout: 30_000 });
    });

    await test.step("chrome: the map-name editor and assistant close are named", async () => {
      await page.locator('button[title^="Rename "]').click();
      await expect(
        page.getByRole("textbox", { name: "Map name" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      expect(
        await page
          .locator('[aria-label="Close assistant"]')
          .count(),
      ).toBe(1);
    });

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`the focus census (${theme}): un-suppressed families draw the ring; hit floors hold`, async ({
      page,
      context,
    }) => {
      const consoleErrors = trackConsole(page);
      // The table whose inspection read the results step cuts on
      // purpose: its resource errors are induced, not defects.
      let cutTable: string | null = null;
      await page.addInitScript((t) => {
        window.localStorage.setItem("dezfil-theme", t);
      }, theme);
      await routeHouse(context);
      const { mapId, layerId } = await seedStyledMap(page);

      await test.step("builder families", async () => {
        await page.goto(`/maps/${mapId}?layer=${layerId}`);
        await expect(page.getByText("12 features").first()).toBeVisible({
          timeout: 30_000,
        });
        // StylePanel select family (the fill attribute select).
        await expectRing(
          page,
          page.getByRole("combobox", { name: "Fill color attribute" }),
          "the fill attribute select",
        );
        // StylePanel break-input family + its hit floor.
        const breakInput = page.getByRole("textbox", {
          name: "Fill class boundary 1",
        });
        await expectRing(page, breakInput, "the class boundary field");
        await expectHitFloor(breakInput, "the class boundary field");
        await expectHitFloor(
          page.locator('input[aria-label="Fill class 1 color"]'),
          "the class color swatch",
        );
        // FilterSection bound family.
        await expectRing(
          page,
          page.getByRole("spinbutton", { name: "riders minimum" }),
          "the filter minimum",
        );
        await expectRing(
          page,
          page.getByRole("spinbutton", { name: "riders maximum" }),
          "the filter maximum",
        );
        // The filter brush handles: transparent inputs whose knobs wear
        // the ring. Before, the ring painted on the input — which spans
        // the whole track — so it framed the histogram.
        for (const handle of ["Minimum", "Maximum"] as const) {
          const input = page
            .getByRole("slider", { name: handle, exact: true })
            .first();
          await expectRelocatedRing(
            page,
            input,
            page.locator(`input[aria-label="${handle}"] + span`).first(),
            `the filter brush ${handle.toLowerCase()} handle`,
          );
        }
        // Reorder grip: ring + floor.
        const grip = page.getByRole("button", { name: "Reorder alpha", exact: true });
        await expectRing(page, grip, "the layer reorder grip");
        await expectHitFloor(grip, "the layer reorder grip");
        // Histogram handle: floor (its ring is the same global rule).
        await expectHitFloor(
          page.getByRole("slider", { name: "Riders range start" }),
          "the histogram handle",
        );
        // Canvas-legend affordance: ring + floor.
        const legendTitle = page.getByRole("button", {
          name: "Edit legend title, alpha",
        });
        await expectRing(page, legendTitle, "the canvas legend title");
        await expectHitFloor(legendTitle, "the canvas legend title");
        // Legend tab: title input family + the eye toggle's floor.
        await page.getByRole("tab", { name: "Legend" }).click();
        await expectRing(
          page,
          page.getByRole("textbox", { name: "Legend title, alpha" }),
          "the legend title input",
        );
        await expectHitFloor(
          page.getByRole("button", {
            name: /Hide fill variable name, alpha/,
          }),
          "the variable eye toggle",
        );
        // The layer rename input (previously ring-less entirely). Text
        // fields are :focus-visible on any focus in Chromium, so the
        // autofocused editor must draw the ring.
        await page.getByRole("tab", { name: "Layers" }).click();
        // Rename lives behind the row's overflow menu since 0089.
        await page
          .getByRole("button", { name: "Layer menu", exact: true })
          .first()
          .click();
        await page
          .getByRole("menuitem", { name: "Rename", exact: true })
          .click();
        const rename = page.getByRole("textbox", { name: "Layer name" });
        await expect(rename).toBeFocused();
        expect(
          await rename.evaluate((el) => getComputedStyle(el).outlineStyle),
          "the layer rename input draws the ring",
        ).toBe("solid");
        await page.keyboard.press("Escape");
        // The map-name editor family.
        await page.locator('button[title^="Rename "]').click();
        const mapName = page.getByRole("textbox", { name: "Map name" });
        await expect(mapName).toBeFocused();
        expect(
          await mapName.evaluate((el) => getComputedStyle(el).outlineStyle),
          "the map name input draws the ring",
        ).toBe("solid");
        await page.keyboard.press("Escape");
        // Add-layer catalog search family.
        await page.getByRole("button", { name: "Add layer" }).click();
        // Files-first: the census probes the Tables search.
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /^Tables/ })
          .click();
        await expectRing(
          page,
          page.getByRole("searchbox", { name: "Search tables" }).or(
            page.getByPlaceholder("Search tables…"),
          ),
          "the catalog search",
        );
        await page.keyboard.press("Escape");
      });

      await test.step("workspace families", async () => {
        // Gallery search (the unconditional suppression).
        await page.goto("/maps");
        await expectRing(
          page,
          page.getByRole("textbox", { name: "Search maps" }),
          "the gallery search",
        );
        // The add-data dialog families: PostGIS and URL import fields.
        await page.goto("/data");
        await page.getByRole("button", { name: "Add data" }).first().click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("tab", { name: "From URL" }).click();
        await expectRing(
          page,
          dialog.getByRole("textbox").first(),
          "the URL import field",
        );
        await page.keyboard.press("Escape");
      });

      await test.step("workflow canvas families", async () => {
        const id = await seedWorkflow(page);
        await seedOffArrangement(page, id);
        await page.goto(`/workflows/${id}`);
        await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
        await expectRing(page, page.getByRole("tab", { name: /^Sources/ }), "the pane's Sources tab");
        await expectRing(page, page.getByRole("searchbox", { name: "Search sources" }), "the pane's search");
        await expectRing(page, page.getByRole("button", { name: "Zoom in" }), "the stage's zoom in");
        // Undo and Redo: dimmed until there is a step, so Arrange makes one
        // and its undo makes the other side; each then takes the ring and
        // holds the hit floor.
        await page.getByRole("button", { name: "Arrange by dependency" }).click();
        await page.waitForTimeout(700);
        const undoBtn = page.getByRole("button", { name: "Undo", exact: true });
        await expect(undoBtn).toBeEnabled();
        await expectRing(page, undoBtn, "the stage's Undo");
        await expectHitFloor(undoBtn, "the stage's Undo");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(700);
        const redoBtn = page.getByRole("button", { name: "Redo", exact: true });
        await expect(redoBtn).toBeEnabled();
        await expectRing(page, redoBtn, "the stage's Redo");
        await expectHitFloor(redoBtn, "the stage's Redo");
        // The lock: the last stage button, named and pressed while locked.
        await expectRing(page, page.getByRole("button", { name: "Lock canvas" }), "the lock");
        await expectHitFloor(page.getByRole("button", { name: "Lock canvas" }), "the lock");
        await expectRing(page, page.locator(".react-flow__node").first(), "a canvas node");
      });

      await test.step("workflow canvas, editing families", async () => {
        const pane = page.locator("[data-canvas-pane]");
        await pane.getByRole("tab", { name: /^Tools/ }).click();
        await expectRing(page, pane.getByRole("button", { name: "Add Buffer" }), "a pane Tools row");
        await pane.getByRole("button", { name: "Add Buffer" }).click();
        await page.locator('[data-node][data-name="result_buffer"] [data-v]').first().click();
        const panel = page.locator("[data-node-panel]");
        await expect(panel).toBeVisible();
        await expectRing(page, panel.getByRole("combobox", { name: "Features to buffer" }), "the panel's input picker");
        // The picker's popover: its search takes the ring and the arrows walk the rows.
        await page.keyboard.press("ArrowDown");
        const pickerSearch = page.locator("[data-picker-pop]").getByRole("textbox");
        await expect(pickerSearch).toBeFocused();
        await expect(page.locator("[data-picker-pop] [role='option'][data-active]")).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(panel.getByRole("combobox", { name: "Features to buffer" })).toBeFocused();
        await expectRing(page, panel.getByRole("spinbutton", { name: /^distance/ }), "a parameter control");
        await expectRing(page, panel.getByRole("textbox", { name: "Dataset name" }), "the name field");
        await expectRing(page, panel.getByRole("button", { name: "Remove node" }), "Remove node");
        await panel.getByRole("button", { name: "Remove node" }).click();
        const dialog = page.locator("[data-removal-dialog]");
        await expectRing(page, dialog.getByRole("button", { name: "Keep" }), "the confirmation's Keep");
        await dialog.getByRole("button", { name: "Keep" }).click();
      });

      await test.step("workflow canvas, run families", async () => {
        await page.keyboard.press("Escape");
        await expectRing(page, page.getByRole("button", { name: "Run all" }), "the frame's Run all");
        await expectRing(page, page.getByRole("separator", { name: "Resize the results band" }), "the band's separator");
        await page.getByRole("button", { name: "Run all" }).click();
        const confirm = page.locator("[data-run-confirm]");
        await expectRing(page, confirm.getByRole("button", { name: "Cancel" }), "the run confirmation's Cancel");
        await confirm.getByRole("button", { name: "Cancel" }).click();
      });

      await test.step("workflow canvas, results families", async () => {
        // A source selected makes the result tabs available; each family is
        // reached by keyboard before it is used, so the ring is the keyboard's.
        await page.locator('.react-flow__node[aria-label$=", source table"]').first().click();
        await expectRing(page, page.getByRole("tab", { name: "Data" }), "the band's Data tab");
        await page.keyboard.press("Enter");
        const resultsBand = page.locator("[data-results-band]");
        await expect(resultsBand).not.toHaveAttribute("data-collapsed", "true");
        await expectRing(page, resultsBand.getByRole("button", { name: "Add to a map" }), "the band's Add to a map");
        await expectRing(page, resultsBand.getByRole("link", { name: "Open in Data" }), "the band's Data link");
        await expectRing(page, page.locator("[data-band-data] td[tabindex='0']").first(), "a grid cell");
        // The map: the shared preview's canvas is named and takes the ring.
        await page.getByRole("tab", { name: "Map" }).click();
        const mapCanvas = page.locator("[data-band-map] canvas.maplibregl-canvas");
        await expect(mapCanvas).toBeVisible({ timeout: 30_000 });
        expect(await mapCanvas.getAttribute("aria-label"), "the band's map is named").toBeTruthy();
        await expectRing(page, mapCanvas, "the band's map");
        // Retry: a cut inspection read shows it in Provenance, and it takes the ring.
        const table = (await page.locator("[data-band-lead] b").innerText()).trim();
        cutTable = table;
        let cut = true;
        await page.route(`**/api/tables/${table}`, async (route) => (cut ? route.abort() : route.continue()));
        await page.getByRole("tab", { name: "Provenance" }).click();
        const retry = page.locator("[data-band-read-failed]").getByRole("button", { name: "Retry" });
        await expectRing(page, retry, "the band's Retry");
        cut = false;
        await retry.click();
        await expect(page.locator("[data-band-provenance]")).toBeVisible();
        await page.unroute(`**/api/tables/${table}`);
      });

      await test.step("workflow canvas, note families", async () => {
        // The tool; a note made by Enter, its text field focused; the edit
        // closed by a key returns focus to the note, an annotation; the
        // menu's swatches and buttons; the eight handles' hit surfaces in
        // the note's own space (on screen they scale with the zoom).
        await page.keyboard.press("Escape");
        const noteTool = page.getByRole("button", { name: "Add a note" });
        await expectRing(page, noteTool, "the note tool");
        await expectHitFloor(noteTool, "the note tool");
        await page.keyboard.press("Enter");
        await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-mode", "note");
        await page.keyboard.press("Enter");
        const noteField = page.getByRole("textbox", { name: "Note text" });
        await expectRing(page, noteField, "the note text");
        await page.keyboard.press("Escape");
        const note = page.locator(".react-flow__node[data-id^='note:']").first();
        await expect(note).toBeFocused();
        await expectRing(page, note, "a note");
        const noteMenu = page.getByRole("group", { name: "Note", exact: true });
        const swatch = noteMenu.getByRole("button", { name: "green", exact: true });
        await expectRing(page, swatch, "a note swatch");
        await expectHitFloor(swatch, "a note swatch");
        for (const name of ["Edit note", "Duplicate note", "Delete note"]) await expectRing(page, noteMenu.getByRole("button", { name }), `the menu's ${name}`);
        const zoom = Number(await page.locator(".react-flow__viewport").evaluate((el) => /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? "1"));
        const controls = note.locator(".react-flow__resize-control");
        await expect(controls).toHaveCount(8);
        for (let i = 0; i < 8; i++) {
          const box = (await controls.nth(i).boundingBox())!;
          expect(box.width / zoom, `resize handle ${i} width`).toBeGreaterThanOrEqual(23.5);
          expect(box.height / zoom, `resize handle ${i} height`).toBeGreaterThanOrEqual(23.5);
        }
        await noteMenu.getByRole("button", { name: "Delete note" }).click();
        await expect(note).toHaveCount(0);
      });

      const unexpected = consoleErrors.filter(
        (e) => !isAllowedConsoleError(e.text, e.url) && !(cutTable && (e.url ?? "").includes(`/api/tables/${cutTable}`)),
      );
      expect(unexpected).toEqual([]);
    });
  }
});
