// Pixel regressions: the three recurring field-found visual classes, each
// held by a detector that is RED-PROVEN in the same run — the check
// demonstrably fails against a seeded defect of its class before the
// honest state passes it. Design per the flake truth rules: every capture
// is the disciplined map shot (inset clip, floating chrome masked);
// comparisons are statistical over decoded pixels or change-detection —
// never byte-exact across composited chrome; anchors are settled states,
// never transients.
//
// - OPACITY/ALPHA MATHS: a committed opacity drop must actually thin the
//   paint — red-dominance over the map region falls with opacity, and
//   sits between "full paint" and "no layer". Red-proven against a
//   SEEDED defect, rendered for real: an opacity commit that paints
//   nothing different (the layer's own value re-committed) is rejected.
// - ICON RENDERING: icon glyphs actually draw with their fill color —
//   colored pixels appear where the hidden-layer baseline has none.
//   Red-proven against a SEEDED defect, rendered for real: the glyph URL
//   the canvas loads serves an EMPTY SVG — the blank atlas itself — and
//   the visible icon layer's render is rejected. This detector excludes
//   Playwright's magenta chrome mask: a visible constant-style layer also
//   creates a masked legend, and that rectangle is not glyph paint.
// - ANIMATION LIVENESS: a playing timeline advances frames; pausing
//   settles them. Defect shape red-proven: the liveness detector cannot
//   pass on a frozen surface.
//
// Environment: the documented gate — production standalone,
// DEZFIL_RENDER_CAP_FEATURES=2000, third-party hosts blocked. Run via
// `npm run e2e:pixel` with DEZFIL_BASE_URL pointing at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  layerSaveArrived,
  mapShot,
  patchLayer,
  patchMap,
  routeHouse,
  saveSettled,
  seedCsv,
  seedFile,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const districtsTable = `px_districts_${runId}`;
const stationsTable = `px_stations_${runId}`;
const labelsTable = `px_labels_${runId}`;

/** Decode a PNG shot in the browser and return red-dominance stats over
 * the whole (already inset, already masked) region. */
async function redStats(
  page: Page,
  shot: Buffer,
  { ignorePlaywrightMask = false }: { ignorePlaywrightMask?: boolean } = {},
): Promise<{ meanRedness: number; redPixels: number }> {
  return page.evaluate(async ({ b64, ignorePlaywrightMask }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let redness = 0;
    let redPixels = 0;
    let pixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // `mapShot` masks floating chrome with Playwright's #ff00ff. Most
      // comparisons carry the same mask floor on both sides, but the icon
      // row compares a visible layer (and therefore a constant legend) to
      // a hidden one. Ignore the solid mask there so a legend rectangle
      // cannot impersonate red icon ink. The small tolerance covers edge
      // compositing without excluding this row's red fill (220, 30, 30).
      if (
        ignorePlaywrightMask &&
        r >= 240 &&
        g <= 15 &&
        b >= 240
      ) {
        continue;
      }
      pixels += 1;
      const dominance = r - (g + b) / 2;
      if (dominance > 0) redness += dominance;
      if (dominance > 48) redPixels += 1;
    }
    return { meanRedness: pixels === 0 ? 0 : redness / pixels, redPixels };
  }, { b64: shot.toString("base64"), ignorePlaywrightMask });
}

const RED = { r: 220, g: 30, b: 30, a: 1 };

