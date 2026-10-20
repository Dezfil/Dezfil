import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { addLayer, createMap, patchLayer, patchMap, seedCsv } from "./support";
import { readThenWriteRequestSetup } from "./edit-basis";
import { waitForPicture } from "./picture-support";
import { closeAll, createMapWithLayer, createProject, invitePerson, PASSWORD, runTag, share, uploadSentinel, type Person } from "./sharing-support";
import { pictureBasemap } from "../test-support/picture-basemap";
import { pointStyle } from "../test-support/picture-pixels";
import { edgeRise, luminance } from "../test-support/edge-rise";
import { coveredWidth, PICTURE_SHAPES, shapeForBox, type PictureShape } from "../src/lib/pictures/shapes";

/**
 * Every card host shows a map picture as sharply as the screen allows, on
 * a production build: at one, two and three screen pixels per point, at
 * window widths on both sides of every layout and shape switch (found by
 * sweeping each page's widths and watching its hosts' boxes), and after a
 * resize and a browser zoom. For each picture of the fixture map on screen:
 * the shape suits its box; the image offers a size at least as large as
 * the screen area the picture covers and, at a whole density, the browser
 * took one, read from the file's own pixels; a straight edge of the
 * fixture rises from 10 to 90 percent within two screen pixels. A 692 pixel
 * picture enlarged and served in its place fails that bound wherever it
 * would cover at least twice its width. Where Home's Continue card is at
 * least as wide as the card's proportion, the fixture's outermost marks
 * are wholly inside it. The fade and the labels a host draws over the
 * picture are hidden while measuring: they are the host's, not the
 * picture's.
 *
 * Then the reads behind it: a page opened again receives none of the
 * picture bytes the browser holds (every read is answered 304), while a
 * reader who lost reach to a dataset the picture drew, and another
 * account signed in on the same browser, are refused the picture they
 * once held.
 *
 * Run against an isolated production instance with the renderer, the
 * loopback ground allowed (DEZFIL_EGRESS_ALLOWLIST=127.0.0.1), one worker:
 * npx playwright test e2e/picture-sharpness.spec.ts --project=chromium --workers=1
 */

const NAVY = [20, 50, 110] as const, ORANGE = [233, 90, 45] as const, MUSTARD = [200, 160, 20] as const;
/** The data: an edge polygon whose east side is the straight edge, and
 * the two outermost marks at the data's corners. */
const FIXTURE = [
  { name: "Edge", sql: "SELECT ST_MakeEnvelope(13.42, 0.006, 13.45, 0.024) AS geom", style: pointStyle(NAVY, 0) },
  { name: "North-west mark", sql: "SELECT ST_Point(13.40, 0.03) AS geom", style: pointStyle(ORANGE, 10) },
  { name: "South-east mark", sql: "SELECT ST_Point(13.50, 0.0) AS geom", style: pointStyle(MUSTARD, 10) },
];
const BASE_WIDTHS = [360, 414, 560, 641, 699, 701, 900, 1024, 1280, 1440, 1920, 2560];
const DENSITIES = [1, 2, 3];
const HIDE_HOST_CHROME = `
  :has(> img[src*="/thumbnail?"])::after, :has(> img[src*="/thumbnail?"])::before { content: none !important; }
  :has(> img[src*="/thumbnail?"]) > :not(img):not(svg) { visibility: hidden !important; }`;

type Host = "card" | "continue" | "recent" | "project picture" | "dialog";
interface Seen { host: Host; index: number; box: { x: number; y: number; width: number; height: number }; currentSrc: string; srcset: string | null }

