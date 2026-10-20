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
//   account's own first map, the one "Your first map" builds; then the
//   states of the Use Dezfil pages, each made from the one before it by its
//   seeding in `STATE_SEEDING` (a state without one is the state before it,
//   in a browser of its own). The script takes the states in the order of
//   `STATES`, every scene of one before the next, so a seeded scene never
//   shows the first map;
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
import { ASSISTANT_MESSAGES } from "./docs-pictures-assistant.mjs";
import { FIXED_TIME } from "./docs-pictures-capture.mjs";
import { ASSISTANT_MAP, BIG_CITIES, FIRST_MAP, MEMBER_MAPS, PROJECT, SELF_HOST, USE_MAPS, USE_SHARE, runWorkflow, seedAssistantMap, seedFirstMap, seedMember, seedSelfHost, seedUseMaps, seedUseShare, seedWorkflow } from "./docs-pictures-instance.mjs";

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
// Use Dezfil: the SQL workspace, as "Query with SQL" walks through it, on
// the first map's cities, in the `sql` state.

/** Step 3's query: the cities of more than ten million people, largest
 * first, with their points. No two of the 15 share a population, so the
 * order is total. */
export const SQL_PAGE_QUERY = [
  "SELECT name, country, population, geometry",
  "FROM world_cities",
  "WHERE population > 10000000",
  "ORDER BY population DESC;",
].join("\n");

/** How many rows step 3's query answers. */
const SQL_PAGE_ROWS = 15;

/** What the History scene runs after step 3's query, in order: the page's
 * API example, then a query that fails with sql_error. */
const SQL_PAGE_HISTORY = [
  "SELECT name, country FROM world_cities ORDER BY population DESC LIMIT 3",
  "SELECT nme FROM world_cities",
];

/** Where the SQL workspace keeps its draft and its history in the
 * browser. Each SQL scene starts without them, so none inherits the draft
 * or the history of the scene before it in the same browser. */
export const SQL_STORAGE_KEYS = ["dezfil:sql:draft", "dezfil:sql:history"];

/** The results card, and the pane of Sources and History. */
const SQL_RESULTS = 'section[aria-label="Results"]';
const SQL_PANE = 'aside[aria-label="Sources and history"]';

/** Type a query into the empty or selected editor, run it, and wait for
 * its answer. Every answer that ran carries the run time the main
 * screens' SQL scene shows, so two runs draw the same picture. */
async function runSqlPageQuery(page, sql) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(sql);
  await page.keyboard.press("Escape");
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/query" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await answered;
  await page.getByRole("button", { name: "Run query", exact: true }).waitFor();
}

/** The SQL workspace after step 3: opened with nothing kept from an
 * earlier scene, the query run, its 15 cities in the table and the Map tab
 * live. */
async function openSqlResult(page) {
  await page.addInitScript((keys) => {
    for (const key of keys) localStorage.removeItem(key);
  }, SQL_STORAGE_KEYS);
  await page.route((url) => url.pathname === "/api/query", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const answer = await route.fetch();
    if (!answer.ok()) return route.fulfill({ response: answer });
    return route.fulfill({ response: answer, json: { ...(await answer.json()), runtimeMs: SQL_SCENE_RUNTIME_MS } });
  });
  await page.goto("/sql");
  await page.locator(`[data-name="${FIRST_MAP.layer}"]`).waitFor();
  await runSqlPageQuery(page, SQL_PAGE_QUERY);
  const results = page.locator(SQL_RESULTS);
  await results.locator("table tbody tr").nth(SQL_PAGE_ROWS - 1).waitFor();
  if (await results.getByRole("tab", { name: "Map", exact: true }).isDisabled()) throw new Error("Step 3's result has no geometry: its Map tab is disabled.");
}

const SQL_PAGE_SCENES = [
  {
    // The page's opening picture: Sources, the editor and the 15 cities as
    // a table, in the full frame.
    id: "sql-workspace",
    file: "use/sql-workspace.webp",
    pages: ["docs/use/sql.md"],
    kind: "still",
    state: "sql",
    open: openSqlResult,
  },
  {
    // Step 5's first tab: the Save as dataset panel under the result's
    // bar, the new name typed and not yet saved.
    id: "sql-save-as-dataset",
    file: "use/sql-save-as-dataset.webp",
    pages: ["docs/use/sql.md"],
    kind: "still",
    state: "sql",
    crop: { selector: [`${SQL_RESULTS} > div:first-child`, '[role=group][aria-label="Save as dataset"]'], margin: 16 },
    async open(page) {
      await openSqlResult(page);
      await page.getByRole("button", { name: "Save as dataset", exact: true }).click();
      await page.getByLabel("Name for the new dataset").fill("megacities");
    },
  },
  {
    // The History tab after three runs, one of them failed. The browser's
    // fixed clock gives every card the same day and time.
    id: "sql-history",
    file: "use/sql-history.webp",
    pages: ["docs/use/sql.md"],
    kind: "still",
    state: "sql",
    // From the pane's tabs to Clear history, without the empty pane below.
    crop: { selector: [`${SQL_PANE} [role=tablist]`, `${SQL_PANE} button:has-text("Clear history")`], margin: 12 },
    async open(page) {
      await openSqlResult(page);
      for (const sql of SQL_PAGE_HISTORY) await runSqlPageQuery(page, sql);
      await page.locator(SQL_RESULTS).getByText("sql_error", { exact: true }).waitFor();
      await page.getByRole("tab", { name: /^History/ }).click();
      await page.locator("[data-history-card]").nth(SQL_PAGE_HISTORY.length).waitFor();
    },
  },
];

