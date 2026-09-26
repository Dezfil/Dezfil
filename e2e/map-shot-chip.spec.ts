// The map-pixel shots do not see the save status chip.
//
// Moved the builder's transient save status out of the header card and
// onto the map stage, inside `.canvasCol` — inside the region every
// map-pixel shot clips. The chip fades for 430 ms after each save, so a
// byte-exact poll straddling that window compares a frame holding the
// chip's ghost against one without it. `journey.spec.ts` then failed
// deterministically on its post-undo settle (the differing region was
// exactly the chip's box: 32 pixels of 498,480, maximum per-channel delta
// 1, the other 498,448 byte-identical), and `support.ts`'s shared
// `expectMapChanged` — which polls for INEQUALITY — could be satisfied by
// the chip alone in nine drives across the layer and import matrices.
//
// The repair is one screenshot-scoped stylesheet, `MAP_SHOT_STYLE`.
// Masking cannot do the job and that was measured: Playwright paints a
// mask at the element's bounding box, and the corner's box is 750x0 with
// the chip down and 750x30 with it up, so the mask rectangle is itself
// the unstable thing.
//
// This file is the ratchet for that line, in two halves, because no
// single check reaches both homes:
//
//   - the RENDERED half proves the mechanism against the real shared
//     helper — that the chip genuinely moves pixels inside the clip, and
//     that `mapShot` holds it out anyway;
//   - the SOURCE half proves the six local shot closures in
//     `journey.spec.ts` still carry the line. The rendered half cannot
//     reach them (they are closures over one test's `canvasBox`), and two
//     green journey runs are absence of failure, not proof.
//
// Neither half asserts anything about the chip's own behavior: its
// placement, text, tone, hold and action are owned by
// `save-status-chip.spec.ts` and watched by `workflow-undo`,
// `workflow-editing` and `workflow-runs`.
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MAP_SHOT_INSET,
  addLayer,
  createMap,
  mapShot,
  routeHouse,
  saveSettled,
  seedCsv,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `chipshot_${runId}`;

const CSV = [
  "id,lng,lat,rank",
  ...Array.from(
    { length: 12 },
    (_, i) => `p${i},${(13.3 + i * 0.02).toFixed(3)},${(52.4 + i * 0.01).toFixed(3)},${i + 1}`,
  ),
].join("\n");

/** The control shot: the same clip and the same chrome masks as
 * `support.ts`'s `mapShot`, and deliberately NOT its stylesheet.
 *
 * It is a separate code path on purpose. A comparison whose two sides come
 * from the same function could not distinguish "the style holds the chip
 * out" from "the chip was never in the clip", and the second reading is
 * the one that would make the whole repair a no-op assertion. */
async function controlShot(page: Page): Promise<Buffer> {
  const box = await page.locator('[class*="canvasCol"]').boundingBox();
  if (!box) throw new Error("map card not on screen");
  return page.screenshot({
    clip: {
      x: box.x + MAP_SHOT_INSET,
      y: box.y + MAP_SHOT_INSET,
      width: box.width - MAP_SHOT_INSET * 2,
      height: box.height - MAP_SHOT_INSET * 2,
    },
    mask: [
      page.locator('[class*="StatusBar-module"]'),
      page.locator('[class*="timelineDock"]'),
      page.locator('[class*="stageStack"]'),
      page.locator('[class*="overlayCorner"]'),
      page.locator('[class*="offline"]'),
      page.locator('[class*="BasemapCredit-module"]'),
    ],
  });
}

/** Hold the chip open, or let it close, WITHOUT touching product state:
 * no store write, no request, nothing the map reads. The chip's own
 * markers are set directly, exactly as the shipped CSS sets them, so the
 * pixels under test are the real chip's — a fake box drawn for the
 * occasion would prove nothing about the shipped one. Nothing re-renders
 * this subtree while the shot is taken, so the attributes stand. */
const holdChip = (page: Page, open: boolean) =>
  page.evaluate((open) => {
    const chip = document.querySelector<HTMLElement>("[data-save-status-chip]");
    const line = document.querySelector<HTMLElement>('[data-save-status="saving"]');
    if (!chip || !line) throw new Error("the stage chip is not mounted");
    const words = line.firstElementChild as HTMLElement | null;
    if (!words) throw new Error("the chip's line has no text band");
    if (open) {
      words.textContent = "Saving…";
      chip.dataset.on = "";
      line.dataset.on = "";
    } else {
      delete chip.dataset.on;
      delete line.dataset.on;
      words.textContent = "";
    }
  }, open);

/** Wait until two consecutive shots agree: the byte-exact comparisons
 * below are only meaningful over a map that has stopped moving, and the
 * chip's own entrance and exit transitions have to finish inside this too. */
async function settle(page: Page, shot: () => Promise<Buffer>): Promise<void> {
  let previous = await shot();
  await expect
    .poll(
      async () => {
        const next = await shot();
        const same = next.equals(previous);
        previous = next;
        return same;
      },
      { timeout: 60_000, intervals: [400] },
    )
    .toBe(true);
}

test("the map shot cannot see the stage's save status chip", async ({
  page,
  context,
}) => {
  // The stubbed basemap style keeps the stage free of tile traffic, so a
  // settled map really is settled and a byte comparison means what it says.
  await routeHouse(context, { basemapStyleStub: true });

  await page.goto("/maps");
  await seedCsv(page, tableName, CSV);
  const mapId = await createMap(page, `chip shot ${runId}`);
  await addLayer(page, mapId, tableName, `SELECT * FROM ${tableName}`);
  await page.goto(`/maps/${mapId}`);
  await expect(
    page.getByRole("button", { name: new RegExp(`^${tableName}`) }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-save-status-chip]")).toHaveCount(1);
  await saveSettled(page);
  await settle(page, () => controlShot(page));

  // Chip down.
  const controlDown = await controlShot(page);
  const shotDown = await mapShot(page);
  expect(
    shotDown.equals(controlDown),
    "the control reads the same region as the shared helper: with the chip down the stylesheet changes nothing",
  ).toBe(true);

  // Chip up, held open, nothing else moved.
  await holdChip(page, true);
  await settle(page, () => controlShot(page));
  const controlUp = await controlShot(page);
  const shotUp = await mapShot(page);

  // The seeded defect this file exists for: the chip is INSIDE the clip
  // and moves pixels there. Without this the equality below would pass on
  // a chip the shot could never have seen.
  expect(
    controlUp.equals(controlDown),
    "the chip is inside the clipped region and changes its pixels",
  ).toBe(false);

  // And the repair: the same two states, through the shipped helper.
  expect(
    shotUp.equals(shotDown),
    "the map shot is byte-identical across the chip's two states",
  ).toBe(true);

  await holdChip(page, false);
});

test("every map-pixel shot closure in the journey carries the stylesheet", async () => {
  const source = await readFile(
    path.join(__dirname, "journey.spec.ts"),
    "utf8",
  );
  const closures = source
    .split("const mapShot = () =>")
    .slice(1)
    .map((rest) => {
      const end = rest.indexOf("\n      });");
      if (end < 0) throw new Error("a map shot closure has an unfamiliar shape");
      return rest.slice(0, end);
    });

  // Named, so a refactor that renames the closure fails here rather than
  // silently checking nothing.
  expect(closures.length, "the journey's map shot closures").toBe(6);
  const bare = closures.filter((body) => !body.includes("style: MAP_SHOT_STYLE"));
  expect(
    bare.length,
    `map shot closures without the stylesheet: ${bare.map((b) => b.slice(0, 80)).join(" | ")}`,
  ).toBe(0);
});
