import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
// The header path and browser titles: the Workspace segment is retired,
// the project renders as a plain segment on filed object pages, titles
// follow the reference's compact hierarchy with the instance name as
// the tail, staleness is exercised three ways, the Settings split
// carries the instance name end to end, the published viewer leaks
// nothing, and outcomes are re-measured with the bounded fixtures at
// both widths.
import { test, expect, type Page, type Route } from "@playwright/test";
import {
  addLayer,
  createMap,
  mapSaveArrived,
  patchMap,
  publishMap,
  routeHouse,
  saveSettled,
  seedCsv,
} from "./support";

const runId = Date.now().toString(36);
const TABLE_ONE = `hp_one_${runId}`; // filed in exactly one project
const TABLE_TWO = `hp_two_${runId}`; // filed in two projects
const PROJECT_A = `Berlin mobility ${runId}`;
const PROJECT_B = `Flood atlas ${runId}`;
const MAP_FILED = `Stations map ${runId}`;
const MAP_UNFILED = `Scratch map ${runId}`;
const MAP_RENAMED = `Depot map ${runId}`;
const WORKFLOW = `Station catchments ${runId}`;
const INSTANCE = "Stadtwerke";
// Named fixture lengths: the instance at its bound, the project at its
// bound, the map at a chosen stress length (maps carry no bound).
const INSTANCE_80 = "S".repeat(80);
const PROJECT_120 = "P".repeat(120);
const MAP_120 = "M".repeat(120);
// A one-word unfiled map, the shortest path.
const MAP_SHORT = `M${runId}`;
// a connection's page. Saving a real connection tests the
// server first, so the page reads a stubbed record — the path and the
// title are the shell's, whatever answered the read.
const CONN_ID = "c-hp";
const CONNECTION = `Harbour warehouse ${runId}`;
const CONNECTION_RENAMED = `Quay warehouse ${runId}`;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

const api = (page: Page, method: string, path: string, body?: unknown, basis?: EditBasis) =>
  page.evaluate(
    async ({ method, path, body, basis }) => {
      const r = await fetch(path, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : undefined), ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      return r.status === 204 ? null : ((await r.json()) as unknown);
    },
    { method, path, body, basis },
  );

/** The mutating surfaces' own signal, as mounted on the project
 * screens; dispatched here directly, it proves the shipped contract:
 * an invalidation reaches every mounted segment without a reload. */
const invalidateProjects = (page: Page) =>
  page.evaluate(() =>
    window.dispatchEvent(new Event("dezfil:projects-changed")),
  );

const title = (page: Page) => expect.poll(() => page.title());

// A mid-test failure must not leave the workspace-global name behind
// for whatever suite runs next on the same instance (the in-test clear
// near the end stays: it is coverage of the clearing flow, not cleanup).
test.afterEach(async ({ request }) => {
  await request
    .patch("/api/settings", { data: { instanceName: null } })
    .catch(() => {});
});
const chip = (page: Page) => page.locator('[title="This instance"]');
const crumbs = (page: Page) =>
  page.getByRole("navigation", { name: "Breadcrumb" });

