import { test, expect, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { addLayer, createMap, patchLayer, patchMap } from "./support";
import { readThenWriteRequestSetup } from "./edit-basis";
import { waitForPicture } from "./picture-support";
import { closeAll, createProject, invitePerson, runTag, type Person } from "./sharing-support";
import { pictureBasemap } from "../test-support/picture-basemap";
import { pointStyle } from "../test-support/picture-pixels";
import { PICTURE_SHAPE } from "../src/lib/pictures/shapes";

/**
 * The cards' look over a map picture, in a browser on a production build.
 *
 * No fade over a drawn picture: in every host that shows one (the Maps
 * card, Home's Continue card, a project's card, and a map template's
 * picture on the Templates page, Home's shelf and Home's template lead) the
 * strip's foot is read from the screen and from the stored file laid out as
 * the host lays it out, and the two agree; with the picture's drawn mark
 * taken off, the fade returns over the same foot and they no longer agree,
 * the control. A map template's place label reads at a contrast of at
 * least 4.5 to 1 over each shipped map template's picture, light and dark.
 * The layer count stands in the card body, under the picture.
 *
 * A map wider than one world, shown in the Continue card beside Start on
 * both sides of a 1,160 px Home, at 968 px and at the widest, and in a
 * Maps card: its marks are decoded where the world once across the picture
 * puts them, edge to edge, centred on the prime meridian at 20 degrees
 * north.
 *
 * Run against an isolated production instance with the renderer and the
 * loopback ground allowed (DEZFIL_EGRESS_ALLOWLIST=127.0.0.1), one worker:
 * npx playwright test e2e/picture-look.spec.ts --project=chromium --workers=1
 */

const ORANGE = [233, 90, 45] as const, GREEN = [90, 200, 60] as const, BROWN = [140, 90, 40] as const;
/** The world-wide fixture: a mark on the prime meridian at 20 degrees
 * north, one near the 180th meridian on either side, and two near the
 * poles that make the data taller than one world. */
const WORLD = [
  { lng: 0, lat: 20, colour: ORANGE }, { lng: 172, lat: 20, colour: GREEN }, { lng: -172, lat: 20, colour: BROWN },
  { lng: 0, lat: 80, colour: [120, 120, 120] as const }, { lng: 0, lat: -80, colour: [30, 30, 30] as const },
];
const NAME = `World look ${runTag()}`;
/** The ground's land fills the southern half, so the picture's foot is land, far from any panel colour. */
const GROUND = (origin: string) => `${origin}/box.json?w=-180&s=-85&e=180&n=0`;
/** Hosts draw their own words over a picture; they are hidden while the foot is read. */
const HIDE_WORDS = `:has(> img[src*="/thumbnail?"]) > :not(img):not(svg), :has(> img[src*="/picture?"]) > :not(img):not(svg) { visibility: hidden !important; }`;

let ground: Awaited<ReturnType<typeof pictureBasemap>>;
let mapId = "", projectId = "";
let fresh: Person | undefined;
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, request, baseURL }) => {
  ground = await pictureBasemap();
  const page = await browser.newPage();
  await page.goto("/maps");
  mapId = await createMap(page, NAME);
  for (const [i, point] of WORLD.entries()) {
    await patchLayer(page, await addLayer(page, mapId, `Point ${i}`, `SELECT ST_Point(${point.lng}, ${point.lat}) AS geom`), { style: pointStyle(point.colour, 10) });
  }
  projectId = await createProject({ api: page.request } as Person, `World look ${runTag()}`, { addMaps: [mapId] });
  await patchMap(page, mapId, { viewport: { lng: 60, lat: -10, zoom: 2, pitch: 0, bearing: 0 }, customBasemap: { url: GROUND(ground.origin), name: "Look ground", attribution: [{ label: "Fixture" }] } });
  await waitForPicture(page.request, mapId);
  await page.close();
  fresh = await invitePerson(browser, request, baseURL!, "Lumen", runTag());
});
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  if (mapId) await readThenWriteRequestSetup(page.request, `/api/maps/${mapId}`, () => ({ method: "DELETE" }));
  if (projectId) await page.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
  await page.close();
  await closeAll([fresh]);
  await ground?.close();
});

/** Nothing on the page still rising in, and the pointer off every card. */
async function atRest(page: Page) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));
}

