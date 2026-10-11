// Templates in a browser: a template's shared address opening before the
// Templates page was visited; the Templates page listing a map template and
// a workflow example from a catalogue; the map template opening read-only
// (the download line while its archive is held, How it's made with its
// sections, Make a copy the only action, the copied note's credits in the
// reader) with no writing request sent from the view; Make a copy landing
// in the builder with the note's credits; the workflow example's node
// panel saying a step's output is the template's result, and its copy's
// saying it was copied from the template. Every journey runs as the browser
// fixture's admin and puts back what it changed: the catalogue's address
// and switch, the downloads, and every copy.
//
// The instance must run on loopback away from port 3000 with
// DEZFIL_EGRESS_ALLOWLIST=127.0.0.1, so the server may read the catalogue
// this spec serves from a fixture on this machine; nothing here reaches
// another machine. The fixture's templates are built in a scratch folder
// of this process's own, never the instance's data folder. The journey
// skips where the server's environment names the catalogue.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page, type Request } from "@playwright/test";
import { buildTools } from "../src/lib/tools/tools";
import { buildTemplate, FIXTURE_SOURCES, type BuiltTemplate } from "../test-support/templates/builder";
import { startLoopbackCatalogue, type LoopbackCatalogue } from "../test-support/templates/catalogue";
import { readThenWriteRequestSetup } from "./edit-basis";
import { isAllowedConsoleError } from "./console-allowlist";
import { runTag } from "./sharing-support";
import { routeHouse, trackConsole, type ConsoleError } from "./support";

const SETTINGS = "/api/instance/settings";
const CATALOGUE_KEYS = ["templatesCatalogueUrl", "templates.catalogue"];
const TAG = runTag();
const MAP_ID = `journey-harbour-${TAG}`;
const WORKFLOW_ID = `journey-busy-${TAG}`;
const MAP_TITLE = `Harbour stations ${TAG}`;
const WORKFLOW_TITLE = `Busy stations ${TAG}`;
/** The workflow example's buffer step's output, drawn as a node. */
const RINGS = "station_rings";

let scratch = "";
let catalogue: LoopbackCatalogue | null = null;
let mapTemplate: BuiltTemplate;
let workflowTemplate: BuiltTemplate;
let environmentNamesCatalogue = false;
/** Whether setup passed the isolation check: teardown touches no instance
 * setup refused. */
let isolated = false;
/** Whether setup sent the catalogue's address and switch: only then does
 * teardown put them back and remove what was downloaded from it. */
let catalogueWritten = false;
/** What each copy made, removed after the journeys. */
const copies: Landed[] = [];

interface Landed {
  project: { id: string };
  members: { maps: { id: string }[]; recipes: { id: string }[]; tables: { id: string; name: string }[] };
}

/** The instance under test, from the same variable the configuration
 * reads, checked before any hook writes to it. */
function requireIsolatedInstance(): void {
  const base = new URL(process.env.DEZFIL_BASE_URL ?? "http://localhost:3000");
  if (!["localhost", "127.0.0.1"].includes(base.hostname) || base.port === "3000") {
    throw new Error("requires an isolated loopback DEZFIL_BASE_URL away from port 3000");
  }
}

function expectQuiet(errors: ConsoleError[]): void {
  expect(errors.filter(error => !isAllowedConsoleError(error.text, error.url))).toEqual([]);
}

// ---------------------------------------------------------------------------
// The watch on writing requests.

/** Every documented operation as a method and a pattern over its path,
 * with whether it changes anything on this server. */