test("opacity/alpha maths: a committed opacity drop thins the paint", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await page.goto("/maps");
  await seedFile(
    page,
    `${districtsTable}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "districts.geojson")),
    "application/geo+json",
  );
  const mapId = await createMap(page, "pixel: opacity");
  await page.goto(`/maps/${mapId}`);
  await expect(
    page.getByRole("tablist", { name: "Builder panels" }),
  ).toBeVisible();
  await saveSettled(page);
  // The no-layer background baseline.
  const background = await redStats(page, await mapShot(page));

  const layerId = await addLayer(
    page,
    mapId,
    districtsTable,
    `SELECT * FROM ${districtsTable}`,
  );
  await patchLayer(page, layerId, {
    style: {
      fill: { type: "constant", color: RED },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 3,
      opacity: 1,
    },
  });
  await page.reload();
  await page.getByRole("button", { name: "Fit to data", exact: true }).click();
  await saveSettled(page);
  const fullShot = await expectSettledShot(page);
  const full = await redStats(page, fullShot);
  // The painted polygons dominate the background decisively.
  expect(full.meanRedness).toBeGreaterThan(background.meanRedness * 3 + 2);

  // The SEEDED DEFECT of this class, rendered for real: an opacity
  // commit that paints nothing different. Committing
  // the opacity the layer already carries is exactly that write — a real
  // PATCH, a real reload, a real render — and it is what a broken app
  // would show after committing 0.35 below. Captured now, fed to the
  // detector after the honest drive.
  await patchLayer(page, layerId, {
    style: {
      fill: { type: "constant", color: RED },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 3,
      opacity: 1,
    },
  });
  await page.reload();
  await saveSettled(page);
  const noOpCommit = await redStats(page, await expectSettledShot(page));

  await patchLayer(page, layerId, {
    style: {
      fill: { type: "constant", color: RED },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 3,
      opacity: 0.35,
    },
  });
  await page.reload();
  await saveSettled(page);
  const thinnedShot = await expectSettledShot(page);
  const thinned = await redStats(page, thinnedShot);

  // The detector, named: a committed opacity drop THINNED the paint —
  // bands, never byte equality.
  const opacityThinned = (
    candidate: { meanRedness: number },
    fullPaint: { meanRedness: number },
  ) => candidate.meanRedness < fullPaint.meanRedness * 0.75;
  expect(opacityThinned(thinned, full)).toBe(true);
  expect(thinned.meanRedness).toBeGreaterThan(background.meanRedness * 1.5);

  // RED-PROOF against the seeded defect captured above: the render of a
  // committed opacity change that thinned nothing must FAIL the detector.
  expect(
    opacityThinned(noOpCommit, full),
    "the detector rejects a REAL no-op opacity commit (seeded defect)",
  ).toBe(false);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

/** A shot only counts once two captures 300ms apart agree — the settled
 * anchor the journey uses, never a mid-paint transient. */
async function expectSettledShot(page: Page): Promise<Buffer> {
  let last = await mapShot(page);
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(300);
        const next = await mapShot(page);
        const stable = next.equals(last);
        last = next;
        return stable;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return last;
}

test("icon rendering: glyphs draw with their fill color", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, stationsTable, csv);
  const mapId = await createMap(page, "pixel: icons");
  const layerId = await addLayer(
    page,
    mapId,
    stationsTable,
    `SELECT * FROM ${stationsTable}`,
  );
  await patchLayer(page, layerId, {
    viz: { type: "icon", glyph: "cafe" },
    style: {
      fill: { type: "constant", color: RED },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 12,
      opacity: 1,
    },
  });
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("button", { name: "Fit to data", exact: true }).click();
  await saveSettled(page);
  const drawn = await redStats(page, await expectSettledShot(page), {
    ignorePlaywrightMask: true,
  });

  // The hidden-layer baseline: the same map with nothing to draw.
  await patchLayer(page, layerId, { visible: false });
  await page.reload();
  await saveSettled(page);
  const hidden = await redStats(page, await expectSettledShot(page), {
    ignorePlaywrightMask: true,
  });

  // The detector, named: icons painted real glyph pixels in the fill
  // color, well clear of the baseline. Mask magenta has already been
  // removed, so the visible layer's legend cannot satisfy this assertion.
  const drawsIcons = (
    candidate: { redPixels: number },
    baseline: { redPixels: number },
  ) => candidate.redPixels > baseline.redPixels + 60;
  expect(drawsIcons(drawn, hidden)).toBe(true);

  // RED-PROOF against an ACTUALLY SEEDED defect of the class. The canvas
  // has no point-mark or atlas fallback: it returns one deck IconLayer,
  // whose mask mode multiplies the final alpha by the atlas alpha. Use a
  // glyph not loaded by the honest arm, so the browser's decoded-image
  // cache cannot satisfy the reload before this late route sees it.
  // Serving a valid-but-EMPTY SVG at that first request is therefore the
  // blank-atlas defect itself: same visible layer, same style, same
  // positions, but no atlas alpha and consequently no icon ink.
  const blankGlyphRoute = /\/maki\/bakery\.svg(?:\?.*)?$/;
  let blankGlyphIntercepted = false;
  await page.route(blankGlyphRoute, (route) => {
    blankGlyphIntercepted = true;
    return route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      // Same declared size as the real glyph (256×256) so only its
      // CONTENT is missing — the atlas geometry is untouched.
      body:
        '<?xml version="1.0" encoding="UTF-8"?><svg version="1.1" ' +
        'xmlns="http://www.w3.org/2000/svg" width="256" height="256" ' +
        'viewBox="0 0 15 15"></svg>',
    });
  });
  await patchLayer(page, layerId, {
    visible: true,
    viz: { type: "icon", glyph: "bakery" },
  });
  await page.reload();
  await saveSettled(page);
  const blankAtlas = await redStats(page, await expectSettledShot(page), {
    ignorePlaywrightMask: true,
  });
  expect(
    blankGlyphIntercepted,
    "the blank-atlas seed intercepted the glyph request",
  ).toBe(true);
  expect(
    drawsIcons(blankAtlas, hidden),
    "the detector rejects a REAL blank-atlas render (seeded defect)",
  ).toBe(false);
  await page.unroute(blankGlyphRoute);

  // The custom-inline arm: the same detector over a sanitized custom
  // SVG riding the viz — the markup is viewBox-only on purpose, the
  // exact shape that silently never drew before the render-time
  // dimension injection (found live by the smoke).
  await patchLayer(page, layerId, {
    viz: {
      type: "icon",
      glyph: "cafe",
      customSvg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
        '<path d="M12 2L2 22h20z"/></svg>',
    },
  });
  await page.reload();
  await saveSettled(page);
  const custom = await redStats(page, await expectSettledShot(page), {
    ignorePlaywrightMask: true,
  });
  expect(
    drawsIcons(custom, hidden),
    "a custom inline SVG paints real fill-colored pixels",
  ).toBe(true);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("animation liveness: a playing timeline advances frames; pause settles them", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await page.goto("/maps");
  // Deliberately Z-LESS timestamps: committed time bounds on UTC-marked
  // (Z-suffixed) values blank the whole layer client-side — a REAL
  // defect this feature's exploration found and recorded in the
  // registry; the liveness class is driven on the healthy format so
  // this check holds animation truth, not that separately-recorded bug.
  const csv = [
    "name,lon,lat,riders,ts",
    "A,13.4133,52.5219,10450,2024-01-01 08:30:00",
    "B,13.3696,52.5251,22310,2024-01-15 17:45:00",
    "C,13.4499,52.5058,780,2024-02-02 12:00:00",
    "D,13.3326,52.5073,15600,2024-02-20 09:15:00",
    "E,13.4021,52.5310,120,2024-03-05 10:00:00",
    "F,13.3562,52.5122,95,2024-03-18 11:20:00",
    "G,13.4388,52.5169,210,2024-04-02 14:40:00",
    "H,13.3501,52.5145,4300,2024-04-21 13:05:00",
    "I,13.4632,52.5296,1800,2024-05-09 15:30:00",
    "J,13.4691,52.4889,2600,2024-05-27 16:10:00",
    "K,13.4692,52.5031,8900,2024-06-11 07:55:00",
    "L,13.3885,52.5487,7200,2024-06-30 18:25:00",
  ].join("\n");
  const table = `pxtl_${runId}`;
  await seedCsv(page, table, csv);
  const mapId = await createMap(page, "pixel: liveness");
  const layerId = await addLayer(
    page,
    mapId,
    table,
    `SELECT * FROM ${table}`,
  );
  await patchLayer(page, layerId, {
    style: {
      fill: { type: "constant", color: RED },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 10,
      opacity: 1,
    },
    filters: [{ kind: "timerange", field: "ts", min: null, max: null }],
  });
  await patchMap(page, mapId, {
    timeline: { layerId, field: "ts", speed: 1 },
  });
  await page.goto(`/maps/${mapId}`);
  await expect(page.getByTestId("timeline")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Fit to data", exact: true }).click();
  await saveSettled(page);

  // RED-PROOF first: on the PAUSED (frozen) surface, the liveness
  // detector must report stillness — the defect shape is a Play that
  // animates nothing.
  const frozenA = await expectSettledShot(page);
  await page.waitForTimeout(600);
  const frozenB = await mapShot(page);
  const frozenLive = !frozenB.equals(frozenA);
  expect(frozenLive, "the detector reports stillness on a frozen surface").toBe(
    false,
  );

  // Narrow the window first: a full-extent window sweeps without any
  // point ever leaving it — the visible animation is a narrow window
  // moving across the extent.
  const endHandle = page.getByRole("slider", { name: "Window end" });
  const before = await endHandle.getAttribute("aria-valuenow");
  const handleBox = (await endHandle.boundingBox())!;
  const track = endHandle.locator("..");
  const trackBox = (await track.boundingBox())!;
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    trackBox.x + trackBox.width * 0.25,
    handleBox.y + handleBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(endHandle).not.toHaveAttribute("aria-valuenow", before!);
  await saveSettled(page);
  // Sanity: the narrowed window still paints its in-window points — a
  // window that blanks everything would fake liveness later.
  const narrowed = await redStats(page, await expectSettledShot(page));
  expect(narrowed.redPixels).toBeGreaterThan(40);

  // Now the real drive: Play must advance frames. 4× speed makes the
  // window cross point timestamps briskly; the detector holds a fixed
  // baseline so no crossing between poll iterations is missed.
  const speedBtn = page.getByRole("button", { name: "Playback speed" });
  await speedBtn.click();
  await speedBtn.click();
  await saveSettled(page);
  const playingBaseline = await mapShot(page);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () => !(await mapShot(page)).equals(playingBaseline), {
      timeout: 30_000,
    })
    .toBe(true);

  // And Pause settles the frames again.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expectSettledShot(page);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

// LABEL FRESHNESS. The reuse caches *which* features are eligible for a
// label — it does not cache the text. Text is a live accessor
// (`deck-style.ts` `labelText`) evaluated on every build, so a stale cache
// still paints current text. **The only thing a stale cache can change is
// membership**, and that is what this has to vary.
//
// Three earlier versions were wrong, each caught by a seeded-defect proof
// rather than by reasoning, and the third is why the fixture looks like it
// does:
//
//  1. It reloaded between captures. A reload remounts the canvas, so every
//     read hit a fresh empty cache — it passed with the defect seeded.
//  2. It took its baseline by toggling labels off and on. Switching off
//     patches `label: undefined`, so switching back on rebuilds from
//     `DEFAULT_LABEL` — white, size 12 — invisible to a red detector.
//  3. It switched between two attributes that were non-empty on every row,
//     so the eligible set was identical either way. Text width changed but
//     membership did not, and membership is the only thing cached. No
//     threshold could have discriminated.
//
// So the two attributes here differ ONLY in how many rows they label — same
// glyph, same width per label — and the assertion counts that difference. A
// stale eligible set repaints one label where four are due, and fails it.
test("label freshness: labels draw, and follow a change of labelled attribute", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await page.goto("/maps");
  // `few` labels one row; `many` labels all four. Identical glyphs, so the
  // painted area differs only by how many features are eligible — exactly
  // what the reuse gates, and nothing else.
  await seedCsv(
    page,
    labelsTable,
    "few,many,lat,lon\n" +
      "MMMM,MMMM,51.10,7.10\n" +
      ",MMMM,51.20,7.20\n" +
      ",MMMM,51.30,7.30\n" +
      ",MMMM,51.40,7.40\n",
  );
  const mapId = await createMap(page, "pixel: label freshness");
  const layerId = await addLayer(
    page,
    mapId,
    labelsTable,
    `SELECT * FROM ${labelsTable}`,
  );
  // Marks are tiny and dark and the label colour is red, so the only red
  // *paint* is label text. (The raw count also carries a constant floor from
  // Playwright's own chrome mask, which fills masked regions with magenta;
  // it is identical in every capture and cancels in the deltas asserted
  // below — never compare these counts to zero.)
  const marks = {
    fill: { type: "constant" as const, color: { r: 12, g: 16, b: 24, a: 1 } },
    fillOpacity: 1,
    stroke: { r: 12, g: 16, b: 24, a: 1 },
    strokeOpacity: 1,
    strokeWidth: 0,
    pointRadius: 1,
    opacity: 1,
  };
  await patchLayer(page, layerId, {
    style: {
      ...marks,
      label: { attribute: "few", size: 28, color: RED, haloWidth: 0, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } },
    },
  });

  // `?layer=` selects it server-side, so the style panel is up without a
  // click that could race the first paint.
  await page.goto(`/maps/${mapId}?layer=${layerId}`);
  await page.getByRole("button", { name: "Fit to data", exact: true }).click();
  await saveSettled(page);
  const few = await redStats(page, await expectSettledShot(page));

  // THE GUARD. Same page, same mounted canvas, same live cache — only the
  // attribute changes, through the real control, with no navigation and no
  // off/on cycle (the panel preserves label colour and size across an
  // attribute switch). Four labels are now due where one was. A stale
  // eligible set repaints the single one and fails this.
  const labelHead = page.getByRole("button", { name: "Label", exact: true });
  if ((await labelHead.getAttribute("aria-expanded")) !== "true") {
    await labelHead.click();
  }
  const textSelect = page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: "Label", exact: true }) })
    .locator("select")
    .first();
  await expect(textSelect).toHaveValue("few");
  // Arm the arrival signal BEFORE the action that triggers the write.
  // `saveSettled` alone passes in the window before a just-triggered write
  // has rendered its whisper — its own doc says so — and the builder does
  // not optimistically install this select, so settling bare could capture
  // the canvas still showing `few` and manufacture a failure.
  const labelSaved = layerSaveArrived(page);
  await textSelect.selectOption("many");
  await labelSaved;
  await saveSettled(page);
  const many = await redStats(page, await expectSettledShot(page));

  const followsAttribute = (
    after: { redPixels: number },
    before: { redPixels: number },
  ) => after.redPixels > before.redPixels + 60;
  expect(
    followsAttribute(many, few),
    "a changed labelled attribute relabels the right features (stale-label guard)",
  ).toBe(true);

  // Baseline, measured last and through the API so it cannot disturb the
  // live sequence above: the same layer with no label paints no label text.
  await patchLayer(page, layerId, { style: marks });
  await page.reload();
  await saveSettled(page);
  const unlabelled = await redStats(page, await expectSettledShot(page));

  const drawsLabels = (
    candidate: { redPixels: number },
    baseline: { redPixels: number },
  ) => candidate.redPixels > baseline.redPixels + 60;
  expect(
    drawsLabels(few, unlabelled),
    "labels paint in the label colour",
  ).toBe(true);

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});
