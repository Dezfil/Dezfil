// Map labels' face and weight on every surface that draws them, as each
// really draws them. One map carries a normal and a bold label of the same
// text on simple layers, a label on a tiled layer (over the instance's
// feature cap, so it takes the tiled road), labels on grid cells, and a
// cluster layer's counts, each in a colour of its own.
//
// In the browser (the builder, the workspace reader, a template view, a
// published map, its embed, the builder's Export image and the render page
// the server's images are drawn from), the record of every glyph drawn into
// a text atlas says the face and weight each label asked for and whether
// the face had arrived: letters only in the surface's own face (Inter in
// the workspace and on the render page, Archivo on a published map and its
// embed), at 600 and 700 and nothing else, never in a fallback; cell labels'
// digits at 600 in the same face; the counts' digits in Inter 400 on every
// surface. The pixels say each kind drew, and that the bold label holds
// more ink than the normal one.
//
// The server's images (the API image export, a card picture and the
// assistant's look of the map) are drawn by the server's own browser on the
// render page, where nothing can be recorded. The image export at the
// render page's own definition holds each label's ink within a few percent
// of the render page's, whose faces the record names; a card picture and
// the look, drawn at their own sizes, hold the same proportion of bold ink
// to normal. A fallback face, or a weight other than the record's, moves
// both.
//
// The face's own arrival: a face that arrives late but within the labels'
// wait is the one drawn; a Cyrillic label draws in the face's own Cyrillic;
// a face that never arrives leaves labels to the fallback within the wait.
//
// Run with DEZFIL_BASE_URL at an isolated instance on a fresh data folder
// with DEZFIL_RENDER_CAP_FEATURES=2000, DEZFIL_EGRESS_ALLOWLIST=127.0.0.1, a
// renderer at DEZFIL_CHROMIUM_PATH and the picture style fixture preload,
// as `src/lib/pictures/pictures.real-render.md` describes for the theme
// suite: the server's images then draw the three built-in styles as flat
// grounds.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { buildTemplate, type BuiltTemplate } from "../test-support/templates/builder";
import { startLoopbackCatalogue, type LoopbackCatalogue } from "../test-support/templates/catalogue";
import {
  DIGIT,
  LETTER,
  declaredFaces,
  drawnGlyphs,
  forgetGlyphs,
  inkOf,
  postForPng,
  recordGlyphs,
  weightsBy,
  type DrawnGlyph,
} from "./label-probes";
import { waitForPicture } from "./picture-support";
import { createProject, invitePerson, runTag, share, type Person } from "./sharing-support";
import { addLayer, createMap, patchLayer, patchMap, publishMap, routeHouse } from "./support";

const TAG = runTag();
const TABLE = `lf_${TAG}`;
const TEMPLATE_ID = `label-faces-${TAG}`;

type RGB = readonly [number, number, number];
const RED: RGB = [210, 30, 40];
const BLUE: RGB = [30, 60, 210];
const GREEN: RGB = [20, 150, 60];
const ORANGE: RGB = [235, 120, 0];
/** The stubbed Light style's ground (the picture fixture's too). */
const POSITRON = { url: "/styles/positron", css: "#f0e6c8", rgb: [240, 230, 200] as RGB };

const rgba = (c: RGB, a = 1) => ({ r: c[0], g: c[1], b: c[2], a });
const invisible = {
  fill: { type: "constant", color: rgba([0, 0, 0], 0) },
  fillOpacity: 0,
  stroke: rgba([0, 0, 0], 0),
  strokeOpacity: 0,
  strokeWidth: 0,
  pointRadius: 1,
  opacity: 1,
};
/** A label of its own colour and no halo, so its ink is its colour alone. */
const ownLabel = (colour: RGB, extra: Record<string, unknown> = {}) => ({
  size: 24,
  textPaint: "own",
  color: rgba(colour),
  haloPaint: "own",
  haloWidth: 0,
  haloColor: rgba([0, 0, 0], 0),
  density: 1,
  ...extra,
});

/** Where each probe stands, around the map's centre at zoom 14: the simple
 * labels above it, the tiled and cell labels level with it, the cluster
 * between, all clear of the corners' controls and legend. */