const OPERATIONS = buildTools().map(tool => ({
  method: tool.method.toUpperCase(),
  pattern: new RegExp(`^${tool.path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
  params: (tool.path.match(/\{/g) ?? []).length,
  readOnly: tool.effects.readOnly,
}));

/** Whether a request changes nothing on this server: a read, or a
 * documented operation that declares itself read-only (where two
 * operations' paths both match, the one with fewer parameters, the more
 * literal, is the request's). Anything else, an undocumented non-read
 * included, counts as a write. */
function changesNothing(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const operation = OPERATIONS
    .filter(each => each.method === method && each.pattern.test(pathname))
    .sort((a, b) => a.params - b.params)[0];
  return operation?.readOnly === true;
}

/** Record every request to this server, from the moment it starts, that
 * could change anything there, but for the one download the view is
 * allowed to make. */
function watchWrites(page: Page, origin: string, templateId: string): string[] {
  const writes: string[] = [];
  const download = `/api/templates/${encodeURIComponent(templateId)}/fetch`;
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    const method = request.method();
    if (method === "POST" && url.pathname === download) return;
    if (!changesNothing(method, url.pathname)) writes.push(`${method} ${url.pathname}`);
  });
  return writes;
}

/** The watch shown to bite: a write the server refuses, sent from the
 * page, is caught; nothing is written, since the map does not exist. */
async function watchBites(page: Page, writes: string[]): Promise<void> {
  const before = writes.length;
  const refused = await page.evaluate(async () => (await fetch("/api/maps/not-a-map", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "{}",
  })).status);
  expect(refused).toBeGreaterThanOrEqual(400);
  expect(writes.slice(before)).toEqual(["PATCH /api/maps/not-a-map"]);
}

// ---------------------------------------------------------------------------
// Steps.

const card = (page: Page, id: string) => page.locator(`[data-template="${id}"]`);
const view = (page: Page) => page.locator("body[data-template-view]");
const panel = (page: Page) => page.locator("aside[data-template-panel]");
const folds = (page: Page) => panel(page).locator("[data-fold]");
const note = (page: Page) => page.locator('[data-widget-card="note"]');

/** The note's credit lines, every source's, where the note is drawn. */
async function expectCredits(page: Page): Promise<void> {
  for (const source of FIXTURE_SOURCES) await expect(note(page)).toContainText(source.credit);
}

/** The header holds Make a copy and nothing else: no run chrome, no undo. */
async function expectCopyTheOnlyAction(page: Page, title: string): Promise<void> {
  await expect(page.locator("#header-actions-right button")).toHaveCount(1);
  await expect(page.locator("#header-actions-right [data-template-copy]")).toHaveAttribute("aria-label", `Make a copy of ${title}`);
  await expect(page.locator("#header-actions-left button")).toHaveCount(0);
}

/** Make a copy from the view's action, into a project named for this run:
 * answers what the copy made, once the page has landed on it. */
async function makeCopy(page: Page, template: BuiltTemplate, landing: RegExp): Promise<Landed> {
  const { id, title, version } = template.facts;
  await page.locator("[data-template-copy]").click();
  const dialog = page.locator("[data-template-copy-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-copy-sub]")).toHaveText(`${title}, version ${version}, becomes yours in a new project.`);
  await dialog.getByRole("textbox", { name: "Project name" }).fill(`Journey ${title}`);
  const copied = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/templates/${id}/copy` && response.request().method() === "POST");
  await dialog.locator("[data-copy-confirm]").click();
  const answer = await copied;
  expect(answer.status()).toBe(201);
  const landed = await answer.json() as Landed;
  copies.push(landed);
  await expect(page).toHaveURL(landing);
  return landed;
}

/** Open a node's panel on the canvas, clear of the results band where
 * there is one. */
async function selectNode(page: Page, name: string): Promise<void> {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.getByRole("button", { name: "Fit to view" }).click();
  await page.waitForTimeout(300);
  const band = page.locator("[data-results-band]");
  if (await band.count()) {
    const bar = await band.boundingBox();
    const stage = await page.locator("[data-canvas-stage]").boundingBox();
    if (bar && stage) {
      let top = Infinity;
      for (const tile of await page.locator("[data-node]").all()) {
        const box = await tile.boundingBox();
        if (box && box.x < stage.x + stage.width && box.x + box.width > stage.x) top = Math.min(top, box.y);
      }
      const shift = top !== Infinity ? Math.max(0, Math.ceil(stage.y + stage.height + 12 - top)) : 0;
      if (shift > 0) {
        const x = bar.x + bar.width * 0.5;
        const y = bar.y - 8;
        await page.mouse.move(x, y);
        await page.mouse.down();
        const steps = Math.max(3, Math.ceil(shift / 40));
        for (let i = 1; i <= steps; i++) await page.mouse.move(x, y + (shift * i) / steps);
        await page.mouse.up();
        await page.waitForTimeout(200);
      }
    }
  }
  await page.locator(`[data-node][data-name="${name}"] [data-v]`).first().click();
  await expect(page.locator("[data-node-panel]")).toBeVisible();
}

/** Remove one copy: its workflow and map, its project, then its datasets. */
async function removeCopy(request: APIRequestContext, landed: Landed): Promise<void> {
  for (const recipe of landed.members.recipes) {
    await readThenWriteRequestSetup(request, `/api/recipes/${recipe.id}`, () => ({ method: "DELETE" })).catch(() => undefined);
  }
  for (const map of landed.members.maps) {
    await readThenWriteRequestSetup(request, `/api/maps/${map.id}`, () => ({ method: "DELETE" })).catch(() => undefined);
  }
  await request.delete(`/api/projects/${landed.project.id}`).catch(() => undefined);
  for (const table of landed.members.tables) await request.delete(`/api/tables/${table.name}`).catch(() => undefined);
}

// ---------------------------------------------------------------------------

test.beforeAll(async ({ request }) => {
  requireIsolatedInstance();
  isolated = true;
  const read = await (await request.get(SETTINGS)).json() as { settings: Record<string, { source: string }> };
  environmentNamesCatalogue = read.settings.templatesCatalogueUrl?.source === "environment";
  if (environmentNamesCatalogue) return;
  // The builder writes its datasets through the engine, whose data folder
  // is this scratch folder for as long as the build takes.
  scratch = await mkdtemp(path.join(os.tmpdir(), "dezfil-templates-journey-"));
  const previous = process.env.DEZFIL_DATA_DIR;
  process.env.DEZFIL_DATA_DIR = path.join(scratch, "data");
  try {
    mapTemplate = await buildTemplate(path.join(scratch, "map"), { kind: "map", id: MAP_ID, title: MAP_TITLE });
    workflowTemplate = await buildTemplate(path.join(scratch, "workflow"), { kind: "workflow", id: WORKFLOW_ID, title: WORKFLOW_TITLE });
  } finally {
    if (previous === undefined) delete process.env.DEZFIL_DATA_DIR;
    else process.env.DEZFIL_DATA_DIR = previous;
  }
  catalogue = await startLoopbackCatalogue();
  await catalogue.publish([mapTemplate, workflowTemplate]);
  // The literal loopback address, which the allowlist names; a new port
  // each run, so the server's kept list goes with the address it replaces.
  const address = new URL(catalogue.indexUrl);
  address.hostname = "127.0.0.1";
  // Set before the write, which may land even if its answer is lost.
  catalogueWritten = true;
  const saved = await request.patch(SETTINGS, { data: { templatesCatalogueUrl: address.toString(), "templates.catalogue": true } });
  expect(saved.status()).toBe(200);
});

test.beforeEach(async ({ context }) => {
  requireIsolatedInstance();
  test.skip(environmentNamesCatalogue, "the server's environment names the template catalogue");
  await routeHouse(context);
});

// Teardown puts back only what this spec made, and only on an instance
// setup accepted: where setup refused the instance (the default address
// included), it writes nothing there.
test.afterAll(async ({ request }) => {
  try {
    if (isolated) {
      for (const landed of copies) await removeCopy(request, landed);
      if (catalogueWritten) {
        await request.delete("/api/templates/downloads");
        await request.patch(SETTINGS, { data: Object.fromEntries(CATALOGUE_KEYS.map(key => [key, null])) });
      }
    }
  } finally {
    await catalogue?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
});

test.describe("Templates", () => {
  test.describe.configure({ mode: "serial" });

  test("a shared template address opens before the Templates page was visited", async ({ page, baseURL }) => {
    const errors = trackConsole(page);
    const writes = watchWrites(page, new URL(baseURL!).origin, WORKFLOW_ID);
    const response = await page.goto(`/templates/${WORKFLOW_ID}`);
    expect(response?.status()).toBe(200);
    await expect(view(page)).toHaveCount(1);
    await expect(page.locator("[data-template-fallback]")).toHaveCount(0);
    await expect(page.locator("[data-workflow-canvas]")).toBeVisible({ timeout: 30_000 });
    await expect(panel(page)).toBeVisible();
    expect(writes).toEqual([]);
    expectQuiet(errors);
  });

  test("the Templates page lists both, a map template opens read-only with its credits, and its copy lands in the builder", async ({ page, baseURL }) => {
    const errors = trackConsole(page);
    await page.goto("/templates");
    await expect(card(page, MAP_ID)).toBeVisible();
    await expect(card(page, WORKFLOW_ID)).toBeVisible();
    await expect(card(page, MAP_ID).locator('[data-field="title"]')).toHaveText(MAP_TITLE);
    await expect(card(page, WORKFLOW_ID).locator('[data-field="title"]')).toHaveText(WORKFLOW_TITLE);
    // The map template is listed only; the workflow example was downloaded
    // when its shared address opened.
    await expect(card(page, MAP_ID).locator('[data-field="absent"]')).toContainText("when opened");
    await expect(card(page, WORKFLOW_ID).locator('[data-field="absent"]')).toHaveCount(0);

    // Held at the archive, the view says it is downloading; let go, the
    // reader takes its place.
    const archive = catalogue!.hold(`/archives/${MAP_ID}-${mapTemplate.facts.version}.zip`, await readFile(mapTemplate.archive));
    const writes = watchWrites(page, new URL(baseURL!).origin, MAP_ID);
    await card(page, MAP_ID).locator('[data-hint="Open"]').click();
    await expect(page).toHaveURL(new RegExp(`/templates/${MAP_ID}$`));
    await archive.arrived;
    await expect(page.locator("[data-template-downloading]")).toContainText("Downloading the template");
    archive.release();
    await expect(page.locator("[data-template-downloading]")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator("[data-template-fallback]")).toHaveCount(0);
    await expect(view(page)).toHaveCount(1);

    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute("aria-label", "How it's made");
    await expect(folds(page)).toHaveCount(4);
    for (const name of ["question", "data", "layers", "styling"]) {
      await expect(panel(page).locator(`[data-fold="${name}"]`)).toHaveCount(1);
    }
    await expectCopyTheOnlyAction(page, MAP_TITLE);
    await expectCredits(page);

    expect(writes).toEqual([]);
    expectQuiet(errors);
    await watchBites(page, writes);

    const landed = await makeCopy(page, mapTemplate, /\/maps\/[^/]+$/);
    expect(new URL(page.url()).pathname).toBe(`/maps/${landed.members.maps[0].id}`);
    await expectCredits(page);
    await expect(view(page)).toHaveCount(0);
  });

  test("a workflow example's node panel names the template's result, and its copy's names the copy", async ({ page }) => {
    const errors = trackConsole(page);
    await page.goto("/templates");
    await card(page, WORKFLOW_ID).locator('[data-hint="Open"]').click();
    await expect(page).toHaveURL(new RegExp(`/templates/${WORKFLOW_ID}$`));
    await expect(page.locator("[data-template-fallback]")).toHaveCount(0);
    await expect(folds(page)).toHaveCount(5);
    for (const name of ["question", "data", "workflow", "layers", "styling"]) {
      await expect(panel(page).locator(`[data-fold="${name}"]`)).toHaveCount(1);
    }
    await expectCopyTheOnlyAction(page, WORKFLOW_TITLE);
    await selectNode(page, RINGS);
    await expect(page.locator("[data-node-panel] [data-last-run]")).toHaveText("the template's result");

    const landed = await makeCopy(page, workflowTemplate, /\/workflows\/[^/]+$/);
    expect(new URL(page.url()).pathname).toBe(`/workflows/${landed.members.recipes[0].id}`);
    await selectNode(page, RINGS);
    await expect(page.locator("[data-node-panel] [data-last-run]")).toHaveText("copied from the template");
    expectQuiet(errors);
  });
});
