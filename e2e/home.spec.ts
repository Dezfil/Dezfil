// Home in a browser: where the lead, Start and the templates below stand at
// the two windows the page is drawn for and as the window narrows, nothing
// scrolling sideways or standing past the window's edge; the whole Tab
// order of a fresh account's Home and of a busy one's, every stop drawing
// the focus ring, Enter opening a card and a row; a copy made from the
// templates below landing on its canvas, then leading Home with its
// workflow and datasets in Recent; and the lead's place keeping its height
// while the lead is worked out.
//
// The instance must be a dedicated one, on loopback away from port 3000,
// whose server reads its template catalogue from a folder on this machine:
// DEZFIL_TEMPLATES_CATALOGUE names that folder, holding at least nine
// templates, in the server's environment and in this process's, which
// reads the folder's index and nothing else. Without the variable the
// journey skips. Every browser request off the loopback is refused, as the
// other journeys refuse them. The journey makes two accounts of its own,
// invited by the browser fixture's admin, and teardown removes what they
// made.
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import type { TemplateCard, TemplateList } from "../src/lib/templates/card";
import { isAllowedConsoleError } from "./console-allowlist";
import { browserApi, readThenWriteBrowserSetup, readThenWriteRequestSetup } from "./edit-basis";
import { setLook } from "./look-evidence";
import { closeAll, invitePerson, runTag, type Person } from "./sharing-support";
import { createMap, routeHouse, seedCsv, trackConsole, type ConsoleError } from "./support";

const CATALOGUE = process.env.DEZFIL_TEMPLATES_CATALOGUE ?? "";
/** A folder, not an address: the variable may name either. */
const NAMES_FOLDER = CATALOGUE !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(CATALOGUE);
const TAG = runTag();
/** The windows the page is drawn for. */
const WINDOWS = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }];
/** Below the width at which the lead and Start stand side by side. */
const BELOW_BESIDE = { width: 860, height: 800 };
/** The galleries' narrow width, where a card takes the whole row. */
const NARROW = { width: 600, height: 800 };
const START_STOPS = ["button New map", "button Add data", "button New workflow", "link Open SQL"];

/** The template list once the catalogue folder was read, as the server
 * answers it: the order every expectation below is stated in. */
let list: TemplateCard[] = [];
/** A fresh account: nothing of its own until it copies a template. */
let fresh: Person | undefined;
/** An account with a map of its own, a workflow to run again and its
 * datasets. */
let busy: Person | undefined;
/** What each account made, removed after the journeys. */
const made: { person: Person; maps: string[]; recipes: string[]; tables: string[]; projects: string[] }[] = [];

/** The instance under test, from the same variable the configuration reads,
 * checked before anything is written to it. */
function requireIsolatedInstance(): void {
  const base = new URL(process.env.DEZFIL_BASE_URL ?? "http://localhost:3000");
  if (!["localhost", "127.0.0.1"].includes(base.hostname) || base.port === "3000") {
    throw new Error("requires an isolated loopback DEZFIL_BASE_URL away from port 3000");
  }
}

function expectQuiet(errors: ConsoleError[]): void {
  expect(errors.filter((error) => !isAllowedConsoleError(error.text, error.url))).toEqual([]);
}

// ---------------------------------------------------------------------------
// Reading the page.

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const measured = await locator.boundingBox();
  if (!measured) throw new Error("the part is not drawn");
  return measured;
}

const leadPlace = (page: Page) => page.locator("[data-lead]");
const start = (page: Page) => page.locator("[data-start]");
const recentRows = (page: Page) => page.locator("[data-recent-row]");
const cardStops = (t: TemplateCard) => [`link Open ${t.title}`, `button Open ${t.title}`, `button Make a copy of ${t.title}`];

/** Wait until nothing on Home is still rising in, so a box is measured at
 * rest; the pointer rests on the welcome, off every card. */
async function atRest(page: Page): Promise<void> {
  await page.locator("[data-welcome]").hover();
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      const endless = animation.effect?.getComputedTiming().iterations === Infinity;
      return endless || !(target instanceof Element) || !target.closest("[data-home]") || animation.playState !== "running";
    }),
  );
}

/** Open Home and wait for its parts: the lead chosen, Recent and the
 * templates below drawn or absent. */
