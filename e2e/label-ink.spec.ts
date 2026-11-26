// Automatic labels take their paint from the tone of the basemap actually
// drawn under them: dark text (#243230) on a white halo over a light map,
// light text (#e9ecf3) on a #0b0e14 halo over a dark one, whatever the fill
// right under the label. Every case below draws one label over a district
// of a middle tone and reads the pixels where it stands: the expected text
// colour inside its strokes, its halo pulling the district's colour toward
// the halo's around them, the other tone's text nowhere, and the basemap's
// own ground around the district, so each case is the basemap it claims.
//
// The labels are drawn at the largest size, where the halo's soft rim is
// widest; the read itself is in `label-probes.ts`.
//
// The cases, in the builder: Light, Streets, Dark, Satellite with imagery
// and without it (the deployment's default drawn instead), Auto in the
// light and the dark theme, a style of the map's own in each theme, and a
// basemap that fails to load (the plain background, in the theme's tone).
// A switch of theme or basemap repaints the label with no reload. On a
// published map: the reader's own basemap pick and the reader's theme
// switch, each at once. In the server's images: the image export over each
// basemap and appearance, and the assistant's look in the dark appearance.
//
// A deployment's own style takes the surface's theme too. That case needs
// an instance started with DEZFIL_BASEMAP_URL at a loopback style and the
// test process told so with DEZFIL_E2E_DEPLOYMENT_STYLE=1; without it, it
// skips and says so. Every other case skips on such an instance, which
// pins Auto to that style.
//
// Run with DEZFIL_BASE_URL at an isolated instance on a fresh data folder
// with DEZFIL_EGRESS_ALLOWLIST=127.0.0.1, a renderer at DEZFIL_CHROMIUM_PATH
// and the picture style fixture preload, as
// `src/lib/pictures/pictures.real-render.md` describes for the theme suite:
// the server's images draw the three built-in styles as the same flat
// grounds the browser is answered here.
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { encodePng } from "../src/lib/export/png-codec";
import { DISTRICT, describePaint, holds, paintOf, postForPng, type Paint, type RGB } from "./label-probes";
import { runTag } from "./sharing-support";
import { addLayer, createMap, patchLayer, patchMap, publishMap, routeHouse } from "./support";

const TAG = runTag();
const TABLE = `lk_${TAG}`;
const deployment = process.env.DEZFIL_E2E_DEPLOYMENT_STYLE === "1";

/** The built-in styles' flat grounds, the picture fixture's colours. */
const GROUNDS = {
  dark: { path: "/styles/dark", rgb: [26, 42, 58] as RGB },
  light: { path: "/styles/positron", rgb: [240, 230, 200] as RGB },
  streets: { path: "/styles/liberty", rgb: [200, 224, 240] as RGB },
};
const IMAGERY: RGB = [60, 110, 60];
const CUSTOM: RGB = [138, 138, 138];
const CENTRE = { lng: 13.4, lat: 52.52 };
const VIEW = { lng: CENTRE.lng, lat: CENTRE.lat, zoom: 14, pitch: 0, bearing: 0 };

const hex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const rgba = (c: RGB, a = 1) => ({ r: c[0], g: c[1], b: c[2], a });

/** Answer the built-in styles as flat grounds, all but those named. */
async function stubStyles(context: BrowserContext, failing: (keyof typeof GROUNDS)[] = []) {
  await routeHouse(context);
  await context.route("https://tiles.openfreemap.org/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const entry = Object.entries(GROUNDS).find(([, g]) => g.path === pathname);
    if (!entry || failing.includes(entry[0] as keyof typeof GROUNDS)) return route.abort();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: "ground", type: "background", paint: { "background-color": hex(entry[1].rgb) } }] }),
    });
  });
}

const deckShot = (page: Page) => page.locator("canvas#deckgl-overlay").first().screenshot();

/** Poll the canvas until its label holds a tone's recipe on that ground. */
async function expectCanvas(page: Page, tone: "light" | "dark", where: string, ground?: RGB) {
  let last: Paint | null = null;
  let shot: Buffer | null = null;
  await expect
    .poll(async () => {
      shot = await deckShot(page);
      last = await paintOf(page, shot);
      return holds(last, tone, ground);
    }, { message: `${where}: the ${tone} recipe`, timeout: 30_000 })
    .toBe(true)
    .catch(async (error: Error) => {
      if (shot) await writeFile(test.info().outputPath(`${where.replace(/\W+/g, "-")}.png`), shot);
      throw new Error(`${error.message}\n${where}: ${last ? describePaint(last) : "no picture"}`);
    });
  if (shot) await writeFile(test.info().outputPath(`${where.replace(/\W+/g, "-")}.png`), shot);
  // The canvas says the same tone it painted for.
  await expect(page.locator("[data-label-tone]").first()).toHaveAttribute("data-label-tone", tone);
}