const CENTRE = { lng: 13.4, lat: 52.52 };
const rows = [
  "kind,name,lon,lat",
  `normal,HHHHHH,${CENTRE.lng - 0.01},${CENTRE.lat + 0.003}`,
  `bold,HHHHHH,${CENTRE.lng + 0.01},${CENTRE.lat + 0.003}`,
  ...Array.from({ length: 30 }, (_, i) => `cell,,${CENTRE.lng + 0.01 + (i % 6) * 0.00002},${CENTRE.lat - 0.0005 + Math.floor(i / 6) * 0.00002}`),
  ...Array.from({ length: 25 }, (_, i) => `cluster,,${CENTRE.lng + (i % 5) * 0.00002},${CENTRE.lat + 0.001 + Math.floor(i / 5) * 0.00002}`),
  // Unmarked corners: a picture framed to the data keeps every label whole.
  ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([x, y]) => `frame,,${CENTRE.lng + x * 0.022},${CENTRE.lat + y * 0.006}`),
];

/** The tiled layer: 2,401 points (over the 2,000-feature cap), only the
 * first labelled, the rest unmarked around it. */
const TILED_SQL = `SELECT
    CASE WHEN r.i = 0 THEN 'TTTT' ELSE NULL END AS tag,
    ST_Point(${CENTRE.lng - 0.01} + (r.i % 50) * 0.00001, ${CENTRE.lat - 0.0005} - floor(r.i / 50) * 0.00001) AS geometry
  FROM range(0, 2401) AS r(i)`;

/** Answer the built-in Light style as a flat ground; the house policy
 * aborts every other third-party request. Registered after it, so it wins. */
async function stubLight(context: BrowserContext) {
  await routeHouse(context);
  await context.route("https://tiles.openfreemap.org/**", async (route) => {
    if (new URL(route.request().url()).pathname !== POSITRON.url) return route.abort();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: "ground", type: "background", paint: { "background-color": POSITRON.css } }] }),
    });
  });
}

let mapId = "";
let token = "";
let tableId = "";
let viewer: Person | undefined;
let scratch = "";
let catalogue: LoopbackCatalogue | null = null;
let template: BuiltTemplate | null = null;