async function openHome(page: Page, lead: "template" | "continue"): Promise<void> {
  await page.goto("/");
  await expect(page.locator(`[data-lead="${lead}"]`)).toBeVisible();
  await expect(page.locator('[data-recent-place="pending"]')).toHaveCount(0);
  await expect(page.locator('[data-shelf="pending"]')).toHaveCount(0);
  await atRest(page);
}

async function expectBeside(page: Page, what: string): Promise<void> {
  const lead = await box(leadPlace(page));
  const beside = await box(start(page));
  expect(beside.x, `${what}: Start stands right of the lead`).toBeGreaterThanOrEqual(lead.x + lead.width);
  expect(Math.abs(beside.y - lead.y), `${what}: Start's top is the lead's`).toBeLessThanOrEqual(1);
  expect(Math.abs(beside.height - lead.height), `${what}: Start is as tall as the lead`).toBeLessThanOrEqual(1);
}

async function expectUnder(page: Page, what: string): Promise<void> {
  const lead = await box(leadPlace(page));
  const under = await box(start(page));
  expect(under.y, `${what}: Start stands under the lead`).toBeGreaterThanOrEqual(lead.y + lead.height);
  expect(Math.abs(under.x - lead.x), `${what}: Start starts where the lead does`).toBeLessThanOrEqual(1);
}

/** The templates below as drawn, row by row, each row's ids left to right. */
function shelfRows(page: Page): Promise<string[][]> {
  return page.locator('[data-shelf="shown"] [data-template]').evaluateAll((cards) => {
    const rows: { top: number; cards: { left: number; id: string }[] }[] = [];
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      let row = rows.find((each) => Math.abs(each.top - r.top) <= 1);
      if (!row) rows.push((row = { top: r.top, cards: [] }));
      row.cards.push({ left: r.left, id: card.getAttribute("data-template") ?? "" });
    }
    return rows.sort((a, b) => a.top - b.top).map((row) => row.cards.sort((a, b) => a.left - b.left).map((each) => each.id));
  });
}

/** In rows of `per`, the ids in the list's order. */
const inRows = (cards: TemplateCard[], per: number) =>
  Array.from({ length: Math.ceil(cards.length / per) }, (_, i) => cards.slice(i * per, i * per + per).map((t) => t.id));

/** Nothing scrolls sideways, and no part of Home stands past the window's
 * edges: the page, its sections and cards, the start actions, the rows,
 * and the template lead's words and actions. */
async function expectNothingSideways(page: Page, what: string): Promise<void> {
  const found = await page.evaluate(() => {
    const root = document.documentElement;
    const width = root.clientWidth;
    const parts = document.querySelectorAll(
      "[data-home], [data-home] section, [data-home] article, [data-start-action], [data-recent-row], [data-attention], " +
        '[data-lead] [data-field="title"], [data-lead] [data-field="question"], [data-lead] button',
    );
    const outside = [...parts]
      .filter((part) => {
        const r = part.getBoundingClientRect();
        return r.width > 0 && (r.left < -0.5 || r.right > width + 0.5);
      })
      .map((part) => `${part.tagName.toLowerCase()} ${part.getAttribute("aria-label") ?? part.getAttribute("data-field") ?? ""}`.trim());
    return { scroll: root.scrollWidth, width, outside };
  });
  expect(found.scroll, `${what}: nothing scrolls sideways`).toBeLessThanOrEqual(found.width);
  expect(found.outside, `${what}: nothing stands past the window's edges`).toEqual([]);
}

/** Tab from the welcome through Home: each stop as its role and name, the
 * stops that do not draw the census's ring (reached by keyboard,
 * :focus-visible, a solid outline at least 2px wide), and the stops whose
 * ring an ancestor's clip cuts off on some side, until focus leaves Home.
 * Clicking the welcome makes it where Tab starts from. */
