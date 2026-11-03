// Count legend: a skewed whole-number column reads as what each class
// holds. The table is 1,239 made-up cells of 1 to 73 collisions each,
// shaped so Quantile asked for five classes returns four (breaks 1, 2, 3)
// and Natural breaks returns five (breaks 4, 14, 27, 42). Each is made
// once through the API and once in the Style panel, where choosing the
// column first opens on Natural breaks, and each is read on a
// fresh load in the builder's legend, the Legend tab's placeholders, the
// Style panel's class rows and the published page signed out. A boundary
// is then typed in a row, and each of the histogram's three handles is
// moved on its own. Before whole-number labels these exact texts fail:
// the legend read "< 1", "1 – 2", "2 – 3", "≥ 3".
//
// Environment: the documented gate (isolated server, fresh data dir) on a
// production build. Run with DEZFIL_BASE_URL at the server.
import { test, expect, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  layerSaveArrived,
  patchLayer,
  publishMap,
  readLayer,
  routeHouse,
  saveSettled,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);

/** `n` whole numbers from `from` to `to`, thinning toward the top. */
const band = (n: number, from: number, to: number) =>
  Array.from({ length: n }, (_, k) => from + Math.floor((to - from + 1) * (k / n) ** 2));
const COLLISIONS = [
  ...new Array<number>(736).fill(1),
  ...new Array<number>(194).fill(2),
  ...new Array<number>(68).fill(3),
  ...new Array<number>(46).fill(4),
  ...band(112, 5, 14),
  ...band(50, 21, 27),
  ...band(22, 34, 42),
  ...band(10, 55, 72),
  73,
];
const CSV = [
  "cell,lon,lat,collisions",
  ...COLLISIONS.map((n, i) => `${i + 1},${(13.3 + (i % 36) * 0.006).toFixed(3)},${(52.46 + Math.floor(i / 36) * 0.004).toFixed(3)},${n}`),
].join("\n");

const QUANTILE = { breaks: [1, 2, 3], labels: ["≤ 1", "2", "3", "> 3"] };
const NATURAL = { breaks: [4, 14, 27, 42], labels: ["≤ 4", "5 – 14", "15 – 27", "28 – 42", "> 42"] };
const NAMES = { quantile: "Quantile collisions", natural: "Natural collisions", panel: "Panel collisions" };

type Fill = { type: string; method?: string; breaks?: number[]; wholeNumbers?: boolean };
type Layer = { style: { fill: Fill } & Record<string, unknown> };

/** Every legend block's entry texts, by the block's title. */
async function legendLabels(page: Page): Promise<Record<string, string[]>> {
  return page.locator('[data-map-legend] [class*="block"]').evaluateAll((blocks) =>
    Object.fromEntries(
      blocks.map((b) => [
        (b.querySelector('[class*="title"] > :first-child') as HTMLElement | null)?.textContent?.trim() ?? "",
        [...b.querySelectorAll('li[class*="entry"]')].map((li) => li.textContent?.trim() ?? ""),
      ]),
    ),
  );
}

/** The Fill class rows as they read: each row's lead text and boundary. */
async function classRows(page: Page): Promise<string[]> {
  return page.getByRole("textbox", { name: "Fill class boundary 1" }).evaluate((first) =>
    [...first.closest('[class*="legendPreview"]')!.querySelectorAll('[class*="legendRow"]')].map((row) => {
      const label = row.querySelector('[class*="legendLabel"]')!;
      const field = label.querySelector("input");
      return `${label.textContent ?? ""}${field?.value ?? ""}`.replace(/\s+/g, " ").trim();
    }),
  );
}

/** The automatic text the Legend tab offers in each label slot. */
async function placeholders(page: Page, layer: string, count: number): Promise<(string | null)[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      page.getByRole("textbox", { name: `Legend label ${i + 1}, ${layer}`, exact: true }).getAttribute("placeholder"),
    ),
  );
}

