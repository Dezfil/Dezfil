// Styling, legend and 3D: the channel and legend classes the journey
// never asserted — the opacity commit as a durable styled truth, POLYGON
// extrusion through the real Height-by control, legend title/label
// editing with its PUBLISHED read-back, and the record's named promotion
// drive: an external change (undo, then redo) landing while the legend
// editor is open refreshes every field to the committed state.
// (Data-driven fill/classification/palette and the cell extrusion are
// journey-held; size/stroke channels are matrix-held — the verification
// record maps them.)
//
// Environment: the documented gate — production standalone,
// DEZFIL_RENDER_CAP_FEATURES=2000, third-party hosts blocked. Run via
// `npm run e2e:styling` with DEZFIL_BASE_URL pointing at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  expectMapChanged,
  layerSaveArrived,
  mapShot,
  patchLayer,
  publishMap,
  readLayer,
  readPublished,
  routeHouse,
  saveSettled,
  seedFile,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const districtsTable = `sty_districts_${runId}`;

/** Arrival signal for a history write — undo and redo have their own
 * endpoints, so the layer-PATCH signal never sees them. */
const historyArrived = (page: Page, kind: "undo" | "redo") =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new RegExp(`/api/maps/[^/]+/${kind}$`).test(response.url()),
  );

test("opacity, polygon extrusion, legend editing, and the external-refresh contract", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await test.step("seed: polygon table, map, categorical fill", async () => {
    await page.goto("/maps");
    await seedFile(
      page,
      `${districtsTable}.geojson`,
      readFileSync(path.join(FIXTURES_DIR, "districts.geojson")),
      "application/geo+json",
    );
  });

  const mapId = await createMap(page, "styling and legend");
  const layerId = await addLayer(
    page,
    mapId,
    districtsTable,
    `SELECT * FROM ${districtsTable}`,
  );
  await patchLayer(page, layerId, {
    style: {
      fill: {
        type: "categorical",
        attribute: "name",
        palette: "vivid",
        map: [
          { value: "Mitte", color: { r: 214, g: 96, b: 77, a: 0.9 } },
          { value: "Kreuzberg", color: { r: 67, g: 147, b: 195, a: 0.9 } },
        ],
        other: { r: 180, g: 180, b: 180, a: 0.9 },
      },
      fillOpacity: 0.72,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 0.85,
      strokeWidth: 1,
      pointRadius: 3,
      opacity: 1,
    },
  });
  await page.goto(`/maps/${mapId}`);
  const layerRow = page
    .getByRole("button", { name: new RegExp(`^${districtsTable}`) })
    .first();
  await expect(layerRow).toBeVisible({ timeout: 30_000 });
  await layerRow.click();

  await test.step("the opacity slider commits a durable styled truth", async () => {
    const opacity = page.getByRole("slider", { name: "Layer opacity" });
    await expect(opacity).toHaveValue("1");
    const base = await mapShot(page);
    // Sliders preview during the drag and commit ONCE on release — a real
    // pointer drag, not a programmatic value set.
    const box = (await opacity.boundingBox())!;
    const y = box.y + box.height / 2;
    const saved = layerSaveArrived(page);
    await page.mouse.move(box.x + box.width - 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, y, { steps: 6 });
    await page.mouse.up();
    await saved;
    await saveSettled(page);
    await expectMapChanged(page, base);
    const layer = await readLayer<{ style: { opacity: number } }>(
      page,
      layerId,
    );
    // The committed value is wherever the drag released — the durable
    // truth is that it committed and is well below the starting 1.
    expect(layer.style.opacity).toBeGreaterThan(0.2);
    expect(layer.style.opacity).toBeLessThan(0.6);
  });

  await test.step("polygon extrusion through the real Height-by control", async () => {
    const heightBy = page
      .locator("span", { hasText: "Height by" })
      .locator("xpath=following-sibling::select[1]");
    await expect(heightBy).toBeVisible();
    const base = await mapShot(page);
    const saved = layerSaveArrived(page);
    await heightBy.selectOption("population");
    await saved;
    await saveSettled(page);
    const layer = await readLayer<{
      style: { heightBy?: { attribute: string; range: [number, number] } };
    }>(page, layerId);
    expect(layer.style.heightBy?.attribute).toBe("population");
    // Extrusion arms the fine pitch control alongside the elevation —
    // the style panel's slider, named precisely (the status-probe sweep
    // mis-scoped this at the pill, where flat cameras show no pitch at
    // all).
    await expect(
      page.getByRole("slider", { name: "Pitch", exact: true }),
    ).toBeVisible();
    // Tilt so the prisms are visible, then the canvas must move. The
    // builder's stage toggle eases the camera and can settle back under
    // a re-render (journey 3D step) — re-click until pressed.
    const tiltBtn = page.getByRole("button", { name: /Tilt the map|Back to flat/ });
    await expect
      .poll(
        async () => {
          if ((await tiltBtn.getAttribute("aria-pressed")) !== "true") {
            await tiltBtn.click();
          }
          return tiltBtn.getAttribute("aria-pressed");
        },
        { timeout: 15_000 },
      )
      .toBe("true");
    await expectMapChanged(page, base);
    await saveSettled(page);
  });

  await test.step("legend title and label edits commit and paint", async () => {
    await page
      .getByRole("tablist", { name: "Builder panels" })
      .getByRole("tab", { name: "Legend" })
      .click();
    const title = page.locator('input[title="Legend title"]');
    await expect(title).toBeVisible();
    const firstEntry = page.locator('[class*="entryRow"] input').first();
    await expect(firstEntry).toBeVisible();

    const titleEcho = layerSaveArrived(page);
    await title.click();
    await title.fill("District bands");
    // Blur commits the title.
    await firstEntry.click();
    await titleEcho;
    const labelEcho = layerSaveArrived(page);
    await firstEntry.fill("Central");
    await firstEntry.press("Enter");
    await labelEcho;
    await saveSettled(page);
    const legend = page.locator("[data-corner]", {
      hasText: "District bands",
    });
    await expect(legend).toBeVisible();
    await expect(legend).toContainText("Central");
  });

  await test.step("promotion: undo with the editor open refreshes every field to committed", async () => {
    const firstEntry = page.locator('[class*="entryRow"] input').first();
    await expect(firstEntry).toHaveValue("Central");
    // Undo is a write — on its OWN lane (`POST /api/maps/{id}/undo`), not
    // the layer PATCH lane. Arm that arrival before the click so the
    // refresh assertions below read state the server has confirmed, never
    // optimism (`saveSettled` alone can pass before the write even
    // renders its whisper).
    const undone = historyArrived(page, "undo");
    await page.getByRole("button", { name: /^Undo/ }).click();
    await undone;
    await saveSettled(page);
    // The external change (undo) landed while the editor is open: the
    // label field refreshes to the committed automatic label — never a
    // surviving draft — and the title keeps its own earlier commit.
    await expect(firstEntry).not.toHaveValue("Central");
    await expect(
      page.locator('input[title="Legend title"]'),
    ).toHaveValue("District bands");
    await expect(
      page.locator("[data-corner]", { hasText: "District bands" }),
    ).not.toContainText("Central");

    // Redo is the same contract from the other side: the editor field
    // returns to the redone committed label.
    const redone = historyArrived(page, "redo");
    await page.getByRole("button", { name: /^Redo/ }).click();
    await redone;
    await saveSettled(page);
    await expect(firstEntry).toHaveValue("Central");
  });

  await test.step("labels off→on restores the authored styling", async () => {
    // The authored label arrives via the API (the panel's own slider and
    // color controls are pixel ground); the off→on cycle under test
    // drives the real Text control.
    const before = await readLayer<{ style: Record<string, unknown> }>(
      page,
      layerId,
    );
    await patchLayer(page, layerId, {
      style: {
        ...before.style,
        label: {
          attribute: "name",
          size: 24,
          color: { r: 214, g: 96, b: 77, a: 1 },
          haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
        },
      },
    });
    await page.reload();
    const row = page
      .getByRole("button", { name: new RegExp(`^${districtsTable}`) })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const text = page.getByLabel("Label text");
    await expect(text).toHaveValue("name");

    // Off: the persisted label goes, and with it the attribute choice.
    await text.selectOption("");
    await expect
      .poll(async () => {
        const l = await readLayer<{ style: { label?: unknown } }>(
          page,
          layerId,
        );
        return l.style.label === undefined || l.style.label === null;
      })
      .toBe(true);

    // On again: the authored size, color and halo come back.
    await text.selectOption("name");
    await expect
      .poll(async () => {
        const l = await readLayer<{
          style: {
            label?: {
              attribute?: string;
              size: number;
              haloWidth: number;
              color: { r: number };
            };
          };
        }>(page, layerId);
        const label = l.style.label;
        return (
          label !== undefined &&
          label.attribute === "name" &&
          label.size === 24 &&
          label.haloWidth === 1 &&
          label.color.r === 214
        );
      })
      .toBe(true);

    // A direct attribute switch still preserves the styling (the
    // long-standing sibling contract the fix must not disturb).
    await text.selectOption("population");
    await expect
      .poll(async () => {
        const l = await readLayer<{
          style: { label?: { attribute?: string; size: number } };
        }>(page, layerId);
        return l.style.label?.attribute === "population" &&
          l.style.label.size === 24;
      })
      .toBe(true);

    // A different layer with no remembered styling gets the defaults —
    // one layer's memory must not leak into another (per-layer isolation).
    const layer2Id = await addLayer(
      page,
      mapId,
      districtsTable,
      `SELECT * FROM ${districtsTable}`,
    );
    await page.reload();
    // New layers insert at the top of the list — the fresh layer is first.
    const row2 = page
      .getByRole("button", { name: new RegExp(`^${districtsTable}`) })
      .first();
    await expect(row2).toBeVisible({ timeout: 30_000 });
    await row2.click();
    await page.getByLabel("Label text").selectOption("name");
    await expect
      .poll(async () => {
        const l = await readLayer<{
          style: { label?: { size: number; haloWidth: number } };
        }>(page, layer2Id);
        return (
          l.style.label !== undefined &&
          l.style.label.size === 12 &&
          l.style.label.haloWidth === 0
        );
      })
      .toBe(true);
  });

  await test.step("the published viewer reads back the edited legend and the extrusion", async () => {
    const token = await publishMap(page, mapId);
    const view = await readPublished<{
      layers: {
        id: string;
        legendTitle: string | null;
        legendLabels: (string | null)[] | null;
        style: { opacity: number; heightBy?: { attribute: string } };
      }[];
    }>(page, token);
    const layer = view.layers.find((l) => l.id === layerId)!;
    expect(layer.legendTitle).toBe("District bands");
    expect(layer.legendLabels?.[0]).toBe("Central");
    expect(layer.style.opacity).toBeLessThan(0.6);
    expect(layer.style.heightBy?.attribute).toBe("population");

    await page.goto(`/v/${token}`);
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.getByText("District bands")).toBeVisible();
    await expect(page.getByText("Central")).toBeVisible();
    // Extruded polygons hand the reader the tilt control — the
    // builder's tilted camera persisted, so it may already read "Back
    // to flat".
    await expect(
      page.getByRole("button", { name: /Tilt the map|Back to flat/ }),
    ).toBeVisible();
  });

  await test.step("the console stayed clean", async () => {
    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });
});