let ground: Awaited<ReturnType<typeof pictureBasemap>>;
let mapId = "", projectId = "", table = "";
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  ground = await pictureBasemap();
  const page = await browser.newPage();
  await page.goto("/maps");
  table = (await seedCsv(page, `sharpness_${runTag()}`, "v,lon,lat\n1,13.4,0\n")).name;
  mapId = await createMap(page, "Sharpness fixture");
  for (const layer of FIXTURE) await patchLayer(page, await addLayer(page, mapId, layer.name, layer.sql), { style: layer.style });
  await patchMap(page, mapId, { viewport: { lng: 13.45, lat: 0.015, zoom: 11, pitch: 0, bearing: 0 }, customBasemap: { url: `${ground.origin}/plain.json`, name: "Sharpness ground", attribution: [{ label: "Fixture" }] } });
  projectId = await createProject({ api: page.request } as Person, `Sharpness ${runTag()}`, { addMaps: [mapId] });
  await waitForPicture(page.request, mapId);
  await page.close();
});
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  if (mapId) await readThenWriteRequestSetup(page.request, `/api/maps/${mapId}`, () => ({ method: "DELETE" }));
  await page.close();
  await ground?.close();
});

/** The pages that hold the hosts, each opened fresh. */
const PAGES: { name: string; open: (page: Page) => Promise<void> }[] = [
  { name: "Maps, grid", open: async page => { await page.goto("/maps"); await page.getByRole("button", { name: "Grid view" }).click(); } },
  { name: "Maps, list", open: async page => { await page.goto("/maps"); await page.getByRole("button", { name: "List view" }).click(); } },
  { name: "Home", open: async page => { await page.goto("/"); } },
  { name: "Project", open: async page => { await page.goto(`/projects/${projectId}`); } },
  { name: "Add to a map", open: async page => { await page.goto(`/tables/${table}`); await page.getByRole("button", { name: "Add to a map" }).first().click(); await expect(page.getByRole("dialog")).toBeVisible(); } },
];

const pictures = (page: Page) => page.locator(`img[src*="/api/maps/${mapId}/thumbnail?"]`);
/** The pixel width of the file the browser chose, read from the file
 * itself: an image offered by width reports its width divided by the
 * density the browser picked, not the file's. */
const fileWidths = new Map<string, number>();
async function fileWidth(page: Page, src: string): Promise<number> {
  if (!fileWidths.has(src)) {
    const response = await page.request.get(src);
    expect(response.status(), src).toBe(200);
    fileWidths.set(src, (await sharp(await response.body()).metadata()).width!);
  }
  return fileWidths.get(src)!;
}
/** Every picture of the fixture on the page, once each has loaded. */
async function seen(page: Page): Promise<Seen[]> {
  await expect.poll(() => pictures(page).evaluateAll(images => images.length > 0 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)), { timeout: 30000 }).toBe(true);
  return pictures(page).evaluateAll(images => images.map((element, index) => {
    const image = element as HTMLImageElement, rect = image.getBoundingClientRect();
    const host = image.closest("[data-lead='continue']") ? "continue" : image.closest("[data-recent-row]") ? "recent" : image.closest("[data-tile]") ? "project picture" : image.closest("[role='dialog']") ? "dialog" : "card";
    return { host, index, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, currentSrc: image.currentSrc, srcset: image.getAttribute("srcset") };
  })) as Promise<Seen[]>;
}

async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: data };
}
type Pixels = Awaited<ReturnType<typeof pixels>>;
const near = (image: Pixels, offset: number, colour: readonly number[], tolerance = 30) => colour.every((value, channel) => Math.abs(image.rgba[offset + channel] - value) < tolerance);
function colourBox(image: Pixels, colour: readonly number[]) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, count = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (!near(image, (y * image.width + x) * 4, colour)) continue;
    count++; left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
  }
  return { left, right, top, bottom, count };
}
/** The rise of the edge polygon's east side, along a row in its upper part,
 * in screen pixels; null when the polygon is drawn too small to measure. */