/** The label of each layer of the faces map, by its name. */
async function seedFacesMap(page: Page): Promise<string> {
  const upload = await page.request.post("/api/tables", {
    multipart: { file: { name: `${TABLE}.csv`, mimeType: "text/csv", buffer: Buffer.from(rows.join("\n") + "\n") } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  tableId = (await upload.json()).id;
  const id = await createMap(page, `Label faces ${TAG}`);
  await patchMap(page, id, { basemap: "light", viewport: { lng: CENTRE.lng, lat: CENTRE.lat, zoom: 14, pitch: 0, bearing: 0 } });
  const layer = async (name: string, sql: string, style: Record<string, unknown>, viz?: Record<string, unknown>) => {
    const layerId = await addLayer(page, id, name, sql);
    await patchLayer(page, layerId, { style, ...(viz ? { viz } : {}) });
  };
  await layer("normal", `SELECT * FROM ${TABLE} WHERE kind = 'normal'`, { ...invisible, label: ownLabel(RED, { attribute: "name" }) });
  await layer("bold", `SELECT * FROM ${TABLE} WHERE kind = 'bold'`, { ...invisible, label: ownLabel(BLUE, { attribute: "name", weight: "bold" }) });
  await layer("tiled", TILED_SQL, { ...invisible, label: ownLabel(GREEN, { attribute: "tag" }) });
  await layer("cells", `SELECT * FROM ${TABLE} WHERE kind = 'cell'`, { ...invisible, label: ownLabel(ORANGE, { size: 12 }) },
    { type: "grid", cellKm: 0.2, aggregate: { fn: "count" } });
  await layer("frame", `SELECT * FROM ${TABLE} WHERE kind = 'frame'`, invisible);
  await layer("clusters", `SELECT * FROM ${TABLE} WHERE kind = 'cluster'`, {
    ...invisible, fill: { type: "constant", color: rgba([120, 120, 120]) }, fillOpacity: 1, pointRadius: 6,
  }, { type: "cluster", radiusPx: 40, color: "fixed", showCounts: true });
  return id;
}

/** What a surface's record and canvas say about its labels. */
async function expectFaces(page: Page, face: "inter" | "archivo", where: string) {
  const faces = await declaredFaces(page);
  const family = faces[face];
  let glyphs: DrawnGlyph[] = [];
  await expect.poll(async () => {
    glyphs = await drawnGlyphs(page);
    const letters = weightsBy(glyphs, family, LETTER).weights;
    const digits = weightsBy(glyphs, faces.inter, DIGIT).weights;
    return letters.includes(600) && letters.includes(700) && digits.includes(400);
  }, { message: `${where}: labels at 600 and 700 and counts at 400 drawn`, timeout: 60_000 }).toBe(true);
  const letters = weightsBy(glyphs, family, LETTER);
  expect(letters.weights, `${where}: label letters in ${family}`).toEqual([600, 700]);
  expect(letters.fallback, `${where}: label letters drawn before their face arrived`).toBe(0);
  const letterFamilies = new Set(glyphs.filter((g) => LETTER.test(g.text) && g.family !== "").map((g) => g.family));
  expect([...letterFamilies], `${where}: the only face label letters were asked in`).toEqual([family]);
  // Cell labels are digits in the label face at its normal weight, and
  // cluster counts keep Inter at 400 on every surface, the published map's
  // included: on the workspace both are Inter, apart by weight.
  const counts = weightsBy(glyphs, faces.inter, DIGIT);
  if (face === "inter") {
    expect(counts.weights, `${where}: Inter digits, the counts' and the cells'`).toEqual([400, 600]);
  } else {
    expect(weightsBy(glyphs, family, DIGIT).weights, `${where}: cell label digits`).toEqual([600]);
    expect(counts.weights, `${where}: count digits`).toEqual([400]);
  }
  expect(counts.fallback, `${where}: digits drawn before Inter arrived`).toBe(0);
  return glyphs;
}

/** Each kind's ink on a picture of the map, and the bold label's share of
 * the normal one's. */
async function inks(page: Page, png: Buffer, ground?: RGB) {
  const read = async (c: RGB) => inkOf(page, png, c, ground ? { ground } : {});
  const [red, blue, green, orange] = await Promise.all([read(RED), read(BLUE), read(GREEN), read(ORANGE)]);
  return { red, blue, green, orange, bold: blue.coverage / red.coverage };
}

function expectEveryKind(found: Awaited<ReturnType<typeof inks>>, where: string, kinds: ("tiled" | "cells")[] = ["tiled", "cells"]) {
  expect(found.red.solid, `${where}: the normal label`).toBeGreaterThan(40);
  expect(found.blue.solid, `${where}: the bold label`).toBeGreaterThan(40);
  if (kinds.includes("tiled")) expect(found.green.solid, `${where}: the tiled label`).toBeGreaterThan(20);
  // Cell labels are sized by their cells on the ground, so a picture framed
  // wider draws them small: ink present, not a solid count.
  if (kinds.includes("cells")) expect(found.orange.coverage, `${where}: the cell labels`).toBeGreaterThan(5);
  expect(found.bold, `${where}: bold ink over normal ink`).toBeGreaterThan(1.05);
}

const deckShot = (page: Page) => page.locator("canvas#deckgl-overlay").first().screenshot();

/** Keep a picture beside the test's results, for the record. */
async function keep(name: string, png: Buffer) {
  await writeFile(test.info().outputPath(`${name}.png`), png);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ baseURL }) => {
  if (!baseURL || new URL(baseURL).port === "3000") throw new Error("Use an isolated instance with the picture style fixture preload.");
});

test.afterAll(async ({ request }) => {
  await viewer?.context.close();
  if (template) {
    await request.delete("/api/templates/downloads").catch(() => undefined);
    await request.patch("/api/instance/settings", { data: { templatesCatalogueUrl: null, "templates.catalogue": null } }).catch(() => undefined);
  }
  await catalogue?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** The render page's ratio of bold ink to normal, which the server's
 * images are held to. */
let renderRatio = 0;
let renderInks: Awaited<ReturnType<typeof inks>> | null = null;
const exportDefinition = {
  viewport: { lng: CENTRE.lng, lat: CENTRE.lat, zoom: 14, pitch: 0, bearing: 0 },
  size: { width: 960, height: 600 },
  legend: { visible: false, corner: "bottom-left", size: "m" },
  widgets: [],
  title: null,
  appearance: "light",
  mapScale: 1,
};

test("labels draw in Inter at 600 and 700 in the builder, cluster counts in Inter 400", async ({ page, context }) => {
  test.setTimeout(240_000);
  await recordGlyphs(context);
  await stubLight(context);
  await page.goto("/maps");
  mapId = await seedFacesMap(page);
  await page.goto(`/maps/${mapId}`);
  const tiledRow = page.getByRole("button", { name: /^tiled/ });
  await expect(tiledRow).toContainText("features · tiled", { timeout: 90_000 });
  await expectFaces(page, "inter", "builder");
  await expect.poll(async () => (await inks(page, await deckShot(page))).green.solid, { timeout: 60_000 }).toBeGreaterThan(20);
  const builderShot = await deckShot(page);
  await keep("builder", builderShot);
  const found = await inks(page, builderShot);
  expectEveryKind(found, "builder");
  test.info().annotations.push({ type: "ink", description: `builder ${JSON.stringify({ bold: found.bold, red: found.red.coverage, blue: found.blue.coverage })}` });

  await test.step("the builder's Export image draws the same faces into its file", async () => {
    await forgetGlyphs(page);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.getByRole("menuitem", { name: /Image/ }).first().click();
    await expect(page.getByRole("dialog", { name: "Export image" })).toBeVisible();
    await expect(page.locator("[data-export-card] canvas").first()).toBeVisible({ timeout: 30_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("[data-export-download]").click()]);
    const file = await download.path();
    const png = await readFile(file);
    await keep("export-image", png);
    // The card's map asks for no face but the builder's: any atlas it
    // builds afresh names only Inter at 600 and 700, and the counts' 400.
    const glyphs = await drawnGlyphs(page);
    const faces = await declaredFaces(page);
    for (const weight of weightsBy(glyphs, faces.inter, LETTER).weights) expect([600, 700], "Export image letters").toContain(weight);
    expect(glyphs.filter((g) => LETTER.test(g.text) && g.family !== faces.inter).length, "Export image letters in another face").toBe(0);
    const exported = await inks(page, png);
    expectEveryKind(exported, "Export image");
    expect(Math.abs(exported.bold - found.bold), "Export image bold proportion against the builder's").toBeLessThan(0.08);
  });
});

test("the render page the server draws from asks for Inter at 600 and 700, and the image export draws what it draws", async ({ page, context }) => {
  test.setTimeout(180_000);
  await recordGlyphs(context);
  await stubLight(context);
  await page.addInitScript((d) => {
    (window as { __DEZFIL_EXPORT_DEFINITION__?: unknown }).__DEZFIL_EXPORT_DEFINITION__ = d;
  }, exportDefinition);
  await page.setViewportSize(exportDefinition.size);
  await page.goto(`/render/${mapId}`);
  await expect(page.locator('[data-export-ready="true"]')).toBeVisible({ timeout: 60_000 });
  await expectFaces(page, "inter", "render page");
  const shot = await page.screenshot();
  await keep("render-page", shot);
  renderInks = await inks(page, shot);
  expectEveryKind(renderInks, "render page");
  renderRatio = renderInks.bold;

  const exported = await postForPng(page, `/api/maps/${mapId}/export/image`, { definition: exportDefinition });
  expect(exported.status, exported.text).toBe(200);
  await keep("api-image-export", exported.png!);
  const server = await inks(page, exported.png!);
  expectEveryKind(server, "API image export");
  for (const [name, colour] of [["normal", "red"], ["bold", "blue"]] as const) {
    const ratio = server[colour].coverage / renderInks[colour].coverage;
    expect(Math.abs(ratio - 1), `API image export: the ${name} label's ink against the render page's (${ratio.toFixed(3)})`).toBeLessThan(0.06);
  }
  test.info().annotations.push({ type: "ink", description: `render ${renderRatio.toFixed(3)} export ${server.bold.toFixed(3)}` });
});

test("a card picture and the assistant's look hold the render page's proportion of bold ink", async ({ page, context }) => {
  test.setTimeout(180_000);
  expect(renderRatio, "the render page was read first").toBeGreaterThan(1);
  await stubLight(context);
  await page.goto("/maps");
  await waitForPicture(page.request, mapId);
  const picture = await page.request.get(`/api/maps/${mapId}/thumbnail`);
  expect(picture.status()).toBe(200);
  await keep("card-picture", await picture.body());
  const card = await inks(page, await picture.body());
  expectEveryKind(card, "card picture");
  expect(Math.abs(card.bold - renderRatio), `card picture bold proportion ${card.bold.toFixed(3)} against ${renderRatio.toFixed(3)}`).toBeLessThan(0.1);

  const look = await page.request.post("/api/maps/look", { data: { mapId, appearance: "light" } });
  expect(look.status(), await look.text()).toBe(200);
  const lookPng = Buffer.from((await look.json()).image.content_base64, "base64");
  await keep("assistant-look", lookPng);
  const looked = await inks(page, lookPng);
  expectEveryKind(looked, "the assistant's look");
  expect(Math.abs(looked.bold - renderRatio), `look bold proportion ${looked.bold.toFixed(3)} against ${renderRatio.toFixed(3)}`).toBeLessThan(0.1);
  test.info().annotations.push({ type: "ink", description: `card ${card.bold.toFixed(3)} look ${looked.bold.toFixed(3)}` });
});

test("a published map and its embed draw labels in Archivo at 600 and 700, counts in Inter 400", async ({ page, context }) => {
  test.setTimeout(180_000);
  await recordGlyphs(context);
  await stubLight(context);
  await page.goto("/maps");
  token = await publishMap(page, mapId);
  for (const [where, address] of [["published map", `/v/${token}`], ["embed", `/v/${token}?embed=1`]] as const) {
    await page.goto(address);
    await expect(page.locator("canvas#deckgl-overlay")).toBeVisible({ timeout: 30_000 });
    await expectFaces(page, "archivo", where);
    await expect.poll(async () => (await inks(page, await deckShot(page))).green.solid, { timeout: 60_000 }).toBeGreaterThan(20);
    const shot = await deckShot(page);
    await keep(where.replace(/\W+/g, "-"), shot);
    expectEveryKind(await inks(page, shot), where);
  }
});

test("the workspace reader draws labels in Inter at 600 and 700", async ({ browser, request, baseURL }) => {
  test.setTimeout(180_000);
  viewer = await invitePerson(browser, request, baseURL!, "Jonas", TAG);
  const owner = { api: request } as Person;
  const projectId = await createProject(owner, `Label faces ${TAG}`, { addMaps: [mapId], addTables: [tableId] });
  await share(owner, projectId, viewer, "viewer");
  await recordGlyphs(viewer.context);
  await stubLight(viewer.context);
  const page = await viewer.context.newPage();
  await page.goto(`/maps/${mapId}`);
  await expect(page.locator("canvas#deckgl-overlay")).toBeVisible({ timeout: 30_000 });
  // The reader, not the builder: no Export, nothing to change.
  await expect(page.getByRole("button", { name: "Export", exact: true })).toHaveCount(0);
  await expectFaces(page, "inter", "workspace reader");
  await expect.poll(async () => (await inks(page, await deckShot(page))).green.solid, { timeout: 60_000 }).toBeGreaterThan(20);
  const shot = await deckShot(page);
  await keep("workspace-reader", shot);
  expectEveryKind(await inks(page, shot), "workspace reader");
});

test("a template view draws labels in Inter at 600 and 700", async ({ page, context, request }) => {
  test.setTimeout(240_000);
  const read = await (await request.get("/api/instance/settings")).json() as { settings: Record<string, { source: string }> };
  test.skip(read.settings.templatesCatalogueUrl?.source === "environment", "the server's environment names the template catalogue");
  scratch = await mkdtemp(path.join(os.tmpdir(), "dezfil-label-faces-"));
  const previous = process.env.DEZFIL_DATA_DIR;
  process.env.DEZFIL_DATA_DIR = path.join(scratch, "data");
  try {
    // The fixture's two layers, one labelled normal and one bold. A
    // template's datasets are small, so it carries no tiled layer here.
    template = await buildTemplate(path.join(scratch, "map"), {
      kind: "map", id: TEMPLATE_ID, title: `Label faces ${TAG}`,
      edit: (files) => {
        for (const [name, document] of files.documents) {
          if (!name.startsWith("maps/")) continue;
          document.basemap = "light";
          const layers = document.layers as { style: Record<string, unknown> }[];
          layers[0].style = { ...invisible, label: ownLabel(RED, { attribute: "name" }) };
          layers[1].style = { ...invisible, label: ownLabel(BLUE, { attribute: "name", weight: "bold" }) };
        }
      },
    });
  } finally {
    if (previous === undefined) delete process.env.DEZFIL_DATA_DIR;
    else process.env.DEZFIL_DATA_DIR = previous;
  }
  catalogue = await startLoopbackCatalogue();
  await catalogue.publish([template]);
  const address = new URL(catalogue.indexUrl);
  address.hostname = "127.0.0.1";
  const saved = await request.patch("/api/instance/settings", { data: { templatesCatalogueUrl: address.toString(), "templates.catalogue": true } });
  expect(saved.status(), await saved.text()).toBe(200);

  await recordGlyphs(context);
  await stubLight(context);
  await page.goto(`/templates/${TEMPLATE_ID}`);
  await expect(page.locator("canvas#deckgl-overlay")).toBeVisible({ timeout: 60_000 });
  const faces = await declaredFaces(page);
  let glyphs: DrawnGlyph[] = [];
  await expect.poll(async () => {
    glyphs = await drawnGlyphs(page);
    const w = weightsBy(glyphs, faces.inter, LETTER).weights;
    return w.includes(600) && w.includes(700);
  }, { message: "template view: labels at 600 and 700", timeout: 60_000 }).toBe(true);
  expect(weightsBy(glyphs, faces.inter, LETTER).weights).toEqual([600, 700]);
  expect(weightsBy(glyphs, faces.inter, LETTER).fallback).toBe(0);
  const shot = await deckShot(page);
  await keep("template-view", shot);
  const found = await inks(page, shot);
  expect(found.red.solid, "template view: the normal labels").toBeGreaterThan(40);
  expect(found.blue.solid, "template view: the bold labels").toBeGreaterThan(40);
});

/** The URLs of a family's declared font files, from the page's styles. */
async function fontFiles(page: Page, family: string): Promise<string[]> {
  return page.evaluate((family) => {
    const urls: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const name = rule.style.getPropertyValue("font-family").trim().replace(/^(["'])(.*)\1$/, "$2").toLowerCase();
        if (name !== family) continue;
        // A stylesheet's own address resolves its relative font addresses.
        const base = sheet.href ?? location.href;
        for (const m of rule.style.getPropertyValue("src").matchAll(/url\(["']?([^"')]+)["']?\)/g)) urls.push(new URL(m[1], base).pathname);
      }
    }
    return urls;
  }, family);
}

test.describe("the face's own arrival", () => {
  let cyrillicMap = "";
  let interFiles: string[] = [];

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    await routeHouse(context);
    const page = await context.newPage();
    await page.goto("/maps");
    interFiles = await fontFiles(page, (await declaredFaces(page)).inter);
    expect(interFiles.length, "Inter's declared files").toBeGreaterThan(1);
    const upload = await page.request.post("/api/tables", {
      multipart: { file: { name: `lfc_${TAG}.csv`, mimeType: "text/csv", buffer: Buffer.from(`name,lon,lat\nМосква,${CENTRE.lng},${CENTRE.lat}\n`) } },
    });
    expect(upload.status()).toBe(201);
    cyrillicMap = await createMap(page, `Label arrival ${TAG}`);
    await patchMap(page, cyrillicMap, { basemap: "light", viewport: { lng: CENTRE.lng, lat: CENTRE.lat, zoom: 13, pitch: 0, bearing: 0 } });
    const layerId = await addLayer(page, cyrillicMap, "names", `SELECT * FROM lfc_${TAG}`);
    await patchLayer(page, layerId, { style: { ...invisible, label: ownLabel(RED, { attribute: "name", size: 32 }) } });
    await context.close();
  });

  /** Open the map with every Inter file held as given; answers how many
   * Inter files the page asked for, so a hold that never met a request
   * cannot pass for one that did. */
  const openWithFonts = async (context: BrowserContext, page: Page, hold: (route: import("@playwright/test").Route) => Promise<void>) => {
    await recordGlyphs(context);
    await stubLight(context);
    const held: string[] = [];
    await context.route((url) => interFiles.includes(url.pathname), async (route) => {
      held.push(new URL(route.request().url()).pathname);
      await hold(route);
    });
    // A held face holds the document's load: read it as soon as it parses.
    await page.goto(`/maps/${cyrillicMap}`, { waitUntil: "domcontentloaded" });
    return held;
  };

  test("a face that arrives late but within the wait is the one drawn, Cyrillic included", async ({ page, context }) => {
    const held = await openWithFonts(context, page, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await route.continue();
    });
    const inter = (await declaredFaces(page)).inter;
    let glyphs: DrawnGlyph[] = [];
    await expect.poll(async () => {
      glyphs = (await drawnGlyphs(page)).filter((g) => g.family === inter && LETTER.test(g.text));
      return glyphs.length;
    }, { timeout: 30_000 }).toBeGreaterThanOrEqual(6);
    const cyrillic = glyphs.filter((g) => /\p{Script=Cyrillic}/u.test(g.text));
    expect(cyrillic.map((g) => g.text).sort().join(""), "every Cyrillic letter drawn").toBe([..."Москва"].sort().join(""));
    expect(cyrillic.filter((g) => !g.loaded).length, "Cyrillic letters drawn before the face arrived").toBe(0);
    expect(glyphs.every((g) => g.weight === 600)).toBe(true);
    // Both the Latin file and the Cyrillic one were held, and the first
    // label glyph came after the hold.
    expect(held.length, "Inter files held").toBeGreaterThanOrEqual(2);
    expect(Math.min(...glyphs.map((g) => g.at)), "the first label glyph, in ms since the page began").toBeGreaterThan(2_500);
    expect((await inkOf(page, await deckShot(page), RED)).solid, "the label drew").toBeGreaterThan(40);
  });

  test("a face that never arrives leaves labels to the fallback within the wait", async ({ page, context }) => {
    // Known to fail: a font file that stalls holds the document's load, and
    // the map's WebGL device waits for that load before it draws anything,
    // marks included, so labels draw only once the request ends, however
    // long that is. The labels' own wait never gets its turn.
    test.fail(true, "the map's drawing waits for the page's load, which a stalled font file holds");
    const held = await openWithFonts(context, page, async (route) => {
      // Unanswered for three times the wait, then refused: a stalled face.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      await route.abort().catch(() => undefined);
    });
    const inter = (await declaredFaces(page)).inter;
    let glyphs: DrawnGlyph[] = [];
    await expect.poll(async () => {
      glyphs = (await drawnGlyphs(page)).filter((g) => g.family === inter && LETTER.test(g.text));
      return glyphs.length;
    }, { timeout: 30_000 }).toBeGreaterThanOrEqual(6);
    expect(held.length, "Inter files held").toBeGreaterThanOrEqual(1);
    expect(glyphs.every((g) => !g.loaded), "drawn in the fallback").toBe(true);
    // Not before the wait ran out.
    expect(Math.min(...glyphs.map((g) => g.at)), "the first label glyph, in ms since the page began").toBeGreaterThan(5_000);
    // The wait is five seconds from when the canvas first asked for the
    // face, after the page's own load: the first label glyph comes well
    // inside a quarter of a minute of the document's start.
    expect(Math.min(...glyphs.map((g) => g.at)), "the first label glyph, in ms since the page began").toBeLessThan(15_000);
    await expect.poll(async () => (await inkOf(page, await deckShot(page), RED)).solid, { timeout: 10_000 }).toBeGreaterThan(40);
  });
});