async function setTheme(page: Page, theme: "light" | "dark") {
  for (let i = 0; i < 2 && (await page.evaluate(() => document.documentElement.dataset.theme)) !== theme; i += 1) {
    await page.getByRole("button", { name: "Switch between dark and light theme" }).click();
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

type Rgb = [number, number, number];
async function meanOf(raw: { data: Buffer; info: { width: number; height: number; channels: number } }, area?: { left: number; top: number; width: number; height: number }): Promise<Rgb> {
  const { data, info } = raw;
  const a = area ?? { left: 0, top: 0, width: info.width, height: info.height };
  const sum = [0, 0, 0];
  for (let y = a.top; y < a.top + a.height; y += 1) for (let x = a.left; x < a.left + a.width; x += 1) {
    const o = (y * info.width + x) * info.channels;
    for (let c = 0; c < 3; c += 1) sum[c] += data[o + c];
  }
  const n = a.width * a.height;
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}
const apart = (a: Rgb, b: Rgb) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** The strip's foot as the screen shows it, against the stored file laid
 * out as the host lays it out (covering its box, centred): their largest
 * difference in any channel, 0 to 255. */
async function footDifference(page: Page, img: Locator): Promise<number> {
  await atRest(page);
  const box = (await img.boundingBox())!;
  const dpr = await page.evaluate(() => devicePixelRatio);
  const band = { x: box.x + 3, y: box.y + box.height * 0.86, width: box.width - 6, height: box.height * 0.1 };
  const shot = await page.screenshot({ clip: band, animations: "disabled" });
  const seen = await meanOf(await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true }));
  const src = await img.evaluate((el: HTMLImageElement) => el.currentSrc);
  const file = Buffer.from(await (await page.request.get(src)).body());
  const W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
  const laid = await sharp(file).resize(W, H, { fit: "cover", position: "centre" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const stored = await meanOf(laid, { left: Math.round(3 * dpr), top: Math.round(0.86 * H), width: W - Math.round(6 * dpr), height: Math.round(0.1 * H) });
  return apart(seen, stored);
}

/** No fade over a drawn picture: the mark is on, the strip draws no
 * overlay, the foot matches the file; for the map's own hosts, the control
 * too: the mark taken off brings the fade back over the same foot. */
async function expectNoFade(page: Page, img: Locator, what: string, control: boolean) {
  await expect(img, `${what}: the picture is drawn`).toHaveAttribute("data-loaded", "", { timeout: 30000 });
  await page.addStyleTag({ content: HIDE_WORDS });
  expect(await img.evaluate((el) => getComputedStyle(el.parentElement!, "::after").content), `${what}: no overlay over the picture`).toBe("none");
  const difference = await footDifference(page, img);
  expect(difference, `${what}: the foot as stored`).toBeLessThan(10);
  test.info().annotations.push({ type: "foot", description: `${what}: ${difference.toFixed(1)} of 255 from the stored file` });
  if (!control) return;
  await img.evaluate((el) => el.removeAttribute("data-loaded"));
  const faded = await footDifference(page, img);
  expect(faded, `${what}: the control, the fade back over the foot`).toBeGreaterThan(30);
  await page.reload();
}

const fixture = (page: Page) => page.locator(`img[src*="/api/maps/${mapId}/thumbnail?"]`);

test("no fade over a drawn map picture on the Maps card, Home's Continue card and a project's card; the count in the body", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/maps");
  await setTheme(page, "light");
  const card = page.locator("article").filter({ has: fixture(page) });
  await expectNoFade(page, card.locator("img"), "Maps card", true);
  const strip = (await card.locator("img").boundingBox())!;
  const count = (await card.locator("[data-layer-count]").boundingBox())!;
  expect(count.y, "the count stands under the picture, in the body").toBeGreaterThanOrEqual(strip.y + strip.height);
  await expect(card.locator("[data-layer-count]")).toHaveText(`${WORLD.length} layers`);

  await page.goto("/");
  await expect(page.locator("[data-lead] img")).toHaveAttribute("src", new RegExp(`/api/maps/${mapId}/thumbnail`));
  await expectNoFade(page, page.locator("[data-lead] img"), "Continue", true);

  await page.goto(`/projects/${projectId}`);
  await expectNoFade(page, page.locator('[data-sec-card="map"]').filter({ has: fixture(page) }).locator("img"), "a project's card", true);
});

test("no fade over a map template's picture on the Templates page, Home's shelf and Home's template lead", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/templates");
  await setTheme(page, "light");
  const pictures = page.locator("[data-template] img");
  await expect(pictures.first()).toBeVisible();
  for (let i = 0; i < (await pictures.count()); i += 1) await expectNoFade(page, pictures.nth(i), `Templates card ${i + 1}`, false);

  await page.goto("/");
  const shelf = page.locator('[data-shelf="shown"] [data-template] img');
  await expect(shelf.first()).toBeVisible();
  for (let i = 0; i < (await shelf.count()); i += 1) await expectNoFade(page, shelf.nth(i), `Home's shelf ${i + 1}`, false);

  const lead = await fresh!.context.newPage();
  await lead.setViewportSize({ width: 1440, height: 900 });
  await lead.goto("/");
  await expect(lead.locator('[data-lead="template"]')).toBeVisible();
  if ((await lead.locator('[data-lead="template"] img').count()) === 0) {
    test.info().annotations.push({ type: "template lead", description: "the first template draws a workflow's graph: no map picture to read" });
  } else {
    await expectNoFade(lead, lead.locator('[data-lead="template"] img'), "Home's template lead", false);
  }
  await lead.close();
});