// ---------------------------------------------------------------------------
// Use Dezfil: the Big cities workflow "Workflows" builds on the first map's
// cities, in the `workflow` state as made and never run, and in the
// `workflow-run` state after its run.

/** Where the results band keeps a person's choice of open or closed in the
 * browser. Each workflow scene starts without it, so the band opens as the
 * instance's default says: closed, until a run in the page opens it. */
export const BAND_CHOICE_KEY = "dezfil.workflow.band-choice";

/** A tile on the canvas, by the dataset it writes or, for a source, reads. */
const workflowTile = (page, name) => page.locator(`[data-node][data-name="${name}"]`);

/** Open the Big cities workflow on its canvas, with its three tiles drawn. */
async function openWorkflow(page) {
  await page.addInitScript((key) => localStorage.removeItem(key), BAND_CHOICE_KEY);
  const workflow = await findByName(page, "/api/recipes?origin=workflow", BIG_CITIES.name, (body) => body.recipes);
  await page.goto(`/workflows/${workflow.id}`);
  for (const name of [FIRST_MAP.layer, BIG_CITIES.filter.parameters.name, BIG_CITIES.cells.parameters.name]) await workflowTile(page, name).waitFor();
}

const WORKFLOW_PAGE_SCENES = [
  {
    // The page's opening picture: the canvas after the run, each node with
    // its check mark and the results band on its bar, in the full frame.
    // The run is the seeding's, so the band stays closed: its Messages
    // carry the time of each run, which differs on every run.
    id: "workflows-canvas",
    file: "use/workflows-canvas.webp",
    pages: ["docs/use/workflows.md"],
    kind: "still",
    state: "workflow-run",
    async open(page) {
      await openWorkflow(page);
      await page.locator('[data-node][data-kind="node"][data-state="up to date"]').nth(1).waitFor();
    },
  },
  {
    // Step 4: the Filter rows panel before any run, its preview read.
    id: "workflows-node-panel",
    file: "use/workflows-node-panel.webp",
    pages: ["docs/use/workflows.md"],
    kind: "still",
    state: "workflow",
    // The panel stands over the canvas: a margin would cut into the tiles
    // beside it. The crop ends under Output: the state holds both nodes,
    // so the Run section offers Run from here, which a reader at step 4,
    // with Filter rows alone, does not have yet.
    crop: { selector: ["aside[data-node-panel] > header", 'aside[data-node-panel] section[aria-label="Output"]'], margin: 0 },
    async open(page) {
      await openWorkflow(page);
      await workflowTile(page, BIG_CITIES.filter.parameters.name).click();
      await page.locator("aside[data-node-panel] [data-preview-line]").waitFor();
    },
  },
  {
    // Step 6: the Run all dialog, before the run is confirmed. Closing the
    // page leaves the workflow unrun.
    id: "workflows-run-all",
    file: "use/workflows-run-all.webp",
    pages: ["docs/use/workflows.md"],
    kind: "still",
    state: "workflow",
    crop: { selector: "[data-run-confirm]", margin: 24 },
    async open(page) {
      await openWorkflow(page);
      await page.locator('[data-run-action="run-all"]').click();
      await page.locator("[data-run-confirm] [data-plan-list] li").nth(1).waitFor();
    },
  },
];

// ---------------------------------------------------------------------------
// Use Dezfil: the assistant, as "The assistant" shows it on a map, on the
// SQL page and on a workflow, in the `assistant` state: the first account's
// City sizes map, the first map's cities in one color, beside the Big
// cities workflow. The model is the run's scripted one
// (docs-pictures-assistant.mjs): what it says is scripted, what it does
// runs on the instance.

/** The run time every action line of the pane shows. The server measures
 * each action afresh, so its time differs on every run; the scenes' pages
 * are handed the instance's own answers with this time in them, as the SQL
 * scenes are for a query's, so two runs draw the same picture. */
