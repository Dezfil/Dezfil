// The status pill's priority dropping.
//
// Everything is measured from the visible pill — the probe row is
// invisible and inert and must never satisfy an assertion. The contract:
// with all five items present (records via a widget, pitch via tilt),
// narrowing the stage walks the visible set through every priority
// boundary — pitch out first, then bbox, then records, then zoom, coords
// last, then no pill at all — with survivors in today's order and no
// item ever clipped.
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
  patchMap,
  seedFile,
  trackConsole,
} from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `statusbar_${runId}`;

const WIDE = { width: 1440, height: 900 };

const BAR = "[data-status-bar]";
const ITEMS: Record<string, string> = {
  records: `${BAR} [data-records]`,
  coords: `${BAR} button[data-hint="Copy coordinates"]`,
  zoom: `${BAR} :text-is("Zoom")`,
  pitch: `${BAR} :text-is("Pitch")`,
  bbox: `${BAR} button[data-hint="Copy bounding box"]`,
};
/** Today's document order — survivors must keep it. */
const DOC_ORDER = ["records", "coords", "zoom", "pitch", "bbox"];
/** The ruled drop order, first-out first. */
const DROP_ORDER = ["pitch", "bbox", "records", "zoom", "coords"];

async function visibleSet(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const key of DOC_ORDER) {
    if (await page.locator(ITEMS[key]).isVisible()) out.push(key);
  }
  return out;
}

/** No clipping: every visible item's box sits fully inside the pill's. */
async function expectNoClipping(page: Page) {
  // boundingBox() waits for attachment, so ask for existence first — an
  // absent pill is the honest narrowest state, not a timeout.
  if ((await page.locator(BAR).count()) === 0) return;
  const bar = await page.locator(BAR).boundingBox();
  if (!bar) return;
  for (const key of DOC_ORDER) {
    const item = page.locator(ITEMS[key]);
    if (!(await item.isVisible())) continue;
    const box = (await item.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bar.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
  }
  const overflow = await page
    .locator(BAR)
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.use({ viewport: WIDE });

test("the pill drops items whole, in priority order, at every boundary", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const consoleErrors = trackConsole(page);

  await page.goto("/maps");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `statusbar ${runId}`);
  await addLayer(page, mapId, stations, `SELECT * FROM ${stations}`);
  // A category widget so the Records readout exists — it must ride a
  // real layer, so read the one just added.
  const layerId = await page.evaluate(async (id) => {
    const map = (await (
      await fetch(`/api/maps/${id}`, { cache: "no-store" })
    ).json()) as { layers: { id: string }[] };
    return map.layers[0].id;
  }, mapId);
  await patchMap(page, mapId, {
    widgets: [
      {
        id: `w-${runId}`,
        type: "category",
        layerId,
        title: "By kind",
        field: "kind",
        agg: "count",
        aggField: null,
        unit: null,
        note: null,
        format: null,
        visible: true,
      },
    ],
  });
  await page.goto(`/maps/${mapId}`);
  await expect(page.locator(BAR)).toBeVisible();

  // The pill renders before the camera handle exists — a tilt click into
  // a null handle is a silent no-op. Zoom showing a number is the camera
  // being live.
  await expect(page.locator(BAR)).toContainText(/Zoom\s*\d/);

  // Pitch into view: tilt the camera from the stage stack.
  await page.getByRole("button", { name: "Tilt the map" }).click();
  await expect(page.locator(ITEMS.pitch)).toBeVisible();

  // All five at full width, in document order.
  await expect.poll(() => visibleSet(page)).toEqual(DOC_ORDER);
  await expectNoClipping(page);

  // For every size 0–5, the only legal composition: the document-ordered
  // survivors after the ruled drops.
  const legal = new Map<number, string>();
  {
    let remaining = [...DOC_ORDER];
    legal.set(remaining.length, remaining.join());
    for (const drop of DROP_ORDER) {
      remaining = remaining.filter((k) => k !== drop);
      legal.set(remaining.length, remaining.join());
    }
  }

  // Narrow in small steps. Capacity is not strictly monotone in viewport
  // width (the shell's 1120px breakpoint widens the stage as the viewport
  // crosses it, and the spec lets items return when width does) — so the
  // claim checked at every step is compositional: whatever size shows, it
  // is exactly the priority survivors of that size, unclipped. The walk
  // must still visit every size from five to none.
  const sizesSeen = new Set<number>([5]);
  for (let width = WIDE.width; width >= 160; width -= 8) {
    await page.setViewportSize({ width, height: WIDE.height });
    await page.waitForTimeout(90);
    const now = await visibleSet(page);
    expect(now.join()).toBe(legal.get(now.length));
    sizesSeen.add(now.length);
    await expectNoClipping(page);
  }
  expect([...sizesSeen].sort()).toEqual([0, 1, 2, 3, 4, 5]);

  // And the pill itself is gone at the narrowest — no empty husk.
  expect(await page.locator(BAR).count()).toBe(0);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