/** Classify through the API: compute, check the answer, then save it. */
async function classifyThroughApi(page: Page, layerId: string, method: "quantile" | "natural") {
  const before = await readLayer<Layer>(page, layerId);
  const paint = await page.evaluate(
    async ({ layerId, method }) => {
      const r = await fetch(`/api/layers/${layerId}/fill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attribute: "collisions", method, classes: 5 }),
      });
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()) as Fill;
    },
    { layerId, method },
  );
  expect(paint.breaks).toEqual((method === "quantile" ? QUANTILE : NATURAL).breaks);
  expect(paint.wholeNumbers, "a count column is whole numbers").toBe(true);
  // Computing saved nothing.
  expect((await readLayer<Layer>(page, layerId)).style.fill).toEqual(before.style.fill);
  await patchLayer(page, layerId, { style: { ...before.style, fill: paint } });
  expect((await readLayer<Layer>(page, layerId)).style.fill).toMatchObject({ breaks: paint.breaks, wholeNumbers: true });
}

/** The thumb's travel on a range input: its width less the 9px grip. */
const GRIP = 9;

/** Drag one histogram handle to a value on the log axis over 1 to 73 and
 * let go, waiting for the one layer write the release makes. */
async function moveHandle(page: Page, index: number, to: number, patches: () => number) {
  const handle = page.getByRole("slider", { name: `Class boundary ${index + 1}`, exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const x = (fraction: number) => box.x + GRIP / 2 + (box.width - GRIP) * fraction;
  const y = box.y + box.height / 2;
  const before = patches();
  const saved = layerSaveArrived(page);
  await page.mouse.move(x(Number(await handle.inputValue()) / 1000), y);
  await page.mouse.down();
  await page.mouse.move(x(Math.log(to) / Math.log(73)), y, { steps: 8 });
  expect(patches(), "dragging previews without writing").toBe(before);
  await page.mouse.up();
  await saved;
  await saveSettled(page);
  expect(patches() - before, "one write per finished drag").toBe(1);
  await expect(handle).toHaveAttribute("aria-valuetext", String(to));
}

test("a count column's classes read as what they hold, everywhere they show", async ({ page, context, browser, baseURL }) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  await page.goto("/maps");
  const { name: table } = await seedCsv(page, `collisions_${runId}`, CSV);
  const mapId = await createMap(page, `Collisions ${runId}`);
  const ids = {
    quantile: await addLayer(page, mapId, NAMES.quantile, `SELECT * FROM "${table}"`),
    natural: await addLayer(page, mapId, NAMES.natural, `SELECT * FROM "${table}"`),
    panel: await addLayer(page, mapId, NAMES.panel, `SELECT * FROM "${table}"`),
  };

  await test.step("both classifications through the API carry the whole-number fact", async () => {
    await classifyThroughApi(page, ids.quantile, "quantile");
    await classifyThroughApi(page, ids.natural, "natural");
  });

  await test.step("both classifications in the panel, each read on a fresh load", async () => {
    await page.goto(`/maps/${mapId}?layer=${ids.panel}`);
    const attribute = page.getByRole("combobox", { name: "Fill color attribute" });
    await expect(attribute).toBeVisible({ timeout: 30_000 });
    let saved = layerSaveArrived(page);
    await attribute.selectOption("collisions");
    await saved;
    await saveSettled(page);
    // A whole-number column opens on Natural breaks.
    expect((await readLayer<Layer>(page, ids.panel)).style.fill).toMatchObject({ method: "natural", breaks: NATURAL.breaks, wholeNumbers: true });

    const method = page.getByRole("combobox", { name: "Fill classification method" });
    saved = layerSaveArrived(page);
    await method.selectOption("quantile");
    await saved;
    await saveSettled(page);
    expect((await readLayer<Layer>(page, ids.panel)).style.fill).toMatchObject({ method: "quantile", breaks: QUANTILE.breaks, wholeNumbers: true });
    await page.reload();
    await expect.poll(async () => (await legendLabels(page))[NAMES.panel]).toEqual(QUANTILE.labels);

    saved = layerSaveArrived(page);
    await method.selectOption("natural");
    await saved;
    await saveSettled(page);
    expect((await readLayer<Layer>(page, ids.panel)).style.fill).toMatchObject({ method: "natural", breaks: NATURAL.breaks, wholeNumbers: true });
    await page.reload();
    await expect.poll(async () => (await legendLabels(page))[NAMES.panel]).toEqual(NATURAL.labels);
  });

  await test.step("the builder's legend and the class rows agree on every layer", async () => {
    await page.goto(`/maps/${mapId}`);
    await expect
      .poll(() => legendLabels(page), { timeout: 30_000 })
      .toEqual({ [NAMES.quantile]: QUANTILE.labels, [NAMES.natural]: NATURAL.labels, [NAMES.panel]: NATURAL.labels });
    for (const [key, labels] of [["quantile", QUANTILE.labels], ["natural", NATURAL.labels], ["panel", NATURAL.labels]] as const) {
      await page.goto(`/maps/${mapId}?layer=${ids[key]}`);
      await expect(page.getByRole("textbox", { name: "Fill class boundary 1" })).toBeVisible({ timeout: 30_000 });
      expect(await classRows(page), `the class rows of ${NAMES[key]}`).toEqual(labels);
    }
  });

  await test.step("the Legend tab offers the same automatic text", async () => {
    await page.getByRole("tablist", { name: "Builder panels" }).getByRole("tab", { name: "Legend" }).click();
    expect(await placeholders(page, NAMES.quantile, 4)).toEqual(QUANTILE.labels);
    expect(await placeholders(page, NAMES.natural, 5)).toEqual(NATURAL.labels);
    expect(await placeholders(page, NAMES.panel, 5)).toEqual(NATURAL.labels);
    await expect(page.getByRole("textbox", { name: `Legend label 5, ${NAMES.quantile}`, exact: true })).toHaveCount(0);
  });

  const token = await publishMap(page, mapId);
  const reader = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const view = await reader.newPage();
  const viewErrors = trackConsole(view);
  try {
    await routeHouse(reader, { basemapStyleStub: true });

    await test.step("the published page reads the same, signed out", async () => {
      expect((await reader.request.get("/api/account")).status(), "the reader is signed out").toBe(401);
      await view.goto(`/v/${token}`);
      await expect
        .poll(() => legendLabels(view), { timeout: 30_000 })
        .toEqual({ [NAMES.quantile]: QUANTILE.labels, [NAMES.natural]: NATURAL.labels, [NAMES.panel]: NATURAL.labels });
    });

    await test.step("a boundary typed in a row keeps the whole-number labels", async () => {
      await page.goto(`/maps/${mapId}?layer=${ids.panel}`);
      const boundary = page.getByRole("textbox", { name: "Fill class boundary 2" });
      await expect(boundary).toHaveValue("14", { timeout: 30_000 });
      const saved = layerSaveArrived(page);
      await boundary.fill("12");
      await boundary.press("Enter");
      await saved;
      await saveSettled(page);
      expect((await readLayer<Layer>(page, ids.panel)).style.fill).toMatchObject({ method: "custom", breaks: [4, 12, 27, 42], wholeNumbers: true });
      const typed = ["≤ 4", "5 – 12", "13 – 27", "28 – 42", "> 42"];
      await expect.poll(async () => (await legendLabels(page))[NAMES.panel]).toEqual(typed);
      expect(await classRows(page)).toEqual(typed);
    });

    await test.step("each of the histogram's three handles moves on its own", async () => {
      await page.goto(`/maps/${mapId}?layer=${ids.quantile}`);
      const brush = page.locator('[data-axis="log"]');
      await expect(brush, "the skewed counts draw on a log axis").toBeVisible({ timeout: 30_000 });
      const handles = page.getByRole("slider", { name: /^Class boundary \d$/ });
      await expect(handles).toHaveCount(3);
      expect(await handles.evaluateAll((all) => all.map((h) => h.getAttribute("aria-valuetext")))).toEqual(["1", "2", "3"]);
      // On the log axis 1, 2 and 3 stand apart; linearly over 1 to 73 all
      // three would sit within 3% of the track's left end.
      const places = (await handles.evaluateAll((all) => all.map((h) => Number((h as HTMLInputElement).value)))).map((v) => v / 1000);
      places.forEach((place, i) => expect(place).toBeCloseTo(Math.log(i + 1) / Math.log(73), 2));

      let patches = 0;
      const count = (request: { method(): string; url(): string }) => {
        if (request.method() === "PATCH" && /\/api\/layers\/[^/]+$/.test(request.url())) patches += 1;
      };
      page.on("request", count);
      await moveHandle(page, 2, 10, () => patches);
      await moveHandle(page, 1, 5, () => patches);
      await moveHandle(page, 0, 3, () => patches);
      page.off("request", count);

      expect((await readLayer<Layer>(page, ids.quantile)).style.fill).toMatchObject({ method: "custom", breaks: [3, 5, 10], wholeNumbers: true });
      const moved = ["≤ 3", "4 – 5", "6 – 10", "> 10"];
      await expect.poll(async () => (await legendLabels(page))[NAMES.quantile]).toEqual(moved);

      // The published page follows on its next read.
      await view.reload();
      await expect.poll(async () => (await legendLabels(view))[NAMES.quantile], { timeout: 30_000 }).toEqual(moved);
    });
  } finally {
    await reader.close();
  }

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
  expect(viewErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});
