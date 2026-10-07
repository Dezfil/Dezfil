// The export journeys' fixture: a twelve-station map styled in two class
// colours (kelp and amber) with a histogram widget, the builder opened on
// it and the export card opened over it. Shared by every journey that
// downloads or previews the image, so a comparison between two of them
// is a comparison over one map state, never two forks of it, and by any
// journey that needs a styled map with a legend and a widget on its stage.
import path from "node:path";
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  patchLayer,
  patchMap,
  seedCsv,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `exp_${runId}`;

export const KELP = { r: 26, g: 93, b: 74 };
export const AMBER = { r: 233, g: 179, b: 91 };

export async function seed(page: Page): Promise<{ mapId: string; layerId: string }> {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  const mapId = await createMap(page, "Export flow");
  const layerId = await addLayer(
    page,
    mapId,
    "stations",
    `SELECT * FROM "${tableName}"`,
  );
  await patchLayer(page, layerId, {
    style: {
      fill: {
        type: "quantile",
        attribute: "riders",
        palette: "global_warming",
        breaks: [12000],
        colors: [
          { r: KELP.r, g: KELP.g, b: KELP.b, a: 0.9 },
          { r: AMBER.r, g: AMBER.g, b: AMBER.b, a: 0.9 },
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

export async function openBuilder(page: Page, mapId: string): Promise<void> {
  await page.goto(`/maps/${mapId}`);
  await expect(page.getByText("12 features").first()).toBeVisible({
    timeout: 30_000,
  });
}

export async function openCard(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /Image/ }).first().click();
  await expect(page.getByRole("dialog", { name: "Export image" })).toBeVisible();
  // The preview map inside the frame must actually render before any
  // capture or framing assertion means anything.
  await expect(
    page.locator("[data-export-card] canvas").first(),
  ).toBeVisible({ timeout: 30_000 });
}