async function expectImage(found: { paint: Paint; png: Buffer }, tone: "light" | "dark", where: string, ground?: RGB) {
  await writeFile(test.info().outputPath(`${where.replace(/\W+/g, "-")}.png`), found.png);
  expect(holds(found.paint, tone, ground), `${where}: the ${tone} recipe. ${describePaint(found.paint)}`).toBe(true);
}

/** A map of one automatic label over a district, on a basemap. */
async function seedMap(page: Page, name: string, basemap: Record<string, unknown>): Promise<string> {
  const id = await createMap(page, `${name} ${TAG}`);
  await patchMap(page, id, { viewport: VIEW, ...basemap });
  const district = await addLayer(page, id, "district", `SELECT ST_MakeEnvelope(${CENTRE.lng - 0.012}, ${CENTRE.lat - 0.003}, ${CENTRE.lng + 0.012}, ${CENTRE.lat + 0.003}) AS geometry`);
  await patchLayer(page, district, {
    style: { fill: { type: "constant", color: rgba(DISTRICT) }, fillOpacity: 1, stroke: rgba(DISTRICT), strokeOpacity: 0, strokeWidth: 0, pointRadius: 1, opacity: 1 },
  });
  const labels = await addLayer(page, id, "label", `SELECT * FROM ${TABLE}`);
  await patchLayer(page, labels, {
    style: {
      fill: { type: "constant", color: rgba([0, 0, 0], 0) }, fillOpacity: 0, stroke: rgba([0, 0, 0], 0), strokeOpacity: 0,
      strokeWidth: 0, pointRadius: 1, opacity: 1,
      // Automatic for both parts: no choice and no colour sent.
      label: { attribute: "name", size: 72, density: 1 },
    },
  });
  return id;
}

const exportDefinition = (appearance: "light" | "dark") => ({
  viewport: VIEW,
  size: { width: 960, height: 600 },
  legend: { visible: false, corner: "bottom-left", size: "m" },
  widgets: [],
  title: null,
  appearance,
  mapScale: 1,
});

async function serverImage(page: Page, mapId: string, appearance: "light" | "dark") {
  const exported = await postForPng(page, `/api/maps/${mapId}/export/image`, { definition: exportDefinition(appearance) });
  expect(exported.status, exported.text).toBe(200);
  return { paint: await paintOf(page, exported.png!), png: exported.png! };
}

