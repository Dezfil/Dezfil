// The picture script's scene list: one entry per picture or recording the
// documentation carries. "Every scene" means this list, and a manifest row's
// scene is one of its ids. Every scene is taken in both of the app's themes:
// `file` and `poster` name the light take, which is what pages and the
// README name, and the dark take is written beside each with `.dark` before
// the extension.
//
// Each scene names:
// - `id`, the scene, and `file`, its light take's file under docs/images/;
// - `pages`, the pages that use it (for the author: the page contract holds
//   the use);
// - `kind`, a still or a recording;
// - `state`, the instance state it is taken in: `fresh` before any account
//   exists; `seeded` after the seeding (two accounts, a shared project, the
//   three shipped templates copied and the repository's fixtures uploaded),
//   signed in as the first account; `first-map` after that and the first
//   account's own first map, the one "Your first map" builds. The script
//   takes the states in this order, every scene of one before the next, so
//   a seeded scene never shows the first map;
// - `map: true`, when the scene shows a map: its page may reach the built-in
//   basemap's host, and nothing is taken until every map on the page is at
//   rest on the built-in basemap, its tiles loaded. Without it, the
//   basemap's host is refused like any other and fails the run;
// - `crop`, when the picture is not the full frame: the element to frame,
//   or a list of elements framed together, and the margin around it, in
//   CSS pixels; the rectangle it comes to is declared in the scene's
//   manifest rows and shared by its two takes;
// - `open`, how the page is brought to the scene's first frame;
// - for a recording, `poster`, its poster's file, and `steps`: each one an
//   optional action, after which the page is settled and the frame is held
//   for `hold` frames of the cadence (ten a second), so the recording's
//   length is the frames held, at most eight seconds.

import { FIRST_MAP } from "./docs-pictures-instance.mjs";

/** Open the Templates page and wait until the catalogue has been read and
 * the three shipped cards are drawn with their pictures. */
async function openTemplates(page) {
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/templates/refresh" && response.request().method() === "POST");
  await page.goto("/templates");
  const answer = await refreshed;
  if (!answer.ok()) throw new Error(`The template catalogue read answered ${answer.status()}.`);
  await page.locator("article[data-template]").nth(2).waitFor();
  if (await page.locator("[data-catalogue-line]").count()) throw new Error("The Templates page shows a catalogue line: the catalogue folder was not read as listed.");
}

/** A map or workflow of the first account's, found by its name in a list
 * the API answers. */
async function findByName(page, address, name, pick = (body) => body) {
  const listed = await page.request.get(address);
  if (!listed.ok()) throw new Error(`${address} answered ${listed.status()}.`);
  const found = pick(await listed.json()).find((entry) => entry.name === name);
  if (!found) throw new Error(`There is no ${name} at ${address}: the seeding did not make it.`);
  return found;
}

// ---------------------------------------------------------------------------
// The first map, as "Your first map" builds it, on the built-in basemap.

/** Open the first map in the builder, as the seeding made it, and wait
 * until its layer card counts the cities and the legend shows the
 * population classes. */
async function openFirstMap(page) {
  const map = await findByName(page, "/api/maps", FIRST_MAP.name);
  await page.goto(`/maps/${map.id}`);
  await page.locator("[data-layer-select]", { hasText: `${FIRST_MAP.features} features` }).waitFor();
  await page.locator("[data-corner] li").nth(1).waitFor();
}

/** The Fill section of the open layer's style panel: the only section
 * with a Fill opacity row. */
const FILL_SECTION = '[data-builder-pane] section:has-text("Fill opacity")';

