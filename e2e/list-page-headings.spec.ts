// The five list pages' heading and primary button: a title and its
// action with no count beside it in any state, the second line only
// when it says something the title cannot, one button rule with the
// plus on all five, the row aligned to the top, and the Data page
// called Data in every place the app names it. Each test measures one
// criterion on the rendered page, so a red run names what is wrong
// rather than stopping at the first difference.
//
// The count pill a field round rejected is gone. The pill was also this
// file's readiness anchor on the populated pages;
// every such wait now stands on a seeded item's own name, which says
// both that the read resolved and that it resolved to content.
//
// The empty-collection case wants a fresh data directory (the runbook's
// isolated instance): it runs before any seeding here and skips, naming
// the reason, when the instance already holds something. Every other
// test seeds its own subjects once, keyed by the run id.
import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import { createMap, publishMap, routeHouse, seedCsv } from "./support";

const runId = Date.now().toString(36);
const BERLIN = `Berlin ${runId}`;
const ATLAS = `Atlas ${runId}`;
const EMPTY = `Empty shelf ${runId}`;
const M_STATIONS = `Stations ${runId}`;
const M_DEPOTS = `Depots ${runId}`;
const M_SCRATCH = `Scratch ${runId}`;
const W_LANE = `Lane density ${runId}`;
const T_LPH_A = `lph_a_${runId}`;
const CSV = "name,lng,lat\nBuoy A,7.10,53.52\n";

type PageSpec = {
  path: string;
  title: string;
  /** The heading button's accessible name; exact, so a ghost tile that
   * starts with the same words never stands in for it. */
  action: string;
  role: "button" | "link";
  /** The ghost tile's caption: the page has resolved to its zero state
   * once this stands, so the zero measurements never read a pending
   * heading, which is silent too. */
  emptyMark: string;
  /** A seeded item's own name: the page has resolved to CONTENT once
   * this stands. It replaces the count pill waited on, so an absence is
   * never read off a page that has not answered yet. */
  seededMark: string;
  /** The listing the page waits on, held to hold the page pending. */
  listRoute: string;
  /** The page's own reading whisper: proof the page IS pending, so the
   * pending measurement is never taken off a resolved page. */
  pendingMark: string;
};

const PAGES: PageSpec[] = [
  { path: "/projects", title: "Projects", action: "New project", role: "button", emptyMark: "A name, nothing else", seededMark: BERLIN, listRoute: "/api/projects", pendingMark: "Reading your projects…" },
  { path: "/maps", title: "Maps", action: "New map", role: "button", emptyMark: "Start from a blank map", seededMark: M_STATIONS, listRoute: "/api/maps", pendingMark: "Reading your maps…" },
  { path: "/workflows", title: "Workflows", action: "New workflow", role: "button", emptyMark: "Start from a blank canvas", seededMark: W_LANE, listRoute: "/api/recipes", pendingMark: "Reading your workflows…" },
  { path: "/data", title: "Data", action: "Add data", role: "button", emptyMark: "Upload a file or import from a source", seededMark: T_LPH_A, listRoute: "/api/tables", pendingMark: "Reading your tables…" },
  { path: "/connections", title: "Connections", action: "Add connection", role: "link", emptyMark: "Snapshot tables from a PostGIS database", seededMark: "Warehouse 1", listRoute: "/api/connections/postgis", pendingMark: "Reading your connections…" },
];