export const ASSISTANT_ELAPSED_MS = 100;

const ELAPSED = /"elapsedMs":\s*-?\d+(?:\.\d+)?/g;

/** The pane, open. */
const ASSISTANT_PANE = '[data-assistant-pane][data-open="true"]';

/** Hand the page the assistant's answers with the steady action time. */
async function steadyAssistantTimes(page) {
  const assistant = (url) => url.pathname === "/api/assistant/messages" || url.pathname.startsWith("/api/assistant/runs/");
  await page.route(assistant, async (route) => {
    const answer = await route.fetch();
    const headers = { ...answer.headers() };
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    const body = (await answer.text()).replace(ELAPSED, `"elapsedMs":${ASSISTANT_ELAPSED_MS}`);
    return route.fulfill({ status: answer.status(), headers, body });
  });
}

/** Leave no request of an earlier scene waiting at a card: each is
 * abandoned, as the API offers, before the page opens, so no pane offers
 * to recover one. The cards wait on the server, whatever page or browser
 * asked. */
async function abandonPending(page) {
  const listed = await page.request.get("/api/assistant/pending");
  if (!listed.ok()) throw new Error(`/api/assistant/pending answered ${listed.status()}.`);
  const origin = new URL(listed.url()).origin;
  for (const { runId } of (await listed.json()).pending) {
    const gone = await page.request.delete(`/api/assistant/runs/${encodeURIComponent(runId)}`, { headers: { origin } });
    if (!gone.ok()) throw new Error(`Abandoning the waiting request ${runId} answered ${gone.status()}.`);
  }
}

/** Open the pane from its door in the page's header. */
async function openAssistant(page) {
  await page.getByRole("button", { name: "Open assistant", exact: true }).click();
  const pane = page.locator(ASSISTANT_PANE);
  await pane.getByRole("textbox", { name: "Ask the assistant" }).waitFor();
  return pane;
}

/** Send a message from the pane's box, as Enter does. */
async function sendMessage(pane, message) {
  const box = pane.getByRole("textbox", { name: "Ask the assistant" });
  await box.fill(message);
  await box.press("Enter");
}

/** Rest the pointer on the pane's chips, which are not controls, so
 * nothing the picture shows lights up under it. */
async function restPointer(pane) {
  await pane.locator("[data-talking-about]").hover();
}

/** Open the City sizes map with its cities drawn, and the pane beside it,
 * with nothing of an earlier scene waiting. */
async function openAssistantMap(page) {
  await abandonPending(page);
  await steadyAssistantTimes(page);
  const map = await findByName(page, "/api/maps", ASSISTANT_MAP.name);
  await page.goto(`/maps/${map.id}`);
  await page.locator("[data-layer-select]", { hasText: `${FIRST_MAP.features} features` }).waitFor();
  return openAssistant(page);
}