test("the path, the titles, the instance name and the re-measure", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  let connection = {
    id: CONN_ID,
    name: CONNECTION,
    host: "db.internal",
    port: 5432,
    database: "harbour",
    username: "dezfil_ro",
    ssl: true,
    createdAt: "2026-08-31T08:00:00.000Z",
    status: "connected",
    lastCheckedAt: "2026-08-31T08:00:00.000Z",
    lastCheckError: null,
    serverVersion: "PostgreSQL 16.4",
    postgisVersion: "3.4.2",
  };
  await routeHouse(context, {
    basemapStyleStub: true,
    handler: async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const method = request.method();
      if (pathname === "/api/connections/postgis" && method === "GET") {
        await json(route, [connection]);
        return true;
      }
      if (pathname === `/api/connections/postgis/${CONN_ID}` && method === "PATCH") {
        const body = request.postDataJSON() as { name?: string };
        connection = { ...connection, name: body.name ?? connection.name };
        await json(route, connection);
        return true;
      }
      if (pathname === `/api/connections/postgis/${CONN_ID}/test` && method === "POST") {
        await json(route, connection);
        return true;
      }
      if (pathname === `/api/connections/postgis/${CONN_ID}/snapshots` && method === "GET") {
        await json(route, { snapshots: [] });
        return true;
      }
      return false;
    },
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  // ---- seed: an unnamed instance (self-contained against residue),
  // two projects, a filed and an unfiled map, a one-project and a
  // two-project table, a filed workflow ----
  await api(page, "PATCH", "/api/settings", { instanceName: null });
  const projectA = ((await api(page, "POST", "/api/projects", {
    name: PROJECT_A,
  })) as { id: string }).id;
  const projectB = ((await api(page, "POST", "/api/projects", {
    name: PROJECT_B,
  })) as { id: string }).id;
  await seedCsv(
    page,
    TABLE_ONE,
    "name,lng,lat\nBuoy A,7.10,53.52\nBuoy B,7.22,53.44\n",
  );
  await seedCsv(
    page,
    TABLE_TWO,
    "name,lng,lat\nBuoy C,6.98,53.61\nBuoy D,7.05,53.55\n",
  );
  // Membership is by dataset id, not table name.
  const tables = (await api(page, "GET", "/api/tables")) as {
    id: string;
    name: string;
  }[];
  const idOf = (name: string) => tables.find((t) => t.name === name)!.id;
  await api(page, "PATCH", `/api/projects/${projectA}/members`, {
    addTables: [idOf(TABLE_ONE), idOf(TABLE_TWO)],
  });
  await api(page, "PATCH", `/api/projects/${projectB}/members`, {
    addTables: [idOf(TABLE_TWO)],
  });
  const filedMapId = ((await api(page, "POST", "/api/maps", {
    name: MAP_FILED,
    projectId: projectA,
  })) as { id: string }).id;
  await addLayer(page, filedMapId, TABLE_ONE, `SELECT * FROM ${TABLE_ONE}`);
  const unfiledMapId = await createMap(page, MAP_UNFILED);
  const workflowId = ((await api(page, "POST", "/api/recipes", {
    name: WORKFLOW,
    projectId: projectA,
  })) as { recipe: { id: string } }).recipe.id;

  // Criterion 5's route matrix, walked once per instance state.
  const walkMatrix = async (tail: string) => {
    const matrix: [string, string][] = [
      ["/", `Home · ${tail}`],
      ["/projects", `Projects · ${tail}`],
      ["/maps", `Maps · ${tail}`],
      ["/workflows", `Workflows · ${tail}`],
      // the page is called Data wherever the app names it.
      ["/data", `Data · ${tail}`],
      ["/connections", `Connections · ${tail}`],
      ["/connections/new", `Connections · ${tail}`],
      // an object page, never repeating its section.
      [`/connections/${CONN_ID}`, `${connection.name} · ${tail}`],
      ["/sql", `SQL · ${tail}`],
      ["/developer", `Developer · ${tail}`],
      ["/settings", `Settings · ${tail}`],
      [`/maps/${filedMapId}`, `${MAP_FILED} · ${PROJECT_A} · ${tail}`],
      [`/maps/${unfiledMapId}`, `${MAP_UNFILED} · ${tail}`],
      [
        `/workflows/${workflowId}`,
        `${WORKFLOW} · ${PROJECT_A} · ${tail}`,
      ],
      [`/tables/${TABLE_ONE}`, `${TABLE_ONE} · ${PROJECT_A} · ${tail}`],
      // A table in two projects names no project anywhere.
      [`/tables/${TABLE_TWO}`, `${TABLE_TWO} · ${tail}`],
    ];
    for (const [route, expected] of matrix) {
      await page.goto(route);
      await title(page).toBe(expected);
    }
  };

  await test.step("titles and segments, instance unnamed — the full matrix", async () => {
    await walkMatrix("Dezfil");
    await expect(chip(page)).toHaveCount(0);

    await page.goto(`/maps/${filedMapId}`);
    await title(page).toBe(`${MAP_FILED} · ${PROJECT_A} · Dezfil`);
    const segment = crumbs(page).getByRole("link", { name: PROJECT_A });
    await expect(segment).toBeVisible();
    // Since the segment opens the project's own home.
    await expect(segment).toHaveAttribute("href", `/projects/${projectA}`);
    await expect(crumbs(page)).not.toContainText("Workspace");

    await page.goto(`/maps/${unfiledMapId}`);
    await title(page).toBe(`${MAP_UNFILED} · Dezfil`);
    await expect(
      crumbs(page).getByRole("link", { name: PROJECT_A }),
    ).toHaveCount(0);
  });

  await test.step("Settings splits, and a saved instance name reaches the chip and the title without a reload", async () => {
    await page.goto("/settings");
    await title(page).toBe("Settings · Dezfil");
    await expect(
      page.getByRole("heading", { name: "Instance", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Instance", exact: true }).getByLabel("Instance name")).toBeVisible();
    await expect(chip(page)).toHaveCount(0);

    const workspaceCard = page.locator("form", {
      has: page.getByLabel("Instance name"),
    });
    await page.getByLabel("Instance name").fill(INSTANCE);
    await workspaceCard.getByRole("button", { name: "Save" }).click();
    await expect(workspaceCard.getByRole("status")).toHaveText("Saved");
    await expect(chip(page)).toHaveText(INSTANCE);
    await title(page).toBe(`Settings · ${INSTANCE}`);
  });

  await test.step("the title matrix, instance named", async () => {
    await walkMatrix(INSTANCE);
    await expect(
      crumbs(page).getByRole("link", { name: PROJECT_A }),
    ).toHaveCount(0);
    await expect(chip(page)).toHaveText(INSTANCE);
    // The table's name renders in the crumb, plain: no rename button
    // (the side-by-side round caught the segment missing entirely).
    await expect(crumbs(page)).toContainText(TABLE_TWO);
    await expect(
      crumbs(page).getByRole("button", { name: TABLE_TWO }),
    ).toHaveCount(0);
  });

  await test.step("a connection's page carries its name, plain; a rename updates path and title without a reload", async () => {
    await page.goto(`/connections/${CONN_ID}`);
    await title(page).toBe(`${CONNECTION} · ${INSTANCE}`);
    await expect(crumbs(page)).toContainText(CONNECTION);
    await expect(
      crumbs(page).getByRole("button", { name: CONNECTION }),
    ).toHaveCount(0);
    await expect(
      crumbs(page).getByRole("link", { name: "Connections", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Connection name").fill(CONNECTION_RENAMED);
    // The form's own save (saving re-tests the connection; the stub
    // answers the test and the save alike).
    await page.getByRole("button", { name: "Test & save changes" }).click();
    await title(page).toBe(`${CONNECTION_RENAMED} · ${INSTANCE}`);
    await expect(crumbs(page)).toContainText(CONNECTION_RENAMED);
    // Leaving retains nothing.
    await crumbs(page)
      .getByRole("link", { name: "Connections", exact: true })
      .click();
    await title(page).toBe(`Connections · ${INSTANCE}`);
    await expect(crumbs(page)).not.toContainText(CONNECTION_RENAMED);
  });

  await test.step("staleness: an object rename updates the title; navigating away retains nothing", async () => {
    await page.goto(`/maps/${filedMapId}`);
    await title(page).toBe(`${MAP_FILED} · ${PROJECT_A} · ${INSTANCE}`);
    await saveSettled(page);
    await page.locator('button[title^="Rename "]').click();
    await page.getByLabel("Map name").fill(MAP_RENAMED);
    const arrived = mapSaveArrived(page);
    await page.keyboard.press("Enter");
    await arrived;
    await title(page).toBe(`${MAP_RENAMED} · ${PROJECT_A} · ${INSTANCE}`);

    // Client-side navigation to a list: no name, no project residue.
    await crumbs(page).getByRole("link", { name: "Maps", exact: true }).click();
    await expect(page).toHaveURL(/\/maps$/);
    await title(page).toBe(`Maps · ${INSTANCE}`);
    await expect(
      crumbs(page).getByRole("link", { name: PROJECT_A }),
    ).toHaveCount(0);
  });

  await test.step("a project rename reaches the mounted segment without a reload", async () => {
    await page.goto(`/maps/${filedMapId}`);
    await expect(
      crumbs(page).getByRole("link", { name: PROJECT_A }),
    ).toBeVisible();
    await api(page, "PATCH", `/api/projects/${projectA}`, {
      name: PROJECT_120,
    });
    await invalidateProjects(page);
    await expect(
      crumbs(page).getByRole("link", { name: PROJECT_120 }),
    ).toBeVisible();
    await title(page).toBe(`${MAP_RENAMED} · ${PROJECT_120} · ${INSTANCE}`);
  });

  let token = "";
  await test.step("the published viewer shows no chip, no segment, an unchanged title", async () => {
    token = await publishMap(page, filedMapId);
    await page.goto(`/v/${token}`);
    await expect(page.getByText(MAP_RENAMED).first()).toBeVisible({
      timeout: 30_000,
    });
    await title(page).toBe("Dezfil");
    await expect(chip(page)).toHaveCount(0);
    await expect(page.getByText(PROJECT_120)).toHaveCount(0);
    await expect(page.getByText(INSTANCE, { exact: true })).toHaveCount(0);
  });

  await test.step("re-measured: bounded fixtures, both widths, the Publish control opens", async () => {
    await api(page, "PATCH", "/api/settings", { instanceName: INSTANCE_80 });
    await patchMap(page, filedMapId, { name: MAP_120 });
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      // A full load per width: the API-set instance name also proves the
      // chip and title read persisted state, not the live event.
      await page.goto(`/maps/${filedMapId}`);
      await title(page).toBe(`${MAP_120} · ${PROJECT_120} · ${INSTANCE_80}`);
      await expect(chip(page)).toHaveText(INSTANCE_80);
      await saveSettled(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `no horizontal overflow at ${viewport.width}`).toBe(0);
      await page
        .getByRole("button", { name: "Published", exact: true })
        .click();
      await expect(page.locator("#publish-popover")).toBeVisible();
      await page.keyboard.press("Escape");
    }
  });

  await test.step("a project delete dissolves the segment, live and after a reload", async () => {
    await api(page, "DELETE", `/api/projects/${projectA}`);
    await invalidateProjects(page);
    await expect(
      crumbs(page).getByRole("link", { name: PROJECT_120 }),
    ).toHaveCount(0);
    await title(page).toBe(`${MAP_120} · ${INSTANCE_80}`);
    await page.reload();
    await title(page).toBe(`${MAP_120} · ${INSTANCE_80}`);
    await expect(
      crumbs(page).getByRole("link", { name: PROJECT_120 }),
    ).toHaveCount(0);
  });

  await test.step("clearing the instance name removes the chip without a reload", async () => {
    await page.goto("/settings");
    const workspaceCard = page.locator("form", {
      has: page.getByLabel("Instance name"),
    });
    await expect(page.getByLabel("Instance name")).toHaveValue(INSTANCE_80);
    await page.getByLabel("Instance name").fill("");
    await workspaceCard.getByRole("button", { name: "Save" }).click();
    await expect(workspaceCard.getByRole("status")).toHaveText("Saved");
    await expect(chip(page)).toHaveCount(0);
    await title(page).toBe("Settings · Dezfil");
  });
});

test("the builder's header card reaches the layer pane's right edge at both widths; a list page's card still shrinks", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await api(page, "PATCH", "/api/settings", { instanceName: null });
  const shortMapId = await createMap(page, MAP_SHORT);
  const card = page.locator("header > div").first();
  const pane = page
    .getByRole("tab", { name: "Layers" })
    .locator("xpath=ancestor::aside[1]");
  let builderRight = 0;
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/maps/${shortMapId}`);
    await title(page).toBe(`${MAP_SHORT} · Dezfil`);
    await expect(pane).toBeVisible();
    const c = (await card.boundingBox())!;
    const p = (await pane.boundingBox())!;
    builderRight = c.x + c.width;
    expect(
      builderRight,
      `at ${viewport.width}: the card's right edge reaches the pane's`,
    ).toBeGreaterThanOrEqual(p.x + p.width - 1);
  }
  await page.goto("/maps");
  await title(page).toBe("Maps · Dezfil");
  const listCard = (await card.boundingBox())!;
  expect(
    listCard.x + listCard.width,
    "off the builder the card shrinks to its content again",
  ).toBeLessThan(builderRight);
});

// The card reaches the pane on every surface that has one ----

const RECIPE_SHORT = `W${runId}`;
// Past the pane-aligned width and short of the name's 300 px cap.
// Re-spaced, with the mid margin below. The card used to carry ~74 px
// of reserved status width, and the ladder this step climbs — aligned,
// then past the pane, then stopped at the name's cap — was spaced
// inside it: on the builder the old fixture cleared the pane by more
// than the check's 20 px only because of the reservation, and with it
// gone the whole rung between the pane's edge and the cap is about 50
// px wide, not 125. The relations the step asserts are unchanged; what
// they are asserted with fits the card the path actually needs.
const RECIPE_MID = `Catchments near tram stations ${runId}`;
// Past the cap, twice: the two must lay out the same width.
const RECIPE_LONG = `Regional accessibility of primary care practices by public transport, weekday morning peak ${runId}`;
const RECIPE_LONGER = `${RECIPE_LONG} draft v3`;

const card = (page: Page) => page.locator("header > div").first();
const headerActions = (page: Page) =>
  page.locator("header > div").nth(1).locator("button, a");
const railLink = (page: Page, name: string) =>
  page
    .locator('nav[aria-label="Product navigation"]')
    .getByRole("link", { name, exact: true });

/** The card's insets, measured from the rendered text rather than from
 * boxes: the left inset runs from the card's border to the glyph box of
 * the P of Dezfil, the right clearance from the path's last visible
 * character to the border. The last character is the last non-empty
 * text node in the breadcrumb, clipped to its element's content box so
 * a truncated name measures at its ellipsis. What sits between the text
 * and the border differs by page (a name's own 4 px, the SQL console's
 * link 8 px), which is why an element box would not evidence this. */
const insets = (page: Page) =>
  page.evaluate(() => {
    const cardEl = document.querySelector("header > div")!;
    const brand = cardEl.querySelector('a[href="/"]')!;
    const nav = cardEl.querySelector('nav[aria-label="Breadcrumb"]')!;
    const walker = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n.textContent ?? "").trim()) continue;
      // A hidden node is not a character anyone sees. The builder's save
      // whisper used to be exactly that — laid out beside the name and
      // hidden until a save — until moved it to the stage; the guard
      // stays as the rule it always was.
      const style = getComputedStyle(n.parentElement!);
      if (style.visibility === "hidden" || style.display === "none") continue;
      last = n;
    }
    if (!last) throw new Error("the breadcrumb has no visible text");
    const range = document.createRange();
    range.selectNodeContents(last);
    const glyphs = range.getBoundingClientRect();
    const holder = last.parentElement!;
    const contentRight =
      holder.getBoundingClientRect().right -
      parseFloat(getComputedStyle(holder).paddingRight);
    range.selectNodeContents(brand);
    const p = range.getBoundingClientRect();
    const c = cardEl.getBoundingClientRect();
    return {
      left: p.left - c.left,
      right: c.right - Math.min(glyphs.right, contentRight),
      // A button reports no scrollable overflow, so the truncation is
      // read from the glyph run itself: its full extent past the box.
      truncated: glyphs.right > contentRight + 0.5,
      cardWidth: c.width,
    };
  });

const expectClearance = async (page: Page, where: string) => {
  const i = await insets(page);
  // The numbers, for the record: what the assertion below compares.
  console.log(
    `${where}: card ${i.cardWidth.toFixed(1)} px, left inset ${i.left.toFixed(1)}, right clearance ${i.right.toFixed(1)}${i.truncated ? ", name shortened" : ""}`,
  );
  expect(
    i.right,
    `${where}: the right clearance (${i.right.toFixed(1)}) is at least the left inset (${i.left.toFixed(1)})`,
  ).toBeGreaterThanOrEqual(i.left - 0.5);
  return i;
};

const edges = async (page: Page, pane: ReturnType<Page["locator"]>) => {
  await expect(pane).toBeVisible();
  const c = (await card(page).boundingBox())!;
  const p = (await pane.boundingBox())!;
  return { cardRight: c.x + c.width, paneRight: p.x + p.width, cardWidth: c.width };
};

test("the header card reaches the pane on the workflow canvas and the SQL console, its clearance holds, it grows to the cap, yields to the actions and releases on leaving", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await api(page, "PATCH", "/api/settings", { instanceName: null });
  const mapId = await createMap(page, MAP_SHORT);
  const recipeId = ((await api(page, "POST", "/api/recipes", {
    name: RECIPE_SHORT,
  })) as { recipe: { id: string } }).recipe.id;

  const builderPane = page.locator("aside[data-builder-pane]");
  const canvasPane = page.locator("aside[data-canvas-pane]");
  const sqlPane = page.locator('aside[aria-label="Sources and history"]');
  const surfaces: [string, string, ReturnType<Page["locator"]>][] = [
    ["builder", `/maps/${mapId}`, builderPane],
    ["workflow canvas", `/workflows/${recipeId}`, canvasPane],
    ["SQL console", "/sql", sqlPane],
  ];

  let alignedWidth = 0;
  await test.step("with a short path the card's right edge meets the pane's on all three surfaces at both widths, and the right clearance is at least the left inset", async () => {
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      for (const [name, route, pane] of surfaces) {
        await page.goto(route);
        const e = await edges(page, pane);
        console.log(`${name} at ${viewport.width}: card right ${e.cardRight}, pane right ${e.paneRight}`);
        expect(
          Math.abs(e.cardRight - e.paneRight),
          `${name} at ${viewport.width}: the card's right edge (${e.cardRight}) sits on the pane's (${e.paneRight})`,
        ).toBeLessThanOrEqual(1);
        await expectClearance(page, `${name} at ${viewport.width}`);
        alignedWidth = e.cardWidth;
      }
    }
  });

  await test.step("a path too long for the aligned width grows the card past the pane; a longer one stops at the name's cap; the clearance holds throughout", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const cases: [string, string, (name: string) => Promise<unknown>, ReturnType<Page["locator"]>][] = [
      [
        "workflow canvas",
        `/workflows/${recipeId}`,
        (name) => readThenWriteBrowserSetup(page, `/api/recipes/${recipeId}`, () => ({ method: "PATCH", path: `/api/recipes/${recipeId}`, body: { name } })).then(result => result.json),
        canvasPane,
      ],
      [
        "builder",
        `/maps/${mapId}`,
        (name) => patchMap(page, mapId, { name }),
        builderPane,
      ],
    ];
    for (const [surface, route, rename, pane] of cases) {
      await rename(RECIPE_MID);
      await page.goto(route);
      const mid = await edges(page, pane);
      expect(
        mid.cardRight,
        `${surface}: a mid-length name grows the card past the pane`,
      ).toBeGreaterThan(mid.paneRight + 10);
      const midInsets = await expectClearance(page, `${surface}, mid-length name`);
      expect(midInsets.truncated, `${surface}: the mid-length name is whole`).toBe(false);

      await rename(RECIPE_LONG);
      await page.goto(route);
      const long = await edges(page, pane);
      expect(long.cardWidth, `${surface}: a long name grows the card further`).toBeGreaterThan(mid.cardWidth + 20);
      const longInsets = await expectClearance(page, `${surface}, long name`);
      expect(longInsets.truncated, `${surface}: the long name is shortened at the cap`).toBe(true);

      await rename(RECIPE_LONGER);
      await page.goto(route);
      const longer = await edges(page, pane);
      expect(
        Math.abs(longer.cardWidth - long.cardWidth),
        `${surface}: a longer name still stops at the cap (${long.cardWidth} vs ${longer.cardWidth})`,
      ).toBeLessThanOrEqual(1);
      await expectClearance(page, `${surface}, longer name`);
      await rename(RECIPE_SHORT);
    }
  });

  await test.step("at 1280 px with a published map and the bounded fixtures, every header action stays inside the viewport and Published opens; the card gave way", async () => {
    const projectId = ((await api(page, "POST", "/api/projects", {
      name: PROJECT_120,
    })) as { id: string }).id;
    const filedId = ((await api(page, "POST", "/api/maps", {
      name: MAP_120,
      projectId,
    })) as { id: string }).id;
    await publishMap(page, filedId);
    await api(page, "PATCH", "/api/settings", { instanceName: INSTANCE_80 });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/maps/${filedId}`);
    await title(page).toBe(`${MAP_120} · ${PROJECT_120} · ${INSTANCE_80}`);
    await expect(chip(page)).toHaveText(INSTANCE_80);
    await expect(builderPane).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, "no horizontal overflow").toBe(0);
    const actions = headerActions(page);
    const count = await actions.count();
    expect(count, "the published builder's actions are there").toBeGreaterThanOrEqual(6);
    for (let i = 0; i < count; i++) {
      const box = (await actions.nth(i).boundingBox())!;
      expect(box, `action ${i} has a box`).not.toBeNull();
      expect(box.x + box.width, `action ${i} ends inside the viewport`).toBeLessThanOrEqual(1280);
      expect(box.x, `action ${i} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    }
    const c = (await card(page).boundingBox())!;
    const a0 = (await actions.first().boundingBox())!;
    const aLast = (await actions.last().boundingBox())!;
    console.log(`header and actions at 1280: card ${c.x.toFixed(1)} to ${(c.x + c.width).toFixed(1)}, actions ${a0.x.toFixed(1)} to ${(aLast.x + aLast.width).toFixed(1)}, ${count} actions`);
    expect(c.x + c.width, "the card ends before the actions").toBeLessThanOrEqual(a0.x);
    await expectClearance(page, "1280, published, the bounded fixtures");
    await page.getByRole("button", { name: "Published", exact: true }).click();
    await expect(page.locator("#publish-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await api(page, "PATCH", "/api/settings", { instanceName: null });
    await api(page, "DELETE", `/api/projects/${projectId}`);
  });

  await test.step("at a narrow window the workflow canvas's and the SQL console's actions stay inside the viewport and pressable; the run dock's refusal text moves the floor", async () => {
    await readThenWriteBrowserSetup(page, `/api/recipes/${recipeId}`, () => ({ method: "PATCH", path: `/api/recipes/${recipeId}`, body: { name: RECIPE_SHORT } })).then(result => result.json);
    const inside = async (where: string, width: number) => {
      const actions = headerActions(page);
      const count = await actions.count();
      expect(count, `${where}: actions present`).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < count; i++) {
        const box = (await actions.nth(i).boundingBox())!;
        expect(box, `${where}: action ${i} has a box`).not.toBeNull();
        expect(box.x + box.width, `${where}: action ${i} ends inside the viewport`).toBeLessThanOrEqual(width);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${where}: no horizontal overflow`).toBe(0);
    };
    const narrow: [string, string, ReturnType<Page["locator"]>, number][] = [
      ["workflow canvas", `/workflows/${recipeId}`, canvasPane, 600],
      ["SQL console", "/sql", sqlPane, 480],
    ];
    for (const [surface, route, pane, width] of narrow) {
      await page.setViewportSize({ width, height: 600 });
      await page.goto(route);
      const e = await edges(page, pane);
      console.log(`${surface} at ${width}: card right ${e.cardRight}, pane right ${e.paneRight}`);
      await inside(`${surface} at ${width}`, width);
      expect(
        e.cardRight,
        `${surface} at ${width}: the card gave way before the pane's edge`,
      ).toBeLessThan(e.paneRight - 1);
      await expectClearance(page, `${surface} at ${width}`);
    }
    // Pressable, not merely inside: the theme toggle flips the theme.
    const theme = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const was = await theme();
    await page.getByRole("button", { name: "Switch between dark and light theme" }).click();
    await expect.poll(theme, { message: "the theme toggle is pressable at 480" }).not.toBe(was);
    await page.getByRole("button", { name: "Switch between dark and light theme" }).click();
    // The run dock's refusal, at a width where the aligned card fits
    // before the text appears and not after: the floor must follow.
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(`/workflows/${recipeId}`);
    const before = await edges(page, canvasPane);
    expect(
      Math.abs(before.cardRight - before.paneRight),
      "at 900 the card is aligned before the refusal",
    ).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Run all" }).click();
    await expect(page.locator("[data-run-refusal]")).toBeVisible();
    await expect
      .poll(async () => (await card(page).boundingBox())!.width, {
        message: "the card yields to the refusal text",
      })
      .toBeLessThan(before.cardWidth - 20);
    const after = (await card(page).boundingBox())!;
    console.log(`workflow canvas at 900: card ${before.cardWidth.toFixed(1)} before the refusal, ${after.width.toFixed(1)} after`);
    await inside("workflow canvas at 900 with the refusal", 900);
    await expectClearance(page, "workflow canvas at 900 with the refusal");
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(async () => (await card(page).boundingBox())!.width, {
      message: "the floor returns once the refusal is dismissed",
    }).toBeGreaterThan(before.cardWidth - 1);
  });

  await test.step("leaving the workflow canvas or the SQL console for a list page returns the card to its content width without a reload", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const leavings: [string, string, ReturnType<Page["locator"]>, string, RegExp][] = [
      ["workflow canvas", `/workflows/${recipeId}`, canvasPane, "Workflows", /\/workflows$/],
      ["SQL console", "/sql", sqlPane, "Maps", /\/maps$/],
    ];
    for (const [surface, route, pane, link, listUrl] of leavings) {
      await page.goto(route);
      const on = await edges(page, pane);
      expect(Math.abs(on.cardRight - on.paneRight), `${surface}: aligned before leaving`).toBeLessThanOrEqual(1);
      await railLink(page, link).click();
      await expect(page).toHaveURL(listUrl);
      await expect.poll(async () => (await card(page).boundingBox())!.width, {
        message: `${surface}: the list page's card shrinks below the aligned width (${alignedWidth})`,
      }).toBeLessThan(alignedWidth - 20);
      const left = (await card(page).boundingBox())!.width;
      await page.reload();
      await expect(pane).toHaveCount(0);
      const fresh = (await card(page).boundingBox())!.width;
      console.log(`leaving the ${surface}: aligned ${alignedWidth.toFixed(1)}, after leaving ${left.toFixed(1)}, fresh ${fresh.toFixed(1)}`);
      expect(
        Math.abs(left - fresh),
        `${surface}: the width after leaving (${left}) is the fresh load's (${fresh})`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
