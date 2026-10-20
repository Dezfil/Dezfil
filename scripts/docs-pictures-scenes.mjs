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
//   account's own first map, the one "Your first map" builds; `use-maps`
//   after that and what the Use Dezfil pages on data and maps show beside
//   it. The script takes the states in this order, every scene of one
//   before the next, so a seeded scene never shows the first map, and what
//   a use-maps scene changes as it opens never reaches an earlier picture;
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

import { readFile } from "node:fs/promises";
import { FIRST_MAP, USE_MAPS } from "./docs-pictures-instance.mjs";

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
 * strongest, with their place, magnitude, depth and geometry. The result
 * keeps its geometry, so its Map tab and Add as map layer are live, as the
 * page beside the picture offers them. No two of the six struck at the same
 * time, so the order is total. The year stays out: the results table
 * writes whole numbers with a thousands separator, a year as "2,004". */
export const SQL_SCENE_QUERY = [
  "SELECT place, magnitude, depth_km, geom",
  "FROM earthquakes",
  "WHERE magnitude >= 8.5",
  "ORDER BY magnitude DESC, time_utc;",
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

// ---------------------------------------------------------------------------
// Use Dezfil on data and maps: Import data, Build a map, and Widgets and
// tools, in the use-maps state. A scene that changes the instance makes the
// change at the start of its own `open`, so both its takes start from the
// same state, whatever the scene before it left.

/** A change made through the documented API as the signed-in account,
 * carrying this instance's Origin as the app's own pages do, and the edit
 * revision it is based on where the operation takes one. */
async function change(page, method, address, { body, revision } = {}) {
  const { origin } = new URL((await page.request.get("/api/health")).url());
  const headers = { origin, ...(revision ? { "x-edit-revision": revision } : {}) };
  const answer = await page.request.fetch(address, { method, headers, ...(body === undefined ? {} : { data: body }) });
  if (!answer.ok()) throw new Error(`${method} ${address} answered ${answer.status()}: ${await answer.text()}`);
  return answer.status() === 204 ? null : answer.json();
}

/** The Data page's Add data dialog as it opens: Files, with Upload file and
 * its drop box. */
async function openAddData(page) {
  await page.goto("/data");
  await page.getByRole("button", { name: "Add data", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add data" });
  await dialog.getByRole("button", { name: "Upload data files" }).waitFor();
  return dialog;
}

/** One of Add data's sources, by its title: the button also reads the line
 * under the title. */
const importSource = (dialog, title) => dialog.getByRole("button", { name: new RegExp(`^${title} `) });

/** The file the column matching scene drops: the first map's cities with
 * their coordinates in columns named y and x, names Dezfil does not take
 * as coordinates without asking. */
const XY_CITIES = { file: "world-cities-xy.csv", table: "world_cities_xy" };

async function xyCities() {
  const [header, ...rows] = (await readFile(new URL(`../${FIRST_MAP.fixture}`, import.meta.url), "utf8")).split("\n");
  if (header !== "name,country,population,latitude,longitude") throw new Error(`${FIRST_MAP.fixture} begins with ${header}, not the columns the scene renames.`);
  return Buffer.from([header.replace("latitude,longitude", "y,x"), ...rows].join("\n"));
}

/** Set the first map as a scene shows it: whether its Megacities layer is
 * drawn, and whether its widgets are on the map. A scene of the first map
 * sets both at the start of its take, so neither take shows what the scene
 * before it set. */
async function arrangeWorldCities(page, { megacities, widgets }) {
  const { id } = await findByName(page, "/api/maps", FIRST_MAP.name);
  const read = async () => (await page.request.get(`/api/maps/${id}`)).json();
  let map = await read();
  const layer = map.layers.find((entry) => entry.name === USE_MAPS.megacities.name);
  if (!layer) throw new Error(`${FIRST_MAP.name} has no ${USE_MAPS.megacities.name} layer: the use-maps seeding did not add it.`);
  if (layer.visible !== megacities) {
    const current = await (await page.request.get(`/api/layers/${layer.id}`)).json();
    await change(page, "PATCH", `/api/layers/${layer.id}`, { body: { visible: megacities }, revision: current.editRevision });
    map = await read();
  }
  if (map.widgets.some((widget) => widget.visible !== widgets)) {
    await change(page, "PATCH", `/api/maps/${id}`, { body: { widgets: map.widgets.map((widget) => ({ ...widget, visible: widgets })) }, revision: map.editRevision });
  }
}

/** The first map in the builder, once its cities' layer card counts them. */
async function openWorldCities(page) {
  const { id } = await findByName(page, "/api/maps", FIRST_MAP.name);
  await page.goto(`/maps/${id}`);
  await page.locator("[data-layer-select]", { hasText: `${FIRST_MAP.features} features` }).waitFor();
}

/** The Visualization section of the open layer's style panel: its type
 * tiles, size and opacity. */
const VIZ_SECTION = '[data-builder-pane] section:has(> button:has-text("Visualization"))';

/** Open the style panel of the layer whose card names it, at its
 * Visualization section. */
async function openVisualization(page, layer) {
  await page.locator("[data-layer-select]", { hasText: layer }).click();
  const section = page.locator(VIZ_SECTION).first();
  await section.waitFor();
  await section.scrollIntoViewIfNeeded();
  return section;
}

/** The draw tools' dock, and the line under the map that explains the
 * polygon tool once it is picked. */
const DRAW_DOCK = '[role=toolbar][aria-label="Draw tools"]';
const POLYGON_LINE = '[role=status]:has-text("Click to place vertices")';

const USE_MAPS_SCENES = [
  {
    // Add data as the Data page opens it: the four sources, Upload file and
    // the drop box with its formats.
    id: "import-data-add-data",
    file: "use/import-data-add-data.webp",
    pages: ["docs/use/import-data.md"],
    kind: "still",
    state: "use-maps",
    crop: { selector: "[role=dialog]", margin: 24 },
    open: openAddData,
  },
  {
    // The CSV with x and y columns dropped on Add data: the column matching
    // step with the pair read as longitude and latitude, the projection,
    // the count of rows that read and the preview. The upload lands a
    // dataset, so the take before this one's is removed first; the step is
    // never confirmed.
    id: "import-data-column-matching",
    file: "use/import-data-column-matching.webp",
    pages: ["docs/use/import-data.md"],
    kind: "still",
    state: "use-maps",
    crop: { selector: "[role=dialog]", margin: 24 },
    async open(page) {
      const tables = await (await page.request.get("/api/tables")).json();
      for (const table of tables.filter((entry) => entry.name === XY_CITIES.table)) await change(page, "DELETE", `/api/tables/${encodeURIComponent(table.name)}`);
      const dialog = await openAddData(page);
      await dialog.locator("input[type=file]").setInputFiles({ name: XY_CITIES.file, mimeType: "text/csv", buffer: await xyCities() });
      const step = dialog.locator("[data-column-matching]");
      await step.waitFor();
      if ((await step.getByRole("button", { name: "Coordinate pair" }).getAttribute("aria-pressed")) !== "true") throw new Error("The column matching step did not read the x and y columns as a coordinate pair.");
      for (const [label, column] of [["Longitude column", "x"], ["Latitude column", "y"]]) {
        const select = step.getByLabel(label, { exact: true });
        if ((await select.inputValue()) !== column) await select.selectOption(column);
      }
      const projection = step.getByLabel("Projection", { exact: true });
      if ((await projection.inputValue()) === "") await projection.selectOption("4326");
      await step.getByText(`${FIRST_MAP.features} of ${FIRST_MAP.features} sampled rows read as`).waitFor();
    },
  },
  {
    // The PostGIS source with no saved connection: the form that adds one.
    id: "import-data-postgis",
    file: "use/import-data-postgis.webp",
    pages: ["docs/use/import-data.md"],
    kind: "still",
    state: "use-maps",
    crop: { selector: "[role=dialog]", margin: 24 },
    async open(page) {
      const dialog = await openAddData(page);
      await importSource(dialog, "PostGIS").click();
      await dialog.getByRole("heading", { name: "Connect a PostGIS database" }).waitFor();
      await dialog.getByRole("button", { name: "Test & save connection" }).waitFor();
    },
  },
  {
    // The builder in full on the first map with its second layer: the
    // Layers tab with both cards, the cities' style panel open at
    // Visualization, the map and the legend.
    id: "build-a-map-builder",
    file: "use/build-a-map-builder.webp",
    pages: ["docs/use/build-a-map.md"],
    kind: "still",
    state: "use-maps",
    map: true,
    async open(page) {
      await arrangeWorldCities(page, { megacities: true, widgets: false });
      await openWorldCities(page);
      await page.locator("[data-layer-select]", { hasText: `${USE_MAPS.megacities.features} features` }).waitFor();
      await openVisualization(page, FIRST_MAP.layer);
    },
  },
  {
    // The earthquakes around Japan as hex bins: their style panel at
    // Visualization with Hex bins chosen, Show and the cell size, and the
    // map the builder framed on them as it opened.
    id: "build-a-map-hex-bins",
    file: "use/build-a-map-hex-bins.webp",
    pages: ["docs/use/build-a-map.md"],
    kind: "still",
    state: "use-maps",
    map: true,
    async open(page) {
      const { id } = await findByName(page, "/api/maps", USE_MAPS.earthquakes.name);
      await page.goto(`/maps/${id}`);
      await page.locator("[data-layer-select]", { hasText: USE_MAPS.earthquakes.layer }).filter({ hasText: "cells" }).waitFor();
      const section = await openVisualization(page, USE_MAPS.earthquakes.layer);
      if ((await section.getByRole("button", { name: "Hex bins" }).getAttribute("data-active")) !== "true") throw new Error("The earthquakes layer is not drawn as hex bins.");
    },
  },
  {
    // The Basemap tab of the first map: the styles with Auto chosen,
    // Custom…, the basemap's map layers and the status bar's switch.
    id: "build-a-map-basemap",
    file: "use/build-a-map-basemap.webp",
    pages: ["docs/use/build-a-map.md"],
    kind: "still",
    state: "use-maps",
    map: true,
    crop: { selector: "[data-builder-pane]", margin: 12 },
    async open(page) {
      await arrangeWorldCities(page, { megacities: true, widgets: false });
      await openWorldCities(page);
      await page.getByRole("tab", { name: "Basemap", exact: true }).click();
      await page.getByRole("heading", { name: "Map layers" }).waitFor();
      await page.getByRole("heading", { name: "Overlays" }).waitFor();
    },
  },
  {
    // Drawing on the first map: the draw tools with Draw a polygon picked,
    // three vertices placed and the polygon left open, and the line under
    // the map. Nothing is saved: a session's layer and dataset are made by
    // its first finished shape.
    id: "build-a-map-draw",
    file: "use/build-a-map-draw.webp",
    pages: ["docs/use/build-a-map.md"],
    kind: "still",
    state: "use-maps",
    map: true,
    crop: { selector: [DRAW_DOCK, POLYGON_LINE], margin: 120 },
    async open(page) {
      await arrangeWorldCities(page, { megacities: true, widgets: false });
      await openWorldCities(page);
      await page.getByRole("button", { name: "Draw", exact: true }).click();
      const dock = page.locator(DRAW_DOCK);
      await dock.getByRole("button", { name: "Draw a polygon" }).click();
      const line = page.locator(POLYGON_LINE);
      await line.waitFor();
      const top = await dock.boundingBox();
      const bottom = await line.boundingBox();
      const middle = top.x + top.width / 2;
      for (const [x, y] of [[middle - 170, top.y + top.height + 140], [middle + 150, top.y + top.height + 100], [middle + 40, bottom.y - 120]]) {
        await page.mouse.click(x, y);
      }
      await page.locator("svg[data-armed] circle").nth(2).waitFor();
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
  ...USE_MAPS_SCENES,
];

export const STATES = ["fresh", "seeded", "first-map", "use-maps"];
