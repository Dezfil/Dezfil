// What a map's card shows while its picture is made on the server, in every
// host of the card and in both themes: the Maps gallery as a grid and as a
// list, Home, the Projects gallery as a grid and as a list, a project's home
// as cards and as a list, an empty project's recent rows and the add-to-map
// dialog. A card whose picture waits shows the last picture its viewer may
// be served, or today's placeholder when there is none; a failed picture
// leaves the same; a picture that fails to load in the browser shows the
// placeholder. A page with a waiting card asks its listing again every five
// seconds, one ask at a time, stops once none waits or the page leaves, and
// the newer picture lands on the card without a reload. A data-only change
// gets a picture address of its own, so the next listing shows it whatever
// the browser keeps under the older address: the older picture, when the
// instance lets it keep pictures, or nothing, when it does not. With
// no renderer the listing says unavailable, nothing asks again, System reads
// Not found, and administrators, and nobody else, see one line at the foot
// of each card page.
//
// Provisioning: two isolated production standalones from one build, neither
// on the development port, each with its own scratch data directory.
//
// - DEZFIL_BASE_URL: the instance the migrated theme suite runs on, set up
//   as docs/operate/runbook.md "Map picture proofs" describes: a real image
//   renderer, the style fixture preload with DEZFIL_PICTURE_STYLE_FIXTURE=1,
//   a data directory whose name includes `pictures-`, and Images at once at
//   its default.
// - DEZFIL_NO_RENDERER_URL: the same standalone launched the same way, with
//   its preloads, on another port and data directory, with
//   DEZFIL_CHROMIUM_PATH naming a file that does not exist and no style
//   fixture. Without it the no-renderer test is skipped, visibly, and that
//   skip is not evidence.
//
// The pixel baselines, the waiting placeholder in every host and theme and
// the administrators' line on every card page in both themes, are cut on
// the first run on these instances with --update-snapshots=missing, looked
// at, and kept beside this spec. Later runs compare against them.
//
//   DEZFIL_BASE_URL=http://127.0.0.1:3581 DEZFIL_NO_RENDERER_URL=http://127.0.0.1:3583 \
//     npx playwright test e2e/card-states.spec.ts --project=chromium
//
// Left to the server suite, which runs them under a clock it controls: the
// retry schedule, the count of attempts after a quiet period, and that
// nothing is launched for an hour without a renderer.
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import {
  FIXTURES_DIR,
  LOCAL_HOSTNAMES,
  consumeExpected,
  routeHouse,
  trackConsole,
  type ConsoleError,
} from "./support";
import { readThenWriteRequestSetup } from "./edit-basis";
import { waitForPicture } from "./picture-support";
import { invitePerson, runTag, type Person } from "./sharing-support";
import { isAllowedConsoleError } from "./console-allowlist";
import { captureBasis } from "../scripts/revision-fixtures.mjs";
import { browserAccount, provisionJourney } from "../scripts/journey-auth.mjs";

test.beforeEach(async ({ baseURL }) => {
  if (!baseURL || new URL(baseURL).port === "3000") throw new Error("Use an isolated instance with the picture style fixture preload.");
});

const runId = Date.now().toString(36);
const NO_RENDERER = process.env.DEZFIL_NO_RENDERER_URL;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/** The marks' fill, which a decoded picture is searched for. */
const KELP = [26, 93, 74] as const;
const VIEW = { lng: 13.4, lat: 52.52, zoom: 10, pitch: 0, bearing: 0 };
/** Today's placeholder: the chart paper every card strip draws under its picture. */
const PLACEHOLDER = 'svg[viewBox="0 0 320 190"]';
const NOTICE = "No map pictures: this instance has no renderer. Settings · System says how to set one.";
const STATIONS = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");

const kelp = { r: KELP[0], g: KELP[1], b: KELP[2], a: 1 };
const styleOf = (pointRadius: number) => ({
  fill: { type: "constant", color: kelp },
  fillOpacity: 1,
  stroke: kelp,
  strokeOpacity: 1,
  strokeWidth: 0,
  pointRadius,
  opacity: 1,
});

// ---- the API, as the fixture's people use it ----

interface Probe {
  id: string;
  name: string;
  layerId: string;
}

interface Listed {
  id: string;
  name: string;
  pictureState: string;
  pictureVersion: string | null;
  hasThumbnail: boolean;
}

async function listing(api: APIRequestContext): Promise<Listed[]> {
  const response = await api.get("/api/maps");
  expect(response.status()).toBe(200);
  return response.json();
}

async function listed(api: APIRequestContext, map: Probe): Promise<Listed | undefined> {
  return (await listing(api)).find((row) => row.id === map.id);
}