async function tabThroughHome(page: Page, most = 80): Promise<{ stops: string[]; ringless: string[]; clipped: string[] }> {
  await page.locator("[data-welcome]").click();
  const stops: string[] = [];
  const ringless: string[] = [];
  const clipped: string[] = [];
  for (let i = 0; i < most; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest("[data-home]")) return null;
      const role = el.getAttribute("role") ?? (el.tagName === "A" ? "link" : el.tagName.toLowerCase());
      const name = el.getAttribute("aria-label") ?? (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const style = getComputedStyle(el);
      const ring = el.matches(":focus-visible") && style.outlineStyle === "solid" && parseFloat(style.outlineWidth) >= 2;
      // The ring's outer edge, and whether an ancestor that clips its
      // overflow cuts it on any side.
      const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      const r = el.getBoundingClientRect();
      let cut = false;
      for (let a = el.parentElement; a && !cut; a = a.parentElement) {
        const own = getComputedStyle(a);
        if (own.overflowX === "visible" && own.overflowY === "visible") continue;
        const c = a.getBoundingClientRect();
        const inner = { left: c.left + a.clientLeft, top: c.top + a.clientTop, right: c.left + a.clientLeft + a.clientWidth, bottom: c.top + a.clientTop + a.clientHeight };
        cut = r.left - reach < inner.left - 0.5 || r.top - reach < inner.top - 0.5 || r.right + reach > inner.right + 0.5 || r.bottom + reach > inner.bottom + 0.5;
      }
      return { stop: `${role} ${name}`, ring, cut };
    });
    if (stop === null) break;
    stops.push(stop.stop);
    if (!stop.ring) ringless.push(stop.stop);
    if (stop.cut) clipped.push(stop.stop);
  }
  return { stops, ringless, clipped };
}

/** Press Tab from where focus stands until the target holds it. */
async function tabTo(page: Page, target: Locator, what: string, most = 80): Promise<void> {
  for (let i = 0; i < most; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`${what} is not reachable by keyboard (${most} Tabs)`);
}

/** The lead's place and Start, measured while the workflows read is held
 * and again once it answers: the place keeps its height meanwhile. */
async function heldAndArrived(page: Page, lead: "template" | "continue"): Promise<{ pending: Box[]; arrived: Box[] }> {
  const workflowsRead = /\/api\/recipes\?origin=workflow$/;
  // Every read of the workflows is held, a development build's second
  // mount's included, and all are let go together.
  const held: Route[] = [];
  await page.route(workflowsRead, (route) => {
    held.push(route);
  });
  await page.goto("/");
  await expect(page.locator('[data-lead="pending"]')).toBeVisible();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await atRest(page);
  const pending = [await box(leadPlace(page)), await box(start(page))];
  await page.unroute(workflowsRead);
  for (const route of held) await route.continue();
  await expect(page.locator(`[data-lead="${lead}"]`)).toBeVisible();
  await atRest(page);
  return { pending, arrived: [await box(leadPlace(page)), await box(start(page))] };
}

// ---------------------------------------------------------------------------