const api = (page: Page, method: string, pathName: string, body?: unknown) =>
  page.evaluate(
    async ({ method, pathName, body }) => {
      const r = await fetch(pathName, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      const text = r.status === 204 ? "" : await r.text();
      return text ? (JSON.parse(text) as unknown) : null;
    },
    { method, pathName, body },
  );

/* The heading's parts, located the way both trees expose them: the
   page's first h1, the count mark once drawn inside it, and the
   paragraph right after it. The mark is kept as a locator so its
   absence is asserted against the exact node it occupied; the title's
   own text is read alongside it, so a count re-drawn without the mark
   is caught too. */
const title = (page: Page) => page.locator("main h1").first();
const countMark = (page: Page) => title(page).locator("[data-heading-count]");
const line = (page: Page) => page.locator("main h1 + p").first();
const lineTexts = (page: Page) =>
  page.locator("main h1 + p").allTextContents();
const action = (page: Page, spec: PageSpec) =>
  page.locator("main").getByRole(spec.role, { name: spec.action, exact: true });
/* The populated readiness anchor: the page's own seeded item on screen.
   Soft, so a red run reaches every page; a page that never answers
   fails here rather than passing an absence read off its loading
   state. */
/** The heading's two readings at once: how many count marks stand
 * inside the title, and the title's own text. Collected rather than
 * asserted on the spot, so a run reports every state it visited instead
 * of stopping at the first that differs. */
const headingReading = async (page: Page) => ({
  marks: await countMark(page).count(),
  title: (await title(page).innerText()).trim(),
});
const contentOf = async (page: Page, spec: PageSpec) =>
  expect
    .soft(
      page.locator("main").getByText(spec.seededMark).first(),
      `${spec.path}: the seeded item`,
    )
    .toBeVisible();

/* Connections are tested against a live database on creation, so a
   ledger of three is stubbed at the list route; everything
   else on the page reaches the real instance. */
const json = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

async function stubConnections(context: BrowserContext, count: number) {
  const connections = Array.from({ length: count }, (_, i) => ({
    id: `c-${i}`,
    name: `Warehouse ${i + 1}`,
    host: "db.internal",
    port: 5432,
    database: "mobility",
    username: "dezfil_ro",
    ssl: true,
    createdAt: "2026-08-31T08:00:00.000Z",
    status: "connected",
    lastCheckedAt: "2026-08-31T08:00:00.000Z",
    lastCheckError: null,
    serverVersion: "PostgreSQL 16.4",
    postgisVersion: "3.4.2",
  }));
  await routeHouse(context, {
    handler: async (route) => {
      const { pathname } = new URL(route.request().url());
      if (route.request().method() !== "GET") return false;
      if (pathname === "/api/connections/postgis") {
        await json(route, connections);
        return true;
      }
      if (/^\/api\/connections\/postgis\/[^/]+\/snapshots$/.test(pathname)) {
        await json(route, { snapshots: [] });
        return true;
      }
      return false;
    },
  });
}

/* Three of everything, once per file run: three projects (one of them
   empty), three maps (two in Berlin, one of them published), three
   workflows and three tables. */
let seeded: { berlin: string; empty: string } | null = null;
async function seed(page: Page) {
  if (seeded) return seeded;
  await page.goto("/maps");
  const berlin = ((await api(page, "POST", "/api/projects", { name: BERLIN })) as { id: string }).id;
  await api(page, "POST", "/api/projects", { name: ATLAS });
  const empty = ((await api(page, "POST", "/api/projects", { name: EMPTY })) as { id: string }).id;
  await api(page, "POST", "/api/maps", { name: M_STATIONS, projectId: berlin });
  await api(page, "POST", "/api/maps", { name: M_DEPOTS, projectId: berlin });
  const scratch = await createMap(page, M_SCRATCH);
  await publishMap(page, scratch);
  for (const name of ["Lane density", "Loose ends", "Hex grid"]) {
    await api(page, "POST", "/api/recipes", { name: `${name} ${runId}`, origin: "workflow" });
  }
  for (const name of ["lph_a", "lph_b", "lph_c"]) {
    await seedCsv(page, `${name}_${runId}`, CSV);
  }
  seeded = { berlin, empty };
  return seeded;
}

test("an empty collection with no scope shows neither count nor line (at zero)", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");
  const held = await Promise.all([
    api(page, "GET", "/api/projects"),
    api(page, "GET", "/api/maps"),
    api(page, "GET", "/api/recipes?origin=workflow"),
    api(page, "GET", "/api/tables"),
    api(page, "GET", "/api/connections/postgis"),
  ]);
  const counts = held.map((h) =>
    Array.isArray(h) ? h.length : ((h as { recipes: unknown[] }).recipes ?? []).length,
  );
  // The list reporter prints no skip reason, so the precondition says
  // what it read (projects/maps/workflows/tables/connections).
  console.log(`zero state: the instance holds ${counts.join("/")}`);
  test.skip(
    counts.some((n) => n > 0),
    "the instance already holds something: the zero state wants a fresh data directory",
  );

  // Read all five before judging, so a red run names every page.
  const seen: Record<string, { marks: number; title: string; lines: string[] }> = {};
  for (const spec of PAGES) {
    await page.goto(spec.path);
    await expect(title(page)).toContainText(spec.title);
    // The zero state has resolved once the ghost tile's caption stands.
    await expect(page.getByText(spec.emptyMark)).toBeVisible();
    seen[spec.path] = { ...(await headingReading(page)), lines: await lineTexts(page) };
  }
  // One comparison over all five pages and all three readings, so a
  // seeded defect is proven against each of them rather than against
  // whichever is checked first.
  expect(seen, "at zero: no count mark, the title alone, no second line").toEqual(
    Object.fromEntries(
      PAGES.map((p) => [p.path, { marks: 0, title: p.title, lines: [] }]),
    ),
  );
  // Projects' line under its empty card is struck.
  await page.goto("/projects");
  await expect(page.getByText("A name, nothing else")).toBeVisible();
  await expect(
    page.getByText("Until then everything simply lives here", { exact: false }),
  ).toHaveCount(0);
});