/** WCAG contrast of two colours. */
function contrast(a: Rgb, b: Rgb) {
  const l = (c: Rgb) => {
    const [r, g, bl] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [l(a), l(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("a map template's place label reads at 4.5 to 1 or more over every shipped map template's picture, light and dark", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/templates");
  const labels: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const cards = page.locator("[data-template]").filter({ has: page.locator("img") });
    await expect(cards.first()).toBeVisible();
    for (let i = 0; i < (await cards.count()); i += 1) {
      const card = cards.nth(i);
      await expect(card.locator("img")).toHaveAttribute("src", new RegExp(`theme=${theme}`));
      await expect(card.locator("img")).toHaveAttribute("data-loaded", "", { timeout: 30000 });
      await atRest(page);
      const label = card.locator('[data-field="place"]');
      const box = (await label.boundingBox())!;
      // The words' own colour, as the browser resolves it.
      const words = await label.evaluate((el) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.fillStyle = getComputedStyle(el).color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)] as Rgb;
      });
      // The glass behind them: the label's padding, left of the words.
      const glass = await meanOf(await sharp(await page.screenshot({ clip: { x: box.x + 2, y: box.y + box.height / 2 - 3, width: 4, height: 6 } })).removeAlpha().raw().toBuffer({ resolveWithObject: true }));
      const ratio = contrast(words, glass);
      labels.push(`${theme} ${await card.getAttribute("data-template")}: ${ratio.toFixed(2)}`);
      expect(ratio, `${theme}, ${await card.getAttribute("data-template")}: the place label's contrast`).toBeGreaterThanOrEqual(4.5);
    }
  }
  test.info().annotations.push({ type: "label contrast", description: labels.join("; ") });
});

/** Home's own width. */
const homeWidth = (page: Page) => page.locator("[data-home]").evaluate((el) => el.getBoundingClientRect().width);
async function windowFor(page: Page, home: number): Promise<number> {
  let window = home + 160;
  for (let i = 0; i < 4; i += 1) {
    await page.setViewportSize({ width: window, height: 900 });
    const measured = await homeWidth(page);
    if (Math.abs(measured - home) < 0.01) return window;
    window += Math.round(home - measured);
  }
  throw new Error(`no window lays Home out ${home} px wide`);
}

/** The world fixture's marks in a host's picture, decoded from the
 * screen: the box is at least as wide as the picture's proportion, so the
 * picture spans it edge to edge, cropped only at its top and foot; the
 * prime meridian at 20 degrees north at the box's centre, the marks near
 * the 180th meridian at its two sides. */
async function expectWorldAcross(page: Page, img: Locator, what: string) {
  await expect(img, `${what}: the picture is drawn`).toHaveAttribute("data-loaded", "", { timeout: 30000 });
  await atRest(page);
  const box = (await img.boundingBox())!;
  const { frame } = PICTURE_SHAPE;
  expect(box.width / box.height, `${what}: the box keeps the picture's whole width`).toBeGreaterThanOrEqual(frame.width / frame.height - 0.005);
  const shot = await sharp(await page.screenshot({ clip: box })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = shot;
  const k = info.width / box.width;
  const at = (colour: readonly number[]) => {
    let x = 0, y = 0, n = 0;
    for (let row = 0; row < info.height; row += 1) for (let column = 0; column < info.width; column += 1) {
      const o = (row * info.width + column) * info.channels;
      if (colour.every((v, c) => Math.abs(data[o + c] - v) < 30)) { x += column + 0.5; y += row + 0.5; n += 1; }
    }
    expect(n, `${what}: colour ${colour} drawn`).toBeGreaterThanOrEqual(3);
    return { x: x / n / k, y: y / n / k };
  };
  const tolerance = Math.max(2, 2 * (box.width / frame.width));
  for (const point of WORLD.slice(0, 3)) {
    const mark = at(point.colour);
    const want = { x: box.width / 2 + (point.lng / 360) * box.width, y: box.height / 2 };
    expect(Math.abs(mark.x - want.x), `${what}: ${point.lng} degrees across the box`).toBeLessThan(tolerance);
    expect(Math.abs(mark.y - want.y), `${what}: 20 degrees north at the box's middle`).toBeLessThan(tolerance);
  }
}

test("a map wider than one world shows the world once, edge to edge, in the Continue card beside Start and in a Maps card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await setTheme(page, "light");
  await page.addStyleTag({ content: HIDE_WORDS });
  const lead = page.locator("[data-lead] img");
  await expect(lead).toHaveAttribute("src", new RegExp(`/api/maps/${mapId}/thumbnail`));
  for (const width of [1160, 1159, 968, "widest"] as const) {
    const window = width === "widest" ? 2400 : await windowFor(page, width);
    await page.setViewportSize({ width: window, height: 900 });
    await expectWorldAcross(page, lead, `Continue, Home ${await homeWidth(page)} px`);
  }
  for (const window of [1280, 1440]) {
    await page.setViewportSize({ width: window, height: 900 });
    await page.goto("/maps");
    await page.addStyleTag({ content: HIDE_WORDS });
    await expectWorldAcross(page, page.locator("article").filter({ has: fixture(page) }).locator("img"), `Maps card at ${window} px`);
  }
});