test.describe("Home", () => {
  test.skip(!NAMES_FOLDER, "needs DEZFIL_TEMPLATES_CATALOGUE naming a local catalogue folder, in the server's environment and this process's");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser, request, baseURL }) => {
    requireIsolatedInstance();
    const index = JSON.parse(readFileSync(path.join(CATALOGUE, "index.json"), "utf8")) as { templates?: unknown[] };
    expect(index.templates?.length ?? 0, "the catalogue folder lists at least nine templates").toBeGreaterThanOrEqual(9);
    const listed = (await (await request.get("/api/templates")).json()) as TemplateList;
    expect(listed.catalogue.folder, "the server reads its catalogue from a folder").toBe(true);
    expect(listed.catalogue.state, "the catalogue is in use on this instance").not.toBe("off");
    // Read the folder now, so every page below answers its list whole.
    const refreshed = await request.post("/api/templates/refresh");
    expect(refreshed.status()).toBe(200);
    list = ((await refreshed.json()) as TemplateList).templates;
    expect(list.length, "the template list holds at least nine").toBeGreaterThanOrEqual(9);
    fresh = await invitePerson(browser, request, baseURL!, "Wren", TAG);
    busy = await invitePerson(browser, request, baseURL!, "Rhea", TAG);
    for (const person of [fresh, busy]) {
      await routeHouse(person.context);
      made.push({ person, maps: [], recipes: [], tables: [], projects: [] });
    }
  });

  // Teardown removes what the two accounts made, as each of them.
  test.afterAll(async () => {
    for (const { person, maps, recipes, tables, projects } of made) {
      for (const id of recipes) await readThenWriteRequestSetup(person.api, `/api/recipes/${id}`, () => ({ method: "DELETE" })).catch(() => undefined);
      for (const id of maps) await readThenWriteRequestSetup(person.api, `/api/maps/${id}`, () => ({ method: "DELETE" })).catch(() => undefined);
      for (const id of projects) await person.api.delete(`/api/projects/${id}`).catch(() => undefined);
      for (const name of tables) await person.api.delete(`/api/tables/${name}`).catch(() => undefined);
    }
    await closeAll([fresh, busy]);
  });

  test("a fresh account: the template lead beside Start at both windows, eight templates in two rows of four, nothing sideways", async () => {
    const page = await fresh!.context.newPage();
    const errors = trackConsole(page);
    for (const rail of ["hover", "open"] as const) {
      await setLook(fresh!.api, { rail });
      for (const window of WINDOWS) {
        const what = `${window.width} × ${window.height}, rail ${rail}`;
        await page.setViewportSize(window);
        await openHome(page, "template");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome, Wren");
        // The tree the screen reader walks: one first-level heading, one
        // heading per present section, none for Recent.
        expect(await page.getByRole("heading").allTextContents()).toEqual([
          "Welcome, Wren", "Start with a template", "Or start your own", "What Dezfil can do",
        ]);
        await expect(leadPlace(page).locator('[data-field="title"]')).toHaveText(list[0].title);
        await expectBeside(page, what);
        await expect(page.locator('[data-shelf="shown"] h2')).toHaveText("What Dezfil can do");
        await expect(page.locator("[data-shelf-count]")).toHaveText(`${list.length} templates on open data`);
        expect(await shelfRows(page), `${what}: the next eight, four to a row`).toEqual(inRows(list.slice(1, 9), 4));
        await expect(page.locator("[data-recent]")).toHaveCount(0);
        await expectNothingSideways(page, what);
      }
    }
    await setLook(fresh!.api, { rail: "hover" });

    // The template's arrival in the place held for it: measured for the
    // record; the place keeps Continue's height, and the template lead
    // stands taller by its title and question.
    await page.setViewportSize(WINDOWS[0]);
    const { pending, arrived } = await heldAndArrived(page, "template");
    test.info().annotations.push({
      type: "the lead's place",
      description: `template lead at 1280 × 800: the place ${Math.round(pending[0].height)} px while read, ${Math.round(arrived[0].height)} px once drawn`,
    });
    await page.close();
    expectQuiet(errors);
  });

  test("below the side-by-side width Start stands under the lead; at the narrow width nothing is cut off or scrolls sideways", async () => {
    const page = await fresh!.context.newPage();
    const errors = trackConsole(page);
    await page.setViewportSize(BELOW_BESIDE);
    await openHome(page, "template");
    await expectUnder(page, "860 × 800");
    expect(await shelfRows(page), "860 × 800: two to a row").toEqual(inRows(list.slice(1, 9), 2));
    await expectNothingSideways(page, "860 × 800");

    await page.setViewportSize(NARROW);
    await openHome(page, "template");
    await expectUnder(page, "600 × 800");
    expect(await shelfRows(page), "600 × 800: one to a row").toEqual(inRows(list.slice(1, 9), 1));
    // The template's actions stand under its words, inside its card.
    const card = await box(leadPlace(page).locator("article"));
    const question = await box(leadPlace(page).locator('[data-field="question"]'));
    for (const name of [`Open ${list[0].title}`, `Make a copy of ${list[0].title}`]) {
      const action = await box(leadPlace(page).getByRole("button", { name, exact: true }));
      expect(action.y, `${name} stands under the question`).toBeGreaterThanOrEqual(question.y + question.height);
      expect(action.x + action.width, `${name} stands inside the card`).toBeLessThanOrEqual(card.x + card.width);
      expect(action.y + action.height, `${name} stands inside the card`).toBeLessThanOrEqual(card.y + card.height);
    }
    await expectNothingSideways(page, "600 × 800");
    await page.close();
    expectQuiet(errors);
  });

  test("a fresh account's Tab order: the template lead and its actions, Start, the link to all, every card and its two actions, each with the ring; Enter opens the lead", async () => {
    const page = await fresh!.context.newPage();
    const errors = trackConsole(page);
    await page.setViewportSize(WINDOWS[0]);
    await openHome(page, "template");
    const { stops, ringless, clipped } = await tabThroughHome(page);
    expect(clipped, "no ring is cut by a clip").toEqual([]);
    expect(stops).toEqual([
      ...cardStops(list[0]),
      ...START_STOPS,
      "link All templates",
      ...list.slice(1, 9).flatMap(cardStops),
    ]);
    expect(ringless, "every stop draws the ring").toEqual([]);

    await page.locator("[data-welcome]").click();
    await tabTo(page, leadPlace(page).getByRole("link", { name: `Open ${list[0].title}` }), "the template lead");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/templates/${list[0].id}$`));
    await page.close();
    expectQuiet(errors);
  });

  test("a copy made from the templates below lands, then leads Home with its workflow and datasets in Recent; four templates in one row at both windows", async () => {
    const page = await fresh!.context.newPage();
    const errors = trackConsole(page);
    await page.setViewportSize(WINDOWS[0]);
    await openHome(page, "template");
    const below = list.slice(1, 9);
    const chosen = below.find((t) => t.kind === "workflow") ?? below[0];
    const card = page.locator(`[data-shelf="shown"] [data-template="${chosen.id}"]`);
    await card.hover();
    await card.getByRole("button", { name: `Make a copy of ${chosen.title}`, exact: true }).click();
    const dialog = page.locator("[data-template-copy-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Project name" }).fill(`Home copy ${TAG}`);
    // A template not on this server yet downloads from the folder first.
    const copied = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/templates/${chosen.id}/copy` && response.request().method() === "POST", { timeout: 120_000 });
    await dialog.locator("[data-copy-confirm]").click();
    const answer = await copied;
    expect(answer.status()).toBe(201);
    const landed = (await answer.json()) as {
      project: { id: string };
      members: { maps: { id: string }[]; recipes: { id: string }[]; tables: { id: string; name: string }[] };
    };
    const record = made[0];
    record.projects.push(landed.project.id);
    record.maps.push(...landed.members.maps.map((m) => m.id));
    record.recipes.push(...landed.members.recipes.map((r) => r.id));
    record.tables.push(...landed.members.tables.map((t) => t.name));
    const landing = chosen.kind === "workflow" ? `/workflows/${landed.members.recipes[0].id}` : `/maps/${landed.members.maps[0].id}`;
    await expect(page).toHaveURL(new RegExp(`${landing}$`), { timeout: 60_000 });

    // Home: the copy's map leads, wearing no owner; the rest of the copy
    // is in Recent, newest first, eight at most.
    const mapName = ((await (await fresh!.api.get(`/api/maps/${landed.members.maps[0].id}`)).json()) as { name: string }).name;
    const recipeNames: string[] = [];
    for (const recipe of landed.members.recipes) {
      recipeNames.push(((await (await fresh!.api.get(`/api/recipes/${recipe.id}`)).json()) as { recipe: { name: string } }).recipe.name);
    }
    const copiedNames = [...recipeNames, ...landed.members.tables.map((t) => t.name)];
    await openHome(page, "continue");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome back, Wren");
    await expect(leadPlace(page).getByRole("link", { name: `Open ${mapName}`, exact: true })).toBeVisible();
    await expect(leadPlace(page).locator("[data-owner-pill]")).toHaveCount(0);
    const rows = await recentRows(page).evaluateAll((each) => each.map((row) => row.getAttribute("aria-label") ?? ""));
    expect(rows).toHaveLength(Math.min(8, copiedNames.length));
    for (const name of rows) expect(copiedNames, `${name} is the copy's`).toContain(name);
    if (copiedNames.length <= 8) expect([...rows].sort()).toEqual([...copiedNames].sort());

    for (const rail of ["hover", "open"] as const) {
      await setLook(fresh!.api, { rail });
      for (const window of WINDOWS) {
        const what = `${window.width} × ${window.height}, rail ${rail}`;
        await page.setViewportSize(window);
        await openHome(page, "continue");
        await expectBeside(page, what);
        await expect(page.locator('[data-shelf="shown"] h2')).toHaveText("From the templates");
        await expect(page.locator("[data-shelf-link]")).toHaveText(`All ${list.length} templates`);
        expect(await shelfRows(page), `${what}: four in one row`).toEqual([list.slice(0, 4).map((t) => t.id)]);
        await expectNothingSideways(page, what);
      }
    }
    await setLook(fresh!.api, { rail: "hover" });
    await page.close();
    expectQuiet(errors);
  });

  test("a busy account's Tab order: Continue, Start, Run, each row, the link to all and the four templates, each with the ring; Enter opens a row; the lead's place keeps its height", async () => {
    test.setTimeout(240_000);
    const page = await busy!.context.newPage();
    const errors = trackConsole(page);
    await page.setViewportSize(WINDOWS[0]);
    const record = made[1];

    await test.step("a workflow to run again, then a map of their own last", async () => {
      await page.goto("/maps");
      const source = `home_src_${TAG}`;
      const output = `home_out_${TAG}`;
      await seedCsv(page, source, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
      record.tables.push(source);
      const created = await browserApi(page, "POST", "/api/recipes", { name: `Home lanes ${TAG}`, origin: "workflow" });
      expect(created.status).toBe(201);
      const id = (created.json.recipe as { id: string }).id;
      record.recipes.push(id);
      const step = await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({
        method: "POST", path: `/api/recipes/${id}/steps`, body: { operation: "sql_step", parameters: { sql: `SELECT * FROM ${source}`, name: output } },
      }));
      expect(step.status).toBe(201);
      const stepId = (step.json.step as { id: string }).id;
      const run = await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/runs`, body: { members: [stepId] } }));
      expect(run.status).toBeLessThan(300);
      await expect.poll(async () => {
        const read = await browserApi(page, "GET", `/api/recipes/${id}`);
        return (read.json.recipe as { steps: { latestAttempt: { state: string } | null }[] }).steps[0]?.latestAttempt?.state ?? "none";
      }, { timeout: 60_000 }).toBe("succeeded");
      record.tables.push(output);
      // An edit awaiting a run makes the workflow one to run again.
      const edited = await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({
        method: "PATCH", path: `/api/recipes/${id}/steps/${stepId}`, body: { parameters: { sql: `SELECT name FROM ${source}`, name: output } },
      }));
      expect(edited.status).toBe(200);
      record.maps.push(await createMap(page, `Home map ${TAG}`));
    });

    // What Rhea reaches, from the lists themselves: her map leads, and
    // Recent is the rest.
    const workflows = ((await (await busy!.api.get("/api/recipes?origin=workflow")).json()) as { recipes: { id: string; name: string; summary: { status: string } }[] }).recipes;
    const tables = (await (await busy!.api.get("/api/tables")).json()) as { name: string }[];
    expect(workflows.map((w) => [w.name, w.summary.status])).toEqual([[`Home lanes ${TAG}`, "run_again"]]);
    const recentNames = [...workflows.map((w) => w.name), ...tables.map((t) => t.name)];

    await openHome(page, "continue");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome back, Rhea");
    const headings = await page.getByRole("heading").allTextContents();
    expect(headings.slice(0, 3)).toEqual(["Welcome back, Rhea", "Continue", "Start"]);
    expect(headings[3]).toMatch(/^Recent( in .+)?$/);
    expect(headings.slice(4)).toEqual(["From the templates"]);
    const rows = await recentRows(page).evaluateAll((each) => each.map((row) => row.getAttribute("aria-label") ?? ""));
    expect([...rows].sort()).toEqual([...recentNames].sort());
    const { stops, ringless, clipped } = await tabThroughHome(page);
    expect(clipped, "no ring is cut by a clip").toEqual([]);
    expect(stops).toEqual([
      `link Open Home map ${TAG}`,
      ...START_STOPS,
      `button Run Home lanes ${TAG}`,
      ...rows.map((name) => `link ${name}`),
      `link All ${list.length} templates`,
      ...list.slice(0, 4).flatMap(cardStops),
    ]);
    expect(ringless, "every stop draws the ring").toEqual([]);

    await page.locator("[data-welcome]").click();
    await tabTo(page, page.locator('[data-recent-row="workflow"]'), "the workflow's row");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/workflows/${record.recipes[0]}$`));

    // While the workflows are read the place holds the card's height:
    // Start beside it does not move when Continue arrives.
    const { pending, arrived } = await heldAndArrived(page, "continue");
    test.info().annotations.push({
      type: "the lead's place",
      description: `Continue at 1280 × 800: the place ${Math.round(pending[0].height)} px while read, ${Math.round(arrived[0].height)} px once drawn`,
    });
    expect(Math.abs(arrived[0].height - pending[0].height), "the place keeps its height").toBeLessThanOrEqual(2);
    expect(Math.abs(arrived[1].height - pending[1].height), "Start beside it keeps its height").toBeLessThanOrEqual(2);
    await page.close();
    expectQuiet(errors);
  });
});