test("while the read is pending the heading is its title alone (while pending)", async ({
  page,
  context,
}) => {
  await seed(page);
  // Each page's listing is held at the network boundary, so the page
  // stays in the state it draws before the world answers. The gate is a
  // single handler reading a mutable subject: routeHouse installs one
  // route for the whole context.
  let gate: { path: string; wait: Promise<void> } | null = null;
  await routeHouse(context, {
    basemapStyleStub: true,
    handler: async (route) => {
      const { pathname } = new URL(route.request().url());
      if (gate && route.request().method() === "GET" && pathname === gate.path) {
        await gate.wait;
      }
      // Never fulfilled here: held, then let through to the instance.
      return false;
    },
  });
  // Read all five before judging, so a red run names every page.
  const seen: Record<string, { marks: number; title: string; lines: string[] }> = {};
  for (const spec of PAGES) {
    let release = () => {};
    gate = {
      path: spec.listRoute,
      wait: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    await page.goto(spec.path);
    // The page IS pending: its own reading whisper stands. Without this
    // the measurements below could be taken off a resolved page, where
    // no count is drawn for a different reason.
    await expect
      .soft(
        page.getByText(spec.pendingMark),
        `${spec.path}: the reading whisper`,
      )
      .toBeVisible();
    seen[spec.path] = { ...(await headingReading(page)), lines: await lineTexts(page) };
    release();
    gate = null;
  }
  expect(
    seen,
    "while pending: no count mark, the title alone, no second line",
  ).toEqual(
    Object.fromEntries(
      PAGES.map((p) => [p.path, { marks: 0, title: p.title, lines: [] }]),
    ),
  );
});

test("three items in no scope: a title, no count, no second line (at several items)", async ({
  page,
  context,
}) => {
  await stubConnections(context, 3);
  await seed(page);
  // Read all five before judging, so a red run names every page.
  const seen: Record<string, { marks: number; title: string; lines: string[] }> = {};
  for (const spec of PAGES) {
    await page.goto(spec.path);
    await expect(title(page)).toContainText(spec.title);
    // This waited on the count pill. The wait now stands on the page's
    // own seeded item, which polls until the read settles and says the
    // list resolved to content, not merely to a heading.
    await contentOf(page, spec);
    await expect(action(page, spec)).toBeVisible();
    seen[spec.path] = { ...(await headingReading(page)), lines: await lineTexts(page) };
  }
  expect(
    seen,
    "at three: no count mark, the title alone, no second line",
  ).toEqual(
    Object.fromEntries(
      PAGES.map((p) => [p.path, { marks: 0, title: p.title, lines: [] }]),
    ),
  );
});

test("the second line appears only when it says something new", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  const { berlin, empty } = await seed(page);
  // The seed navigates only on its first call; the reads need a page.
  await page.goto("/maps");
  const total = ((await api(page, "GET", "/api/maps")) as unknown[]).length;
  const narrowed: Record<string, { marks: number; title: string }> = {};

  await test.step("a search narrows: 'n of total shown'", async () => {
    await page.goto("/maps");
    // The wording first, so a red run names what the line said instead.
    await page.getByLabel("Search maps").fill(M_STATIONS);
    await expect(line(page)).toHaveText(`1 of ${total} shown`);
    // Under a search: the line settled the read, so the absence is read
    // off a rendered heading. Each narrowing's reading goes into
    // `narrowed` and they are judged together at the end, so a seeded
    // defect is proven against every one of them and not only the first.
    narrowed["a search"] = await headingReading(page);
    await page.getByLabel("Search maps").fill("");
    expect(await lineTexts(page), "cleared: no line").toEqual([]);
  });

  await test.step("a filter chip narrows the same way", async () => {
    const published = ((await api(page, "GET", "/api/maps")) as { publishToken: string | null }[])
      .filter((m) => m.publishToken).length;
    expect(published).toBeGreaterThan(0);
    expect(published).toBeLessThan(total);
    const chips = page.getByRole("group", { name: "Filter maps" });
    await chips.getByRole("button", { name: /^Published/ }).click();
    await expect(line(page)).toHaveText(`${published} of ${total} shown`);
    // Under a chip filter.
    narrowed["a chip filter"] = await headingReading(page);
    await chips.getByRole("button", { name: /^All/ }).click();
    expect(await lineTexts(page), "all: no line").toEqual([]);
  });

  await test.step("a project scope names itself; a search inside it composes; clearing the search leaves the scope's line", async () => {
    await page.goto(`/maps?project=${berlin}`);
    await expect(line(page)).toHaveText(`2 in ${BERLIN}`);
    // Under a project scope, and under a search inside one.
    narrowed["a project scope"] = await headingReading(page);
    await page.getByLabel("Search maps").fill(M_DEPOTS);
    await expect(line(page)).toHaveText(`1 of 2 in ${BERLIN} shown`);
    narrowed["a search inside a scope"] = await headingReading(page);
    await page.getByLabel("Search maps").fill("");
    await expect(line(page)).toHaveText(`2 in ${BERLIN}`);
  });

  await test.step("an empty project still says which project it is, with no count", async () => {
    await page.goto(`/maps?project=${empty}`);
    await expect(line(page)).toHaveText(`0 in ${EMPTY}`);
    narrowed["an empty scope"] = await headingReading(page);
  });

  expect(narrowed, "no count beside the title under any narrowing").toEqual({
    "a search": { marks: 0, title: "Maps" },
    "a chip filter": { marks: 0, title: "Maps" },
    "a project scope": { marks: 0, title: "Maps" },
    "a search inside a scope": { marks: 0, title: "Maps" },
    "an empty scope": { marks: 0, title: "Maps" },
  });
});

