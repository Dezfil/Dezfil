// The shared corner picker.
//
// Everything is measured or read from ARIA truth — radio roles, checked
// state, live corner storage — never a styling class. The contracts:
// both surfaces show the map-proxy picker; choosing stores; a saved
// corner round-trips; one tab stop with reading-order arrows; the
// export credit's collision corner is disabled and unreachable; legend
// dragging survives.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  patchLayer,
  seedFile,
  trackConsole,
} from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `corner_${runId}`;

const WIDE = { width: 1440, height: 900 };
const CORNER_NAMES = ["Top left", "Top right", "Bottom left", "Bottom right"];

async function seedMap(page: Page): Promise<string> {
  await page.goto("/maps");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `corner ${runId}`);
  await addLayer(page, mapId, stations, `SELECT * FROM ${stations}`);
  return mapId;
}

const legendPicker = (page: Page) =>
  page.getByRole("radiogroup", { name: "Legend corner" });

test.use({ viewport: WIDE });

test("the Legend tab's picker stores, round-trips, and walks by arrow", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Legend" })
    .click();

  const picker = legendPicker(page);
  await expect(picker).toBeVisible();
  // Four markers, named, bottom-left the default truth.
  for (const name of CORNER_NAMES) {
    await expect(picker.getByRole("radio", { name, exact: true })).toBeVisible();
  }
  await expect(
    picker.getByRole("radio", { name: "Bottom left", exact: true }),
  ).toHaveAttribute("aria-checked", "true");

  // One tab stop.
  expect(
    await picker.locator('[role="radio"][tabindex="0"]').count(),
  ).toBe(1);

  // Choose top-right by click; the map stores it and it round-trips.
  await picker.getByRole("radio", { name: "Top right", exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const map = (await (
          await fetch(`/api/maps/${id}`, { cache: "no-store" })
        ).json()) as { legendCorner?: string | null };
        return map.legendCorner ?? null;
      }, mapId),
    )
    .toBe("top-right");
  await page.reload();
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Legend" })
    .click();
  await expect(
    legendPicker(page).getByRole("radio", { name: "Top right", exact: true }),
  ).toHaveAttribute("aria-checked", "true");

  // Arrow keys walk reading order from the focused stop.
  await legendPicker(page)
    .getByRole("radio", { name: "Top right", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    legendPicker(page).getByRole("radio", { name: "Bottom left", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(
    legendPicker(page).getByRole("radio", { name: "Top right", exact: true }),
  ).toHaveAttribute("aria-checked", "true");

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the export credit's picker disables the legend's corner, unreachable by click or arrow", async ({
  page,
}) => {
  const mapId = await seedMap(page);
  // A data-driven channel so the legend exists in the export dialog.
  await page.goto(`/maps/${mapId}`);
  const layerId = await page.evaluate(async (id) => {
    const map = (await (
      await fetch(`/api/maps/${id}`, { cache: "no-store" })
    ).json()) as { layers: { id: string }[] };
    return map.layers[0].id;
  }, mapId);
  await patchLayer(page, layerId, {
    style: {
      fill: {
        type: "quantile",
        attribute: "riders",
        palette: "global_warming",
        breaks: [12000],
        colors: [
          { r: 13, g: 125, b: 92, a: 0.9 },
          { r: 224, g: 154, b: 66, a: 0.9 },
        ],
      },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 6,
      opacity: 1,
    },
  });
  await page.reload();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /Image/ }).click();
  const dialog = page.getByRole("dialog", { name: "Export image" });
  await expect(dialog).toBeVisible();

  const credit = dialog.getByRole("radiogroup", { name: "Credit corner" });
  await expect(credit).toBeVisible();
  // The legend sits bottom-left by default: that corner is disabled.
  const blocked = credit.getByRole("radio", { name: "Bottom left", exact: true });
  await expect(blocked).toBeDisabled();
  // Clicking it changes nothing.
  const before = await credit
    .locator('[role="radio"][aria-checked="true"]')
    .getAttribute("aria-label");
  await blocked.click({ force: true });
  await expect(
    credit.locator('[role="radio"][aria-checked="true"]'),
  ).toHaveAttribute("aria-label", before!);
  // Arrows never land on it: walk the full cycle and collect names.
  await credit.locator('[role="radio"][tabindex="0"]').focus();
  const seen = new Set<string>();
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("ArrowRight");
    const name = await credit
      .locator('[role="radio"][aria-checked="true"]')
      .getAttribute("aria-label");
    if (name) seen.add(name);
  }
  expect(seen.has("Bottom left")).toBe(false);
});