async function expectState(api: APIRequestContext, map: Probe, state: string, timeout = 60_000) {
  await expect
    .poll(async () => (await listed(api, map))?.pictureState, { timeout, message: `${map.name} reads ${state}` })
    .toBe(state);
}

/** Nothing the fixture's account lists waits for its picture, so a page
 * of its cards has nothing to ask about. */
async function noneWaiting(api: APIRequestContext) {
  await expect
    .poll(async () => (await listing(api)).filter((row) => row.pictureState === "waiting").map((row) => row.name), {
      timeout: 120_000,
      message: "no listed map waits",
    })
    .toEqual([]);
}

async function upload(api: APIRequestContext, name: string, csv: string): Promise<string> {
  const response = await api.post("/api/tables", {
    multipart: { file: { name: `${name}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) } },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).name;
}

async function createProject(api: APIRequestContext, name: string): Promise<string> {
  const response = await api.post("/api/projects", { data: { name } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).id;
}

async function addLayer(api: APIRequestContext, mapId: string, name: string, sql: string): Promise<string> {
  const added = await readThenWriteRequestSetup(api, `/api/maps/${mapId}`, () => ({
    method: "POST",
    path: `/api/maps/${mapId}/layers`,
    options: { data: { name, sql } },
  }));
  expect(added.status(), await added.text()).toBe(201);
  return (await added.json()).id;
}

async function styleLayer(api: APIRequestContext, layerId: string, pointRadius: number) {
  const styled = await readThenWriteRequestSetup(api, `/api/layers/${layerId}`, () => ({
    method: "PATCH",
    options: { data: { style: styleOf(pointRadius) } },
  }));
  expect(styled.status(), await styled.text()).toBe(200);
}

/** A map of one kelp layer under a fixed camera, filed in a project when
 * one is named. Every step is a drawing change, so the server's first
 * attempt comes five seconds after the last of them. */
async function seedMap(api: APIRequestContext, name: string, sql: string, projectId?: string): Promise<Probe> {
  const created = await api.post("/api/maps", { data: projectId ? { name, projectId } : { name } });
  expect(created.status(), await created.text()).toBe(201);
  const id: string = (await created.json()).id;
  const layerId = await addLayer(api, id, "Stations", sql);
  await styleLayer(api, layerId, 12);
  const camera = await readThenWriteRequestSetup(api, `/api/maps/${id}`, () => ({
    method: "PATCH",
    options: { data: { viewport: VIEW } },
  }));
  expect(camera.status(), await camera.text()).toBe(200);
  return { id, name, layerId };
}

async function editRevision(api: APIRequestContext, map: Probe): Promise<string> {
  const read = await api.get(`/api/maps/${map.id}`);
  expect(read.status()).toBe(200);
  return captureBasis(await read.json()).editRevision;
}

async function deleteMap(api: APIRequestContext, map: Probe) {
  const deleted = await readThenWriteRequestSetup(api, `/api/maps/${map.id}`, () => ({ method: "DELETE" }));
  expect(deleted.status()).toBe(204);
}

/** A layer that draws until a moment just ahead and fails from then on. It
 * is accepted before that moment, and the server's attempt, five quiet
 * seconds after it, comes after. */
async function addExpiringLayer(api: APIRequestContext, map: Probe) {
  const failAt = Date.now() + 4_000;
  await addLayer(
    api,
    map.id,
    "Expiring",
    `SELECT ST_Point(13.4, 52.52) AS geom, CASE WHEN epoch_ms(current_timestamp) > ${failAt} THEN error('The fixture expired.') ELSE 1 END AS value`,
  );
  expect(Date.now(), "the expiring layer was accepted before it expired").toBeLessThan(failAt);
}

/** Keeps a map's picture waiting: a drawing change every two seconds
 * restarts the server's five-second quiet period before any attempt. Each
 * change is a radius not drawn before, so the drawing never lands back on
 * a picture already made. `stop` ends it and reports a change that was
 * refused; `halt` only ends it, for a test already failing. */
let radius = 12;
function keepWaiting(api: APIRequestContext, map: Probe) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      radius = Math.round((radius + 0.1) * 10) / 10;
      await styleLayer(api, map.layerId, radius);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  })();
  loop.catch(() => {});
  return {
    stop: async () => {
      stopped = true;
      await loop;
    },
    halt: () => {
      stopped = true;
    },
  };
}

async function setGeometry(api: APIRequestContext, table: string, columns: string[]) {
  const address = `/api/tables/${encodeURIComponent(table)}/geometry`;
  const inspected = await api.get(address);
  expect(inspected.status(), await inspected.text()).toBe(200);
  const { revision } = await inspected.json();
  const set = await api.put(address, {
    data: { expectedRevision: revision, choice: { format: "pair", columns, epsg: 4326 } },
  });
  expect(set.status(), await set.text()).toBe(200);
}

// ---- the page's asks of its maps listing ----

interface Ask {
  at: number;
  done?: number;
}

interface ListingWatch {
  after(from: number): Ask[];
}

/** Every ask the page makes of a maps listing (the workspace's or a
 * project's), with when it started and when it was answered. Reads made
 * through the test's own request context are not the page's and are not
 * seen. */
function watchListing(page: Page): ListingWatch {
  const asks: Ask[] = [];
  const open = new Map<Request, Ask>();
  const isListing = (request: Request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/maps";
  page.on("request", (request) => {
    if (!isListing(request)) return;
    const ask: Ask = { at: Date.now() };
    asks.push(ask);
    open.set(request, ask);
  });
  const close = (request: Request) => {
    const ask = open.get(request);
    if (!ask) return;
    ask.done = Date.now();
    open.delete(request);
  };
  page.on("requestfinished", close);
  page.on("requestfailed", close);
  return { after: (from) => asks.filter((ask) => ask.at >= from) };
}

/** The page asks again on its own, twice in a row, the next ask five
 * seconds after the last was answered and never beside it. */
async function expectPaced(watch: ListingWatch, label: string) {
  const from = Date.now();
  await expect
    .poll(() => watch.after(from).filter((ask) => ask.done !== undefined).length, {
      timeout: 20_000,
      message: `${label} asks its listing again while a card waits`,
    })
    .toBeGreaterThanOrEqual(2);
  const asks = watch.after(from);
  for (let i = 1; i < asks.length; i += 1) {
    if (asks[i - 1].done === undefined) break;
    expect(asks[i].at - asks[i - 1].done!, `${label}: an ask starts five seconds after the last answer, never beside it`).toBeGreaterThanOrEqual(4_500);
  }
}

async function expectNoAsks(page: Page, watch: ListingWatch, label: string, ms = 12_000) {
  const from = Date.now();
  await page.waitForTimeout(ms);
  expect(watch.after(from), `${label} asks nothing`).toEqual([]);
}

/** Once the news is out, the page takes it at its next ask, at most one
 * more, and then asks nothing. */
async function expectStopsAsking(page: Page, watch: ListingWatch, label: string) {
  const from = Date.now();
  await page.waitForTimeout(7_000);
  const last = watch.after(from).at(-1);
  if (last) await expect.poll(() => last.done !== undefined).toBe(true);
  await expectNoAsks(page, watch, label);
}

// ---- the hosts ----

interface Places {
  project: string;
  empty: string;
  table: string;
}

interface Host {
  name: string;
  path: (places: Places) => string;
  /** The view to choose, and whether the page keeps the choice in the
   * person's settings. */
  view?: { label: "Grid view" | "List view"; saved: boolean };
  dialog?: true;
}

// A list before its grid, so every saved view ends as the grid.
const HOSTS: Host[] = [
  { name: "maps-list", path: () => "/maps", view: { label: "List view", saved: true } },
  { name: "maps-grid", path: () => "/maps", view: { label: "Grid view", saved: true } },
  { name: "home", path: () => "/" },
  { name: "projects-list", path: () => "/projects", view: { label: "List view", saved: true } },
  { name: "projects-grid", path: () => "/projects", view: { label: "Grid view", saved: true } },
  { name: "project-list", path: (p) => `/projects/${p.project}`, view: { label: "List view", saved: false } },
  { name: "project-cards", path: (p) => `/projects/${p.project}`, view: { label: "Grid view", saved: false } },
  { name: "empty-project", path: (p) => `/projects/${p.empty}` },
  { name: "add-to-map", path: (p) => `/tables/${encodeURIComponent(p.table)}`, dialog: true },
];
const MAPS_GRID = HOSTS[1];

/** A map's card on the page: by its name, or a project's tile for it. */
const cardOf = (page: Page, map: Probe) =>
  page.locator(`[data-tile][data-id="${map.id}"]`).or(page.getByText(map.name, { exact: true })).first();

const themeOf = (page: Page) =>
  page.evaluate(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));

/** Sets the theme with the page's own toggle. A press the page was not yet
 * ready to take is pressed again. */
async function ensureTheme(page: Page, theme: Theme) {
  const toggle = page.getByRole("button", { name: "Switch between dark and light theme" });
  await expect(async () => {
    if ((await themeOf(page)) !== theme) await toggle.click();
    await expect.poll(() => themeOf(page), { timeout: 2_000 }).toBe(theme);
  }).toPass({ timeout: 15_000 });
}

async function chooseView(page: Page, label: string, saved: boolean) {
  const group = page.getByRole("group", { name: "View" });
  const button = group.getByRole("button", { name: label, exact: true });
  // The saved view has been read once one button is on.
  await expect(group.locator("button[data-on]")).toHaveCount(1);
  if ((await button.getAttribute("data-on")) !== null) return;
  const kept = saved
    ? page.waitForResponse((r) => new URL(r.url()).pathname === "/api/settings" && r.request().method() === "PATCH")
    : null;
  await button.click();
  await expect(button).toHaveAttribute("data-on", "true");
  if (kept) expect((await kept).ok()).toBe(true);
}

/** Opens the host in the theme with the map's card on it. The theme is set
 * once the page has drawn its cards, and before a dialog covers it. */
async function visit(page: Page, host: Host, places: Places, theme: Theme, map: Probe) {
  await page.goto(host.path(places));
  if (host.dialog) {
    const open = page.getByRole("button", { name: "Add to a map" });
    await expect(open).toBeVisible();
    await ensureTheme(page, theme);
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      if (!(await dialog.isVisible())) await open.click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
  } else {
    await expect(cardOf(page, map)).toBeVisible();
    await ensureTheme(page, theme);
    if (host.view) await chooseView(page, host.view.label, host.view.saved);
  }
  await expect(cardOf(page, map)).toBeVisible();
  await page.mouse.move(0, 0);
}

/** Marks each picture strip of the map's cards on the page: the element
 * that holds the placeholder and the picture over it, in the card naming
 * the map or in a project's tile for it. A card climbs to its own strip
 * only; a climb that reaches more than one strip has left the card. */
async function markStrips(page: Page, map: Probe): Promise<Locator> {
  const marked = await page.evaluate(
    ({ id, name, placeholder }) => {
      for (const old of document.querySelectorAll(`[data-probe-strip="${id}"]`)) old.removeAttribute("data-probe-strip");
      const starts = [
        ...document.querySelectorAll(`[data-tile][data-id="${id}"]`),
        ...[...document.querySelectorAll("body *")].filter(
          (el) => el.childElementCount === 0 && el.textContent?.trim() === name,
        ),
      ];
      let count = 0;
      for (const start of starts) {
        let card: Element | null = start;
        while (card && card.querySelectorAll(placeholder).length === 0) card = card.parentElement;
        const strips = card?.querySelectorAll(placeholder);
        if (!strips || strips.length !== 1) continue;
        strips[0].parentElement!.setAttribute("data-probe-strip", id);
        count += 1;
      }
      return count;
    },
    { id: map.id, name: map.name, placeholder: PLACEHOLDER },
  );
  expect(marked, `${map.name}'s card pictures on ${page.url()}`).toBeGreaterThan(0);
  return page.locator(`[data-probe-strip="${map.id}"]`);
}

/** A dialog stands centred, so its place moves by half a pixel with its
 * height, and its height with how many maps the store holds. Before its
 * strip is pictured, the dialog is moved by that fraction onto whole
 * pixels, so the capture has one size and one drawing however many maps
 * there are. */
async function onWholePixels(page: Page, strip: Locator) {
  // Measured once the dialog has come in, not while it still moves.
  await page.getByRole("dialog").evaluate((dialog) =>
    Promise.all(
      dialog
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
  const box = await strip.boundingBox();
  expect(box, "the strip is laid out").not.toBeNull();
  const shift = { x: Math.round(box!.x) - box!.x, y: Math.round(box!.y) - box!.y };
  await page.getByRole("dialog").evaluate((dialog: HTMLElement, { x, y }) => {
    dialog.style.translate = `${x}px ${y}px`;
  }, shift);
  const moved = await strip.boundingBox();
  expect(
    [moved!.x, moved!.y].map((v) => Math.abs(v - Math.round(v)) < 0.01),
    "the strip stands on whole pixels",
  ).toEqual([true, true]);
}

const addressed = (src: string | null) => {
  const query = new URL(src ?? "", "http://card.test").searchParams;
  return { version: query.get("v"), theme: query.get("theme") };
};

const loaded = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;

/** Every card of the map shows today's placeholder and no picture. */
async function expectPlaceholder(page: Page, map: Probe): Promise<Locator> {
  let strips!: Locator;
  await expect(async () => {
    strips = await markStrips(page, map);
    for (const strip of await strips.all()) {
      await expect(strip.locator(PLACEHOLDER)).toBeVisible({ timeout: 1_000 });
      await expect(strip.locator("img")).toHaveCount(0, { timeout: 1_000 });
    }
  }).toPass({ timeout: 20_000 });
  return strips;
}

/** Every card of the map shows this version of its picture, in the theme,
 * loaded. */
async function expectPicture(page: Page, map: Probe, version: string | null, theme: Theme) {
  expect(version, `${map.name} has a picture to show`).not.toBeNull();
  await expect(async () => {
    const strips = await markStrips(page, map);
    for (const strip of await strips.all()) {
      const img = strip.locator("img");
      await expect(img).toHaveCount(1, { timeout: 1_000 });
      expect(addressed(await img.getAttribute("src"))).toEqual({ version, theme });
      expect(await img.evaluate(loaded)).toBe(true);
    }
  }).toPass({ timeout: 20_000 });
}

/** Waits, on the open page, for every card of the map to show a picture
 * other than `previous`, and answers its version. */
async function expectNewPicture(page: Page, map: Probe, previous: string | null, theme: Theme): Promise<string> {
  let version = "";
  await expect(async () => {
    const strips = await markStrips(page, map);
    for (const strip of await strips.all()) {
      const img = strip.locator("img");
      await expect(img).toHaveCount(1, { timeout: 1_000 });
      const shown = addressed(await img.getAttribute("src"));
      expect(shown.version).not.toBeNull();
      expect(shown.version).not.toBe(previous);
      expect(shown.theme).toBe(theme);
      expect(await img.evaluate(loaded)).toBe(true);
      version = shown.version!;
    }
  }).toPass({ timeout: 90_000, intervals: [1_000] });
  return version;
}

/** A mark on the document, so a reload, which would lose it, shows. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __cardStates?: number }).__cardStates = 1;
  });
}

async function expectSameDocument(page: Page) {
  expect(
    await page.evaluate(() => (window as unknown as { __cardStates?: number }).__cardStates),
    "the page was not reloaded",
  ).toBe(1);
}

interface Marks {
  marks: number;
  /** Where the marks sit across the picture, as a share of its width. */
  cx: number;
}

/** The marks in a picture: in the image the card shows, decoded off the
 * element itself, or in the copy the browser holds for that address, read
 * from its cache without asking the server. Null when there is no such
 * image or copy. The workspace's own fetch asks every read of the instance
 * afresh, so the cache is read with the fetch of a blank frame of the
 * page's own origin. */
async function marksOf(page: Page, src: string, from: "card" | "cache"): Promise<Marks | null> {
  return page.evaluate(
    async ({ src, from, kelp }) => {
      let source: CanvasImageSource;
      let width: number;
      let height: number;
      if (from === "cache") {
        const frame = document.createElement("iframe");
        frame.hidden = true;
        document.body.appendChild(frame);
        try {
          const response = await frame
            .contentWindow!.fetch(new URL(src, location.href).href, { cache: "only-if-cached", mode: "same-origin" })
            .catch(() => null);
          if (!response?.ok) return null;
          const bitmap = await createImageBitmap(new Blob([await response.arrayBuffer()]));
          [source, width, height] = [bitmap, bitmap.width, bitmap.height];
        } finally {
          frame.remove();
        }
      } else {
        const shown = [...document.images].find((img) => img.getAttribute("src") === src);
        if (!shown || !shown.complete || shown.naturalWidth === 0) return null;
        [source, width, height] = [shown, shown.naturalWidth, shown.naturalHeight];
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.drawImage(source, 0, 0);
      const { data } = context.getImageData(0, 0, width, height);
      let marks = 0;
      let sx = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          if (Math.abs(data[i] - kelp[0]) <= 24 && Math.abs(data[i + 1] - kelp[1]) <= 24 && Math.abs(data[i + 2] - kelp[2]) <= 24) {
            marks += 1;
            sx += x;
          }
        }
      }
      return { marks, cx: marks ? sx / marks / width : 0 };
    },
    { src, from, kelp: [...KELP] },
  );
}

/** The map's card on the Maps gallery shows this version, and what its
 * picture holds. */
async function shownMarks(page: Page, map: Probe, version: string | null) {
  await expectPicture(page, map, version, "light");
  const src = await (await markStrips(page, map)).first().locator("img").getAttribute("src");
  const marks = await marksOf(page, src!, "card");
  expect(marks, "the card's picture decodes").not.toBeNull();
  return { src: src!, ...marks! };
}

function expectQuietConsole(errors: ConsoleError[]) {
  expect(errors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
}

test.describe("card states with a renderer", () => {
  test.beforeEach(async ({ page }) => {
    const system = await page.request.get("/api/instance/settings");
    expect(system.status(), "the browser fixture reads System as an administrator").toBe(200);
    expect(
      (await system.json()).parts.image_renderer.available,
      "DEZFIL_BASE_URL points at an instance with an image renderer",
    ).toBe(true);
  });

  test("a card waiting for its first picture shows the placeholder in every host and theme, asks every five seconds one ask at a time, stops when its page leaves, and takes the picture without a reload", async ({
    page,
    context,
  }) => {
    test.setTimeout(600_000);
    await routeHouse(context);
    const errors = trackConsole(page);
    const asks = watchListing(page);
    const api = page.request;
    const table = await upload(api, `cs_first_${runId}`, STATIONS);
    const project = await createProject(api, `First picture home ${runId}`);
    const empty = await createProject(api, `First picture empty ${runId}`);
    const places = { project, empty, table };
    const map = await seedMap(api, `First picture ${runId}`, `SELECT * FROM "${table}"`, project);
    const waiting = keepWaiting(api, map);
    try {
      await expectState(api, map, "waiting");
      expect((await listed(api, map))?.pictureVersion, "the map has had no picture yet").toBeNull();
      for (const theme of THEMES) {
        for (const host of HOSTS) {
          await test.step(`${host.name}, ${theme}`, async () => {
            await visit(page, host, places, theme, map);
            const strips = await expectPlaceholder(page, map);
            if (host.dialog) await onWholePixels(page, strips.first());
            await expect(strips.first()).toHaveScreenshot(`waiting-${host.name}-${theme}.png`);
            await expect(page.locator("[data-renderer-notice]")).toHaveCount(0);
            if (theme === "light") await expectPaced(asks, host.name);
          });
        }
      }

      await test.step("the gallery left within the page asks nothing more", async () => {
        await visit(page, MAPS_GRID, places, "light", map);
        await markDocument(page);
        await page.locator('nav[aria-label="Product navigation"]').getByRole("link", { name: "Connections" }).click();
        await expect(page).toHaveURL(/\/connections$/);
        await expectSameDocument(page);
        await expectNoAsks(page, asks, "a page without cards, after the gallery left");
        await expectState(api, map, "waiting");
      });

      await visit(page, MAPS_GRID, places, "light", map);
      await expectPlaceholder(page, map);
      await markDocument(page);
      await waiting.stop();
    } finally {
      waiting.halt();
    }

    await test.step("the first picture lands on the open gallery without a reload, and the asking stops", async () => {
      const version = await expectNewPicture(page, map, null, "light");
      await expectSameDocument(page);
      expect((await listed(api, map))?.pictureVersion).toBe(version);
      await noneWaiting(api);
      await expectNoAsks(page, asks, "the gallery once nothing on it waits");
    });
    expectQuietConsole(errors);
  });

  test("a card waiting for a newer picture keeps the previous one in every host and theme, and takes the newer one there without a reload", async ({
    page,
    context,
  }) => {
    test.setTimeout(900_000);
    await routeHouse(context);
    const errors = trackConsole(page);
    const asks = watchListing(page);
    const api = page.request;
    const table = await upload(api, `cs_newer_${runId}`, STATIONS);
    const project = await createProject(api, `Newer picture home ${runId}`);
    const empty = await createProject(api, `Newer picture empty ${runId}`);
    const places = { project, empty, table };
    const map = await seedMap(api, `Newer picture ${runId}`, `SELECT * FROM "${table}"`, project);
    let shown = (await waitForPicture(api, map.id)).pictureVersion;

    for (const host of HOSTS) {
      await test.step(host.name, async () => {
        const waiting = keepWaiting(api, map);
        try {
          await expectState(api, map, "waiting");
          for (const theme of ["dark", "light"] as const) {
            await visit(page, host, places, theme, map);
            await expectPicture(page, map, shown, theme);
          }
          await markDocument(page);
          await waiting.stop();
        } finally {
          waiting.halt();
        }
        const next = await expectNewPicture(page, map, shown, "light");
        await expectSameDocument(page);
        shown = next;
      });
    }

    await noneWaiting(api);
    await expectNoAsks(page, asks, `${HOSTS.at(-1)!.name} once nothing on it waits`);
    expectQuietConsole(errors);
  });

  test("a data-only refresh gets a picture address of its own and shows on the next listing, whatever the browser keeps of the older picture", async ({ page }) => {
    test.setTimeout(300_000);
    // Routing a request turns the browser's cache off, and this test is
    // about that cache, so it routes nothing. It holds instead that the page
    // asks no host but the instance.
    const outside: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (/^https?:$/.test(url.protocol) && !LOCAL_HOSTNAMES.has(url.hostname)) outside.push(request.url());
    });
    const errors = trackConsole(page);
    const api = page.request;
    // Two places per row: the name rule finds lon/lat at upload; east/north
    // is the other place the data can be told to stand.
    const rows = [
      [13.25, 52.52],
      [13.25, 52.55],
      [13.22, 52.52],
      [13.25, 52.49],
    ].map(([lon, lat], i) => `p${i},${lon},${lat},${lon + 0.3},${lat}`);
    const table = await upload(api, `cs_data_${runId}`, ["name,lon,lat,east,north", ...rows].join("\n"));
    const map = await seedMap(api, `Data only ${runId}`, `SELECT * FROM "${table}"`);
    const first = await waitForPicture(api, map.id);

    const told = page.waitForResponse(
      (response) => response.request().resourceType() === "image" && response.url().includes(`/api/maps/${map.id}/thumbnail`),
    );
    await page.goto("/maps");
    const before = await shownMarks(page, map, first.pictureVersion);
    expect(before.marks).toBeGreaterThan(200);
    // What the browser keeps of a card picture is what the instance's answer
    // lets it keep. Either way the copy is read back, never assumed.
    const policy = (await told).headers()["cache-control"] ?? "";
    const keeps = !/\bno-store\b/.test(policy);
    test.info().annotations.push({ type: "card picture caching", description: policy || "no cache-control" });
    const kept = await marksOf(page, before.src, "cache");
    if (keeps) expect(kept, "the browser keeps the picture it showed").not.toBeNull();
    else expect(kept, "told to store nothing, the browser keeps no copy of the picture it showed").toBeNull();

    const revision = await editRevision(api, map);
    await setGeometry(api, table, ["east", "north"]);
    const second = await waitForPicture(api, map.id, first.pictureVersion);
    expect(await editRevision(api, map), "the map itself was not edited").toBe(revision);

    await page.goto("/maps");
    const after = await shownMarks(page, map, second.pictureVersion);
    expect(after.src).not.toBe(before.src);
    expect(after.marks).toBeGreaterThan(200);
    expect(after.cx - before.cx, "the card's picture shows the data where it now stands").toBeGreaterThan(0.1);
    const held = await marksOf(page, before.src, "cache");
    if (keeps) {
      expect(held, "the browser still holds the older picture under the older address").not.toBeNull();
      expect(Math.abs(held!.cx - before.cx), "and that copy is the older picture").toBeLessThan(0.02);
    } else {
      expect(held, "and holds no older picture that could stand in for the newer").toBeNull();
    }
    expect(outside).toEqual([]);
    expectQuietConsole(errors);
  });

  test("a failed picture keeps the previous one, or the placeholder, in every host and theme, the page stops asking, and a picture that fails to load shows the placeholder", async ({
    page,
    context,
  }) => {
    test.setTimeout(600_000);
    await routeHouse(context);
    const errors = trackConsole(page);
    const asks = watchListing(page);
    const api = page.request;
    const table = await upload(api, `cs_failed_${runId}`, STATIONS);
    const project = await createProject(api, `Failed picture home ${runId}`);
    const empty = await createProject(api, `Failed picture empty ${runId}`);
    const places = { project, empty, table };
    const sql = `SELECT * FROM "${table}"`;
    const pictured = await seedMap(api, `Failed after a picture ${runId}`, sql, project);
    const first = await waitForPicture(api, pictured.id);

    // First, while this browser has never loaded the picture, so no copy of
    // it can stand in for the refused load.
    await test.step("a picture that fails to load in the browser shows the placeholder", async () => {
      const address = `**/api/maps/${pictured.id}/thumbnail**`;
      await page.route(address, (route) => route.fulfill({ status: 500, body: "" }));
      await visit(page, MAPS_GRID, places, "light", pictured);
      await expectPlaceholder(page, pictured);
      await consumeExpected(errors, new RegExp(`/api/maps/${pictured.id}/thumbnail`), /500/);
      await page.unroute(address);
    });

    const never = await seedMap(api, `Failed before a picture ${runId}`, sql, project);
    try {
      await addExpiringLayer(api, pictured);
      await addExpiringLayer(api, never);
      await expectState(api, pictured, "waiting");

      await test.step("while both wait, then once both have failed, the gallery shows the previous picture and the placeholder", async () => {
        await visit(page, MAPS_GRID, places, "light", pictured);
        await markDocument(page);
        await expectPicture(page, pictured, first.pictureVersion, "light");
        await expectPlaceholder(page, never);
        await expectState(api, pictured, "failed", 90_000);
        await expectState(api, never, "failed", 90_000);
        await noneWaiting(api);
        await expectStopsAsking(page, asks, "the gallery once its cards have failed");
        await expectSameDocument(page);
        await expectPicture(page, pictured, first.pictureVersion, "light");
        await expectPlaceholder(page, never);
      });

      for (const theme of THEMES) {
        for (const host of HOSTS) {
          await test.step(`${host.name}, ${theme}`, async () => {
            await visit(page, host, places, theme, pictured);
            await expectPicture(page, pictured, first.pictureVersion, theme);
            await expectPlaceholder(page, never);
          });
        }
      }

      expectQuietConsole(errors);
    } finally {
      // Failed work is tried again later; gone maps are not.
      for (const map of [pictured, never]) await deleteMap(api, map).catch(() => undefined);
    }
  });
});

test.describe("card states with no renderer", () => {
  test.skip(!NO_RENDERER, "Set DEZFIL_NO_RENDERER_URL to a second isolated instance without an image renderer.");

  test("the listing reads unavailable, nothing asks again, System reads Not found, and administrators alone see the line at each card page's foot", async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const base = NO_RENDERER!;
    const origin = new URL(base).origin;
    expect(new URL(base).port, "the no-renderer instance is not on the development port").not.toBe("3000");
    await provisionJourney(base, browserAccount);
    const admin = await browser.newContext({
      baseURL: base,
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: { origin },
    });
    let member: Person | undefined;
    try {
      const signed = await admin.request.post("/api/auth/sign-in", {
        data: { email: browserAccount.email, password: browserAccount.password },
      });
      expect(signed.status()).toBe(200);
      expect((await (await admin.request.get("/api/account")).json()).account.isAdmin).toBe(true);
      const system = await admin.request.get("/api/instance/settings");
      expect(system.status()).toBe(200);
      expect((await system.json()).parts.image_renderer).toMatchObject({ found: false, available: false });

      const table = await upload(admin.request, `cs_none_${runId}`, STATIONS);
      const project = await createProject(admin.request, `No renderer home ${runId}`);
      const map = await seedMap(admin.request, `No renderer ${runId}`, `SELECT * FROM "${table}"`, project);
      await expectState(admin.request, map, "unavailable");
      member = await invitePerson(browser, admin.request, base, "Mira", runTag());
      const memberProject = await createProject(member.api, `Member home ${runId}`);
      const memberMap = await seedMap(member.api, `Member map ${runId}`, "SELECT ST_Point(13.4, 52.52) AS geom", memberProject);
      await expectState(member.api, memberMap, "unavailable");

      const cardPages = (projectId: string) => [
        { name: "home", path: "/" },
        { name: "maps", path: "/maps" },
        { name: "projects", path: "/projects" },
        { name: "project", path: `/projects/${projectId}` },
      ];

      await routeHouse(admin);
      const page = await admin.newPage();
      const errors = trackConsole(page);
      const asks = watchListing(page);
      for (const theme of THEMES) {
        for (const at of cardPages(project)) {
          await test.step(`an administrator on ${at.name}, ${theme}`, async () => {
            await page.goto(at.path);
            await expect(cardOf(page, map)).toBeVisible();
            await ensureTheme(page, theme);
            await expectPlaceholder(page, map);
            const line = page.locator("[data-renderer-notice]");
            await expect(line).toHaveCount(1);
            await expect(line).toHaveText(NOTICE);
            await expect(line.getByRole("link", { name: "Settings · System" })).toHaveAttribute(
              "href",
              "/settings/system#sys-renderer",
            );
            await page.mouse.move(0, 0);
            await expect(line).toHaveScreenshot(`no-renderer-line-${at.name}-${theme}.png`);
          });
        }
      }

      await test.step("nothing asks again, and the line leads to System, which reads Not found", async () => {
        await page.goto("/maps");
        await expectPlaceholder(page, map);
        await expectNoAsks(page, asks, "the gallery whose map has no renderer");
        await page.locator("[data-renderer-notice]").getByRole("link", { name: "Settings · System" }).click();
        await expect(page).toHaveURL(/\/settings\/system#sys-renderer$/);
        await expect(page.locator("#sys-renderer")).toContainText("Not found");
      });
      expectQuietConsole(errors);

      await routeHouse(member.context);
      const seen = await member.context.newPage();
      const memberErrors = trackConsole(seen);
      for (const at of cardPages(memberProject)) {
        await test.step(`a member on ${at.name}`, async () => {
          await seen.goto(at.path);
          await expect(cardOf(seen, memberMap)).toBeVisible();
          await expectPlaceholder(seen, memberMap);
          await expect(seen.locator("[data-renderer-notice]")).toHaveCount(0);
        });
      }
      expectQuietConsole(memberErrors);
    } finally {
      await admin.close();
      await member?.context.close();
    }
  });
});