test("one primary button on all five pages, with the plus", async ({
  page,
  context,
}) => {
  await stubConnections(context, 3);
  await seed(page);
  const seen: Record<string, unknown> = {};
  for (const spec of PAGES) {
    await page.goto(spec.path);
    const button = action(page, spec);
    await expect(button).toBeVisible();
    seen[spec.path] = await button.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        radius: cs.borderTopLeftRadius,
        shadow: cs.boxShadow,
        font: cs.fontFamily,
        height: cs.height,
        padding: `${cs.paddingLeft} ${cs.paddingRight}`,
        gap: cs.columnGap,
        icon: el.querySelector("svg") !== null,
        iconFirst: el.firstElementChild?.tagName.toLowerCase() === "svg",
      };
    });
  }
  const groups = new Set(Object.values(seen).map((v) => JSON.stringify(v)));
  expect(
    groups.size,
    `one rule on all five; measured ${JSON.stringify(seen, null, 1)}`,
  ).toBe(1);
  for (const [path, props] of Object.entries(seen) as [string, { icon: boolean; iconFirst: boolean }][]) {
    expect(props.icon, `${path}: a plus`).toBe(true);
    expect(props.iconFirst, `${path}: the plus before the label`).toBe(true);
  }
});

test("the button's top edge is level with the title's box on every page", async ({
  page,
  context,
}) => {
  await stubConnections(context, 3);
  await seed(page);
  for (const spec of PAGES) {
    await page.goto(spec.path);
    const button = action(page, spec);
    await expect(button).toBeVisible();
    const [t, b] = await Promise.all([title(page).boundingBox(), button.boundingBox()]);
    expect(t, `${spec.path}: the title renders`).not.toBeNull();
    expect(b, `${spec.path}: the button renders`).not.toBeNull();
    expect(
      Math.abs(t!.y - b!.y),
      `${spec.path}: title top ${t!.y}, button top ${b!.y}`,
    ).toBeLessThanOrEqual(1);
  }
});

test("the Data page is called Data in its heading, the rail, the breadcrumb and the browser title; the route stays", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  await seed(page);
  await page.goto("/data");
  await expect(page).toHaveURL(/\/data$/);
  // The heading is server-rendered before the listing resolves, so an
  // exact read of it would match the pending title and never see a
  // count arriving after it: the page's own seeded item settles the
  // read first.
  await contentOf(page, PAGES[3]);
  await expect(title(page)).toHaveText("Data");
  await expect(
    page.locator('nav[aria-label="Product navigation"] a[href="/data"]'),
  ).toHaveText("Data");
  await expect(
    page.locator('nav[aria-label="Breadcrumb"] a[href="/data"]'),
  ).toHaveText("Data");
  await expect(page).toHaveTitle(/^Data · /);
});

test("Projects and Connections lose their sentences and carry no count (as amends it)", async ({
  page,
  context,
}) => {
  await stubConnections(context, 3);
  await seed(page);
  // Both pages read before either is judged, so a red run names both.
  const seen: Record<string, { marks: number; title: string; lines: string[] }> = {};
  await page.goto("/projects");
  await expect(action(page, PAGES[0])).toBeVisible();
  await contentOf(page, PAGES[0]);
  seen["/projects"] = { ...(await headingReading(page)), lines: await lineTexts(page) };
  await page.goto("/connections");
  await expect(page.getByText("Warehouse 1")).toBeVisible();
  seen["/connections"] = { ...(await headingReading(page)), lines: await lineTexts(page) };
  expect(seen, "no paragraph and no count on either page").toEqual({
    "/projects": { marks: 0, title: "Projects", lines: [] },
    "/connections": { marks: 0, title: "Connections", lines: [] },
  });
});

/* This measured the pill's light and dark surfaces. The pill is gone,
   so the shot has no subject: the class it guarded cannot
   return without the mark and the title-text reads above going red
   first. */