const ASSISTANT_PAGE_SCENES = [
  {
    // The page's opening picture: the map in full, after the message that
    // colors the cities, the pane with its chips, the two action lines and
    // the reply.
    id: "assistant-builder",
    file: "use/assistant-builder.webp",
    pages: ["docs/use/assistant.md"],
    kind: "still",
    state: "assistant",
    map: true,
    async open(page) {
      const pane = await openAssistantMap(page);
      // The layer's card selects it, and a second press lets it go: a page
      // that opened with it selected is pressed once more.
      const card = page.locator("[data-layer-select]", { hasText: FIRST_MAP.layer });
      const chip = pane.locator('[data-chip="layer"]');
      await card.click();
      if (!(await chip.waitFor({ timeout: 3000 }).then(() => true, () => false))) await card.click();
      await chip.waitFor();
      await sendMessage(pane, ASSISTANT_MESSAGES.color);
      await pane.getByText("The cities are colored by population", { exact: false }).waitFor();
      await pane.locator('[data-record-entry][data-status="succeeded"]').nth(1).waitFor();
      await pane.locator('[data-phase="idle"]').waitFor();
      await page.locator("[data-corner] li").nth(4).waitFor();
      await restPointer(pane);
    },
  },
  {
    // Confirm or cancel: the card waiting before a dataset is deleted, in
    // the pane alone. The card's words name the dataset by its name, which
    // is the same on every run. The request is left waiting, and the next
    // scene abandons it.
    id: "assistant-confirm",
    file: "use/assistant-confirm.webp",
    pages: ["docs/use/assistant.md"],
    kind: "still",
    state: "assistant",
    map: true,
    crop: { selector: ASSISTANT_PANE, margin: 0 },
    async open(page) {
      const pane = await openAssistantMap(page);
      await sendMessage(pane, ASSISTANT_MESSAGES.remove);
      await pane.locator("[data-confirmation] button:not([disabled])").nth(1).waitFor();
      await pane.locator('[data-phase="parked"]').waitFor();
      await restPointer(pane);
    },
  },
  {
    // Write SQL with the assistant: the pane on the SQL page after step 3's
    // query ran, its proposal with Insert into editor, in the pane alone.
    id: "assistant-sql",
    file: "use/assistant-sql.webp",
    pages: ["docs/use/assistant.md"],
    kind: "still",
    state: "assistant",
    crop: { selector: ASSISTANT_PANE, margin: 0 },
    async open(page) {
      await abandonPending(page);
      await steadyAssistantTimes(page);
      await openSqlResult(page);
      const pane = await openAssistant(page);
      await pane.locator('[data-chip="execution"]').waitFor();
      await sendMessage(pane, ASSISTANT_MESSAGES.count);
      await pane.getByRole("button", { name: "Insert into editor", exact: true }).waitFor();
      await pane.locator('[data-phase="idle"]').waitFor();
      await restPointer(pane);
    },
  },
  {
    // Understand a workflow: the pane on Big cities after a run started on
    // the page, Filter rows selected, its two ways in above the empty box,
    // in the pane alone. The run opens the results band, whose messages
    // carry the time of each run: it stays outside the crop.
    id: "assistant-workflow",
    file: "use/assistant-workflow.webp",
    pages: ["docs/use/assistant.md"],
    kind: "still",
    state: "assistant",
    crop: { selector: ASSISTANT_PANE, margin: 0 },
    async open(page) {
      await abandonPending(page);
      await openWorkflow(page);
      const pane = await openAssistant(page);
      await page.locator('[data-run-action="run-all"]').click();
      await page.locator("[data-run-confirm]").getByRole("button", { name: "Run 2 nodes" }).click();
      await pane.locator('[data-chip="run"]', { hasText: "completed" }).waitFor({ timeout: 120_000 });
      await workflowTile(page, BIG_CITIES.filter.parameters.name).click();
      await pane.locator('[data-chip="step"]').waitFor();
      await pane.getByRole("button", { name: "Explain this node", exact: true }).waitFor();
      await pane.getByRole("button", { name: "Diagnose the last run", exact: true }).waitFor();
      await restPointer(pane);
    },
  },
];

// ---------------------------------------------------------------------------
// Use Dezfil: a person's own settings, as "Your settings" shows them, in the
// `member` state: signed in as the second account, a member, so the
// column shows what a member's shows, with three maps of its own, one of
// them published. What these scenes pick is kept with that account alone.