function eastEdgeRise(image: Pixels): number | null {
  const edge = colourBox(image, NAVY);
  if (edge.count < 40 || edge.right - edge.left < 8) return null;
  const row = Math.round(edge.top + (edge.bottom - edge.top) * 0.3);
  const middle = Math.round((edge.left + edge.right) / 2), end = Math.min(image.width - 1, edge.right + (edge.right - middle));
  const line: number[] = [];
  for (let x = middle; x <= end; x++) { const o = (row * image.width + x) * 4; line.push(luminance(image.rgba[o], image.rgba[o + 1], image.rgba[o + 2])); }
  return edgeRise(line);
}

/** The page at rest: a dialog's entrance and any transition finished, so
 * a picture is drawn at its own scale and not resampled mid-animation. */
async function atRest(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
}

/** The picture's box once the page is at rest, and the part of it a
 * person sees: its box cut by every ancestor that clips its content. */
async function boxes(page: Page, index: number) {
  const picture = pictures(page).nth(index);
  await picture.scrollIntoViewIfNeeded();
  await atRest(page);
  return picture.evaluate(element => {
    const own = element.getBoundingClientRect();
    let left = own.left, top = own.top, right = own.right, bottom = own.bottom;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const clip = parent.getBoundingClientRect();
      left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
    }
    return {
      box: { x: own.x, y: own.y, width: own.width, height: own.height },
      visible: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
    };
  });
}

/** Everything one picture on screen must hold. */
async function judge(page: Page, picture: Seen, where: string) {
  const dpr = await page.evaluate(() => devicePixelRatio);
  const { box, visible } = await boxes(page, picture.index);
  const shape: PictureShape = shapeForBox(box);
  const label = `${where}, ${picture.host} ${Math.round(box.width)}×${Math.round(box.height)} at ${dpr}`;
  const chosen = new URL(picture.currentSrc);
  expect(chosen.searchParams.get("shape"), `${label}: the shape for its box`).toBe(shape);
  const covers = coveredWidth(shape, box) * dpr;
  const offered = (picture.srcset ?? "").split(",").map(item => Number(item.trim().split(" ")[1]?.replace("w", "")));
  const widest = PICTURE_SHAPES[shape].widths.at(-1)!;
  expect(Math.max(...offered), `${label}: a size offered for ${Math.ceil(covers)} screen pixels`).toBeGreaterThanOrEqual(Math.min(widest, Math.floor(covers)));
  const taken = await fileWidth(page, picture.currentSrc);
  if (Number.isInteger(dpr)) expect(taken, `${label}: the file taken`).toBeGreaterThanOrEqual(Math.min(widest, Math.floor(covers) - 1));
  const shot = await pixels(await page.screenshot({ clip: visible }));
  const rise = eastEdgeRise(shot);
  if (rise !== null) expect(rise, `${label}: the edge's rise in screen pixels`).toBeLessThanOrEqual(2);
  if (picture.host === "continue" && visible.width / visible.height >= PICTURE_SHAPES.card.frame.width / PICTURE_SHAPES.card.frame.height) {
    const radius = (10 * coveredWidth(shape, box) / PICTURE_SHAPES[shape].frame.width) * dpr;
    for (const colour of [ORANGE, MUSTARD]) {
      const mark = colourBox(shot, colour);
      const seenAs = `seen ${shot.width}×${shot.height} of box ${JSON.stringify(box)} visible ${JSON.stringify(visible)}, mark ${JSON.stringify(mark)}`;
      expect(mark.left > 0 && mark.top > 0 && mark.right < shot.width && mark.bottom < shot.height, `${label}: mark ${colour} inside the card (${seenAs})`).toBe(true);
      expect(mark.count, `${label}: mark ${colour} drawn whole`).toBeGreaterThan(0.6 * Math.PI * radius * radius);
    }
  }
  return { label, covers, taken, rise };
}

async function hideHostChrome(page: Page) { await page.addStyleTag({ content: HIDE_HOST_CHROME }); }

