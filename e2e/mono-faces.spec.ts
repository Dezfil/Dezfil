// The mono diet's rendered truth: the coordinate readouts converge on
// the UI face with tabular numerals, the published view's chrome
// inherits the UI face, the two surviving code/data faces answer under
// their own roots — DM Mono in the workspace, IBM Plex Mono published —
// and the wider UI face stays contained on the constrained surfaces the
// diet demoted. SQL answers in the code face where it is shown as SQL
// (History's saved queries and the tables they read), and so do the
// engine's own words in an error and the code marks the browser would
// otherwise set in its own monospace. The source-side boundary (which
// rules may carry mono at all) is the mono-boundary unit ratchet's; this
// suite measures computed styles and boxes.
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
  consumeExpected,
  createMap,
  patchLayer,
  patchMap,
  publishMap,
  seedFile,
  trackConsole,
} from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `faces_${runId}`;

const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

const MONO = /SF Mono|Cascadia|ui-monospace|monospace|DM.?Mono|Plex/i;

async function seedMap(page: Page): Promise<string> {
  await page.goto("/maps");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `faces ${runId}`);
  const layerId = await addLayer(
    page,
    mapId,
    stations,
    `SELECT * FROM ${stations}`,
  );
  // A classed style so the Legend tab renders per-entry label inputs —
  // the surface whose UA control face the diet demotes explicitly.
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
      pointRadius: 6,
      opacity: 1,
    },
  });
  // The two widget kinds whose demoted chrome is width-constrained: a
  // formula's caption-and-unit sub-line, and a histogram's range line.
  await patchMap(page, mapId, {
    widgets: [
      {
        id: "w-formula",
        type: "formula",
        layerId,
        title: "Riders",
        field: "riders",
        agg: "sum",
        aggField: null,
        unit: "riders per weekday",
        note: "A caption long enough to press against the card's width.",
        format: null,
        visible: true,
      },
      {
        id: "w-hist",
        type: "histogram",
        layerId,
        title: "Spread",
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
  return mapId;
}

test("readouts converge, the two data faces answer, the UI face stays contained", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);

  // ---- The workspace code/data face is DM Mono: the dataset page's
  // "In SQL:" name. Its title is the dataset's name read as a name, in
  // the reading face. ----
  await page.goto(`/tables/${stations}`);
  const tableTitle = page.locator('[class*="title"] h1').first();
  await expect(tableTitle).toBeVisible();
  expect(
    MONO.test(await tableTitle.evaluate((el) => getComputedStyle(el).fontFamily)),
  ).toBe(false);
  const sqlName = page.locator("[data-sql-name] code").first();
  await expect(sqlName).toBeVisible();
  expect(
    await sqlName.evaluate((el) => getComputedStyle(el).fontFamily),
  ).toMatch(/DM.?Mono/i);

  // ---- Builder: the status bar's coordinate readout,
  // and containment on the demoted widget chrome and layer meta. ----
  await page.goto(`/maps/${mapId}`);
  await expect(page.getByText("6 features").first()).toBeVisible({
    timeout: 30_000,
  });
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const statusVal = page
    .locator('[data-status-bar] [class*="val"]')
    .first();
  await expect(statusVal).toBeVisible();
  const statusStyle = await statusVal.evaluate((el) => ({
    font: getComputedStyle(el).fontFamily,
    numeric: getComputedStyle(el).fontVariantNumeric,
  }));
  expect(MONO.test(statusStyle.font)).toBe(false);
  expect(statusStyle.numeric).toContain("tabular-nums");

  // A brush on the histogram makes its range readout appear AND
  // filters the formula off its baseline, so its filtered-from
  // sub-line appears — the two demoted lines a resting fixture never
  // shows (a selector matching nothing is not a check).
  const brushStart = page.getByRole("slider", {
    name: "Spread range start",
  });
  await expect(brushStart).toBeVisible();
  await brushStart.focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowRight");
  await expect(
    page.locator('[data-widget-rail] [class*="range"]').first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-widget-rail] [class*="sub"]').first(),
  ).toBeVisible();

  const constrained = [
    '[data-widget-rail] [class*="caption"]',
    '[data-widget-rail] [class*="sub"]',
    '[data-widget-rail] [class*="range"]',
    '[class*="LayerList"][class*="meta"]',
  ];
  for (const sel of constrained) {
    const els = page.locator(sel);
    const n = await els.count();
    for (let i = 0; i < n; i += 1) {
      const overflow = await els
        .nth(i)
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, `${sel} [${i}] overflows its box`).toBeLessThanOrEqual(
        1,
      );
    }
  }
  // The demoted surfaces are actually on screen (the loop above cannot
  // pass by matching nothing): the formula caption and the layer meta
  // line; the range and sub lines were staged by the brush above.
  await expect(
    page.locator('[data-widget-rail] [class*="caption"]').first(),
  ).toBeVisible();
  await expect(
    page.locator('[class*="LayerList"][class*="meta"]').first(),
  ).toBeVisible();

  // The UA-face escapes the source ratchet cannot see: a
  // bare <input> takes the browser's control face and <kbd> stays
  // UA-monospace unless demoted explicitly — measure the Legend tab's
  // entry input rendered.
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Legend" })
    .click();
  const entryInput = page.locator('input[class*="entryInput"]').first();
  await expect(entryInput).toBeVisible();
  expect(
    MONO.test(
      await entryInput.evaluate((el) => getComputedStyle(el).fontFamily),
    ),
  ).toBe(false);

  // ---- Published: the cursor readout converges, the
  // chrome inherits the UI face, and the
  // published code/data token answers as Plex. ----
  const token = await publishMap(page, mapId);
  await page.goto(`/v/${token}`);
  const pubCanvas = page.locator("canvas").first();
  await expect(pubCanvas).toBeVisible({ timeout: 30_000 });
  const pubBox = (await pubCanvas.boundingBox())!;
  await page.mouse.move(
    pubBox.x + pubBox.width / 2,
    pubBox.y + pubBox.height / 2,
  );
  const readout = page.getByTitle("Copy coordinates");
  await expect(readout).toBeVisible();
  const readoutStyle = await readout.evaluate((el) => ({
    font: getComputedStyle(el).fontFamily,
    numeric: getComputedStyle(el).fontVariantNumeric,
  }));
  expect(MONO.test(readoutStyle.font)).toBe(false);
  expect(readoutStyle.numeric).toContain("tabular-nums");

  const published = await page.evaluate(() => {
    const root = document.querySelector("[data-published-view]")!;
    // The chrome inherits the root's face; the demoted states
    // (preparing prose, Retry, alerts) carry no face rule of their own,
    // so this inheritance IS their computed face.
    const rootFont = getComputedStyle(root).fontFamily;
    // The published code token, asked directly where the surfaces that
    // keep it (an error's details) resolve it.
    const probe = document.createElement("span");
    probe.style.fontFamily = "var(--font-mono)";
    root.appendChild(probe);
    const monoFont = getComputedStyle(probe).fontFamily;
    probe.remove();
    // Absence, rendered: the undefined token no longer exists anywhere
    // as a reference, so nothing resolves through it.
    const monoVar = getComputedStyle(root).getPropertyValue("--mono");
    return { rootFont, monoFont, monoVar };
  });
  expect(MONO.test(published.rootFont)).toBe(false);
  expect(published.monoFont).toMatch(/Plex/i);
  expect(published.monoVar).toBe("");

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("gallery chip counts hold their boxes in the UI face", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  await page.goto("/maps");
  // The search shortcut <kbd> reads the UI face — the UA stylesheet
  // would keep it monospace without the explicit demotion.
  const kbd = page.locator('[class*="search"] kbd').first();
  await expect(kbd).toBeVisible();
  expect(
    MONO.test(await kbd.evaluate((el) => getComputedStyle(el).fontFamily)),
  ).toBe(false);
  const chips = page.locator('[class*="chipCount"]');
  await expect(chips.first()).toBeVisible();
  const n = await chips.count();
  for (let i = 0; i < n; i += 1) {
    const style = await chips.nth(i).evaluate((el) => ({
      overflow: el.scrollWidth - el.clientWidth,
      font: getComputedStyle(el).fontFamily,
    }));
    expect(style.overflow).toBeLessThanOrEqual(1);
    expect(MONO.test(style.font)).toBe(false);
  }
  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

/** Replace the SQL page's draft with `sql`. */
async function typeSql(page: Page, sql: string) {
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(sql);
  await page.keyboard.press("Escape"); // close any completion popup
}

test("SQL, the engine's words and the code marks answer in the code face", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const consoleErrors = trackConsole(page);
  const queried = `faces_sql_${runId}`;
  await page.goto("/maps");
  await seedFile(
    page,
    `${queried}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );

  // ---- The SQL page: a run lands in History as SQL. The card's title
  // is the table the query read, as its SQL wrote it; the saved query is
  // in the code face, its keywords in the editor's colour and weight. ----
  await page.goto("/sql");
  await expect(page.getByLabel("SQL editor")).toBeVisible();
  // The table is known to the page before the run, so the run's card
  // can name it.
  await expect(page.locator("main").getByText(queried, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await typeSql(page, `SELECT * FROM ${queried}`);
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(
    page.getByRole("region", { name: "Results", exact: true }).getByText(/^[\d,]+ rows$/),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "History" }).click();
  const card = page.locator("[data-history-card]").first();
  await expect(card).toBeVisible();
  const title = card.locator('[class*="cardTitle"]');
  await expect(title).toHaveText(queried);
  expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/DM.?Mono/i);
  const excerpt = card.locator('[class*="cardSql"]');
  expect(await excerpt.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/DM.?Mono/i);
  const keyword = await excerpt
    .locator('[class*="tkKw"]')
    .first()
    .evaluate((el) => {
      // The editor's keyword colour, resolved where the keyword sits.
      const probe = document.createElement("span");
      probe.style.color = "var(--code-keyword)";
      el.parentElement!.appendChild(probe);
      const editorColour = getComputedStyle(probe).color;
      probe.remove();
      const cs = getComputedStyle(el);
      return { text: el.textContent, font: cs.fontFamily, weight: cs.fontWeight, colour: cs.color, editorColour };
    });
  expect(keyword.text).toBe("SELECT");
  expect(keyword.font).toMatch(/DM.?Mono/i);
  expect(keyword.weight).toBe("600");
  expect(keyword.colour).toBe(keyword.editorColour);

  // ---- The engine's own words in the error note are in the code face;
  // the note itself keeps the reading face. ----
  await page.getByRole("tab", { name: "Sources" }).click();
  await typeSql(page, `SELECT nope_${runId} FROM ${queried}`);
  await page.getByRole("button", { name: "Run query" }).click();
  const note = page.getByRole("region", { name: "Results", exact: true }).getByRole("alert");
  await expect(note).toBeVisible({ timeout: 20_000 });
  const engine = note.locator('[class*="engine"]');
  await expect(engine).toHaveText(/^Binder Error: /);
  const faces = await engine.evaluate((el) => ({
    engine: getComputedStyle(el).fontFamily,
    sentence: getComputedStyle(el.parentElement!).fontFamily,
    size: getComputedStyle(el).fontSize,
    sentenceSize: getComputedStyle(el.parentElement!).fontSize,
  }));
  expect(faces.engine).toMatch(/DM.?Mono/i);
  expect(MONO.test(faces.sentence)).toBe(false);
  expect(faces.size).toBe(faces.sentenceSize);
  // The refused query's 400 is the console shadow this step asked for.
  await consumeExpected(consoleErrors, /\/api\/query/, /status of 400/);

  // ---- Code marks: the Developer page's parameter names and the MCP
  // card's code take the code face at the size of the text around them,
  // not the browser's own monospace at its own size. ----
  const markFace = (el: Element) => ({
    font: getComputedStyle(el).fontFamily,
    size: getComputedStyle(el).fontSize,
    around: getComputedStyle(el.parentElement!).fontSize,
  });
  await page.goto("/developer");
  const parameter = page.locator('[class*="opDesc"] code').first();
  await expect(parameter).toBeVisible();
  const parameterFace = await parameter.evaluate(markFace);
  expect(parameterFace.font).toMatch(/DM.?Mono/i);
  expect(parameterFace.size).toBe(parameterFace.around);

  await page.goto("/settings/tokens");
  const variable = page.locator("#mcp code", { hasText: /^DEZFIL_API_TOKEN$/ });
  await expect(variable).toBeVisible();
  const variableFace = await variable.evaluate(markFace);
  expect(variableFace.font).toMatch(/DM.?Mono/i);
  expect(variableFace.size).toBe(variableFace.around);
  const configuration = page.locator('#mcp pre[class*="configuration"] code').first();
  await expect(configuration).toBeVisible();
  const configurationFace = await configuration.evaluate(markFace);
  expect(configurationFace.font).toMatch(/DM.?Mono/i);
  expect(configurationFace.size).toBe(configurationFace.around);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