/** A loopback server for the map's own style and the imagery's tiles. */
let fixture: Server | null = null;
let fixtureOrigin = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, baseURL }) => {
  if (!baseURL || new URL(baseURL).port === "3000") throw new Error("Use an isolated instance with the picture style fixture preload.");
  const tile = Buffer.from(encodePng({ width: 256, height: 256, rgba: new Uint8Array(256 * 256 * 4).map((_, i) => (i % 4 === 3 ? 255 : IMAGERY[i % 4])) }));
  fixture = createServer((req, res) => {
    const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    if (req.url === "/style.json") {
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify({ version: 8, sources: {}, layers: [{ id: "ground", type: "background", paint: { "background-color": hex(CUSTOM) } }] }));
      return;
    }
    if (/^\/tiles\/\d+\/\d+\/\d+\.png$/.test(req.url ?? "")) {
      res.writeHead(200, { ...headers, "content-type": "image/png" });
      res.end(tile);
      return;
    }
    res.writeHead(404, headers);
    res.end();
  });
  await new Promise<void>((resolve) => fixture!.listen(0, "127.0.0.1", () => resolve()));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("no fixture address");
  fixtureOrigin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await routeHouse(context);
  await page.goto("/maps");
  const upload = await page.request.post("/api/tables", {
    multipart: { file: { name: `${TABLE}.csv`, mimeType: "text/csv", buffer: Buffer.from(`name,lon,lat\nHHHH,${CENTRE.lng},${CENTRE.lat}\n`) } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  await context.close();
});

test.afterAll(async ({ request }) => {
  await request.patch("/api/instance/settings", { data: { satelliteUrl: null, satelliteAttribution: null } }).catch(() => undefined);
  await new Promise<void>((resolve) => (fixture ? fixture.close(() => resolve()) : resolve()));
});

test.describe("on the instance's own styles", () => {
  test.beforeEach(() => {
    test.skip(deployment, "this instance pins Auto to its own style");
  });

  test("the builder paints each basemap's tone, and a theme or basemap switch repaints at once", async ({ page, context }) => {
    test.setTimeout(240_000);
    await stubStyles(context);
    await page.goto("/maps");
    const cases: [string, Record<string, unknown>, "light" | "dark", RGB][] = [
      ["Light", { basemap: "light" }, "light", GROUNDS.light.rgb],
      ["Streets", { basemap: "streets" }, "light", GROUNDS.streets.rgb],
      ["Dark", { basemap: "dark" }, "dark", GROUNDS.dark.rgb],
      ["Auto", { basemap: null }, "light", GROUNDS.light.rgb],
      ["Own style", { customBasemap: { url: `${fixtureOrigin}/style.json`, name: "Loopback", attribution: [] } }, "light", CUSTOM],
    ];
    const ids: Record<string, string> = {};
    for (const [name, basemap, tone, ground] of cases) {
      ids[name] = await seedMap(page, name, basemap);
      await page.goto(`/maps/${ids[name]}`);
      await expectCanvas(page, tone, `builder, ${name}, light theme`, ground);
    }

    await test.step("the theme switch repaints Auto and the map's own style at once", async () => {
      const toggle = page.getByRole("button", { name: "Switch between dark and light theme" });
      await toggle.click();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
      await expectCanvas(page, "dark", "builder, own style, switched to the dark theme", CUSTOM);
      await page.goto(`/maps/${ids.Auto}`);
      await expectCanvas(page, "dark", "builder, Auto, dark theme", GROUNDS.dark.rgb);
      await toggle.click();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? "light")).toBe("light");
      await expectCanvas(page, "light", "builder, Auto, switched back to the light theme", GROUNDS.light.rgb);
    });

    await test.step("a basemap switch repaints at once", async () => {
      await page.goto(`/maps/${ids.Light}`);
      await expectCanvas(page, "light", "builder, Light", GROUNDS.light.rgb);
      await page.getByRole("tab", { name: "Basemap" }).click();
      await page.getByRole("button", { name: "Dark", exact: true }).click();
      await expectCanvas(page, "dark", "builder, switched to Dark", GROUNDS.dark.rgb);
    });
  });

  test("Satellite paints the dark recipe over imagery, and over the default drawn where there is none", async ({ page, context }) => {
    test.setTimeout(180_000);
    await stubStyles(context);
    await page.goto("/maps");
    const id = await seedMap(page, "Satellite", { basemap: "satellite" });
    // No imagery set up: the deployment's default, the Dark style, draws.
    await page.goto(`/maps/${id}`);
    await expectCanvas(page, "dark", "builder, Satellite with no imagery", GROUNDS.dark.rgb);
    await expectImage(await serverImage(page, id, "light"), "dark", "image export, Satellite with no imagery", GROUNDS.dark.rgb);

    const set = await page.request.patch("/api/instance/settings", { data: { satelliteUrl: `${fixtureOrigin}/tiles/{z}/{x}/{y}.png`, satelliteAttribution: "Imagery fixture" } });
    expect(set.status(), await set.text()).toBe(200);
    await page.goto(`/maps/${id}`);
    await expectCanvas(page, "dark", "builder, Satellite imagery", IMAGERY);
    await expectImage(await serverImage(page, id, "light"), "dark", "image export, Satellite imagery", IMAGERY);
    const unset = await page.request.patch("/api/instance/settings", { data: { satelliteUrl: null, satelliteAttribution: null } });
    expect(unset.status()).toBe(200);
  });

  test("a basemap that fails to load leaves the plain background, and labels take the theme's tone", async ({ page, context }) => {
    await stubStyles(context, ["dark"]);
    await page.goto("/maps");
    const id = await seedMap(page, "Failing", { basemap: "dark" });
    await page.goto(`/maps/${id}`);
    await expect(page.getByText("basemap offline · data only")).toBeVisible({ timeout: 30_000 });
    // Loaded, the Dark style would take the dark recipe.
    await expectCanvas(page, "light", "builder, Dark failing to load, light theme");
  });

  test("on a published map, the reader's basemap pick and theme switch repaint at once", async ({ page, context }) => {
    test.setTimeout(180_000);
    await stubStyles(context);
    await page.goto("/maps");
    const light = await seedMap(page, "Published Light", { basemap: "light" });
    const auto = await seedMap(page, "Published Auto", { basemap: null });
    const lightToken = await publishMap(page, light);
    const autoToken = await publishMap(page, auto);

    await page.goto(`/v/${lightToken}`);
    await expectCanvas(page, "light", "published, Light as saved", GROUNDS.light.rgb);
    await page.getByRole("button", { name: "Basemap" }).click();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expectCanvas(page, "dark", "published, the reader's pick of Dark", GROUNDS.dark.rgb);

    // A published map opens in the dark theme unless its author chose
    // otherwise, and Auto follows the reader's theme.
    await page.goto(`/v/${autoToken}`);
    await expectCanvas(page, "dark", "published, Auto in the dark theme", GROUNDS.dark.rgb);
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expectCanvas(page, "light", "published, Auto switched to the light theme", GROUNDS.light.rgb);
  });

  test("the server's images paint each basemap's and appearance's tone, the assistant's look included", async ({ page, context }) => {
    test.setTimeout(240_000);
    await stubStyles(context);
    await page.goto("/maps");
    const cases: [string, Record<string, unknown>, "light" | "dark", "light" | "dark", RGB][] = [
      ["Light", { basemap: "light" }, "light", "light", GROUNDS.light.rgb],
      ["Light in a dark image", { basemap: "light" }, "dark", "light", GROUNDS.light.rgb],
      ["Streets", { basemap: "streets" }, "light", "light", GROUNDS.streets.rgb],
      ["Dark", { basemap: "dark" }, "light", "dark", GROUNDS.dark.rgb],
      ["Auto", { basemap: null }, "light", "light", GROUNDS.light.rgb],
      ["Auto in a dark image", { basemap: null }, "dark", "dark", GROUNDS.dark.rgb],
      ["Own style", { customBasemap: { url: `${fixtureOrigin}/style.json`, name: "Loopback", attribution: [] } }, "light", "light", CUSTOM],
      ["Own style in a dark image", { customBasemap: { url: `${fixtureOrigin}/style.json`, name: "Loopback", attribution: [] } }, "dark", "dark", CUSTOM],
    ];
    let autoId = "";
    for (const [name, basemap, appearance, tone, ground] of cases) {
      const id = await seedMap(page, `Image ${name}`, basemap);
      if (name === "Auto") autoId = id;
      await expectImage(await serverImage(page, id, appearance), tone, `image export, ${name}`, ground);
    }
    const look = await page.request.post("/api/maps/look", { data: { mapId: autoId, appearance: "dark" } });
    expect(look.status(), await look.text()).toBe(200);
    const png = Buffer.from((await look.json()).image.content_base64, "base64");
    await expectImage({ paint: await paintOf(page, png), png }, "dark", "the assistant's look, Auto in the dark appearance", GROUNDS.dark.rgb);
  });
});