/** The widths on both sides of each place a host's box jumps or its shape changes. */
async function switchesOf(page: Page, open: (page: Page) => Promise<void>): Promise<number[]> {
  await page.setViewportSize({ width: 360, height: 900 });
  await open(page);
  await seen(page);
  const found: number[] = [];
  let last: { width: number; boxes: Seen["box"][] } | null = null;
  for (let width = 360; width <= 2560; width += 20) {
    await page.setViewportSize({ width, height: 900 });
    const boxes = await pictures(page).evaluateAll(images => images.map(image => { const r = image.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    if (last && boxes.length === last.boxes.length) {
      const jumped = boxes.some((box, i) => {
        const before = last!.boxes[i];
        return Math.abs(box.width - before.width) > 0.15 * before.width || Math.abs(box.height - before.height) > 0.15 * before.height || shapeForBox(box) !== shapeForBox(before);
      });
      if (jumped) found.push(last.width + 2, width - 2);
    } else if (last) found.push(last.width + 2, width - 2);
    last = { width, boxes };
  }
  return found;
}

for (const { name, open } of PAGES) {
  test(`${name}: every picture sharp at each density, on both sides of every switch`, async ({ browser }) => {
    test.setTimeout(30 * 60_000);
    const sweep = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 360, height: 900 } });
    const widths = [...new Set([...BASE_WIDTHS, ...(await switchesOf(await sweep.newPage(), open))])].sort((a, b) => a - b);
    await sweep.close();
    const record: unknown[] = [];
    for (const dpr of DENSITIES) {
      const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: widths[0], height: 900 } });
      const page = await context.newPage();
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await open(page);
        await hideHostChrome(page);
        for (const picture of await seen(page)) record.push(await judge(page, picture, `${name} at ${width}`));
      }
      await context.close();
    }
    if (name === "Home") expect(record.some(entry => (entry as { label: string }).label.includes(", continue ")), "the fixture leads Home's Continue card").toBe(true);
    await test.info().attach(`${name} measurements`, { body: JSON.stringify({ widths, record }, null, 1), contentType: "application/json" });
  });
}

test("after a resize and a browser zoom, Home's pictures follow their boxes", async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 900, height: 900 } });
  const page = await context.newPage();
  await page.goto("/");
  await hideHostChrome(page);
  for (const picture of await seen(page)) await judge(page, picture, "Home at 900");
  await page.setViewportSize({ width: 1700, height: 900 });
  // The strip measures again on its resize, and the browser takes the new offer.
  await page.waitForTimeout(500);
  for (const picture of await seen(page)) await judge(page, picture, "Home resized to 1700");
  // A browser zoom of 125 percent: more screen pixels per point, fewer points across.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 720, deviceScaleFactor: 2.5, mobile: false });
  await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(2.5);
  await page.waitForTimeout(500);
  for (const picture of await seen(page)) await judge(page, picture, "Home zoomed to 125 percent");
  await context.close();
});

test("a 692 pixel picture enlarged in place fails the sharpness bound where it covers twice its width", async ({ browser }) => {
  const controls: string[] = [];
  for (const dpr of [2, 3]) {
    const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1920, height: 900 } });
    const page = await context.newPage();
    const small = await (await page.request.get(`/api/maps/${mapId}/thumbnail`)).body();
    await context.route(url => url.pathname === `/api/maps/${mapId}/thumbnail` && url.searchParams.has("shape"), route => route.fulfill({ status: 200, contentType: "image/png", body: small }));
    for (const { name, open } of PAGES) {
      await open(page);
      await hideHostChrome(page);
      for (const picture of await seen(page)) {
        const { box, visible } = await boxes(page, picture.index);
        const covers = coveredWidth(shapeForBox(box), box) * dpr;
        if (covers < 2 * 692) continue;
        const rise = eastEdgeRise(await pixels(await page.screenshot({ clip: visible })));
        expect(rise, `${name} ${picture.host} at ${dpr}: the enlarged picture's edge`).not.toBeNull();
        expect(rise!).toBeGreaterThan(2);
        controls.push(`${name} ${picture.host} at ${dpr}: ${rise!.toFixed(2)}`);
      }
    }
    await context.close();
  }
  expect(controls.length, "some host covers twice 692 pixels").toBeGreaterThan(0);
  await test.info().attach("controls", { body: controls.join("\n"), contentType: "text/plain" });
});