/** Dezfil's default look: every pick at its first choice. */
export const DEFAULT_LOOK = { color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover", panels: "glass" };

/** The Settings page's heading, where the pointer rests and lights nothing. */
const SETTINGS_HEADING = 'h1:text-is("Settings")';

/** Put the member's look back to Dezfil's default before the page opens,
 * so a take starts there whatever the scene before it picked: every
 * member scene but the Harbor one shows the default look. */
async function defaultLook(page) {
  const read = await page.request.get("/api/settings");
  if (!read.ok()) throw new Error(`/api/settings answered ${read.status()}.`);
  const reset = await page.request.patch("/api/settings", { data: { look: DEFAULT_LOOK }, headers: { origin: new URL(read.url()).origin } });
  if (!reset.ok()) throw new Error(`Putting the member's look back answered ${reset.status()}.`);
}

/** Open Appearance at the default look, its Color row drawn. */
async function openAppearance(page) {
  await defaultLook(page);
  await page.goto("/settings/appearance");
  await page.locator("#appearance-color").getByRole("radio", { name: "Kelp", exact: true }).waitFor();
}

/** Store the member's Maps layout and sort, as the screen's own buttons
 * do, before the page opens. Picked on the page, each pick's save is
 * answered but its answer is never read, and the browser then reports the
 * save in flight for as long as the page is open, so the page never comes
 * to rest. */
async function storeMapsView(page, prefs) {
  const read = await page.request.get("/api/settings");
  if (!read.ok()) throw new Error(`/api/settings answered ${read.status()}.`);
  const stored = await page.request.patch("/api/settings", { data: { viewPrefs: { maps: prefs } }, headers: { origin: new URL(read.url()).origin } });
  if (!stored.ok()) throw new Error(`Storing the member's Maps view answered ${stored.status()}.`);
}

/** The Maps list's card of rows: the one element whose children hold the
 * rows' buttons. */
const MAPS_LIST = 'main div:has(> div > button[aria-label^="Open "])';

const SETTINGS_PAGE_SCENES = [
  {
    // The page's opening picture: Appearance at Dezfil's default look, the
    // column of tabs and the Color and contrast card.
    id: "settings-appearance",
    file: "use/settings-appearance.webp",
    pages: ["docs/use/settings.md"],
    kind: "still",
    state: "member",
    crop: { selector: [SETTINGS_HEADING, 'nav[aria-label="Settings"]', "#appearance-color"], margin: 24 },
    async open(page) {
      await openAppearance(page);
      await page.locator(SETTINGS_HEADING).hover();
    },
  },
  {
    // Change the look, step 2: Harbor picked, in the full frame, once its
    // Saved mark has gone, so the picture does not depend on how fast it
    // was taken.
    id: "settings-look-harbor",
    file: "use/settings-look-harbor.webp",
    pages: ["docs/use/settings.md"],
    kind: "still",
    state: "member",
    async open(page) {
      await openAppearance(page);
      await page.locator("#appearance-color").getByRole("radio", { name: "Harbor", exact: true }).click();
      await page.locator('html[data-look-color="harbor"]').waitFor({ state: "attached" });
      await page.locator('[data-appearance-slot="reset"]').waitFor();
      const saved = page.locator("#appearance-color").getByText("Saved", { exact: true });
      await saved.waitFor();
      await saved.waitFor({ state: "hidden", timeout: 10_000 });
      await page.locator(SETTINGS_HEADING).hover();
    },
  },
  {
    // Lay out and sort your lists: the member's maps in List view, sorted
    // Name A to Z.
    id: "settings-maps-list",
    file: "use/settings-maps-list.webp",
    pages: ["docs/use/settings.md"],
    kind: "still",
    state: "member",
    crop: { selector: ['[role=group][aria-label="View"]', MAPS_LIST], margin: 16 },
    async open(page) {
      await defaultLook(page);
      await storeMapsView(page, { view: "list", sort: "name" });
      await page.goto("/maps");
      await page.locator('[role=group][aria-label="View"] button[aria-label="List view"][data-on]').waitFor();
      if ((await page.getByRole("combobox", { name: "Sort maps" }).inputValue()) !== "name") throw new Error("The Maps screen did not open sorted Name A to Z.");
      await page.locator(MAPS_LIST).getByRole("button", { name: /^Open / }).nth(MEMBER_MAPS.count - 1).waitFor();
      const first = await page.locator(MAPS_LIST).getByRole("button", { name: /^Open / }).first().getAttribute("aria-label");
      if (first !== "Open Forty years of big earthquakes") throw new Error(`The list sorted Name A to Z starts with ${first}.`);
      await page.locator(`${MAPS_LIST} > [aria-hidden]`).first().hover();
    },
  },
  {
    // Change your name or email, and your password: the Account card with
    // Change password opened, its fields empty.
    id: "settings-account",
    file: "use/settings-account.webp",
    pages: ["docs/use/settings.md"],
    kind: "still",
    state: "member",
    crop: { selector: "#account", margin: 16 },
    async open(page) {
      await defaultLook(page);
      await page.goto("/settings/account");
      await page.locator("#password > summary").click();
      await page.locator("#account").getByText("At least 8 characters.", { exact: true }).waitFor();
      await page.locator(SETTINGS_HEADING).hover();
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

/** The country the widgets scene leaves out: the one with the most of the
 * first map's cities, three, so the By country widget lists it first. */
const WIDGET_LEFT_OUT = "United States of America";

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
    // its first finished shape. The frame is the map's window, so its
    // controls, legend, status bar and credit show whole. Draw and the
    // polygon tool get a click event rather than the pointer, so neither
    // button grows under the pointer or shrinks as it is pressed, and the
    // page asks for reduced motion, so the draw tools and the line appear
    // without their rise: with the pointer's clicks, one pixel of the
    // polygon tool came out a shade apart from run to run.
    id: "build-a-map-draw",
    file: "use/build-a-map-draw.webp",
    pages: ["docs/use/build-a-map.md"],
    kind: "still",
    state: "use-maps",
    map: true,
    crop: { selector: "[data-drag-canvas]", margin: 0 },
    async open(page) {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await arrangeWorldCities(page, { megacities: true, widgets: false });
      await openWorldCities(page);
      // Draw waits for the map's camera, and a click event, unlike the
      // pointer's click, does not wait for a button to be enabled.
      const draw = page.getByRole("button", { name: "Draw", exact: true, disabled: false });
      await draw.waitFor();
      await draw.dispatchEvent("click");
      const dock = page.locator(DRAW_DOCK);
      await dock.getByRole("button", { name: "Draw a polygon" }).dispatchEvent("click");
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
  {
    // The Widgets tab of the first map with its By country widget on the
    // map, the most numerous country clicked off: its three cities gone
    // from the map and the status bar counting the 45 left. The selection
    // is the page's own and is never saved.
    id: "widgets-and-tools-widgets",
    file: "use/widgets-and-tools-widgets.webp",
    pages: ["docs/use/widgets-and-tools.md"],
    kind: "still",
    state: "use-maps",
    map: true,
    async open(page) {
      await arrangeWorldCities(page, { megacities: false, widgets: true });
      await openWorldCities(page);
      await page.getByRole("tab", { name: "Widgets", exact: true }).click();
      const country = page.locator('[data-widget-card="category"] button', { hasText: WIDGET_LEFT_OUT });
      await country.click();
      await page.locator('[data-widget-card="category"] button:not([data-active])', { hasText: WIDGET_LEFT_OUT }).waitFor();
      await page.locator("[data-records]", { hasText: `${FIRST_MAP.features - 3} of ${FIRST_MAP.features}` }).waitFor();
    },
  },
  {
    // The Tools drawer opened with the cities' layer selected, on Filter
    // rows filled in as the page's steps fill it: the dry run's line and
    // Run ready. Run is never clicked, so no dataset is made.
    id: "widgets-and-tools-tool-form",
    file: "use/widgets-and-tools-tool-form.webp",
    pages: ["docs/use/widgets-and-tools.md"],
    kind: "still",
    state: "use-maps",
    map: true,
    crop: { selector: "[data-recipe-drawer]", margin: 12 },
    async open(page) {
      await arrangeWorldCities(page, { megacities: false, widgets: true });
      await openWorldCities(page);
      await page.locator("[data-layer-select]", { hasText: FIRST_MAP.layer }).click();
      await page.locator("[data-tools-control]").click();
      const drawer = page.locator("[data-recipe-drawer]");
      await drawer.getByText(`Suggested for ${FIRST_MAP.layer}`).waitFor();
      await drawer.locator('[data-catalog-group="Data"] [data-operation="filter_rows"]').click();
      await drawer.locator('[data-param="field"]').selectOption(FIRST_MAP.colorBy);
      await drawer.locator('[data-param="comparison"]').selectOption("greater_than");
      await drawer.locator('[data-param="value"]').fill("10000000");
      await drawer.locator("[data-output-name]").fill("big_cities");
      await drawer.locator("[data-dry-run]", { hasText: `${USE_MAPS.megacities.features} rows` }).waitFor();
      if (await drawer.getByRole("button", { name: "Run", exact: true }).isDisabled()) throw new Error("Run is not ready on the Filter rows form.");
    },
  },
];

// ---------------------------------------------------------------------------
// Templates, beside the Templates page's two scenes in the scene list: a
// template opened and its Make a copy dialog, in the seeded state, where
// the three shipped templates are listed. Neither changes the instance:
// the template's page is read only and the dialog is never confirmed.

/** The shipped template the scenes open, by its id and its title. */
const EARTHQUAKES_TEMPLATE = { id: "earthquakes", title: "Forty years of big earthquakes" };

const TEMPLATE_SCENES = [
  {
    // The earthquakes template opened: its How it's made panel as it
    // opens, The question and Data unfolded, the layers read, framed from
    // its head to the end of the first dataset. The panel alone is framed:
    // the map beside it draws tens of thousands of overlapping points,
    // which come out differently on each run.
    id: "templates-how-its-made",
    file: "use/templates-how-its-made.webp",
    pages: ["docs/use/templates.md"],
    kind: "still",
    state: "seeded",
    map: true,
    crop: { selector: ["[data-template-panel] > header", "[data-template-panel] [data-dataset]"], margin: 0 },
    async open(page) {
      await page.goto(`/templates/${EARTHQUAKES_TEMPLATE.id}`);
      const panel = page.locator("[data-template-panel]");
      await panel.locator('[data-fold="data"] [data-dataset]').nth(1).waitFor();
      await panel.locator('[data-fold="layers"] button', { hasText: /\d/ }).waitFor();
    },
  },
  {
    // The Make a copy dialog for the earthquakes template, opened from its
    // card's corner on the Templates page, so the cards lie behind it and
    // not the template's map. The dialog reads the template as it opens.
    id: "templates-copy",
    file: "use/templates-copy.webp",
    pages: ["docs/use/templates.md"],
    kind: "still",
    state: "seeded",
    crop: { selector: "[data-template-copy-dialog]", margin: 24 },
    async open(page) {
      await openTemplates(page);
      await page.locator(`article[data-template="${EARTHQUAKES_TEMPLATE.id}"]`).hover();
      await page.getByRole("button", { name: `Make a copy of ${EARTHQUAKES_TEMPLATE.title}`, exact: true }).click();
      const dialog = page.locator("[data-template-copy-dialog]");
      await dialog.getByText("Comes with").waitFor();
      await page.mouse.move(0, 0);
    },
  },
];

// ---------------------------------------------------------------------------
// Use Dezfil on sharing: Share and publish in the use-share state, after
// the use-maps one, where the first map is published and two more people
// are on the instance. A scene of the first map sets its layers and widgets
// at the start of its take, as the use-maps scenes do.

/** The shared project's page as its owner sees it, once the line of the
 * people it is shared with and its facts are drawn. */
async function openSharedProject(page) {
  const { id } = await findByName(page, "/api/projects", PROJECT.name);
  await page.goto(`/projects/${id}`);
  await page.locator('[data-members-line="shared"]').waitFor();
  await page.locator("[data-facts]").waitFor();
}

const USE_SHARING_SCENES = [
  {
    // The shared project's Share dialog: the person the seeding left out
    // of the project found by part of her name and picked, with Viewer
    // chosen and Add ready, never clicked; the owner, the Editor and the
    // Viewer under People with access. The pointer leaves the dialog, so
    // no row shows its remove cross.
    id: "share-and-publish-share-dialog",
    file: "use/share-and-publish-share-dialog.webp",
    pages: ["docs/use/share-and-publish.md"],
    kind: "still",
    state: "use-share",
    crop: { selector: "[data-share-dialog]", margin: 24 },
    async open(page) {
      await openSharedProject(page);
      await page.locator("[data-share-action]").click();
      const dialog = page.locator("[data-share-dialog]");
      await dialog.locator("[data-member]").nth(2).waitFor();
      await dialog.getByLabel("Add people by name or email").fill(USE_SHARE.added.name.split(" ")[0]);
      await dialog.getByRole("option", { name: new RegExp(USE_SHARE.added.name) }).click();
      await dialog.locator("[data-picked]").waitFor();
      const viewer = dialog.getByRole("group", { name: "Role" }).getByRole("button", { name: "Viewer", exact: true });
      if ((await viewer.getAttribute("aria-pressed")) !== "true") throw new Error("The Share dialog does not start with Viewer chosen.");
      await page.mouse.move(0, 0);
    },
  },
  {
    // The publish panel of the published first map, below its link: the
    // shared fields' row, Opens in, Readers can and the panel's foot, with
    // no margin, so none of the map around the panel shows. The link is
    // out of the frame: it holds the run's own port and a token drawn
    // afresh on every run.
    id: "share-and-publish-published",
    file: "use/share-and-publish-published.webp",
    pages: ["docs/use/share-and-publish.md"],
    kind: "still",
    state: "use-share",
    map: true,
    crop: { selector: "#publish-popover [data-publish-scroll]", margin: 0 },
    async open(page) {
      await arrangeWorldCities(page, { megacities: false, widgets: true });
      await openWorldCities(page);
      await page.getByRole("button", { name: "Published", exact: true }).click();
      const popover = page.locator("#publish-popover");
      const opensIn = popover.getByRole("group", { name: "Opens in" });
      await opensIn.waitFor();
      if ((await opensIn.getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed")) !== "true") throw new Error(`The first map is not published to open in the ${USE_SHARE.theme} theme.`);
      await popover.getByText(/^\d+ layers? · \d+ fields?$/).waitFor();
    },
  },
  {
    // The Export image dialog of the first map, as it opens on the
    // builder's view, with the map's name typed as the image's title. The
    // By country widget is on the map, so the options list its switch. The
    // pointer leaves the dialog, so no option shows its hover.
    id: "share-and-publish-export-image",
    file: "use/share-and-publish-export-image.webp",
    pages: ["docs/use/share-and-publish.md"],
    kind: "still",
    state: "use-share",
    map: true,
    crop: { selector: "[data-export-card]", margin: 24 },
    async open(page) {
      await arrangeWorldCities(page, { megacities: false, widgets: true });
      await openWorldCities(page);
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Image/ }).click();
      const card = page.locator("[data-export-card]");
      await card.locator("[data-export-download]").waitFor();
      await card.getByLabel("Image title").fill(FIRST_MAP.name);
      await page.mouse.move(0, 0);
    },
  },
];

// ---------------------------------------------------------------------------
// Self-host: the pages for whoever runs the instance, in the `self-host`
// state after every Use Dezfil one, signed in as the first account, the
// instance's admin. The state adds two people to those the states before
// it made, and nothing these scenes do changes the instance.

/** Every account's creation and last sign-in on the Users page at the fixed
 * clock's time, so the list shows the same dates on every run: the page
 * reads them from the users answer, which carries the server's own clock.
 * An account that never signed in keeps reading Never. */
async function steadyUserDates(page) {
  const at = FIXED_TIME.toISOString();
  await page.route((url) => url.pathname === "/api/users", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const answer = await route.fetch();
    if (!answer.ok()) return route.fulfill({ response: answer });
    const body = await answer.json();
    const users = body.users.map((user) => ({ ...user, createdAt: at, lastSignInAt: user.lastSignInAt && at }));
    return route.fulfill({ response: answer, json: { ...body, users } });
  });
}

/** The Users page's list: the card whose first child is the row of column
 * heads. */
const USERS_LIST = 'main div:has(> div[aria-hidden] > span:text-is("Last sign-in"))';

const SELF_HOST_SCENES = [
  {
    // Users' opening picture: the heading with Invite, the search box and
    // the whole list, the admin first, the members, the invited person, and
    // the deactivated one under its group line. The pointer rests outside
    // the list, so no row shows its hover.
    id: "users-list",
    file: "self-host/users-list.webp",
    pages: ["docs/self-host/users.md"],
    kind: "still",
    state: "self-host",
    crop: { selector: ["[data-list-heading]", USERS_LIST], margin: 24 },
    async open(page) {
      await steadyUserDates(page);
      await page.goto("/users");
      await page.locator(USERS_LIST).getByRole("button", { name: new RegExp(SELF_HOST.deactivated.name) }).waitFor();
      await page.locator(USERS_LIST).getByText(`Deactivated · 1`, { exact: true }).waitFor();
      await page.mouse.move(0, 0);
    },
  },
  {
    // What leaves the instance, beside the services that stay off: the
    // first three cards of Data & services, the address finder and travel
    // time each Not set up with its address row alone, and OpenStreetMap on
    // the public Overpass server with its numbers and its empty cache. The
    // instance's environment sets none of the three.
    id: "what-leaves-the-instance-data-services",
    file: "self-host/what-leaves-the-instance-data-services.webp",
    pages: ["docs/self-host/what-leaves-the-instance.md"],
    kind: "still",
    state: "self-host",
    crop: { selector: ["#data-geocoder", "#data-osm"], margin: 16 },
    async open(page) {
      await page.goto("/settings/data");
      for (const card of ["#data-geocoder", "#data-travel"]) await page.locator(card).getByText("Not set up", { exact: true }).waitFor();
      await page.locator("#data-osm #set-osm-cache").waitFor();
      await page.locator(SETTINGS_HEADING).hover();
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
  {
    // The built-in basemap's credit in the lower right corner of a
    // template's map, as the earthquakes template opens on its own page,
    // with a little of the map around it. The template's widget rail ends
    // with its Sources card about 11 CSS pixels above the credit, so a
    // margin wider than that frames a cut-off piece of the card. The page
    // writes nothing, so the seeded state stays as the other scenes find
    // it. A published map carries the same credit, but its page keeps its
    // author's theme whatever the reader's, so it would draw one picture in
    // both takes.
    id: "licence-and-credits-map-credit",
    file: "about/licence-and-credits-map-credit.webp",
    pages: ["docs/about/licence-and-credits.md"],
    kind: "still",
    state: "seeded",
    map: true,
    crop: { selector: "[data-map-credit]", margin: 8 },
    async open(page) {
      await page.goto("/templates/earthquakes");
      await page.locator("[data-map-credit] a").nth(1).waitFor();
    },
  },
  ...MAIN_SCREEN_SCENES,
  ...FIRST_MAP_SCENES,
  ...SQL_PAGE_SCENES,
  ...WORKFLOW_PAGE_SCENES,
  ...ASSISTANT_PAGE_SCENES,
  ...SETTINGS_PAGE_SCENES,
  ...USE_MAPS_SCENES,
  ...TEMPLATE_SCENES,
  ...USE_SHARING_SCENES,
  ...SELF_HOST_SCENES,
];

export const STATES = ["fresh", "seeded", "first-map", "sql", "workflow", "workflow-run", "assistant", "member", "use-maps", "use-share", "self-host"];

/** The states taken signed in as the second account, a member, rather than
 * the first, the instance's admin. */
export const MEMBER_STATES = ["member"];

/** What makes a state after the seeded one from the state before it,
 * called once a run with the first account's API client, the checkout's
 * root and what the seeding returned (the instance's address and the
 * second account's client among it). `sql` has none: it is the first map's state, in a browser of its
 * own, so the SQL workspace's stored draft and history stay among its own
 * scenes. */
export const STATE_SEEDING = {
  "first-map": seedFirstMap,
  workflow: seedWorkflow,
  "workflow-run": runWorkflow,
  assistant: seedAssistantMap,
  member: seedMember,
  "use-maps": seedUseMaps,
  "use-share": seedUseShare,
  "self-host": seedSelfHost,
};