const FIRST_MAP_SCENES = [
  {
    // The finished map, the page's opening picture: the builder in full.
    id: "first-map-finished",
    file: "start/first-map-finished.webp",
    pages: ["docs/start/first-map.md", "docs/start/what-is-dezfil.md"],
    kind: "still",
    state: "first-map",
    map: true,
    open: openFirstMap,
  },
  {
    // Add layer as it opens: Files, Upload file and the drop box.
    id: "first-map-add-layer",
    file: "start/first-map-add-layer.webp",
    pages: ["docs/start/first-map.md"],
    kind: "still",
    state: "first-map",
    map: true,
    crop: { selector: "[role=dialog]", margin: 24 },
    async open(page) {
      await openFirstMap(page);
      await page.getByRole("button", { name: "Add layer", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Upload data files" }).waitFor();
    },
  },
  {
    // The layer's Fill section, colored by population in five classes.
    id: "first-map-style",
    file: "start/first-map-style.webp",
    pages: ["docs/start/first-map.md"],
    kind: "still",
    state: "first-map",
    map: true,
    crop: { selector: FILL_SECTION, margin: 12 },
    async open(page) {
      await openFirstMap(page);
      await page.locator("[data-layer-select]", { hasText: FIRST_MAP.layer }).click();
      const fill = page.locator(FILL_SECTION).first();
      await fill.waitFor();
      // The classes are drawn from the saved style at once; Color by lists
      // the layer's columns only once they are read, and until then it
      // shows its first choice, Single color.
      await fill.getByLabel("Fill class 5 color").waitFor();
      const select = fill.getByLabel("Fill color attribute");
      await select.locator(`option[value="${FIRST_MAP.colorBy}"]`).waitFor({ state: "attached" });
      const colorBy = await select.inputValue();
      if (colorBy !== FIRST_MAP.colorBy) throw new Error(`The cities are colored by ${colorBy}, not ${FIRST_MAP.colorBy}.`);
      await fill.scrollIntoViewIfNeeded();
    },
  },
  {
    // The publish panel before the map is published, under the top bar's
    // buttons with Publish at their right end. The bar's buttons are framed
    // whole: a frame around the panel alone cuts a neighbouring button.
    id: "first-map-publish",
    file: "start/first-map-publish.webp",
    pages: ["docs/start/first-map.md"],
    kind: "still",
    state: "first-map",
    map: true,
    crop: { selector: ["header > div:has(> #header-actions-right)", "#publish-popover"], margin: 24 },
    async open(page) {
      await openFirstMap(page);
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await page.locator("#publish-popover").getByRole("button", { name: "Publish map" }).waitFor();
    },
  },
];

// ---------------------------------------------------------------------------
// The main screens, as "What Dezfil is" shows them, on the seeded instance:
// the first account's copies of the three shipped templates among its work.
// The map builder's picture is the first map's: a full-frame builder on any
// of the copies' maps comes out over the bound on a picture's size.

/** The names the shipped templates' copies carry: each copy's map or
 * workflow keeps its template's title. */
const COPIES = ["Forty years of big earthquakes", "The world's air routes", "Health access in Rwanda"];

/** The query the SQL scene runs on the copied earthquakes: the six
 * strongest, with their place, year, magnitude and geometry. The result
 * keeps its geometry, so its Map tab and Add as map layer are live, as the
 * page beside the picture offers them. No two of the six share a magnitude
 * and a year, so the order is total. */
export const SQL_SCENE_QUERY = [
  "SELECT place, year, magnitude, geom",
  "FROM earthquakes",
  "WHERE magnitude >= 8.5",
  "ORDER BY magnitude DESC, year;",
].join("\n");

/** How many rows the SQL scene's query answers. */
const SQL_SCENE_ROWS = 6;

/** The run time the SQL scene's result shows. The server measures each
 * run afresh, so its time differs on every run; the scene's page is handed
 * the instance's own answer with this time in it, so two runs draw the
 * same picture. Everything else in the answer is the instance's. */
export const SQL_SCENE_RUNTIME_MS = 24;

/** The Maps screen's grid of cards: the one element whose children are the
 * New map tile and the cards. */
const MAPS_GRID = "main div:has(> button):has(> article)";

const MAIN_SCREEN_SCENES = [
  {
    // Home: the last change under Continue, with Start beside it. The crop
    // ends above Recent, whose rows below the fixtures' come from one
    // template copy at one moment and fall in another order on each run.
    id: "what-is-dezfil-home",
    file: "start/what-is-dezfil-home.webp",
    pages: ["docs/start/what-is-dezfil.md"],
    kind: "still",
    state: "seeded",
    crop: { selector: "[data-home] [data-beside]", margin: 24 },
    async open(page) {
      await page.goto("/");
      await page.locator('[data-lead="continue"]').waitFor();
      await page.locator('[data-recent-place="shown"]').waitFor();
      await page.locator('[data-shelf="shown"]').waitFor();
    },
  },
  {
    // Maps in Grid view: the heading, the filters, the New map tile and the
    // three copies' maps. The crop reaches from under the top bar to above
    // the page's foot, where a line tells an administrator of an instance
    // without a renderer for map pictures (the picture run's) how to set
    // one; an instance from the image has one.
    id: "what-is-dezfil-maps",
    file: "start/what-is-dezfil-maps.webp",
    pages: ["docs/start/what-is-dezfil.md"],
    kind: "still",
    state: "seeded",
    crop: { selector: MAPS_GRID, margin: 128 },
    async open(page) {
      await page.goto("/maps");
      for (const name of COPIES) await page.getByRole("link", { name: `Open ${name}`, exact: true }).waitFor();
    },
  },
  {
    // Data: the source chips and the datasets' cards.
    id: "what-is-dezfil-data",
    file: "start/what-is-dezfil-data.webp",
    pages: ["docs/start/what-is-dezfil.md"],
    kind: "still",
    state: "seeded",
    async open(page) {
      await page.goto("/data");
      await page.locator('[data-table-card="earthquakes"]').waitFor();
      await page.locator('[data-table-card="stations"]').waitFor();
    },
  },
  {
    // The SQL workspace: a query on the copied earthquakes, run, its rows
    // as a table with the Map tab live. A fresh browser context starts
    // with no draft kept.
    id: "what-is-dezfil-sql",
    file: "start/what-is-dezfil-sql.webp",
    pages: ["docs/start/what-is-dezfil.md"],
    kind: "still",
    state: "seeded",
    async open(page) {
      await page.route((url) => url.pathname === "/api/query", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        const answer = await route.fetch();
        return route.fulfill({ response: answer, json: { ...(await answer.json()), runtimeMs: SQL_SCENE_RUNTIME_MS } });
      });
      await page.goto("/sql");
      await page.locator('[data-name="earthquakes"]').waitFor();
      await page.locator(".cm-content").click();
      await page.keyboard.insertText(SQL_SCENE_QUERY);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Run query", exact: true }).click();
      const results = page.locator('section[aria-label="Results"]');
      await results.locator("table tbody tr").nth(SQL_SCENE_ROWS - 1).waitFor();
      if (await results.getByRole("tab", { name: "Map", exact: true }).isDisabled()) throw new Error("The SQL scene's result has no geometry: its Map tab is disabled.");
    },
  },
  {
    // The canvas of the copied Health access in Rwanda workflow, as it
    // opens: three sources and six nodes.
    id: "what-is-dezfil-workflow",
    file: "start/what-is-dezfil-workflow.webp",
    pages: ["docs/start/what-is-dezfil.md"],
    kind: "still",
    state: "seeded",
    async open(page) {
      const workflow = await findByName(page, "/api/recipes?origin=workflow", COPIES[2], (body) => body.recipes);
      await page.goto(`/workflows/${workflow.id}`);
      await page.locator(".react-flow__node").nth(8).waitFor();
    },
  },
];

export const SCENES = [
  {
    id: "setup-card",
    file: "start/setup-card.webp",
    pages: ["docs/start/install.md"],
    kind: "still",
    state: "fresh",
    crop: { selector: "main > div", margin: 48 },
    async open(page) {
      await page.goto("/setup");
      await page.locator("form button[type=submit]:not([disabled])").waitFor();
    },
  },
  {
    id: "templates-page",
    file: "use/templates.webp",
    pages: ["README.md", "docs/start/what-is-dezfil.md", "docs/use/templates.md"],
    kind: "still",
    state: "seeded",
    open: openTemplates,
  },
  {
    id: "templates-search",
    file: "use/templates-search.webm",
    poster: "use/templates-search-poster.webp",
    pages: ["docs/use/templates.md"],
    kind: "recording",
    state: "seeded",
    open: openTemplates,
    steps: [
      { hold: 10 },
      { act: (page) => page.keyboard.press("/"), hold: 5 },
      ...[..."quake"].map((letter) => ({ act: (page) => page.keyboard.type(letter), hold: 3 })),
      { hold: 20 },
    ],
  },
  ...MAIN_SCREEN_SCENES,
  ...FIRST_MAP_SCENES,
];

export const STATES = ["fresh", "seeded", "first-map"];