test.describe("on a deployment's own style", () => {
  test.beforeEach(() => {
    test.skip(!deployment, "needs an instance started with DEZFIL_BASEMAP_URL and DEZFIL_E2E_DEPLOYMENT_STYLE=1 here");
  });

  test("Auto on the deployment's style takes the surface's theme, in the builder and in the server's images", async ({ page, context }) => {
    test.setTimeout(180_000);
    await routeHouse(context);
    await page.goto("/maps");
    const id = await seedMap(page, "Deployment", { basemap: null });
    await page.goto(`/maps/${id}`);
    await expectCanvas(page, "light", "builder, the deployment's style, light theme");
    const toggle = page.getByRole("button", { name: "Switch between dark and light theme" });
    await toggle.click();
    await expectCanvas(page, "dark", "builder, the deployment's style, switched to dark");
    await toggle.click();
    await expectImage(await serverImage(page, id, "light"), "light", "image export, the deployment's style, light");
    await expectImage(await serverImage(page, id, "dark"), "dark", "image export, the deployment's style, dark");
    // Satellite with no imagery draws the deployment's style: the theme's tone.
    const satellite = await seedMap(page, "Deployment Satellite", { basemap: "satellite" });
    await expectImage(await serverImage(page, satellite, "light"), "light", "image export, Satellite falling to the deployment's style");
  });
});