test("a page opened again receives none of the picture bytes the browser holds", async ({ page }) => {
  await page.goto("/maps");
  await seen(page);
  const answers: { status: number; asked: boolean }[] = [];
  page.on("response", response => {
    if (response.url().includes(`/api/maps/${mapId}/thumbnail?`)) answers.push({ status: response.status(), asked: !!response.request().headers()["if-none-match"] });
  });
  await page.goto("/maps");
  await seen(page);
  expect(answers.length).toBeGreaterThan(0);
  expect(answers).toEqual(answers.map(() => ({ status: 304, asked: true })));
});

test("a reader who lost reach, and another account on the same browser, are refused the picture they held", async ({ browser, baseURL }) => {
  const tag = runTag();
  const admin = await browser.newContext();
  let owner: Person | undefined, viewer: Person | undefined, stranger: Person | undefined;
  try {
    owner = await invitePerson(browser, admin.request, baseURL!, "Owner", tag);
    viewer = await invitePerson(browser, admin.request, baseURL!, "Viewer", tag);
    stranger = await invitePerson(browser, admin.request, baseURL!, "Stranger", tag);
    const dataset = await uploadSentinel(owner, `points_${tag}`, "sharpness");
    const map = await createMapWithLayer(owner, `Held ${tag}`, [{ name: "Points", sql: `SELECT * FROM ${dataset.name}` }]);
    const read = await owner.api.get(`/api/maps/${map.id}`);
    await owner.api.patch(`/api/maps/${map.id}`, { data: { customBasemap: { url: `${ground.origin}/plain.json`, name: "Sharpness ground", attribution: [{ label: "Fixture" }] } }, headers: { "x-edit-revision": (await read.json()).editRevision } });
    const mapProject = await createProject(owner, `Held maps ${tag}`, { addMaps: [map.id] });
    const dataProject = await createProject(owner, `Held data ${tag}`, { addTables: [dataset.id] });
    await share(owner, mapProject, viewer, "viewer");
    await share(owner, dataProject, viewer, "viewer");
    await waitForPicture(owner.api, map.id);
    const held = async (person: Person, path: string) => {
      const page = await person.context.newPage();
      await page.goto(path);
      const image = page.locator(`img[src*="/api/maps/${map.id}/thumbnail?"]`).first();
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      return { page, url: await image.evaluate(element => (element as HTMLImageElement).currentSrc) };
    };
    // Lost reach to the dataset the picture drew: the held address is refused.
    const viewing = await held(viewer, `/projects/${mapProject}`);
    expect(await viewing.page.evaluate(async url => (await fetch(url)).status, viewing.url)).toBe(200);
    expect((await owner.api.delete(`/api/projects/${dataProject}/people/${viewer.sqlName}`)).status()).toBe(200);
    expect(await viewing.page.evaluate(async url => (await fetch(url)).status, viewing.url)).toBe(404);
    await viewing.page.close();
    // Another account signed in on the same browser: refused too.
    const owning = await held(owner, "/maps");
    expect((await owner.api.post("/api/auth/sign-out")).ok()).toBe(true);
    expect((await owner.api.post("/api/auth/sign-in", { data: { email: stranger.email, password: PASSWORD } })).status()).toBe(200);
    expect(await owning.page.evaluate(async url => (await fetch(url)).status, owning.url)).toBe(404);
  } finally {
    await closeAll([owner, viewer, stranger]);
    await admin.close();
  }
});
